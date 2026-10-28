import {
  Clock,
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

import { type InstantRange, dayWindow } from "./calendar.ts";
import { type ChatgptRequest, readBillingHints } from "./billing-hints.ts";
import {
  type Coverage,
  type Day,
  type PriceBook,
  type Provider,
  ReportRequest,
  UsageReport,
  totalTokens,
  type ReportRow,
  type Source,
  type UsageRecord,
} from "./model.ts";
import { addUsage, priceRecord } from "./pricing.ts";
import { type Attribution, projectResolver } from "./projects.ts";
import { claudeParser } from "./providers/claude.ts";
import { codexParser } from "./providers/codex.ts";
import { copilotDatabaseLines, type CopilotDatabaseError } from "./providers/copilot-db.ts";
import { copilotParser } from "./providers/copilot.ts";
import {
  copilotSessionParser,
  insideSession,
  isSessionEvents,
} from "./providers/copilot-session.ts";
import { grokParser } from "./providers/grok.ts";
import {
  type OpencodeDatabaseError,
  opencodeDatabaseLines,
  opencodeDatabaseName,
} from "./providers/opencode-db.ts";
import { type OpencodeFile, opencodeHistory } from "./providers/opencode.ts";
import { piParser } from "./providers/pi.ts";
import type { ParseResult } from "./providers/shared.ts";
import {
  type ObservedPlan,
  type SyncBucket,
  SyncClient,
  type SyncCoverage,
  SyncPayload,
  hourRange,
  payloadVersion,
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

/** Local diagnostics for the calling application; never part of the upload payload. */
type WarningSink = (message: string) => Effect.Effect<void>;

/** One provider's buckets for a reprice-only upload, and how completely its history was read. */
export interface RepriceScan {
  /** Empty unless `coverage` is `ok` or `partial`, as an upload would leave them out. */
  readonly buckets: readonly SyncBucket[];
  /** `missing` when no source names the provider. */
  readonly coverage: SyncCoverage;
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
      onWarning?: WarningSink,
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
      onWarning?: WarningSink,
    ) => Effect.Effect<HistoryPayload, InvalidRequest>;
    /**
     * One provider's hourly session buckets in `range`, half-open on whole UTC hours, built as
     * `syncPayload` builds an upload's: the same sources, project mappings, billing hints,
     * prices, and keys, so they match the buckets earlier syncs stored for those hours. Every
     * file that can hold usage from `range.start` on is opened, however long before the usual
     * window that is. Meant for reprice-only uploads of hours before a sync's window; plan
     * hints are not collected, and diagnostics are left to the sync that preceded it.
     */
    readonly repriceBuckets: (
      request: ReportRequest,
      provider: Provider,
      range: InstantRange,
    ) => Effect.Effect<RepriceScan, InvalidRequest>;
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
          (request.billingHints !== undefined &&
            !path.isAbsolute(request.billingHints.directory)) ||
          request.sources.some((source) => !path.isAbsolute(source.path)) ||
          request.projects.some((mapping) =>
            mapping.paths.some((prefix) => !path.isAbsolute(prefix)),
          )
        ) {
          return yield* new InvalidRequest({
            message: "Source, billing hint, and project mapping paths must be absolute.",
          });
        }

        return request;
      });

      /**
       * Streams each deduplicated, non-empty record that `locate` places, with its project, and
       * each plan hint it places. Records outside the window are neither deduplicated nor attributed.
       * `locate` places nothing outside `range`, so files settled before it are counted unopened,
       * and databases select only rows inside it.
       */
      const scan = Effect.fn("Ledger.scan")(function* <Slot>(
        request: ReportRequest,
        range: InstantRange,
        locate: (timestamp: number) => Slot | undefined,
        collect: (record: UsageRecord, attribution: Attribution, slot: Slot) => void,
        notice?: (plan: ObservedPlan) => void,
        onWarning?: WarningSink,
      ) {
        const hints = yield* (
          notice !== undefined &&
          request.billingHints !== undefined &&
          request.sources.some((source) => source.provider === "copilot")
            ? readBillingHints(request.billingHints).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              )
            : Effect.succeed(new Map<string, ChatgptRequest>())
        ).pipe(Effect.result);

        const chatgptRequests = Result.isSuccess(hints)
          ? hints.success
          : new Map<string, ChatgptRequest>();

        if (Result.isFailure(hints))
          yield* (
            onWarning?.(
              `Billing hints: ${hints.failure.message} Copilot will not be uploaded. Repair the hints and rerun sync with --since <first missed day>.`,
            ) ?? Effect.void
          );

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
        // Records only every source can classify as originals or copies; run before the copies.
        const deferred: Array<Effect.Effect<void>> = [];
        // OpenCode matches a fork's copies to originals in any of its databases and files.
        const opencode = opencodeHistory((value) => path.normalize(value));

        for (const source of request.sources) {
          let files = 0;
          let filesBeforeWindow = 0;
          let malformedLines = 0;
          let skippedRecords = 0;
          let duplicates = 0;
          let failedFiles = 0;
          let missingRoot = false;
          const warnings = new Set<string>();

          const copilot =
            source.provider === "copilot" ? copilotParser(source.path, chatgptRequests) : undefined;

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

            for (const id of result.excluded) seen.add(`${source.provider}:${id}`);

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
                inherited.push(Effect.suspend(() => place(opencode.settle(record), slot)));
            }

            for (const record of result.deferred) {
              const slot = locate(record.timestamp);

              if (slot !== undefined && totalTokens(record.tokens) > 0)
                deferred.push(
                  Effect.suspend(() => {
                    const classified = opencode.classify(record);

                    return classified.copy
                      ? Effect.sync(() => {
                          inherited.push(
                            Effect.suspend(() => place(opencode.settle(classified.record), slot)),
                          );
                        })
                      : place(classified.record, slot);
                  }),
                );
            }
          });

          const scanFile = Effect.fn("Ledger.scanFile")(function* (
            file: string,
            info: FileSystem.File.Info,
          ) {
            const canonical = yield* fs.realPath(file);
            const identity = `${source.provider}:${canonical}`;
            const settled = settledBefore(path, source, file, info, range.start - modifiedSlack);

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
              Match.when("copilot", () =>
                isSessionEvents(file)
                  ? copilotSessionParser(canonical, chatgptRequests)
                  : (copilot ?? copilotParser(canonical)),
              ),
              Match.when("pi", () => piParser(canonical)),
              Match.when("opencode", () => opencode.parser(opencodeFile(path, canonical))),
              Match.exhaustive,
            );

            let lineNumber = 0;
            files++;

            const lines: Stream.Stream<
              string,
              PlatformError.PlatformError | CopilotDatabaseError | OpencodeDatabaseError
            > =
              source.provider === "copilot" && canonical.endsWith(".db")
                ? Stream.fromIterableEffect(copilotDatabaseLines(canonical))
                : source.provider === "opencode"
                  ? opencodeFile(path, canonical) === "database"
                    ? Stream.fromIterableEffect(
                        opencodeDatabaseLines(canonical, range.start, range.end),
                      )
                    : // A legacy message or session file is one JSON document over several lines.
                      Stream.fromEffect(fs.readFileString(canonical))
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

            if (parser !== copilot && parser.finish !== undefined) yield* accept(parser.finish());
          });

          const pending = [source.path];
          const visitedDirectories = new Set<string>();

          while (pending.length) {
            const entry = pending.pop();

            if (entry === undefined) break;

            const result = yield* Effect.gen(function* () {
              const stat = yield* fs.stat(entry);

              if (stat.type === "Directory") {
                if (!descends(path, source, entry)) return;
                const canonical = yield* fs.realPath(entry);

                if (visitedDirectories.has(canonical)) return;
                visitedDirectories.add(canonical);
                const children = yield* fs.readDirectory(entry);

                for (const child of children.toSorted().toReversed())
                  pending.push(path.join(entry, child));
              } else if (stat.type === "File" && acceptsFile(path, source, entry)) {
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

          const hintsFailed = source.provider === "copilot" && Result.isFailure(hints);

          if (hintsFailed)
            warnings.add("Billing hints could not be read; stored Copilot usage will be kept.");

          // A directory holding no OpenCode history at all is not evidence of none.
          const unrecognised =
            source.provider === "opencode" &&
            !missingRoot &&
            failedFiles === 0 &&
            files === 0 &&
            filesBeforeWindow === 0;

          if (unrecognised)
            warnings.add("No OpenCode database or legacy message or session was found here.");

          const status = hintsFailed
            ? "failed"
            : missingRoot || unrecognised
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
            unreadable: (missingRoot ? 0 : failedFiles) + (hintsFailed ? 1 : 0),
            malformedLines,
            skippedRecords,
            duplicates,
            warnings: [...warnings],
          }));
        }

        for (const legacy of deferred) yield* legacy;

        for (const copy of inherited) yield* copy;

        return coverage.map((summarize) => summarize());
      });

      const report = Effect.fn("Ledger.report")(function* (input: ReportRequest) {
        const request = yield* decode(input);
        const window = dayWindow(request.since, request.until, request.timeZone);
        const rows = new Map<string, ReportRow>();

        // No billing hints are read here, so a Copilot request routed to a ChatGPT plan is
        // priced as Copilot-paid, with Copilot's rate card.
        const coverage = yield* scan(request, window, window.dayOf, (record, { project }, day) => {
          const key = JSON.stringify([project, day, record.provider, record.model]);
          const { usd, base } = priceRecord(record, request.pricing);

          rows.set(key, {
            project,
            day,
            provider: record.provider,
            model: record.model,
            pricePerMillion: base,
            ...addUsage(rows.get(key), record.tokens, usd),
          });
        });

        return UsageReport.make({
          version: 2,
          since: request.since,
          until: request.until,
          timeZone: request.timeZone.id,
          currency: "USD",
          costBasis: "api-equivalent",
          pricing: provenance(request.pricing),
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
        onWarning?: WarningSink,
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
        // Taken before reading, so the payload holds every record written before it. The server
        // refuses an upload whose snapshot is older than the last it applied from this machine.
        const snapshotAt = yield* Clock.currentTimeMillis;

        const coverage = yield* scan(
          request,
          { start: from, end: requested.end },
          (timestamp) => (timestamp >= from && timestamp < requested.end ? timestamp : undefined),
          (record, attribution, timestamp) => {
            earliest = Math.min(earliest, timestamp);
            buckets.add(record, uploadedProject(attribution));
          },
          (plan) => {
            earliest = Math.min(earliest, plan.timestamp);
            hints.add(plan);
          },
          onWarning,
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
        const uploadedBuckets = buckets.finish().filter((bucket) => replaced.has(bucket.provider));

        const payload = yield* SyncPayload.makeEffect({
          version: payloadVersion(uploadedBuckets),
          machine: client.machine,
          clientVersion: client.version,
          timeZone: request.timeZone.id,
          window: {
            start: new Date(window.start).toISOString(),
            end: new Date(window.end).toISOString(),
          },
          currency: "USD",
          costBasis: "api-equivalent",
          pricing: provenance(request.pricing),
          // Unread history must not replace stored usage with less; drop those providers.
          buckets: uploadedBuckets,
          coverage: summary,
          providerHints: hints.finish().filter((hint) => replaced.has(hint.provider)),
          snapshotAt: new Date(snapshotAt).toISOString(),
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

      const repriceBuckets = Effect.fn("Ledger.repriceBuckets")(function* (
        input: ReportRequest,
        provider: Provider,
        range: InstantRange,
      ) {
        const request = yield* decode(input);
        const hours = hourRange(range);

        if (hours.start !== range.start || hours.end !== range.end || range.start >= range.end)
          return yield* new InvalidRequest({ message: "Expected a range of whole UTC hours." });

        const buckets = sessionBuckets(request.pricing);

        const coverage = yield* scan(
          { ...request, sources: request.sources.filter((source) => source.provider === provider) },
          range,
          (timestamp) =>
            timestamp >= range.start && timestamp < range.end ? timestamp : undefined,
          (record, attribution) => buckets.add(record, uploadedProject(attribution)),
          // Plan hints are not repriced. Noticing them still makes the scan read billing hints,
          // as an upload's does, so each request keeps the payer its stored bucket has.
          () => undefined,
        );

        const summary = providerCoverage(coverage).find((entry) => entry.provider === provider) ?? {
          provider,
          status: "missing",
          files: 0,
          filesBeforeWindow: 0,
          unreadable: 0,
          malformedLines: 0,
          skippedRecords: 0,
          duplicates: 0,
        };

        return {
          buckets: replacedProviders([summary]).has(provider) ? buckets.finish() : [],
          coverage: summary,
        } satisfies RepriceScan;
      });

      return Ledger.of({
        report,
        syncPayload: (request, client, onWarning) =>
          Effect.map(payloadFrom(request, client, false, onWarning), ({ payload }) => payload),
        historyPayload: (request, client, onWarning) =>
          payloadFrom(request, client, true, onWarning),
        repriceBuckets,
      });
    }),
  );
}

/** The project an upload names: usage attributed only to a local path is `unattributed`. */
function uploadedProject(attribution: Attribution): string {
  return attribution.shareable ? attribution.project : unattributed;
}

/** A price book's provenance, without its rates, for reports and sync payloads. */
function provenance(pricing: PriceBook) {
  const { status, fetchedAt, source } = pricing;

  return pricing.basis === undefined
    ? { status, fetchedAt, source }
    : { status, fetchedAt, source, basis: pricing.basis };
}

function acceptsFile(path: Path.Path, source: Source, file: string): boolean {
  if (source.path === file) return true;

  if (source.provider === "grok")
    return file.endsWith("/updates.jsonl") || file.endsWith("\\updates.jsonl");

  if (source.provider === "opencode")
    return (
      opencodeFile(path, file) !== "database" || opencodeDatabaseName.test(path.basename(file))
    );

  // A session's folder holds its event log beside files the session wrote.
  if (source.provider === "copilot")
    return insideSession(file)
      ? isSessionEvents(file)
      : file.endsWith(".jsonl") || file.endsWith(".db");

  return file.endsWith(".jsonl");
}

/**
 * What an OpenCode file holds, by its name wherever it lies: `msg_*.json` is a legacy message,
 * `ses_*.json` a legacy session, and any other file a source names, such as an `OPENCODE_DB`
 * override with any extension, is opened as SQLite. A database is never read as text, and one
 * that cannot be opened is unreadable history. Under a source, other databases are read only
 * by OpenCode's own names.
 */
function opencodeFile(path: Path.Path, file: string): OpencodeFile {
  const name = path.basename(file);

  if (!name.endsWith(".json")) return "database";

  return name.startsWith("msg_") ? "message" : name.startsWith("ses_") ? "session" : "database";
}

/**
 * Directories beside OpenCode's history that never hold it: file snapshots, logs, cloned
 * repositories, and binaries, often gigabytes, and legacy parts, diffs, shares, and to-do lists,
 * some named after their session like its legacy session files.
 */
const opencodeElsewhere = new Set([
  "bin",
  "log",
  "part",
  "repos",
  "session_diff",
  "session_share",
  "share",
  "shell",
  "snapshot",
  "todo",
  "tool-output",
]);

/** Whether a directory under a source can hold its history. */
function descends(path: Path.Path, source: Source, directory: string): boolean {
  if (directory === source.path) return true;

  if (source.provider === "copilot") return !insideSession(directory);

  return source.provider !== "opencode" || !opencodeElsewhere.has(path.basename(directory));
}

/**
 * Whether a file found under a source directory was last modified before `cutoff`, and so holds
 * no later usage. A file named as the source itself is always read. So is every Copilot export: a
 * request takes its repository and cache details from spans in other files, and a live SQLite
 * database keeps new rows in its write-ahead log without touching its own modification time,
 * as OpenCode's databases do. A Copilot session's event log stands alone and is only appended
 * to, so it settles like any other. OpenCode's legacy session files are small and always read,
 * since a fork's copies are known by when their session began; its message files are rewritten
 * only while their request runs.
 */
function settledBefore(
  path: Path.Path,
  source: Source,
  file: string,
  info: FileSystem.File.Info,
  cutoff: number,
): boolean {
  if (
    source.path === file ||
    (source.provider === "copilot" && !isSessionEvents(file)) ||
    (source.provider === "opencode" && opencodeFile(path, file) !== "message")
  )
    return false;

  return Option.isSome(info.mtime) && info.mtime.value.getTime() < cutoff;
}
