import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
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

/** Invalid report windows or paths, with no provider payloads in the error. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String,
}) {}

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
       */
      const scan = Effect.fn("Ledger.scan")(function* <Slot>(
        request: ReportRequest,
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
        const coverage: Coverage[] = [];

        for (const source of request.sources) {
          let files = 0;
          let malformedLines = 0;
          let skippedRecords = 0;
          let duplicates = 0;
          let failedFiles = 0;
          let missingRoot = false;
          const warnings = new Set<string>();

          const copilot = source.provider === "copilot" ? copilotParser(source.path) : undefined;

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

              if (slot === undefined || totalTokens(record.tokens) === 0) continue;
              const id = `${record.provider}:${record.id}`;

              if (seen.has(id)) {
                duplicates++;
                continue;
              }

              seen.add(id);
              collect(record, yield* resolveProject(record, source.project), slot);
            }
          });

          const scanFile = Effect.fn("Ledger.scanFile")(function* (file: string) {
            const canonical = yield* fs.realPath(file);
            const identity = `${source.provider}:${canonical}`;

            if (visitedFiles.has(identity)) {
              warnings.add(
                "An overlapping source was counted once; the first source's project override wins.",
              );

              return;
            }

            visitedFiles.add(identity);

            const parser = Match.value(source.provider).pipe(
              Match.when("codex", () => codexParser(canonical)),
              Match.when("claude", () => claudeParser(canonical)),
              Match.when("grok", () => grokParser(canonical)),
              Match.when("copilot", () => copilot ?? copilotParser(canonical)),
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
                yield* scanFile(entry);
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

          coverage.push({
            provider: source.provider,
            source: source.path,
            status,
            files,
            unreadable: missingRoot ? 0 : failedFiles,
            malformedLines,
            skippedRecords,
            duplicates,
            warnings: [...warnings],
          });
        }

        return coverage;
      });

      const report = Effect.fn("Ledger.report")(function* (input: ReportRequest) {
        const request = yield* decode(input);
        const window = dayWindow(request.since, request.until, request.timeZone);
        const rows = new Map<string, ReportRow>();

        const coverage = yield* scan(request, window.dayOf, (record, { project }, day) => {
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
        });

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

      const syncPayload = Effect.fn("Ledger.syncPayload")(function* (
        input: ReportRequest,
        clientInput: SyncClient,
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
        const window = hourRange(dayWindow(request.since, request.until, request.timeZone));
        const buckets = sessionBuckets(request.pricing);
        const hints = planHints();

        const coverage = yield* scan(
          request,
          (timestamp) =>
            timestamp >= window.start && timestamp < window.end ? timestamp : undefined,
          (record, attribution) =>
            buckets.add(record, attribution.shareable ? attribution.project : unattributed),
          (plan) => hints.add(plan),
        );

        const summary = providerCoverage(coverage);
        const replaced = replacedProviders(summary);

        return yield* SyncPayload.makeEffect({
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
      });

      return Ledger.of({ report, syncPayload });
    }),
  );
}

function acceptsFile(source: Source, file: string): boolean {
  if (source.path === file) return true;

  if (source.provider === "grok")
    return file.endsWith("/updates.jsonl") || file.endsWith("\\updates.jsonl");

  return file.endsWith(".jsonl") || (source.provider === "copilot" && file.endsWith(".db"));
}
