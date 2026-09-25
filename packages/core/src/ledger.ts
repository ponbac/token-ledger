import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Match,
  Path,
  Predicate,
  Result,
  Schema,
  Stream,
} from "effect";

import {
  type Coverage,
  ReportRequest,
  UsageReport,
  addTokens,
  totalTokens,
  zeroTokens,
  type ReportRow,
  type Source,
} from "./model.ts";
import { lookupPrice, priceTokens } from "./pricing.ts";
import { projectResolver } from "./projects.ts";
import { claudeParser } from "./providers/claude.ts";
import { codexParser } from "./providers/codex.ts";
import { copilotParser } from "./providers/copilot.ts";
import { grokParser } from "./providers/grok.ts";
import type { ParseResult } from "./providers/shared.ts";

/** Invalid report windows or paths, with no provider payloads in the error. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  message: Schema.String,
}) {}

/** Produces complete or explicitly partial reports, hiding scanning and provider-specific accounting. */
export class Ledger extends Context.Service<
  Ledger,
  {
    readonly report: (request: ReportRequest) => Effect.Effect<UsageReport, InvalidRequest>;
  }
>()("token-ledger/Ledger") {
  /** Filesystem implementation. All mutable aggregation and deduplication state belongs to a single report. */
  static readonly layer = Layer.effect(
    Ledger,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const report = Effect.fn("Ledger.report")(function* (input: ReportRequest) {
        const request = yield* Schema.decodeUnknownEffect(ReportRequest)(input).pipe(
          Effect.mapError(
            () =>
              new InvalidRequest({
                message:
                  "Expected an ordered inclusive UTC day window and valid sources, mappings, and prices.",
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

        const resolveProject = yield* projectResolver(request.projects).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );

        const rows = new Map<string, ReportRow>();
        const seen = new Set<string>();
        const visitedFiles = new Set<string>();
        const coverage: Coverage[] = [];
        const since = Date.parse(`${request.since}T00:00:00Z`);
        const until = Date.parse(`${request.until}T00:00:00Z`) + 86_400_000;

        for (const source of request.sources) {
          let files = 0;
          let malformedLines = 0;
          let skippedRecords = 0;
          let duplicates = 0;
          let failedFiles = 0;
          let missingRoot = false;
          const warnings = new Set<string>();

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
              Match.when("copilot", () => copilotParser(canonical)),
              Match.exhaustive,
            );

            let lineNumber = 0;
            files++;

            const accept = Effect.fn("Ledger.acceptRecords")(function* (result: ParseResult) {
              malformedLines += result.malformed;
              skippedRecords += result.skipped;

              for (const warning of result.warnings) warnings.add(warning);

              for (const record of result.records) {
                if (
                  record.timestamp < since ||
                  record.timestamp >= until ||
                  totalTokens(record.tokens) === 0
                )
                  continue;
                const id = `${record.provider}:${record.id}`;

                if (seen.has(id)) {
                  duplicates++;
                  continue;
                }

                seen.add(id);
                const project = yield* resolveProject(record, source.project);
                const day = new Date(record.timestamp).toISOString().slice(0, 10);
                const key = JSON.stringify([project, day, record.provider, record.model]);
                const previous = rows.get(key);

                const price = lookupPrice(request.pricing, record.model);
                const cost = priceTokens(record.tokens, price);

                const unpricedRecords = (previous?.unpricedRecords ?? 0) + (cost === null ? 1 : 0);

                const pricedCostUsd = (previous?.pricedCostUsd ?? 0) + (cost ?? 0);
                rows.set(key, {
                  project,
                  day,
                  provider: record.provider,
                  model: record.model,
                  pricePerMillion: price ?? null,
                  tokens: addTokens(previous?.tokens ?? zeroTokens, record.tokens),
                  records: (previous?.records ?? 0) + 1,
                  estimatedCostUsd: unpricedRecords > 0 ? null : pricedCostUsd,
                  pricedCostUsd,
                  unpricedRecords,
                });
              }
            });

            yield* fs.stream(canonical).pipe(
              Stream.decodeText,
              Stream.splitLines,
              Stream.runForEach(
                Effect.fn("Ledger.line")(function* (line) {
                  lineNumber++;

                  if (!line.trim()) return;
                  yield* accept(parser.parse(line, lineNumber));
                }),
              ),
            );

            if (parser.finish !== undefined) yield* accept(parser.finish());
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
              if (entry === source.path && Predicate.isTagged(result.failure.reason, "NotFound"))
                missingRoot = true;
              failedFiles++;
              warnings.add("A source path could not be read; totals may be incomplete.");
            }
          }

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
            malformedLines,
            skippedRecords,
            duplicates,
            warnings: [...warnings],
          });
        }

        return UsageReport.make({
          version: 1,
          since: request.since,
          until: request.until,
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

      return Ledger.of({ report });
    }),
  );
}

function acceptsFile(source: Source, file: string): boolean {
  if (source.path === file) return true;

  if (source.provider === "grok")
    return file.endsWith("/updates.jsonl") || file.endsWith("\\updates.jsonl");

  return file.endsWith(".jsonl");
}
