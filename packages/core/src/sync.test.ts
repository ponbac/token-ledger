import { assert, it } from "@effect/vitest";

import { Schema } from "effect";

import { PriceBook, type Coverage } from "./model.ts";
import {
  RepricePayload,
  type SyncBucket,
  SyncCoverage,
  SyncPayload,
  payloadVersion,
  providerCoverage,
  replacedProviders,
  repriceChunks,
  sessionBuckets,
} from "./sync.ts";

function source(
  provider: Coverage["provider"],
  status: Coverage["status"],
  files = 1,
  unreadable = 0,
): Coverage {
  return {
    provider,
    source: `/fixture/${provider}/${status}`,
    status,
    files,
    filesBeforeWindow: 0,
    unreadable,
    malformedLines: status === "partial" ? 1 : 0,
    skippedRecords: 0,
    duplicates: 0,
    warnings: [],
  };
}

it("replaces only providers whose existing history was fully read", () => {
  const summary = providerCoverage([
    source("codex", "ok", 3),
    source("codex", "missing", 0),
    source("claude", "ok"),
    source("claude", "partial"),
    source("grok", "missing", 0),
    source("copilot", "ok"),
    source("copilot", "partial", 1, 1),
  ]);

  assert.deepStrictEqual(
    summary.map((entry) => [entry.provider, entry.status, entry.files, entry.malformedLines]),
    [
      ["claude", "partial", 2, 1],
      ["codex", "ok", 3, 0],
      ["copilot", "failed", 2, 1],
      ["grok", "missing", 0, 0],
    ],
  );
  assert.deepStrictEqual([...replacedProviders(summary)].toSorted(), ["claude", "codex"]);
});

it("requires fully read history before coverage can authorize replacement", () => {
  const valid = Schema.is(SyncCoverage);

  // The first version 1 clients send no filesBeforeWindow.
  const coverage = {
    provider: "codex",
    files: 1,
    unreadable: 0,
    malformedLines: 0,
    skippedRecords: 0,
    duplicates: 0,
  };

  for (const status of ["ok", "partial", "missing", "failed"] as const)
    assert.isTrue(valid({ ...coverage, status }));

  assert.isTrue(valid({ ...coverage, status: "ok", files: 0, filesBeforeWindow: 3 }));

  for (const status of ["missing", "failed"] as const)
    assert.isTrue(valid({ ...coverage, status, unreadable: 1 }));

  for (const status of ["ok", "partial"] as const)
    assert.isFalse(valid({ ...coverage, status, unreadable: 1 }));
});

it("only builds payloads the server can store", () => {
  const buckets = sessionBuckets(
    PriceBook.make({ status: "custom", fetchedAt: null, source: "fixture", prices: {} }),
  );

  for (const model of ["model\0", "model\uFFFD", `model\uFFFD${"😀".repeat(600)}`])
    buckets.add(
      {
        provider: "codex",
        id: model,
        session: "session",
        timestamp: Date.parse("2026-09-22T10:00:00Z"),
        model,
        cwd: null,
        repository: null,
        tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      "project\0",
    );

  const [bucket, long, ...rest] = buckets.finish();
  assert.deepStrictEqual(
    [bucket?.project, bucket?.model, bucket?.records],
    ["project\uFFFD", "model\uFFFD", 2],
  );
  assert.strictEqual(Array.from(long?.model ?? "").length, 512);
  assert.isTrue(long?.model.endsWith("😀"));
  assert.lengthOf(rest, 0);

  const coverage = {
    provider: "codex",
    status: "ok",
    files: 1,
    filesBeforeWindow: 0,
    unreadable: 0,
    malformedLines: 0,
    skippedRecords: 0,
    duplicates: 0,
  };

  const payload = {
    version: 1,
    machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
    clientVersion: "0.0.0-test",
    timeZone: "Europe/Stockholm",
    window: { start: "2026-09-22T00:00:00.000Z", end: "2026-09-23T00:00:00.000Z" },
    currency: "USD",
    costBasis: "api-equivalent",
    pricing: { status: "custom", fetchedAt: null, source: "fixture" },
    buckets: [bucket],
    coverage: [coverage],
  };

  const valid = Schema.is(SyncPayload);
  assert.isTrue(valid(payload));
  const routed = Object.assign({}, bucket, { billingProvider: "claude" });
  assert.isTrue(valid({ ...payload, version: 2, buckets: [bucket, routed] }));
  assert.isFalse(valid({ ...payload, buckets: [routed] }));

  for (const billingProvider of ["codex", "pi", "unknown"])
    assert.isFalse(
      valid({ ...payload, version: 2, buckets: [Object.assign({}, bucket, { billingProvider })] }),
    );

  const hint = { provider: "codex", hourStart: "2026-09-22T10:00:00.000Z", plan: "pro" };
  assert.isTrue(valid({ ...payload, providerHints: [hint] }));

  for (const invalid of [
    {
      ...payload,
      providerHints: [{ ...hint, hourStart: "2026-09-21T23:00:00.000Z" }],
    },
    { ...payload, providerHints: [{ ...hint, hourStart: payload.window.end }] },
    { ...payload, providerHints: [{ ...hint, provider: "grok" }] },
    {
      ...payload,
      providerHints: [{ ...hint, provider: "grok" }],
      coverage: [coverage, { ...coverage, provider: "grok", status: "failed", unreadable: 1 }],
    },
    {
      ...payload,
      providerHints: [{ ...hint, provider: "grok" }],
      coverage: [coverage, { ...coverage, provider: "grok", status: "missing" }],
    },
    { ...payload, buckets: [bucket, bucket] },
    { ...payload, coverage: [coverage, coverage] },
    {
      ...payload,
      buckets: [
        {
          hourStart: "2026-09-22T10:00:00.000Z",
          sessionKey: bucket?.sessionKey,
          project: "project",
          provider: "codex",
          model: "model",
          tokens: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
          records: 2,
          estimatedCostUsd: null,
          unpricedRecords: 3,
        },
      ],
    },
    { ...payload, machine: { ...payload.machine, label: "nul\0" } },
    { ...payload, machine: { ...payload.machine, label: "x".repeat(513) } },
    { ...payload, pricing: { ...payload.pricing, fetchedAt: "yesterday" } },
    { ...payload, pricing: { ...payload.pricing, basis: "" } },
    { ...payload, pricing: { ...payload.pricing, basis: "x".repeat(129) } },
    { ...payload, pricing: { ...payload.pricing, basis: "two words" } },
  ])
    assert.isFalse(valid(invalid));

  assert.isTrue(valid({ ...payload, pricing: { ...payload.pricing, basis: "x".repeat(128) } }));
});

it("prices each record at its own tier before summing the bucket", () => {
  const buckets = sessionBuckets(
    PriceBook.make({
      status: "custom",
      fetchedAt: null,
      source: "fixture",
      prices: {
        tiered: {
          input: 1,
          output: 10,
          cacheRead: 0.1,
          cacheWrite: null,
          tiers: [{ above: 272_000, input: 2, output: 15, cacheRead: 0.2, cacheWrite: null }],
        },
      },
    }),
  );

  // Contexts of 272,000 and 272,001 tokens: the first stays at the base tier.
  for (const [id, cacheRead] of [
    ["short", 271_000],
    ["long", 271_001],
  ] as const)
    buckets.add(
      {
        provider: "codex",
        id,
        session: "session",
        timestamp: Date.parse("2026-10-20T10:00:00Z"),
        model: "tiered",
        cwd: null,
        repository: null,
        tokens: { input: 1_000, cacheRead, cacheWrite: 0, output: 100 },
      },
      "project",
    );

  const [bucket, ...rest] = buckets.finish();
  assert.lengthOf(rest, 0);
  assert.strictEqual(bucket?.records, 2);
  assert.strictEqual(bucket?.tokens.cacheRead, 542_001);

  const short = (1_000 * 1 + 271_000 * 0.1 + 100 * 10) / 1_000_000;
  const long = (1_000 * 2 + 271_001 * 0.2 + 100 * 15) / 1_000_000;
  assert.closeTo(bucket?.estimatedCostUsd ?? -1, short + long, 1e-12);
});

it("uploads the priced subtotal of a bucket that also has unpriced records", () => {
  const buckets = sessionBuckets(
    PriceBook.make({
      status: "custom",
      fetchedAt: null,
      source: "fixture",
      // Like OpenAI rates upstream: no cache-write price.
      prices: { priced: { input: 1, output: 0, cacheRead: 0.1, cacheWrite: null } },
    }),
  );

  const record = (id: string, model: string, cacheWrite: number) =>
    buckets.add(
      {
        provider: "copilot",
        id,
        session: "session",
        timestamp: Date.parse("2026-09-22T10:00:00Z"),
        model,
        cwd: null,
        repository: null,
        tokens: { input: 1_000_000, cacheRead: 0, cacheWrite, output: 0 },
      },
      "project",
    );

  record("costs-one-dollar", "priced", 0);
  record("writes-cache", "priced", 10);
  record("no-price", "unknown-model", 0);

  const finished = buckets.finish();
  assert.deepStrictEqual(
    finished.map((bucket) => [bucket.model, bucket.estimatedCostUsd, bucket.unpricedRecords]),
    [
      ["priced", 1, 1],
      ["unknown-model", null, 1],
    ],
  );
  assert.strictEqual(payloadVersion(finished), 3);

  const payload = {
    version: 3,
    machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
    clientVersion: "0.0.0-test",
    timeZone: "Europe/Stockholm",
    window: { start: "2026-09-22T00:00:00.000Z", end: "2026-09-23T00:00:00.000Z" },
    currency: "USD",
    costBasis: "api-equivalent",
    pricing: { status: "custom", fetchedAt: null, source: "fixture" },
    buckets: finished,
    coverage: [
      {
        provider: "copilot",
        status: "ok",
        files: 1,
        unreadable: 0,
        malformedLines: 0,
        skippedRecords: 0,
        duplicates: 0,
      },
    ],
  };

  const valid = Schema.is(SyncPayload);
  assert.isTrue(valid(payload));
  // Older servers require a null cost whenever any record is unpriced.
  assert.isFalse(valid({ ...payload, version: 2 }));
  assert.isTrue(valid({ ...payload, version: 1, buckets: finished.slice(1) }));
  assert.strictEqual(payloadVersion(finished.slice(1)), 1);
});

it("splits reprice-only uploads into requests the server accepts", () => {
  const fields = {
    hourStart: "2026-10-03T14:00:00.000Z",
    provider: "copilot",
    tokens: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 },
    records: 1,
    estimatedCostUsd: 0.001,
    unpricedRecords: 0,
  } as const;

  const bucket = (
    index: number,
    project = "github.com/example/app",
    model = "test-model",
  ): SyncBucket => ({
    ...fields,
    sessionKey: index.toString(16).padStart(32, "0"),
    project,
    model,
  });

  const valid = Schema.is(RepricePayload);

  const payload = (buckets: readonly unknown[]) => ({
    version: 1,
    clientVersion: "0.0.0-test",
    pricing: {
      status: "fresh",
      fetchedAt: "2026-10-24T10:00:00.000Z",
      source: "fixture",
      basis: "token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers",
    },
    buckets,
  });

  const buckets = Array.from({ length: 20_001 }, (_, index) => bucket(index));
  const chunks = repriceChunks(buckets);

  assert.deepStrictEqual(
    chunks.map((chunk) => chunk.length),
    [20_000, 1],
  );
  assert.deepStrictEqual(chunks.flat(), buckets);
  assert.isTrue(chunks.every((chunk) => valid(payload(chunk))));
  assert.isFalse(valid(payload(buckets)));
  assert.deepStrictEqual(repriceChunks([]), []);

  // The longest names stay inside the server's 16 MiB body limit.
  const long = Array.from({ length: 20_000 }, (_, index) =>
    bucket(index, "😀".repeat(512), "😀".repeat(512)),
  );

  const split = repriceChunks(long);

  assert.isAbove(split.length, 1);
  assert.deepStrictEqual(split.flat(), long);

  for (const chunk of split)
    assert.isBelow(Buffer.byteLength(JSON.stringify(payload(chunk))), 16 * 1024 * 1024);

  const first = bucket(0);
  const pricing = payload([first]).pricing;

  const unhourly = {
    ...fields,
    sessionKey: "0".repeat(32),
    project: "p",
    model: "m",
    hourStart: "2026-10-03T14:30:00.000Z",
  };

  const unpriced = {
    ...fields,
    sessionKey: "0".repeat(32),
    project: "p",
    model: "m",
    estimatedCostUsd: null,
  };

  for (const invalid of [
    payload([first, first]),
    { ...payload([first]), version: 2 },
    { ...payload([first]), pricing: { ...pricing, basis: undefined } },
    { ...payload([first]), pricing: { ...pricing, basis: "" } },
    payload([unpriced]),
    payload([unhourly]),
  ])
    assert.isFalse(valid(invalid));
});
