import { createHash } from "node:crypto";

import { Schema } from "effect";

import type { InstantRange } from "./calendar.ts";
import { Coverage, PriceBook, Provider, Tokens, type UsageRecord } from "./model.ts";
import { type UsageTotals, addUsage, lookupPrice, priceTokens } from "./pricing.ts";

const hour = 3_600_000;

/** A UTC instant in `Date.prototype.toISOString` form, such as `2026-09-22T10:00:00.000Z`. */
const UtcInstant = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  Schema.makeFilter((s) => {
    const ms = Date.parse(s);

    return Number.isFinite(ms) && new Date(ms).toISOString() === s;
  }),
);

/** A UTC instant on a whole hour. */
const UtcHour = UtcInstant.check(Schema.makeFilter((s) => Date.parse(s) % hour === 0));

const maxTextLength = 512;

/** Text the server can store and index: no NUL characters and at most 512 code points. */
const Text = Schema.String.check(
  Schema.makeFilter((s) => !s.includes("\0") && Array.from(s).length <= maxTextLength, {
    expected: `text without NUL characters, at most ${maxTextLength} characters`,
  }),
);

const NonEmptyText = Text.check(Schema.isMinLength(1));

// Provider data may contain anything; keep it storable rather than failing the sync.
// Truncating by code point never splits a surrogate pair.
function storable(text: string): string {
  return Array.from(text.replaceAll("\0", "\uFFFD")).slice(0, maxTextLength).join("");
}

/** A truncated SHA-256 of provider and session; never a raw session ID or file path. */
const SessionKey = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/));

/** One installation. The ID is random and stable; the label is editable and only for display. */
export const SyncMachine = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  label: NonEmptyText,
});

/** The installation producing a payload. */
export interface SyncMachine extends Schema.Schema.Type<typeof SyncMachine> {}

/** The uploading installation and CLI version. */
export const SyncClient = Schema.Struct({
  machine: SyncMachine,
  version: NonEmptyText,
});

/** Payload inputs supplied by the uploading application rather than read from histories. */
export interface SyncClient extends Schema.Schema.Type<typeof SyncClient> {}

const Cost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** One session's usage of one model during one UTC hour. Null cost means some records are unpriced. */
export const SyncBucket = Schema.Struct({
  hourStart: UtcHour,
  sessionKey: SessionKey,
  project: NonEmptyText,
  provider: Provider,
  model: Text,
  tokens: Tokens,
  records: Schema.Int.check(Schema.isGreaterThan(0)),
  estimatedCostUsd: Schema.NullOr(Cost),
  unpricedRecords: Schema.Natural,
}).check(
  Schema.makeFilter(
    (bucket) =>
      bucket.unpricedRecords <= bucket.records &&
      (bucket.estimatedCostUsd === null) === bucket.unpricedRecords > 0,
  ),
);

/** Aggregated usage; the key is `(hourStart, sessionKey, project, provider, model)`. */
export interface SyncBucket extends Schema.Schema.Type<typeof SyncBucket> {}

/**
 * One provider's coverage across its sources, without source paths or diagnostics. The server
 * replaces the provider's stored buckets only when its status is `ok` or `partial`.
 */
export const SyncCoverage = Schema.Struct({
  provider: Provider,
  status: Coverage.fields.status,
  files: Schema.Natural,
  unreadable: Schema.Natural,
  malformedLines: Schema.Natural,
  skippedRecords: Schema.Natural,
  duplicates: Schema.Natural,
}).check(
  Schema.makeFilter(
    (entry) => entry.unreadable === 0 || (entry.status !== "ok" && entry.status !== "partial"),
    { expected: "no unreadable history for coverage that authorizes replacement" },
  ),
);

/** Completeness evidence for one provider on one machine. */
export interface SyncCoverage extends Schema.Schema.Type<typeof SyncCoverage> {}

/** Providers whose stored buckets a payload replaces: those read without losing history. */
export function replacedProviders(coverage: readonly SyncCoverage[]): ReadonlySet<Provider> {
  return new Set(
    coverage.flatMap((entry) =>
      entry.status === "ok" || entry.status === "partial" ? [entry.provider] : [],
    ),
  );
}

/** A billing plan a provider reported during an hour, such as Codex's `plan_type`. */
export const ProviderHint = Schema.Struct({
  provider: Provider,
  hourStart: UtcHour,
  plan: NonEmptyText,
});

/** Evidence of subscription usage; declared subscriptions remain authoritative. */
export interface ProviderHint extends Schema.Schema.Type<typeof ProviderHint> {}

/**
 * Version 1 upload for `PUT /ai-usage/machines/{machineId}/usage`. For each provider whose
 * coverage is `ok` or `partial`, the server replaces the machine's stored buckets for that
 * provider with `hourStart` in the half-open `window`; other providers keep their stored data.
 * The window is on whole UTC hours, and every bucket and plan hint lies inside it and belongs
 * to a replaced provider. Buckets from different machines are summed. `timeZone` is for display
 * only; all instants are UTC.
 */
export const SyncPayload = Schema.Struct({
  version: Schema.Literal(1),
  machine: SyncMachine,
  clientVersion: NonEmptyText,
  timeZone: NonEmptyText,
  window: Schema.Struct({ start: UtcHour, end: UtcHour }).check(
    Schema.makeFilter((window) => window.start < window.end),
  ),
  currency: Schema.Literal("USD"),
  costBasis: Schema.Literal("api-equivalent"),
  pricing: Schema.Struct({
    status: PriceBook.fields.status,
    fetchedAt: Schema.NullOr(UtcInstant),
    source: Text,
  }),
  buckets: Schema.Array(SyncBucket),
  coverage: Schema.Array(SyncCoverage),
  providerHints: Schema.optionalKey(Schema.Array(ProviderHint)),
}).check(
  Schema.makeFilter(
    (payload) =>
      distinct(payload.buckets, (bucket) =>
        JSON.stringify([
          bucket.hourStart,
          bucket.sessionKey,
          bucket.project,
          bucket.provider,
          bucket.model,
        ]),
      ) &&
      distinct(payload.coverage, (entry) => entry.provider) &&
      distinct(payload.providerHints ?? [], (hint) =>
        JSON.stringify([hint.provider, hint.hourStart, hint.plan]),
      ),
    { expected: "unique bucket keys, coverage providers, and plan hints" },
  ),
  Schema.makeFilter((payload) => {
    const replaced = replacedProviders(payload.coverage);

    return [...payload.buckets, ...(payload.providerHints ?? [])].every(
      (entry) =>
        replaced.has(entry.provider) &&
        entry.hourStart >= payload.window.start &&
        entry.hourStart < payload.window.end,
    );
  }),
);

/** Aggregated, path-free usage for one machine; contains no prompts, responses, or requests. */
export interface SyncPayload extends Schema.Schema.Type<typeof SyncPayload> {}

function distinct<A>(items: readonly A[], key: (item: A) => string): boolean {
  return new Set(items.map(key)).size === items.length;
}

/** A plan hint from one provider's history, before hourly deduplication. */
export interface ObservedPlan {
  readonly provider: Provider;
  readonly timestamp: number;
  readonly plan: string;
}

/** Project name for usage whose only attribution is a local path or nothing. */
export const unattributed = "unattributed";

/** Widens a range outward to whole UTC hours, so every hourly bucket of its records lies inside. */
export function hourRange(range: InstantRange): InstantRange {
  return {
    start: Math.floor(range.start / hour) * hour,
    end: Math.ceil(range.end / hour) * hour,
  };
}

/** Stable across syncs; hashing keeps path-based session fallbacks on the machine. */
function sessionKey(provider: Provider, session: string): string {
  return createHash("sha256").update(`${provider}\0${session}`).digest("hex").slice(0, 32);
}

/**
 * Sums streamed records into hourly session buckets, keeping memory proportional to buckets
 * rather than records. `finish` returns them in a stable order.
 */
export function sessionBuckets(pricing: PriceBook) {
  const totals = new Map<
    string,
    {
      readonly record: UsageRecord;
      readonly project: string;
      readonly model: string;
      readonly hourStart: number;
      readonly usage: UsageTotals;
    }
  >();

  return {
    add(record: UsageRecord, name: string): void {
      const hourStart = Math.floor(record.timestamp / hour) * hour;
      const project = storable(name);
      const model = storable(record.model);
      const key = JSON.stringify([hourStart, record.provider, record.session, project, model]);

      const previous = totals.get(key);
      const cost = priceTokens(record.tokens, lookupPrice(pricing, record.model));

      totals.set(key, {
        record: previous?.record ?? record,
        project,
        model,
        hourStart,
        usage: addUsage(previous?.usage, record.tokens, cost),
      });
    },
    finish(): SyncBucket[] {
      return [...totals.values()]
        .map(({ record, project, model, hourStart, usage }): SyncBucket => ({
          hourStart: new Date(hourStart).toISOString(),
          sessionKey: sessionKey(record.provider, record.session),
          project,
          provider: record.provider,
          model,
          tokens: usage.tokens,
          records: usage.records,
          estimatedCostUsd: usage.estimatedCostUsd,
          unpricedRecords: usage.unpricedRecords,
        }))
        .toSorted(
          (a, b) =>
            a.hourStart.localeCompare(b.hourStart) ||
            a.provider.localeCompare(b.provider) ||
            a.sessionKey.localeCompare(b.sessionKey) ||
            a.project.localeCompare(b.project) ||
            a.model.localeCompare(b.model),
        );
    },
  };
}

/**
 * Merges per-source coverage by provider into what the server may replace. `ok` and `partial`
 * mean every existing file was read (`partial`: some lines or records were unusable). `failed`
 * means some existing history could not be read, and `missing` that none was found; the server
 * keeps its data for both. An absent source only matters when the provider has no other.
 */
export function providerCoverage(coverage: readonly Coverage[]): SyncCoverage[] {
  const providers = new Map<Provider, Coverage[]>();

  for (const source of coverage) {
    const sources = providers.get(source.provider) ?? [];
    sources.push(source);
    providers.set(source.provider, sources);
  }

  return [...providers]
    .map(([provider, sources]) => {
      const present = sources.filter((source) => source.status !== "missing");

      const status =
        present.length === 0
          ? "missing"
          : present.some((source) => source.status === "failed" || source.unreadable > 0)
            ? "failed"
            : present.every((source) => source.status === "ok")
              ? "ok"
              : "partial";

      const sum = (count: (source: Coverage) => number) =>
        sources.reduce((total, source) => total + count(source), 0);

      return {
        provider,
        status,
        files: sum((source) => source.files),
        unreadable: sum((source) => source.unreadable),
        malformedLines: sum((source) => source.malformedLines),
        skippedRecords: sum((source) => source.skippedRecords),
        duplicates: sum((source) => source.duplicates),
      } satisfies SyncCoverage;
    })
    .toSorted((a, b) => a.provider.localeCompare(b.provider));
}

/** Collects each plan a provider reported during each UTC hour once; `finish` sorts them. */
export function planHints() {
  const hints = new Map<string, ProviderHint>();

  return {
    add({ provider, timestamp, plan: reported }: ObservedPlan): void {
      const hourStart = new Date(Math.floor(timestamp / hour) * hour).toISOString();
      const plan = storable(reported);
      hints.set(JSON.stringify([hourStart, provider, plan]), { provider, hourStart, plan });
    },
    finish(): ProviderHint[] {
      return [...hints.values()].toSorted(
        (a, b) =>
          a.hourStart.localeCompare(b.hourStart) ||
          a.provider.localeCompare(b.provider) ||
          a.plan.localeCompare(b.plan),
      );
    },
  };
}
