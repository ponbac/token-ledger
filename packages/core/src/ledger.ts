import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Match,
  Option,
  Path,
  type PlatformError,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";

import { dayWindow } from "./calendar.ts";
import {
  type Coverage,
  type Day,
  ReportRequest,
  UsageReport,
  totalTokens,
  type ReportRow,
  type Source,
  type UsageRecord,
} from "./model.ts";
import { addUsage, lookupPrice, priceTokens } from "./pricing.ts";
import { type Attribution, projectResolver } from "./projects.ts";
import { claudeParser } from "./providers/claude.ts";
import { codexParser } from "./providers/codex.ts";
import { copilotDatabaseLines, type CopilotDatabaseError } from "./providers/copilot-db.ts";
import { copilotParser } from "./providers/copilot.ts";
import { grokParser } from "./providers/grok.ts";
import { piParser } from "./providers/pi.ts";
import type { ParseResult } from "./providers/shared.ts";
import {
  type ObservedPlan,
  SyncClient,
  SyncPayload,
  hourRange,
  planHints,
  providerCoverage,
  replacedProviders,
  sessionBuckets,
  unattributed,
} from "./sync.ts";

/**
 * Transcripts are append-only, so a file holds no event later than its last write, and one last
 * modified before the window is not opened, as in T3 Code. The slack is T3 Code's: it absorbs
 * clocks and file systems that disagree with event timestamps, and exceeds the widest gap
 * between two time zones.
 */
const modifiedSlack = 36 * 60 * 60 * 1000;

/**
 * No coding agent recorded usage before this, so an earlier timestamp is a damaged record. A
 * history without a lower bound would otherwise open its window on such a record, decades or
 * millennia back.
 */
const historyFloor = Date.UTC(2020, 0, 1);

/** Invalid report windows or paths, with no provider payloads in the error. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String,
}) {}

/** A sync payload reaching back to the first usage found, and the local day it starts on. */
export interface HistoryPayload {
  readonly payload: SyncPayload;
  readonly since: Day;
}

/** Produces complete or explicitly partial reports, hiding scanning and provider-specific accounting. */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly report: (request: ReportRequest) => Effect.Effect<UsageReport, InvalidRequest>;
    /** Hourly session buckets for upload; local paths and raw session IDs never enter the payload. */
    readonly syncPayload: (
      request: ReportRequest,
      client: SyncClient,
    ) => Effect.Effect<SyncPayload, InvalidRequest>;
    /**
     * As `syncPayload`, with the window begun early enough to hold all usage found before
     * `since` as well. `since` in the result is the local day the window then starts on. Meant
     * for a machine's first upload: the server replaces the whole window, so sending it again
     * after a provider has pruned its history would replace stored usage with less.
     */
    readonly historyPayload: (
      request: ReportRequest,
      client: SyncClient,
    ) => Effect.Effect<HistoryPayload, InvalidRequest>;
  }
>()("token-ledger/Ledger") {
  /** Filesystem implementation. All mutable aggregation and deduplication state belongs to a single call. */
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const decode = Effect.fn("Ledger.decode")(function* (input: ReportRequest) {
        const request = yield* Schema.decodeUnknownEffect(ReportRequest)(input).pipe(
          Effect.mapError(
            () =>
              new InvalidRequest({
                message:
                  "Expected an ordered inclusive day window, a named time zone, and valid sources, mappings, and prices.",
              }),
          ),
        );

        if (
          request.sources.some((source) => !path.isAbsolute(source.path)) ||
          request.projects.some((mapping) =>
            mapping.paths.some((prefix) => !path.isAbsolute(prefix)),
          )
        ) {
          return yield* new InvalidRequest({
            message: "Source and project mapping paths must be absolute.",
          });
        }

        return request;
      });

      /**
       * Streams each deduplicated, non-empty record that `locate` places, with its project, and
       * each plan hint it places. Records outside the window are neither deduplicated nor attributed.
       * `locate` places nothing before `start`, so files settled before it are counted unopened.
       */
      const scan = Effect.fn("Ledger.scan")(function* <Slot>(
        request: ReportRequest,
        start: number,
        locate: (timestamp: number) => Slot | undefined,
        collect: (record: UsageRecord, attribution: Attribution, slot: Slot) => void,
        notice?: (plan: ObservedPlan) => void,
      ) {
        const resolveProject = yield* projectResolver(request.projects).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );

        const seen = new Set<string>();
        const visitedFiles = new Set<string>();
        // Counted without being opened; a later source naming one of these files still reads it.
        const settledFiles = new Set<string>();
        // Built once every source is read, when its duplicate count is final.
        const coverage: Array<() => Coverage> = [];
        // A fork's copies wait for every source, so whichever file holds the original wins.
        const inherited: Array<Effect.Effect<void>> = [];

        for (const source of request.sources) {
          let files = 0;
          let filesBeforeWindow = 0;
          let malformedLines = 0;
          let skippedRecords = 0;
          let duplicates = 0;
          let failedFiles = 0;
          let missingRoot = false;
          const warnings = new Set<string>();

          const copilot = source.provider === "copilot" ? copilotParser(source.path) : undefined;

          const place = Effect.fn("Ledger.placeRecord")(function* (
            record: UsageRecord,
            slot: Slot,
          ) {
            const id = `${record.provider}:${record.id}`;

            if (seen.has(id)) {
              duplicates++;

              return;
            }

            seen.add(id);
            collect(record, yield* resolveProject(record, source.project), slot);
          });

          const accept = Effect.fn("Ledger.acceptRecords")(function* (result: ParseResult) {
            malformedLines += result.malformed;
            skippedRecords += result.skipped;

            for (const warning of result.warnings) warnings.add(warning);

            for (const hint of result.hints) {
              if (locate(hint.timestamp) !== undefined)
                notice?.({ provider: source.provider, ...hint });
            }

            for (const record of result.records) {
              const slot = locate(record.timestamp);

              if (slot !== undefined && totalTokens(record.tokens) > 0) yield* place(record, slot);
            }

            for (const record of result.inherited) {
              const slot = locate(record.timestamp);

              if (slot !== undefined && totalTokens(record.tokens) > 0)
                inherited.push(place(record, slot));
            }
          });

          const scanFile = Effect.fn("Ledger.scanFile")(function* (
            file: string,
            info: FileSystem.File.Info,
          ) {
            const canonical = yield* fs.realPath(file);
            const identity = `${source.provider}:${canonical}`;
            const settled = settledBefore(source, file, info, start - modifiedSlack);

            if (visitedFiles.has(identity) || (settled && settledFiles.has(identity))) {
              warnings.add(
                "An overlapping source was counted once; the first source's project override wins.",
              );

              return;
            }

            if (settled) {
              settledFiles.add(identity);
              filesBeforeWindow++;

              return;
            }

            visitedFiles.add(identity);

            const parser = Match.value(source.provider).pipe(
              Match.when("codex", () => codexParser(canonical)),
              Match.when("claude", () => claudeParser(canonical)),
              Match.when("grok", () => grokParser(canonical)),
              Match.when("copilot", () => copilot ?? copilotParser(canonical)),
              Match.when("pi", () => piParser(canonical)),
              Match.exhaustive,
            );

            let lineNumber = 0;
            files++;

            const lines: Stream.Stream<string, PlatformError.PlatformError | CopilotDatabaseError> =
              source.provider === "copilot" && canonical.endsWith(".db")
                ? Stream.fromIterableEffect(copilotDatabaseLines(canonical))
                : fs.stream(canonical).pipe(Stream.decodeText, Stream.splitLines);

            yield* lines.pipe(
              Stream.runForEach(
                Effect.fn("Ledger.line")(function* (line) {
                  lineNumber++;

                  if (!line.trim()) return;
                  yield* accept(parser.parse(line, lineNumber));
                }),
              ),
            );

            if (copilot === undefined && parser.finish !== undefined)
              yield* accept(parser.finish());
          });

          const pending = [source.path];
          const visitedDirectories = new Set<string>();

          while (pending.length) {
            const entry = pending.pop();

            if (entry === undefined) break;

            const result = yield* Effect.gen(function* () {
              const stat = yield* fs.stat(entry);

              if (stat.type === "Directory") {
                const canonical = yield* fs.realPath(entry);

                if (visitedDirectories.has(canonical)) return;
                visitedDirectories.add(canonical);
                const children = yield* fs.readDirectory(entry);

                for (const child of children.toSorted().toReversed())
                  pending.push(path.join(entry, child));
              } else if (stat.type === "File" && acceptsFile(source, entry)) {
                yield* scanFile(entry, stat);
              }
            }).pipe(Effect.result);

            if (Result.isFailure(result)) {
              if (
                entry === source.path &&
                Predicate.isTagged(result.failure, "PlatformError") &&
                Predicate.isTagged(result.failure.reason, "NotFound")
              )
                missingRoot = true;
              failedFiles++;
              warnings.add("A source path could not be read; totals may be incomplete.");
            }
          }

          if (copilot?.finish !== undefined) yield* accept(copilot.finish());

          const status = missingRoot
            ? "missing"
            : failedFiles > 0 && files === 0
              ? "failed"
              : failedFiles > 0 || malformedLines > 0 || skippedRecords > 0
                ? "partial"
                : "ok";

          coverage.push(() => ({
            provider: source.provider,
            source: source.path,
            status,
            files,
            filesBeforeWindow,
            unreadable: missingRoot ? 0 : failedFiles,
            malformedLines,
            skippedRecords,
            duplicates,
            warnings: [...warnings],
          }));
        }

        for (const copy of inherited) yield* copy;

        return coverage.map((summarize) => summarize());
      });

      const report = Effect.fn("Ledger.report")(function* (input: ReportRequest) {
        const request = yield* decode(input);
        const window = dayWindow(request.since, request.until, request.timeZone);
        const rows = new Map<string, ReportRow>();

        const coverage = yield* scan(
          request,
          window.start,
          window.dayOf,
          (record, { project }, day) => {
            const key = JSON.stringify([project, day, record.provider, record.model]);
            const price = lookupPrice(request.pricing, record.model);

            rows.set(key, {
              project,
              day,
              provider: record.provider,
              model: record.model,
              pricePerMillion: price ?? null,
              ...addUsage(rows.get(key), record.tokens, priceTokens(record.tokens, price)),
            });
          },
        );

        return UsageReport.make({
          version: 2,
          since: request.since,
          until: request.until,
          timeZone: request.timeZone.id,
          currency: "USD",
          costBasis: "api-equivalent",
          pricing: {
            status: request.pricing.status,
            fetchedAt: request.pricing.fetchedAt,
            source: request.pricing.source,
          },
          rows: [...rows.values()].toSorted(
            (a, b) =>
              a.project.localeCompare(b.project) ||
              a.day.localeCompare(b.day) ||
              a.provider.localeCompare(b.provider) ||
              a.model.localeCompare(b.model),
          ),
          coverage,
        });
      });

      const payloadFrom = Effect.fn("Ledger.payloadFrom")(function* (
        input: ReportRequest,
        clientInput: SyncClient,
        history: boolean,
      ) {
        const request = yield* decode(input);

        const client = yield* Schema.decodeUnknownEffect(SyncClient)(clientInput).pipe(
          Effect.mapError(
            () =>
              new InvalidRequest({
                message: "Expected a machine UUID and label and a client version.",
              }),
          ),
        );

        // Local midnights are not whole UTC hours in every zone; widen so hours are never split.
        const requested = hourRange(dayWindow(request.since, request.until, request.timeZone));
        // A history opens every file however old, and its window is settled afterwards.
        const from = history ? Math.min(historyFloor, requested.start) : requested.start;
        const buckets = sessionBuckets(request.pricing);
        const hints = planHints();
        let earliest = requested.start;

        const coverage = yield* scan(
          request,
          from,
          (timestamp) => (timestamp >= from && timestamp < requested.end ? timestamp : undefined),
          (record, attribution, timestamp) => {
            earliest = Math.min(earliest, timestamp);
            buckets.add(record, attribution.shareable ? attribution.project : unattributed);
          },
          (plan) => {
            earliest = Math.min(earliest, plan.timestamp);
            hints.add(plan);
          },
        );

        const since =
          earliest < requested.start
            ? DateTime.formatIsoDate(
                DateTime.setZone(DateTime.makeUnsafe(earliest), request.timeZone),
              )
            : request.since;

        const window =
          since === request.since
            ? requested
            : hourRange(dayWindow(since, request.until, request.timeZone));

        const summary = providerCoverage(coverage);
        const replaced = replacedProviders(summary);

        const payload = yield* SyncPayload.makeEffect({
          version: 1,
          machine: client.machine,
          clientVersion: client.version,
          timeZone: request.timeZone.id,
          window: {
            start: new Date(window.start).toISOString(),
            end: new Date(window.end).toISOString(),
          },
          currency: "USD",
          costBasis: "api-equivalent",
          pricing: {
            status: request.pricing.status,
            fetchedAt: request.pricing.fetchedAt,
            source: request.pricing.source,
          },
          // Unread history must not replace stored usage with less; drop those providers.
          buckets: buckets.finish().filter((bucket) => replaced.has(bucket.provider)),
          coverage: summary,
          providerHints: hints.finish().filter((hint) => replaced.has(hint.provider)),
        }).pipe(
          Effect.mapError(
            () =>
              new InvalidRequest({
                message: "Report data must satisfy the sync payload contract.",
              }),
          ),
        );

        return { payload, since };
      });

      return Ledger.of({
        report,
        syncPayload: (request, client) =>
          Effect.map(payloadFrom(request, client, false), ({ payload }) => payload),
        historyPayload: (request, client) => payloadFrom(request, client, true),
      });
    }),
  );
}

function acceptsFile(source: Source, file: string): boolean {
  if (source.path === file) return true;

  if (source.provider === "grok")
    return file.endsWith("/updates.jsonl") || file.endsWith("\\updates.jsonl");

  return file.endsWith(".jsonl") || (source.provider === "copilot" && file.endsWith(".db"));
}

/**
 * Whether a file found under a source directory was last modified before `cutoff`, and so holds
 * no later usage. A file named as the source itself is always read. So is every Copilot file: a
 * request takes its repository and cache details from spans in other files, and a live SQLite
 * database keeps new rows in its write-ahead log without touching its own modification time.
 */
function settledBefore(
  source: Source,
  file: string,
  info: FileSystem.File.Info,
  cutoff: number,
): boolean {
  if (source.path === file || source.provider === "copilot") return false;

  return Option.isSome(info.mtime) && info.mtime.value.getTime() < cutoff;
}
