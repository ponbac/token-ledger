import { assert, it } from "@effect/vitest";

import { Schema } from "effect";

import { PriceBook, type Coverage } from "./model.ts";
import {
  SyncCoverage,
  SyncPayload,
  providerCoverage,
  replacedProviders,
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
  ])
    assert.isFalse(valid(invalid));
});
