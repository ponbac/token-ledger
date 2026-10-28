import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import type { InstantRange } from "@token-ledger/core/calendar";
import { InvalidRequest, type RepriceScan } from "@token-ledger/core/ledger";
import type { Provider } from "@token-ledger/core/model";
import { RepricePayload, type SyncBucket, SyncPayload } from "@token-ledger/core/sync";
import { DateTime, Effect, FileSystem, Fiber, Path, Predicate, Redacted, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { repriceLine } from "./format.ts";
import {
  RepriceOutcome,
  type RepriceRun,
  RepriceStep,
  repricePlan,
  repriceStoredUsage,
} from "./reprice.ts";
import { loadRepricing } from "./settings.ts";
import { RepricingStatus } from "./upload.ts";

const token = Redacted.make("toki_fixture_secret");

const machine = "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a";

const basis = "token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers";

const windowStart = "2026-10-10T22:00:00.000Z";

const windowEnd = "2026-10-24T22:00:00.000Z";

/** What a sync stored; `null` for a sync that priced without vendor rates, claiming no basis. */
const payload = (pricingBasis: string | null) =>
  SyncPayload.make({
    version: 1,
    machine: { id: machine, label: "test-machine" },
    clientVersion: "0.0.0-test",
    timeZone: "Europe/Stockholm",
    window: { start: windowStart, end: windowEnd },
    currency: "USD",
    costBasis: "api-equivalent",
    pricing:
      pricingBasis === null
        ? { status: "unavailable", fetchedAt: null, source: "fixture" }
        : {
            status: "fresh",
            fetchedAt: "2026-10-24T10:00:00.000Z",
            source: "fixture",
            basis: pricingBasis,
          },
    buckets: [],
    coverage: [],
  });

const decodeStatus = Schema.decodeUnknownSync(RepricingStatus);

const decodeReprice = Schema.decodeUnknownSync(Schema.fromJsonString(RepricePayload));

function bucket(provider: Provider, hourStart: string, index = 0): SyncBucket {
  return {
    hourStart,
    sessionKey: index.toString(16).padStart(32, "0"),
    project: "github.com/example/app",
    provider,
    model: "fixture-model",
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 },
    records: 1,
    estimatedCostUsd: 0.001,
    unpricedRecords: 0,
  };
}

/** The server's answer to which stored usage another basis priced. */
function discovery(providers: ReadonlyArray<readonly [string, string | null]>) {
  return {
    floor: "2026-10-01T00:00:00Z",
    providers: providers.map(([provider, from]) => ({ provider, from, staleBuckets: 12 })),
  };
}

interface Exchange {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
  readonly body: string;
}

/** A toki2 stand-in: `respond` answers each request, or `null` drops the connection. */
function toki(respond: (exchange: Exchange) => Response | null) {
  const exchanges: Exchange[] = [];

  const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest, url) => {
    const exchange = {
      method: request.method,
      url,
      authorization: request.headers["authorization"],
      body: Predicate.isTagged(request.body, "Uint8Array")
        ? new TextDecoder().decode(request.body.body)
        : "",
    };

    exchanges.push(exchange);
    const response = respond(exchange);

    return response === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  const reprices = () =>
    exchanges.flatMap((exchange) =>
      exchange.method === "POST" ? [decodeReprice(exchange.body)] : [],
    );

  return { client, exchanges, reprices };
}

/** Answers discovery with `status` and each reprice with a receipt counting its buckets. */
function answering(status: ReturnType<typeof discovery>) {
  return (exchange: Exchange) =>
    exchange.method === "GET"
      ? Response.json(status)
      : Response.json({
          updated: decodeReprice(exchange.body).buckets.length,
          unmatched: 0,
          beforeFloor: 0,
        });
}

/** A history that holds `buckets` and records every range it is asked for. */
function history(
  buckets: ReadonlyArray<SyncBucket>,
  status: RepriceScan["coverage"]["status"] = "ok",
) {
  const scans: Array<{ readonly provider: Provider; readonly range: InstantRange }> = [];

  const scan = (provider: Provider, range: InstantRange) =>
    Effect.sync((): RepriceScan => {
      scans.push({ provider, range });

      return {
        buckets: status === "ok" ? buckets.filter((entry) => entry.provider === provider) : [],
        coverage: {
          provider,
          status,
          files: status === "missing" ? 0 : 1,
          unreadable: status === "failed" ? 1 : 0,
          malformedLines: 0,
          skippedRecords: 0,
          duplicates: 0,
        },
      };
    });

  return { scan, scans };
}

const settings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return path.join(yield* fs.makeTempDirectoryScoped(), "token-ledger");
});

function run(
  directory: string,
  scan: RepriceRun["scan"],
  providers: ReadonlyArray<Provider> = ["codex", "claude", "copilot", "pi"],
  pricingBasis: string | null = basis,
): RepriceRun {
  return {
    server: new URL("https://toki.example/api"),
    token,
    payload: payload(pricingBasis),
    providers: new Set(providers),
    directory,
    scan,
  };
}

const hour = (instant: string) => Date.parse(instant);

describe("repricePlan", () => {
  const scope = {
    windowStart: hour(windowStart),
    providers: new Set<Provider>(["codex", "claude", "copilot", "pi", "opencode"]),
    server: "https://toki.example",
    basis,
    completed: [],
  };

  it("reprices each covered provider from the server's hour up to the sync's window", () => {
    const status = decodeStatus(
      discovery([
        ["claude", null],
        ["codex", "2026-10-03T14:00:00Z"],
        // A newer server's provider does not hide the rest.
        ["cursor", "2026-10-02T00:00:00Z"],
        // Stale only inside the window, which the sync just stored.
        ["copilot", windowStart],
        ["pi", "2026-10-12T08:00:00Z"],
        // Before the floor, against the contract: never earlier than the floor.
        ["opencode", "2026-09-20T00:00:00.000Z"],
      ]),
    );

    assert.deepStrictEqual(repricePlan(status, scope), [
      RepriceStep.Reprice({
        provider: "codex",
        from: hour("2026-10-03T14:00:00Z"),
        range: { start: hour("2026-10-03T14:00:00Z"), end: hour(windowStart) },
        staleBuckets: 12,
      }),
      RepriceStep.Reprice({
        provider: "opencode",
        from: hour("2026-09-20T00:00:00Z"),
        range: { start: hour("2026-10-01T00:00:00Z"), end: hour(windowStart) },
        staleBuckets: 12,
      }),
    ]);

    assert.deepStrictEqual(repricePlan(decodeStatus(discovery([])), scope), []);
  });

  it("leaves out providers the sync did not cover", () => {
    const status = decodeStatus(
      discovery([
        ["claude", "2026-10-03T14:00:00Z"],
        ["codex", "2026-10-03T14:00:00Z"],
      ]),
    );

    assert.deepStrictEqual(
      repricePlan(status, { ...scope, providers: new Set<Provider>(["codex"]) }).map(
        (step) => step.provider,
      ),
      ["codex"],
    );
  });

  it("skips a provider already repriced from the same hour on the same basis and server", () => {
    const status = decodeStatus(discovery([["codex", "2026-10-03T14:00:00Z"]]));

    // An earlier sync whose window ended where this one starts covered every hour before it.
    const completed = {
      server: "https://toki.example",
      provider: "codex",
      basis,
      from: DateTime.makeUnsafe("2026-10-03T14:00:00Z"),
      coveredUntil: DateTime.makeUnsafe(windowStart),
    } as const;

    assert.deepStrictEqual(repricePlan(status, { ...scope, completed: [completed] }), [
      RepriceStep.Skip({ provider: "codex", from: hour("2026-10-03T14:00:00Z"), staleBuckets: 12 }),
    ]);

    for (const other of [
      { ...completed, basis: "token-ledger-pricing@0;copilot-rates@2026-09-01;litellm@tiers" },
      { ...completed, from: DateTime.makeUnsafe("2026-10-02T09:00:00Z") },
      { ...completed, server: "https://other.example" },
      { ...completed, provider: "claude" as const },
      // A sync of an earlier window never sent the hours between its window and this one.
      { ...completed, coveredUntil: DateTime.makeUnsafe("2026-10-07T00:00:00Z") },
    ])
      assert.isTrue(
        RepriceStep.$is("Reprice")(repricePlan(status, { ...scope, completed: [other] })[0]),
      );
  });
});

describe("repriceStoredUsage", () => {
  it.effect("asks nothing and sends nothing when the sync claimed no pricing basis", () =>
    Effect.gen(function* () {
      const server = toki(answering(discovery([["codex", "2026-10-03T14:00:00Z"]])));
      const { scan, scans } = history([bucket("codex", "2026-10-03T14:00:00.000Z")]);

      const outcomes = yield* repriceStoredUsage(run(yield* settings, scan, undefined, null)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.deepStrictEqual(outcomes, []);
      assert.lengthOf(server.exchanges, 0);
      assert.lengthOf(scans, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends one provider's older buckets, reports the counts, then skips them", () =>
    Effect.gen(function* () {
      const directory = yield* settings;

      const server = toki(
        answering(
          discovery([
            ["claude", null],
            ["codex", "2026-10-03T14:00:00Z"],
            ["copilot", "2026-10-12T00:00:00Z"],
          ]),
        ),
      );

      const { scan, scans } = history([
        bucket("codex", "2026-10-03T14:00:00.000Z", 1),
        bucket("codex", "2026-10-05T09:00:00.000Z", 2),
      ]);

      const first = yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      const discovered = server.exchanges[0];
      assert.strictEqual(discovered?.method, "GET");
      assert.strictEqual(
        `${discovered?.url.origin}${discovered?.url.pathname}`,
        `https://toki.example/api/ai-usage/machines/${machine}/repricing`,
      );
      assert.strictEqual(discovered?.url.searchParams.get("basis"), basis);
      assert.strictEqual(discovered?.authorization, "Bearer toki_fixture_secret");

      assert.deepStrictEqual(scans, [
        {
          provider: "codex",
          range: { start: hour("2026-10-03T14:00:00Z"), end: hour(windowStart) },
        },
      ]);

      const [sent, ...more] = server.reprices();
      assert.lengthOf(more, 0);
      assert.strictEqual(
        server.exchanges[1]?.url.pathname,
        `/api/ai-usage/machines/${machine}/repricing`,
      );
      assert.strictEqual(sent?.version, 1);
      assert.deepStrictEqual(sent?.pricing, {
        status: "fresh",
        fetchedAt: "2026-10-24T10:00:00.000Z",
        source: "fixture",
        basis,
      });
      assert.deepStrictEqual(
        sent?.buckets.map((entry) => entry.hourStart),
        ["2026-10-03T14:00:00.000Z", "2026-10-05T09:00:00.000Z"],
      );

      assert.deepStrictEqual(first, [
        RepriceOutcome.Repriced({
          provider: "codex",
          from: hour("2026-10-03T14:00:00Z"),
          staleBuckets: 12,
          sent: 2,
          updated: 2,
          unmatched: 0,
          beforeFloor: 0,
        }),
      ]);

      assert.match(
        repriceLine(first[0] ?? RepriceOutcome.Unanswered({ message: "" })).text,
        /^Repriced codex from 2026-10-03 14:00 UTC · 12 buckets stored on an older pricing basis · sent 2 · 2 updated · 0 unmatched$/,
      );

      assert.deepStrictEqual(yield* loadRepricing(directory), [
        {
          server: "https://toki.example",
          provider: "codex",
          basis,
          from: DateTime.makeUnsafe("2026-10-03T14:00:00Z"),
          coveredUntil: DateTime.makeUnsafe(windowEnd),
        },
      ]);

      // The same hour on the same basis again: only buckets this machine cannot reproduce.
      const second = yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.deepStrictEqual(second, [
        RepriceOutcome.Skipped({
          provider: "codex",
          from: hour("2026-10-03T14:00:00Z"),
          staleBuckets: 12,
        }),
      ]);
      assert.lengthOf(server.reprices(), 1);
      assert.lengthOf(scans, 1);

      const skipped = repriceLine(second[0] ?? RepriceOutcome.Unanswered({ message: "" }));
      assert.isFalse(skipped.problem);
      assert.include(skipped.text, "Repricing codex skipped");

      // A new basis reprices again.
      const renewed = yield* repriceStoredUsage(
        run(
          directory,
          scan,
          undefined,
          "token-ledger-pricing@2;copilot-rates@2026-11-01;litellm@tiers",
        ),
      ).pipe(Effect.provideService(HttpClient.HttpClient, server.client));

      assert.isTrue(RepriceOutcome.$is("Repriced")(renewed[0]));
      assert.lengthOf(server.reprices(), 2);
      assert.lengthOf(yield* loadRepricing(directory), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("sends at most 20,000 buckets per request and sums the server's counts", () =>
    Effect.gen(function* () {
      const server = toki(answering(discovery([["copilot", "2026-10-01T00:00:00Z"]])));

      const buckets = Array.from({ length: 20_001 }, (_, index) =>
        bucket("copilot", "2026-10-02T10:00:00.000Z", index),
      );

      const { scan } = history(buckets);

      const outcomes = yield* repriceStoredUsage(run(yield* settings, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.deepStrictEqual(
        server.reprices().map((sent) => sent.buckets.length),
        [20_000, 1],
      );
      assert.deepStrictEqual(
        server.reprices().flatMap((sent) => sent.buckets),
        buckets,
      );

      assert.deepStrictEqual(outcomes, [
        RepriceOutcome.Repriced({
          provider: "copilot",
          from: hour("2026-10-01T00:00:00Z"),
          staleBuckets: 12,
          sent: 20_001,
          updated: 20_001,
          unmatched: 0,
          beforeFloor: 0,
        }),
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a transient failure with the same provider's buckets only", () =>
    Effect.gen(function* () {
      let failures = 1;

      const respond = answering(
        discovery([
          ["codex", "2026-10-03T14:00:00Z"],
          ["copilot", "2026-10-04T08:00:00Z"],
        ]),
      );

      const server = toki((exchange) => {
        if (exchange.method !== "POST" || failures === 0) return respond(exchange);

        failures--;

        return new Response(null, { status: 503 });
      });

      const { scan } = history([
        bucket("codex", "2026-10-03T14:00:00.000Z", 1),
        bucket("copilot", "2026-10-04T08:00:00.000Z", 2),
        bucket("copilot", "2026-10-06T08:00:00.000Z", 3),
      ]);

      const running = yield* repriceStoredUsage(run(yield* settings, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      const outcomes = yield* Fiber.join(running);

      const posts = server.exchanges.filter((exchange) => exchange.method === "POST");

      assert.deepStrictEqual(
        server.reprices().map((sent) => sent.buckets.map((entry) => entry.provider)),
        [["codex"], ["codex"], ["copilot", "copilot"]],
      );
      assert.strictEqual(posts[1]?.body, posts[0]?.body);

      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome._tag),
        ["Repriced", "Repriced"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports every failure without failing, and tries again on the next sync", () =>
    Effect.gen(function* () {
      const directory = yield* settings;

      // The server cannot say what to reprice, even after retries.
      const unreachable = toki(() => null);
      const { scan } = history([bucket("codex", "2026-10-03T14:00:00.000Z")]);

      const asking = yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, unreachable.client),
        Effect.forkChild,
      );

      yield* TestClock.adjust("5 minutes");
      const unanswered = yield* Fiber.join(asking);

      assert.lengthOf(unreachable.exchanges, 4);
      assert.deepStrictEqual(unanswered, [
        RepriceOutcome.Unanswered({ message: "Cannot reach https://toki.example." }),
      ]);
      assert.isTrue(
        repriceLine(unanswered[0] ?? RepriceOutcome.Unanswered({ message: "" })).problem,
      );

      // A refused reprice is final for this run, remembered as unfinished.
      const status = discovery([["codex", "2026-10-03T14:00:00Z"]]);

      const refusing = toki((exchange) =>
        exchange.method === "GET" ? Response.json(status) : new Response(null, { status: 400 }),
      );

      const refused = yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, refusing.client),
      );

      assert.lengthOf(refusing.reprices(), 1);
      assert.deepStrictEqual(refused, [
        RepriceOutcome.Failed({
          provider: "codex",
          from: hour("2026-10-03T14:00:00Z"),
          message: "The server refused the request (400).",
          updated: 0,
          unmatched: 0,
        }),
      ]);

      const line = repriceLine(refused[0] ?? RepriceOutcome.Unanswered({ message: "" }));
      assert.isTrue(line.problem);
      assert.include(line.text, "The next sync tries again.");
      assert.deepStrictEqual(yield* loadRepricing(directory), []);

      // History that cannot be found is not pruned history either: it is reported, not
      // remembered, so a later sync that finds it reprices it.
      const absent = history([bucket("codex", "2026-10-03T14:00:00.000Z")], "missing");
      const searching = toki(answering(status));

      const missing = yield* repriceStoredUsage(run(directory, absent.scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, searching.client),
      );

      assert.lengthOf(searching.reprices(), 0);
      assert.deepStrictEqual(missing, [
        RepriceOutcome.NoHistory({
          provider: "codex",
          from: hour("2026-10-03T14:00:00Z"),
          staleBuckets: 12,
        }),
      ]);

      const waiting = repriceLine(missing[0] ?? RepriceOutcome.Unanswered({ message: "" }));
      assert.isFalse(waiting.problem);
      assert.include(waiting.text, "The next sync looks again.");
      assert.deepStrictEqual(yield* loadRepricing(directory), []);

      // Unread history is not pruned history, so nothing is sent for it.
      const unread = history([bucket("codex", "2026-10-03T14:00:00.000Z")], "failed");
      const server = toki(answering(status));

      const failed = yield* repriceStoredUsage(run(directory, unread.scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.lengthOf(server.reprices(), 0);
      assert.isTrue(RepriceOutcome.$is("Failed")(failed[0]));

      // A history that cannot be scanned is reported the same way.
      const broken = yield* repriceStoredUsage(
        run(directory, () => Effect.fail(new InvalidRequest({ message: "Invalid sources." }))),
      ).pipe(Effect.provideService(HttpClient.HttpClient, server.client));

      assert.isTrue(RepriceOutcome.$is("Failed")(broken[0]));

      // The next sync sends it, and remembers it once it is done.
      const done = yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.isTrue(RepriceOutcome.$is("Repriced")(done[0]));
      assert.lengthOf(yield* loadRepricing(directory), 1);

      for (const outcome of [...unanswered, ...refused, ...missing, ...failed, ...broken, ...done])
        assert.notInclude(repriceLine(outcome).text, "toki_fixture_secret");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps other servers' reprices and replaces the provider's own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* settings;

      yield* fs.makeDirectory(directory, { recursive: true });

      yield* fs.writeFileString(
        path.join(directory, "repricing.json"),
        JSON.stringify({
          version: 1,
          completed: [
            {
              server: "https://other.example",
              provider: "codex",
              basis,
              from: "2026-10-02T00:00:00.000Z",
              coveredUntil: windowEnd,
            },
            {
              server: "https://toki.example",
              provider: "codex",
              basis: "older",
              from: "2026-10-02T00:00:00.000Z",
              coveredUntil: windowEnd,
            },
          ],
        }),
      );

      const server = toki(answering(discovery([["codex", "2026-10-03T14:00:00Z"]])));
      const { scan } = history([bucket("codex", "2026-10-03T14:00:00.000Z")]);

      yield* repriceStoredUsage(run(directory, scan)).pipe(
        Effect.provideService(HttpClient.HttpClient, server.client),
      );

      assert.deepStrictEqual(
        (yield* loadRepricing(directory)).map((entry) => [entry.server, entry.basis]),
        [
          ["https://other.example", basis],
          ["https://toki.example", basis],
        ],
      );

      // An unreadable record is forgotten, which only costs sending the buckets again.
      yield* fs.writeFileString(path.join(directory, "repricing.json"), "{");
      assert.deepStrictEqual(yield* loadRepricing(directory), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
