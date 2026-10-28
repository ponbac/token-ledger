import type { InstantRange } from "@token-ledger/core/calendar";
import type { InvalidRequest, RepriceScan } from "@token-ledger/core/ledger";
import { type PricingBasis, Provider } from "@token-ledger/core/model";
import { RepricePayload, type SyncPayload, repriceChunks } from "@token-ledger/core/sync";
import { Data, DateTime, Effect, type Redacted, Result, Schema } from "effect";

import { type CompletedReprice, loadRepricing, saveRepricing } from "./settings.ts";
import { type RepricingStatus, reprice, repricingStatus } from "./upload.ts";

const hour = 3_600_000;

const isProvider = Schema.is(Provider);

/**
 * What a sync does about one provider's stored usage that an older pricing basis priced:
 * `Reprice` sends its buckets in `range`, and `Skip` leaves what a finished reprice covered.
 * `from` is the hour the server named.
 */
export type RepriceStep = Data.TaggedEnum<{
  Reprice: {
    readonly provider: Provider;
    readonly from: number;
    readonly range: InstantRange;
    readonly staleBuckets: number;
  };
  Skip: { readonly provider: Provider; readonly from: number; readonly staleBuckets: number };
}>;

export const RepriceStep = Data.taggedEnum<RepriceStep>();

/** What `repricePlan` weighs besides the server's answer. */
export interface RepriceScope {
  /** The start of the window the sync just stored on the current basis. */
  readonly windowStart: number;
  /** The providers the sync covered, after `--provider`. */
  readonly providers: ReadonlySet<Provider>;
  /** The server's origin, which keys finished reprices. */
  readonly server: string;
  readonly basis: PricingBasis;
  readonly completed: ReadonlyArray<CompletedReprice>;
}

/**
 * The steps for the providers that need one: those the sync covered whose stale usage starts
 * before its window. The window's own hours were just stored on the current basis. A step's
 * range starts at the server's `from`, never before its floor, on a whole hour. Providers the
 * server names but this client does not know, the sync left out, or with nothing stale before
 * the window get no step. A reprice finished from the same `from` on the same basis skips the
 * provider only while its window reached this one's start: then everything from `from` up to
 * this window was sent on this basis, so the stale buckets left are ones this machine cannot
 * reproduce. An earlier sync whose window ended before this one starts left hours between them
 * that it never sent.
 */
export function repricePlan(status: RepricingStatus, scope: RepriceScope): RepriceStep[] {
  const floor = DateTime.toEpochMillis(status.floor);

  return status.providers.flatMap((entry): RepriceStep[] => {
    const provider = entry.provider;

    if (!isProvider(provider) || !scope.providers.has(provider) || entry.from === null) return [];

    const from = DateTime.toEpochMillis(entry.from);
    const start = Math.ceil(Math.max(from, floor) / hour) * hour;

    if (start >= scope.windowStart) return [];

    const finished = scope.completed.some(
      (completed) =>
        completed.server === scope.server &&
        completed.provider === provider &&
        completed.basis === scope.basis &&
        DateTime.toEpochMillis(completed.from) === from &&
        scope.windowStart <= DateTime.toEpochMillis(completed.coveredUntil),
    );

    const staleBuckets = entry.staleBuckets;

    return [
      finished
        ? RepriceStep.Skip({ provider, from, staleBuckets })
        : RepriceStep.Reprice({
            provider,
            from,
            range: { start, end: scope.windowStart },
            staleBuckets,
          }),
    ];
  });
}

/**
 * What happened to stored usage on an older pricing basis after a sync. `Repriced` counts are
 * the server's; `Failed` counts cover the requests it accepted before the failure.
 * `Unremembered`: finished reprices could not be saved.
 */
export type RepriceOutcome = Data.TaggedEnum<{
  Unanswered: { readonly message: string };
  Repriced: {
    readonly provider: Provider;
    readonly from: number;
    readonly staleBuckets: number;
    readonly sent: number;
    readonly updated: number;
    readonly unmatched: number;
    readonly beforeFloor: number;
  };
  Skipped: { readonly provider: Provider; readonly from: number; readonly staleBuckets: number };
  NoHistory: {
    readonly provider: Provider;
    readonly from: number;
    readonly staleBuckets: number;
  };
  Failed: {
    readonly provider: Provider;
    readonly from: number;
    readonly message: string;
    readonly updated: number;
    readonly unmatched: number;
  };
  Unremembered: { readonly message: string };
}>;

export const RepriceOutcome = Data.taggedEnum<RepriceOutcome>();

/** A sync that stored its window on a pricing basis, and how to rebuild older buckets. */
export interface RepriceRun {
  readonly server: URL;
  readonly token: Redacted.Redacted<string>;
  /** The payload the server stored. */
  readonly payload: SyncPayload;
  /** The providers the sync covered, after `--provider`. */
  readonly providers: ReadonlySet<Provider>;
  /** The settings directory, which keeps `repricing.json`. */
  readonly directory: string;
  /** One provider's buckets in a range of whole UTC hours, built as an upload builds them. */
  readonly scan: (
    provider: Provider,
    range: InstantRange,
  ) => Effect.Effect<RepriceScan, InvalidRequest>;
}

/** Sends one provider's buckets in its step's range, in requests the server accepts. */
const repriceProvider = Effect.fn("Sync.repriceProvider")(function* (
  run: RepriceRun,
  basis: PricingBasis,
  step: Data.TaggedEnum.Value<RepriceStep, "Reprice">,
) {
  const { provider, from, staleBuckets } = step;
  let updated = 0;
  let unmatched = 0;
  let beforeFloor = 0;

  const failed = (message: string) =>
    RepriceOutcome.Failed({ provider, from, message, updated, unmatched });

  const scanned = yield* run.scan(provider, step.range).pipe(Effect.result);

  if (Result.isFailure(scanned)) return failed(scanned.failure.message);

  const { buckets, coverage } = scanned.success;

  // Finished without it, the reprice would be remembered and skipped once the history can be
  // read; and without billing hints, Copilot's payers are unknown. It waits, as an upload does.
  if (coverage.status === "failed") return failed("Some of its history could not be read.");

  // No history is not pruned history: an unset variable or an unmounted directory must not be
  // remembered as a finished reprice.
  if (coverage.status === "missing")
    return RepriceOutcome.NoHistory({ provider, from, staleBuckets });

  const { status, fetchedAt, source } = run.payload.pricing;

  for (const chunk of repriceChunks(buckets)) {
    const payload = yield* RepricePayload.makeEffect({
      version: 1,
      clientVersion: run.payload.clientVersion,
      pricing: { status, fetchedAt, source, basis },
      buckets: chunk,
    }).pipe(Effect.result);

    if (Result.isFailure(payload))
      return failed("Its buckets do not satisfy the repricing contract.");

    const receipt = yield* reprice(
      run.server,
      run.token,
      run.payload.machine.id,
      payload.success,
    ).pipe(Effect.result);

    if (Result.isFailure(receipt)) return failed(receipt.failure.message);

    updated += receipt.success.updated;
    unmatched += receipt.success.unmatched;
    beforeFloor += receipt.success.beforeFloor;
  }

  return RepriceOutcome.Repriced({
    provider,
    from,
    staleBuckets,
    sent: buckets.length,
    updated,
    unmatched,
    beforeFloor,
  });
});

/**
 * After a sync stored its window, reprices the machine's older stored usage that another
 * pricing basis priced, one provider at a time, as `repricePlan` decides. A sync without a
 * basis claims none, so it reprices nothing and asks nothing. Never fails: every problem
 * becomes an outcome to report, and the next sync tries again.
 */
export const repriceStoredUsage = Effect.fn("Sync.repriceStoredUsage")(function* (run: RepriceRun) {
  const basis = run.payload.pricing.basis;

  if (basis === undefined) return [];

  const answer = yield* repricingStatus(run.server, run.token, run.payload.machine.id, basis).pipe(
    Effect.result,
  );

  if (Result.isFailure(answer))
    return [RepriceOutcome.Unanswered({ message: answer.failure.message })];

  const server = run.server.origin;
  const completed = yield* loadRepricing(run.directory);

  const steps = repricePlan(answer.success, {
    windowStart: Date.parse(run.payload.window.start),
    providers: run.providers,
    server,
    basis,
    completed,
  });

  const outcomes: RepriceOutcome[] = [];
  const finished: CompletedReprice[] = [];
  // The sync just stored its window on this basis, so a finished reprice covers up to its end.
  const coveredUntil = DateTime.makeUnsafe(run.payload.window.end);

  for (const step of steps) {
    const outcome = yield* RepriceStep.$match(step, {
      Skip: ({ provider, from, staleBuckets }) =>
        Effect.succeed(RepriceOutcome.Skipped({ provider, from, staleBuckets })),
      Reprice: (send) => repriceProvider(run, basis, send),
    });

    outcomes.push(outcome);

    if (RepriceOutcome.$is("Repriced")(outcome))
      finished.push({
        server,
        provider: outcome.provider,
        basis,
        from: DateTime.makeUnsafe(outcome.from),
        coveredUntil,
      });
  }

  if (finished.length === 0) return outcomes;

  const kept = completed.filter(
    (entry) =>
      !finished.some((done) => done.server === entry.server && done.provider === entry.provider),
  );

  const saved = yield* saveRepricing(run.directory, [...kept, ...finished]).pipe(Effect.result);

  if (Result.isFailure(saved))
    outcomes.push(RepriceOutcome.Unremembered({ message: saved.failure.message }));

  return outcomes;
});
