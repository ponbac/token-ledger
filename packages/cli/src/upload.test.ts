import { assert, describe, it } from "@effect/vitest";
import { RepricePayload, SyncPayload } from "@token-ledger/core/sync";
import { DateTime, Effect, Fiber, Option, Predicate, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { hasUploaded, reprice, repricingStatus, upload } from "./upload.ts";

const payload = SyncPayload.make({
  version: 1,
  machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
  clientVersion: "0.0.0-test",
  timeZone: "Europe/Stockholm",
  window: { start: "2026-09-21T22:00:00.000Z", end: "2026-09-22T22:00:00.000Z" },
  currency: "USD",
  costBasis: "api-equivalent",
  pricing: { status: "custom", fetchedAt: null, source: "fixture" },
  buckets: [],
  coverage: [],
});

const token = Redacted.make("toki_fixture");

function server(respond: (request: HttpClientRequest.HttpClientRequest) => Response | null) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];

  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = respond(request);

    return response === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  return { client, requests };
}

describe("hasUploaded", () => {
  const id = "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a";
  const other = "0b0b0b0b-0000-4000-8000-000000000000";

  const list = (machines: ReadonlyArray<string>) => ({
    staleAfterDays: 7,
    from: "2026-09-01",
    to: "2026-09-30",
    machines: machines.map((machineId) => ({ machineId, label: "a machine" })),
  });

  it.effect("asks the server for the caller's machines and looks for this one", () =>
    Effect.gen(function* () {
      const known = server(() => Response.json(list([other, id.toUpperCase()])));

      const listed = yield* hasUploaded(new URL("https://toki.example/api"), token, id).pipe(
        Effect.provideService(HttpClient.HttpClient, known.client),
      );

      assert.isTrue(listed);
      assert.strictEqual(known.requests[0]?.method, "GET");
      assert.strictEqual(known.requests[0]?.url, "https://toki.example/api/ai-usage/machines");
      assert.strictEqual(known.requests[0]?.headers["authorization"], "Bearer toki_fixture");

      for (const machines of [[], [other]]) {
        const unknown = yield* hasUploaded(new URL("https://toki.example/api/"), token, id).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            server(() => Response.json(list(machines))).client,
          ),
        );

        assert.isFalse(unknown);
      }
    }),
  );

  it.effect("fails rather than answer when the reply is not plainly the server's list", () =>
    Effect.gen(function* () {
      // Refused, missing on an older server, broken, partial, a stand-in's empty list, a list
      // whose entries are not machine IDs, another document, not JSON, and unreachable.
      for (const respond of [
        () => new Response(null, { status: 401 }),
        () => new Response(null, { status: 404 }),
        () => new Response(null, { status: 500 }),
        () => Response.json(list([]), { status: 206 }),
        () => Response.json({ machines: [] }),
        () => Response.json(list(["not-a-uuid"])),
        () => Response.json({ ...list([]), machines: "none" }),
        () => new Response("<html>", { status: 200 }),
        () => null,
      ]) {
        const outcome = yield* hasUploaded(new URL("https://toki.example"), token, id).pipe(
          Effect.provideService(HttpClient.HttpClient, server(respond).client),
          Effect.result,
        );

        assert.isTrue(
          Result.isFailure(outcome) && Predicate.isTagged(outcome.failure, "SyncUnreachable"),
        );
      }
    }),
  );
});

describe("upload", () => {
  it.effect("PUTs the payload under the server's path with the bearer token", () =>
    Effect.gen(function* () {
      for (const url of [
        "https://toki.example/api",
        "https://toki.example/api/",
        "https://toki.example/api?tenant=1",
        "https://toki.example/api#machine",
        "https://toki.example/api/?tenant=1#machine",
      ]) {
        const { client, requests } = server(() => Response.json({ storedBuckets: 7 }));

        const stored = yield* upload(new URL(url), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );

        assert.deepStrictEqual(stored, Option.some(7));
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.method, "PUT");
        assert.strictEqual(
          requests[0]?.url,
          `https://toki.example/api/ai-usage/machines/${payload.machine.id}/usage`,
        );
        assert.strictEqual(requests[0]?.headers["authorization"], "Bearer toki_fixture");
        assert.deepStrictEqual(
          requests[0]?.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(requests[0].body.body))
            : undefined,
          JSON.parse(JSON.stringify(payload)),
        );
      }
    }),
  );

  it.effect("classifies refusals, without retrying them, so each maps to its own exit code", () =>
    Effect.gen(function* () {
      for (const [response, tag] of [
        [new Response(null, { status: 401 }), "SyncUnauthorized"],
        [new Response(null, { status: 403 }), "SyncUnauthorized"],
        // A newer snapshot from this machine is stored; resending this one cannot succeed.
        [Response.json({}, { status: 409 }), "SyncSuperseded"],
        [Response.json({ supportedVersions: [2] }, { status: 422 }), "SyncUnsupportedVersion"],
        [Response.json({ supportedVersions: [1] }, { status: 422 }), "SyncRejected"],
        [new Response(null, { status: 422 }), "SyncRejected"],
        [new Response(null, { status: 400 }), "SyncRejected"],
      ] as const) {
        const { client, requests } = server(() => response.clone());

        const result = yield* upload(new URL("https://toki.example"), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
        );

        assert.isTrue(Result.isFailure(result) && Predicate.isTagged(result.failure, tag), tag);
        assert.strictEqual(requests.length, 1, tag);
        assert.notInclude(JSON.stringify(result), "toki_fixture");
      }
    }),
  );

  it.effect("retries transient failures before reporting the server unreachable", () =>
    Effect.gen(function* () {
      const flaky = server(() =>
        flaky.requests.length < 3 ? null : Response.json({ storedBuckets: 0 }, { status: 200 }),
      );

      const recovered = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, flaky.client),
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(recovered), Option.some(0));

      const down = server(() => null);

      const failed = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, down.client),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(failed);
      assert.isTrue(
        Result.isFailure(result) && Predicate.isTagged(result.failure, "SyncUnreachable"),
      );
      assert.strictEqual(down.requests.length, 4);

      const unavailable = server(() => new Response(null, { status: 503 }));

      const overloaded = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, unavailable.client),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      const outage = yield* Fiber.join(overloaded);
      assert.isTrue(
        Result.isFailure(outage) && Predicate.isTagged(outage.failure, "SyncUnreachable"),
      );
      assert.strictEqual(unavailable.requests.length, 4);
    }),
  );

  it.effect("times out stalled response bodies and closes every retry attempt", () =>
    Effect.gen(function* () {
      for (const status of [200, 422]) {
        const signals: AbortSignal[] = [];

        const client = HttpClient.make((request, _url, signal) => {
          signals.push(signal);

          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          });

          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(body, { status })),
          );
        });

        const failed = yield* upload(new URL("https://toki.example"), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
          Effect.forkChild,
        );

        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(signals.length, 4, `stalled ${status} body`);
        assert.isTrue(signals.every((signal) => signal.aborted));

        const result = yield* Fiber.join(failed);
        assert.isTrue(
          Result.isFailure(result) && Predicate.isTagged(result.failure, "SyncUnreachable"),
        );
      }
    }),
  );
});

describe("repricing", () => {
  const id = "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a";
  const basis = "token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers";

  const repricing = RepricePayload.make({
    version: 1,
    clientVersion: "0.0.0-test",
    pricing: { status: "fresh", fetchedAt: "2026-10-24T10:00:00.000Z", source: "fixture", basis },
    buckets: [
      {
        hourStart: "2026-10-03T14:00:00.000Z",
        sessionKey: "0".repeat(32),
        project: "github.com/example/app",
        provider: "copilot",
        model: "fixture-model",
        tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 },
        records: 1,
        estimatedCostUsd: 0.001,
        unpricedRecords: 0,
      },
    ],
  });

  /** Records the URL each request went to, query included, as `HttpClient.make` resolves it. */
  function addressed(respond: () => Response) {
    const urls: URL[] = [];
    const requests: HttpClientRequest.HttpClientRequest[] = [];

    const client = HttpClient.make((request, url) => {
      requests.push(request);
      urls.push(url);

      return Effect.succeed(HttpClientResponse.fromWeb(request, respond()));
    });

    return { client, requests, urls };
  }

  it.effect("asks which stored usage another basis priced, per provider", () =>
    Effect.gen(function* () {
      const { client, requests, urls } = addressed(() =>
        Response.json({
          floor: "2026-10-01T00:00:00Z",
          providers: [
            { provider: "claude", from: null, staleBuckets: 0 },
            { provider: "copilot", from: "2026-10-03T14:00:00Z", staleBuckets: 12 },
            { provider: "cursor", from: "2026-10-02T09:00:00.000Z", staleBuckets: 1 },
          ],
        }),
      );

      const status = yield* repricingStatus(
        new URL("https://toki.example/api?tenant=1"),
        token,
        id,
        basis,
      ).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.strictEqual(requests[0]?.method, "GET");
      assert.strictEqual(requests[0]?.headers["authorization"], "Bearer toki_fixture");
      assert.strictEqual(urls[0]?.origin, "https://toki.example");
      assert.strictEqual(urls[0]?.pathname, `/api/ai-usage/machines/${id}/repricing`);
      assert.deepStrictEqual([...(urls[0]?.searchParams ?? [])], [["basis", basis]]);

      assert.deepStrictEqual(
        DateTime.toEpochMillis(status.floor),
        Date.parse("2026-10-01T00:00:00Z"),
      );
      assert.deepStrictEqual(
        status.providers.map(({ provider, from, staleBuckets }) => [
          provider,
          from === null ? null : DateTime.toEpochMillis(from),
          staleBuckets,
        ]),
        [
          ["claude", null, 0],
          ["copilot", Date.parse("2026-10-03T14:00:00Z"), 12],
          ["cursor", Date.parse("2026-10-02T09:00:00Z"), 1],
        ],
      );

      // A machine the server does not know has no providers.
      const unknown = yield* repricingStatus(
        new URL("https://toki.example"),
        token,
        id,
        basis,
      ).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          server(() => Response.json({ floor: "2026-10-01T00:00:00Z", providers: [] })).client,
        ),
      );

      assert.deepStrictEqual(unknown.providers, []);
    }),
  );

  it.effect("refuses answers that are not the server's own, without retrying them", () =>
    Effect.gen(function* () {
      for (const respond of [
        () => new Response(null, { status: 400 }),
        () => new Response(null, { status: 401 }),
        () => new Response(null, { status: 403 }),
        // A server without repricing.
        () => new Response(null, { status: 404 }),
        () => new Response("<html>", { status: 200 }),
        () => Response.json({ floor: "2026-10-01T00:00:00Z" }),
        () =>
          Response.json({
            floor: "2026-10-01T00:00:00Z",
            providers: [{ provider: "copilot", from: "soon", staleBuckets: 1 }],
          }),
        () =>
          Response.json({
            floor: "2026-10-01T00:00:00Z",
            providers: [{ provider: "copilot", from: null, staleBuckets: -1 }],
          }),
      ]) {
        const refusing = server(respond);

        const outcome = yield* repricingStatus(
          new URL("https://toki.example"),
          token,
          id,
          basis,
        ).pipe(Effect.provideService(HttpClient.HttpClient, refusing.client), Effect.result);

        assert.isTrue(
          Result.isFailure(outcome) && Predicate.isTagged(outcome.failure, "RepricingRefused"),
        );
        assert.strictEqual(refusing.requests.length, 1);
        assert.notInclude(JSON.stringify(outcome), "toki_fixture");
      }
    }),
  );

  it.effect("POSTs new costs and returns the server's counts, retrying transient failures", () =>
    Effect.gen(function* () {
      const flaky = server(() =>
        flaky.requests.length < 3
          ? new Response(null, { status: flaky.requests.length === 1 ? 503 : 429 })
          : Response.json({ updated: 1, unmatched: 0, beforeFloor: 0 }),
      );

      const running = yield* reprice(
        new URL("https://toki.example/api/"),
        token,
        id,
        repricing,
      ).pipe(Effect.provideService(HttpClient.HttpClient, flaky.client), Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(running), {
        updated: 1,
        unmatched: 0,
        beforeFloor: 0,
      });
      assert.strictEqual(flaky.requests.length, 3);

      for (const request of flaky.requests) {
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(
          request.url,
          `https://toki.example/api/ai-usage/machines/${id}/repricing`,
        );
        assert.strictEqual(request.headers["authorization"], "Bearer toki_fixture");
        assert.deepStrictEqual(
          Predicate.isTagged(request.body, "Uint8Array")
            ? JSON.parse(new TextDecoder().decode(request.body.body))
            : undefined,
          JSON.parse(JSON.stringify(repricing)),
        );
      }

      const down = server(() => null);

      const failing = yield* reprice(new URL("https://toki.example"), token, id, repricing).pipe(
        Effect.provideService(HttpClient.HttpClient, down.client),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("5 minutes");
      const failed = yield* Fiber.join(failing);

      assert.isTrue(
        Result.isFailure(failed) && Predicate.isTagged(failed.failure, "RepricingUnavailable"),
      );
      assert.strictEqual(down.requests.length, 4);
    }),
  );
});
