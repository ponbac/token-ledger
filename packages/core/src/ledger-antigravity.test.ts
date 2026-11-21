import { pathToFileURL } from "node:url";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, PlatformError, Schema } from "effect";

import { Ledger } from "./ledger.ts";
import { PriceBook, ReportRequest, type Source } from "./model.ts";
import {
  antigravityBlobChunkBytes,
  chunkedTempBlobReader,
  emptyAntigravityTrajectory,
  extractGenerationMetadata,
  extractStepMetadata,
  extractTrajectoryMetadata,
  readAntigravityDatabase,
  tempChunkSliceSql,
  tempChunkVarintSql,
  tempStageChunksSql,
} from "./providers/antigravity-db.ts";
import { SyncClient, providerCoverage } from "./sync.ts";

const decodeBlobRow = Schema.decodeUnknownSync(Schema.Struct({ chunk: Schema.Uint8Array }));

const utf8 = new TextEncoder();

function protoVarint(value: number): number[] {
  const out: number[] = [];
  let remaining = value;

  do {
    const byte = remaining % 128;
    remaining = Math.floor(remaining / 128);
    out.push(byte + (remaining > 0 ? 128 : 0));
  } while (remaining > 0);

  return out;
}

function protoFieldVarint(field: number, value: number): number[] {
  return [...protoVarint(field * 8), ...protoVarint(value)];
}

function protoFieldBytes(field: number, payload: readonly number[]): number[] {
  return [...protoVarint(field * 8 + 2), ...protoVarint(payload.length), ...payload];
}

function protoFieldText(field: number, value: string): number[] {
  return protoFieldBytes(field, [...utf8.encode(value)]);
}

function protoTimestamp(iso: string): number[] {
  const ms = Date.parse(iso);
  const seconds = Math.floor(ms / 1000);
  const nanos = (ms % 1000) * 1_000_000;

  return [...protoFieldVarint(1, seconds), ...(nanos > 0 ? protoFieldVarint(2, nanos) : [])];
}

function protoUsage(options: {
  readonly modelId?: number;
  readonly input?: number;
  readonly output?: number;
  readonly cacheWrite?: number;
  readonly cacheRead?: number;
  readonly reasoning?: number;
  readonly textOutput?: number;
  readonly responseId?: string;
  readonly requestId?: string;
  readonly traceId?: string;
}): number[] {
  return [
    ...(options.modelId !== undefined ? protoFieldVarint(1, options.modelId) : []),
    ...(options.input !== undefined ? protoFieldVarint(2, options.input) : []),
    ...(options.output !== undefined ? protoFieldVarint(3, options.output) : []),
    ...(options.cacheWrite !== undefined ? protoFieldVarint(4, options.cacheWrite) : []),
    ...(options.cacheRead !== undefined ? protoFieldVarint(5, options.cacheRead) : []),
    ...(options.responseId !== undefined ? protoFieldText(7, options.responseId) : []),
    ...(options.reasoning !== undefined ? protoFieldVarint(9, options.reasoning) : []),
    ...(options.textOutput !== undefined ? protoFieldVarint(10, options.textOutput) : []),
    ...(options.requestId !== undefined ? protoFieldText(11, options.requestId) : []),
    ...(options.traceId !== undefined ? protoFieldText(12, options.traceId) : []),
  ];
}

function protoGeneration(options: {
  readonly systemPrompt?: string;
  readonly messagePrompt?: string;
  readonly promptSection?: string;
  readonly modelId?: number;
  readonly slug?: string;
  readonly displayName?: string;
  readonly timestampIso?: string;
  readonly usage?: readonly number[];
  readonly retries?: ReadonlyArray<readonly number[]>;
}): Uint8Array {
  const inner = [
    ...(options.systemPrompt !== undefined ? protoFieldText(1, options.systemPrompt) : []),
    ...(options.messagePrompt !== undefined ? protoFieldText(2, options.messagePrompt) : []),
    ...(options.modelId !== undefined ? protoFieldVarint(3, options.modelId) : []),
    ...(options.usage !== undefined ? protoFieldBytes(4, options.usage) : []),
    ...(options.timestampIso !== undefined
      ? protoFieldBytes(9, protoFieldBytes(4, protoTimestamp(options.timestampIso)))
      : []),
    ...(options.promptSection !== undefined ? protoFieldText(16, options.promptSection) : []),
    ...(options.retries ?? []).flatMap((retry) =>
      protoFieldBytes(17, [
        ...protoFieldText(1, "RETRY_ERROR_SECRET"),
        ...protoFieldBytes(2, retry),
      ]),
    ),
    ...(options.slug !== undefined ? protoFieldText(19, options.slug) : []),
    ...(options.displayName !== undefined ? protoFieldText(21, options.displayName) : []),
  ];

  return new Uint8Array(protoFieldBytes(1, inner));
}

function protoStep(options: {
  readonly fallbackTimestampIso?: string;
  readonly primaryTimestampIso?: string;
  readonly usage?: readonly number[];
  readonly modelId?: number;
  readonly slug?: string;
  readonly displayName?: string;
  readonly retries?: ReadonlyArray<readonly number[]>;
  readonly secretField?: string;
}): Uint8Array {
  const modelInfo = [
    ...(options.modelId !== undefined ? protoFieldVarint(1, options.modelId) : []),
    ...(options.displayName !== undefined ? protoFieldText(8, options.displayName) : []),
    ...(options.slug !== undefined ? protoFieldText(12, options.slug) : []),
  ];

  return new Uint8Array([
    ...(options.fallbackTimestampIso !== undefined
      ? protoFieldBytes(1, protoTimestamp(options.fallbackTimestampIso))
      : []),
    ...(options.secretField !== undefined ? protoFieldText(5, options.secretField) : []),
    ...(options.primaryTimestampIso !== undefined
      ? protoFieldBytes(8, protoTimestamp(options.primaryTimestampIso))
      : []),
    ...(options.usage !== undefined ? protoFieldBytes(9, options.usage) : []),
    ...(modelInfo.length > 0 ? protoFieldBytes(24, modelInfo) : []),
    ...(options.retries ?? []).flatMap((retry) =>
      protoFieldBytes(28, [
        ...protoFieldText(1, "STEP_RETRY_SECRET"),
        ...protoFieldBytes(2, retry),
      ]),
    ),
  ]);
}

function protoTrajectory(options: {
  readonly workspaceUri?: string;
  readonly gitRootUri?: string;
  readonly repoName?: string;
  readonly remoteUrl?: string;
  readonly timestampIso?: string;
  readonly fallbackUri?: string;
  readonly secretField?: string;
}): Uint8Array {
  const repo = [
    ...(options.repoName !== undefined ? protoFieldText(1, options.repoName) : []),
    ...(options.remoteUrl !== undefined ? protoFieldText(2, options.remoteUrl) : []),
  ];

  const workspace = [
    ...(options.workspaceUri !== undefined ? protoFieldText(1, options.workspaceUri) : []),
    ...(options.gitRootUri !== undefined ? protoFieldText(2, options.gitRootUri) : []),
    ...(repo.length > 0 ? protoFieldBytes(3, repo) : []),
  ];

  return new Uint8Array([
    ...(workspace.length > 0 ? protoFieldBytes(1, workspace) : []),
    ...(options.timestampIso !== undefined
      ? protoFieldBytes(2, protoTimestamp(options.timestampIso))
      : []),
    ...(options.secretField !== undefined ? protoFieldText(4, options.secretField) : []),
    ...(options.fallbackUri !== undefined ? protoFieldText(7, options.fallbackUri) : []),
  ]);
}

const schema = `
  CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);
  CREATE TABLE trajectory_metadata_blob (data BLOB);
`;

const createDatabase = Effect.fn("Test.createAntigravityDb")(function* (
  file: string,
  seed: (db: {
    readonly exec: (sql: string) => void;
    readonly insertGen: (idx: number, blob: Uint8Array) => void;
    readonly insertStep: (idx: number, blob: Uint8Array | null) => void;
    readonly insertTrajectory: (blob: Uint8Array) => void;
  }) => void,
  options?: { readonly keepWal?: boolean },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));

  const db = new DatabaseSync(file);

  try {
    db.exec(schema);
    const gen = db.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
    const step = db.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)");
    const traj = db.prepare("INSERT INTO trajectory_metadata_blob (data) VALUES (?)");

    seed({
      exec: (sql) => db.exec(sql),
      insertGen: (idx, blob) => {
        gen.run(idx, blob);
      },
      insertStep: (idx, blob) => {
        step.run(idx, blob);
      },
      insertTrajectory: (blob) => {
        traj.run(blob);
      },
    });
  } finally {
    if (!options?.keepWal) db.close();
  }

  return db;
});

const priceBook = PriceBook.make({
  status: "fresh",
  fetchedAt: "2026-11-20T00:00:00.000Z",
  source: "synthetic",
  basis: "token-ledger-pricing@2;copilot-rates@2026-11-20;litellm@tiers",
  prices: {
    "gemini/gemini-4-neon": {
      input: 3,
      output: 15,
      cacheRead: 0.15,
      cacheWrite: null,
    },
    "gemini/gemini-4-carbon": {
      input: 2,
      output: 10,
      cacheRead: 0.1,
      cacheWrite: null,
    },
    "gemini/gemini-3.5-flash": {
      input: 1.5,
      output: 9,
      cacheRead: 0.15,
      cacheWrite: null,
    },
    "gemini/gemini-3-flash-preview": {
      input: 0.5,
      output: 3,
      cacheRead: 0.05,
      cacheWrite: null,
    },
  },
});

const utc = Schema.decodeSync(Schema.TimeZoneNamedFromString)("UTC");

const client = SyncClient.make({
  machine: {
    id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a",
    label: "test-machine",
  },
  version: "0.11.2",
});

function findRanges(haystack: Uint8Array, needle: Uint8Array): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];

  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;

    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }

    if (match) ranges.push([i, i + needle.length]);
  }

  return ranges;
}

describe("Antigravity SQLite bounded BLOB slicing", () => {
  it.effect("reads zero bytes of prompt sentinels or excluded fields from SQLite", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-slice-" });
      const file = path.join(root, "conv.db");

      const sysPrompt = "SYS_PROMPT_SENTINEL_11_DO_NOT_READ_BYTES";
      const msgPrompt = "MSG_PROMPT_SENTINEL_12_DO_NOT_READ_BYTES";
      const sectionPrompt = "SECTION_PROMPT_SENTINEL_116_DO_NOT_READ";
      const retrySecret = "RETRY_ERROR_SECRET";
      const stepSecret = "STEP_SECRET_SENTINEL_5_DO_NOT_READ_BYTES";
      const stepRetrySecret = "STEP_RETRY_SECRET";
      const trajSecret = "TRAJ_SECRET_SENTINEL_4_DO_NOT_READ_BYTES";

      const genBlob = protoGeneration({
        systemPrompt: sysPrompt,
        messagePrompt: msgPrompt,
        promptSection: sectionPrompt,
        modelId: 1532,
        slug: "gemini-4-neon",
        displayName: "Gemini 4 Neon (High)",
        timestampIso: "2026-11-20T10:15:00.000Z",
        usage: protoUsage({
          modelId: 1532,
          input: 100,
          cacheRead: 200,
          output: 50,
          requestId: "r1",
        }),
        retries: [protoUsage({ modelId: 1438, input: 10, output: 5, requestId: "r1-retry" })],
      });

      const stepBlob = protoStep({
        secretField: stepSecret,
        primaryTimestampIso: "2026-11-20T10:15:01.000Z",
        usage: protoUsage({
          modelId: 1532,
          input: 100,
          cacheRead: 200,
          output: 50,
          requestId: "r1",
        }),
        retries: [protoUsage({ modelId: 1438, input: 10, output: 5, requestId: "r1-retry" })],
      });

      const trajBlob = protoTrajectory({
        workspaceUri: "file:///work/project",
        remoteUrl: "https://github.com/example/neon-app.git",
        timestampIso: "2026-11-20T10:00:00.000Z",
        secretField: trajSecret,
      });

      yield* createDatabase(file, (db) => {
        db.insertGen(0, genBlob);
        db.insertStep(0, stepBlob);
        db.insertTrajectory(trajBlob);
      });

      const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
      const db = new DatabaseSync(file, { readOnly: true });
      db.exec(
        "PRAGMA temp_store = MEMORY; CREATE TEMP TABLE _ag_chunks (pos INTEGER PRIMARY KEY, b BLOB);",
      );

      const sliceStmt = db.prepare(tempChunkSliceSql);
      const varintStmt = db.prepare(tempChunkVarintSql);
      const clearStmt = db.prepare("DELETE FROM temp._ag_chunks");

      const verifyZeroOverlap = (
        table: "gen_metadata" | "steps" | "trajectory_metadata_blob",
        column: "data" | "metadata",
        rowId: number,
        fullBlob: Uint8Array,
        expectedSentinels: readonly string[],
        run: (reader: ReturnType<typeof chunkedTempBlobReader>) => void,
      ) => {
        const excludedRanges = expectedSentinels.flatMap((text) => {
          const ranges = findRanges(fullBlob, utf8.encode(text));
          assert.isAbove(ranges.length, 0, `sentinel ${text} must exist in test fixture`);

          return ranges;
        });

        const readRanges: Array<readonly [number, number]> = [];
        const stageStmt = db.prepare(tempStageChunksSql(table, column));
        stageStmt.run(rowId);

        try {
          const reader = chunkedTempBlobReader(
            fullBlob.byteLength,
            (chunkPos, sqlOffset, length) => {
              const chunk = decodeBlobRow(sliceStmt.get(chunkPos, sqlOffset, length)).chunk;
              const start = chunkPos + sqlOffset - 1;
              readRanges.push([start, start + chunk.byteLength]);

              return chunk;
            },
            (chunkPos, sqlOffset, maxLength) => {
              const chunk = decodeBlobRow(varintStmt.get(chunkPos, sqlOffset, maxLength)).chunk;
              const start = chunkPos + sqlOffset - 1;
              readRanges.push([start, start + chunk.byteLength]);

              return chunk;
            },
          );

          run(reader);
        } finally {
          clearStmt.run();
        }

        assert.isAbove(readRanges.length, 0);

        for (const [readStart, readEnd] of readRanges) {
          for (const [exStart, exEnd] of excludedRanges) {
            assert.isFalse(
              readStart < exEnd && exStart < readEnd,
              `SQLite read [${readStart}, ${readEnd}) overlapped excluded payload [${exStart}, ${exEnd}) in ${table}.${column}`,
            );
          }
        }
      };

      try {
        verifyZeroOverlap(
          "gen_metadata",
          "data",
          0,
          genBlob,
          [sysPrompt, msgPrompt, sectionPrompt, retrySecret],
          (reader) => {
            const parsed = extractGenerationMetadata(0, reader);
            assert.strictEqual(parsed.explicitModelId, 1532);
            assert.strictEqual(parsed.retryUsageBytes.length, 1);
          },
        );

        verifyZeroOverlap(
          "steps",
          "metadata",
          0,
          stepBlob,
          [stepSecret, stepRetrySecret],
          (reader) => {
            const parsed = extractStepMetadata(0, reader);
            assert.isDefined(parsed.primaryUsageBytes);
            assert.strictEqual(parsed.retryUsageBytes.length, 1);
          },
        );

        verifyZeroOverlap(
          "trajectory_metadata_blob",
          "data",
          1,
          trajBlob,
          [trajSecret],
          (reader) => {
            const target = emptyAntigravityTrajectory();
            extractTrajectoryMetadata(reader, target);
            assert.strictEqual(target.remoteUrls.length, 1);
          },
        );
      } finally {
        db.close();
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Antigravity usage through the Ledger", () => {
  it.effect(
    "reads rowid 0 and multi-page tables, resolves retries and conflicts, prices aliases, and preserves attribution after worktree removal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ledger = yield* Ledger;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-ledger-" });
        const conversations = path.join(root, "conversations");

        // DB 1: single generation at rowid 0 with retry switching model (1532 -> 1438),
        // non-existent deleted worktree URI + recorded git remote URL, and privacy sentinel.
        const conv1 = "11111111-1111-4111-8111-111111111111";

        yield* createDatabase(path.join(conversations, `${conv1}.db`), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              workspaceUri: "file:///deleted/worktree/toki2",
              remoteUrl: "https://github.com/example/toki2.git",
              timestampIso: "2026-11-20T09:00:00.000Z",
            }),
          );
          db.insertGen(
            0,
            protoGeneration({
              systemPrompt: "PRIVATE_PROMPT_NEVER_LEAKS",
              modelId: 1532,
              slug: "gemini-4-neon",
              displayName: "Gemini 4 Neon (High)",
              timestampIso: "2026-11-20T09:10:00.000Z",
              usage: protoUsage({
                modelId: 1532,
                input: 1000,
                cacheRead: 2000,
                output: 500,
                reasoning: 300,
                textOutput: 200,
                requestId: "req-neon-1",
                responseId: "bot-neon-1",
              }),
              // Retry switched to model 1438 (Carbon); must not inherit Neon's name.
              retries: [
                protoUsage({
                  modelId: 1438,
                  input: 400,
                  output: 100,
                  requestId: "req-carbon-retry",
                }),
              ],
            }),
          );
          // Duplicate step observation with larger cached input count and no model info.
          db.insertStep(
            0,
            protoStep({
              primaryTimestampIso: "2026-11-20T09:10:01.000Z",
              usage: protoUsage({
                modelId: 1532,
                input: 1000,
                cacheRead: 2500,
                output: 500,
                requestId: "req-neon-1",
              }),
            }),
          );
        });

        // DB 2: step with concrete model name in field 24 and numeric ID ONLY in primary usage
        // (no explicit modelId in field 24.1), effort/display-name variant agreeing on the same
        // modelId without triggering false conflict suppression, non-concrete slug
        // `gemini-3-flash-agent` (unknown ID 9901) priced end-to-end as gemini-3.5-flash ($9/M
        // out), plus >64 rows exercising multi-page pagination and conflict suppression.
        const conv2 = "22222222-2222-4222-8222-222222222222";
        const scratchPath = path.join(root, "local-scratch");
        const scratchUri = pathToFileURL(scratchPath).href;

        yield* createDatabase(path.join(conversations, `${conv2}.db`), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              workspaceUri: scratchUri,
              timestampIso: "2026-11-20T10:00:00.000Z",
            }),
          );
          // Concrete name + ID only in primary usage teaches 9001 -> gemini-4-neon.
          db.insertStep(
            0,
            protoStep({
              primaryTimestampIso: "2026-11-20T10:01:00.000Z",
              slug: "gemini-4-neon",
              usage: protoUsage({
                modelId: 9001,
                input: 200,
                output: 50,
                requestId: "req-primary-id-infer",
              }),
            }),
          );
          // Effort display-name variant ("Gemini 4 Neon (High)" -> "gemini-4-neon-high") for the
          // same ID 9001 agrees with "gemini-4-neon" rather than triggering conflict suppression.
          db.insertStep(
            1,
            protoStep({
              primaryTimestampIso: "2026-11-20T10:01:30.000Z",
              displayName: "Gemini 4 Neon (High)",
              usage: protoUsage({
                modelId: 9001,
                input: 100,
                output: 25,
                requestId: "req-effort-variant",
              }),
            }),
          );
          // Non-concrete slug `gemini-3-flash-agent` with unknown ID must be preserved for pricing.
          db.insertGen(
            1,
            protoGeneration({
              modelId: 9901,
              slug: "gemini-3-flash-agent",
              timestampIso: "2026-11-20T10:02:00.000Z",
              usage: protoUsage({
                modelId: 9901,
                input: 0,
                output: 1_000_000,
                requestId: "req-flash-agent",
              }),
            }),
          );
          // Conflicting concrete names for static ID 1438: concrete observations keep their own
          // names, while unnamed records with ID 1438 suppress both learned and static names.
          db.insertGen(
            2,
            protoGeneration({
              modelId: 1438,
              slug: "gemini-4-carbon",
              timestampIso: "2026-11-20T10:03:00.000Z",
              usage: protoUsage({ modelId: 1438, input: 100, output: 10, requestId: "req-c1" }),
            }),
          );
          db.insertGen(
            3,
            protoGeneration({
              modelId: 1438,
              slug: "gemini-4-neon",
              timestampIso: "2026-11-20T10:04:00.000Z",
              usage: protoUsage({ modelId: 1438, input: 100, output: 10, requestId: "req-c2" }),
            }),
          );

          // Add 70 paged steps (indices 10..79) using learned ID 9001 without inline name.
          for (let idx = 10; idx < 80; idx++) {
            db.insertStep(
              idx,
              protoStep({
                primaryTimestampIso: "2026-11-20T10:05:00.000Z",
                usage: protoUsage({
                  modelId: 9001,
                  input: 10,
                  output: 5,
                  requestId: `req-page-${idx}`,
                }),
              }),
            );
          }
        });

        // Unrelated sibling files & directories must be ignored without inflating `files`.
        yield* fs.makeDirectory(path.join(root, "brain"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "brain", "ignored.db"), "not-sqlite");
        const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
        const summaryDb = new DatabaseSync(path.join(root, "conversation_summaries.db"));
        summaryDb.exec("CREATE TABLE conversation_summaries (conversation_id TEXT);");
        summaryDb.close();
        const extraDb = new DatabaseSync(path.join(conversations, "unrelated.db"));
        extraDb.exec("CREATE TABLE other (id INTEGER);");
        extraDb.close();

        const request = ReportRequest.make({
          since: "2026-11-20",
          until: "2026-11-20",
          timeZone: utc,
          sources: [{ provider: "antigravity", path: root }],
          projects: [],
          pricing: priceBook,
        });

        const report = yield* ledger.report(request);
        assert.strictEqual(report.coverage.length, 1);
        assert.strictEqual(report.coverage[0]?.status, "ok");
        assert.strictEqual(report.coverage[0]?.files, 2);
        assert.strictEqual(report.coverage[0]?.duplicates, 1);

        const byModel = new Map(report.rows.map((row) => [`${row.project}:${row.model}`, row]));

        // conv1 Neon request merged step's 2500 cacheRead and attributed to git remote.
        const neonRow = byModel.get("github.com/example/toki2:gemini-4-neon");
        assert.isDefined(neonRow);
        assert.deepStrictEqual(neonRow.tokens, {
          input: 1000,
          cacheRead: 2500,
          cacheWrite: 0,
          output: 500,
        });

        // conv1 retry had unnamed ID 1438, which conflicted in conv2 -> suppressed to antigravity-model-1438.
        const retryRow = byModel.get("github.com/example/toki2:antigravity-model-1438");
        assert.isDefined(retryRow);
        assert.strictEqual(retryRow.records, 1);
        assert.isNull(retryRow.estimatedCostUsd);

        // conv2 concrete observations for conflicting ID 1438 kept their own concrete names.
        assert.isDefined(byModel.get(`${scratchPath}:gemini-4-carbon`));

        // conv2 learned ID 9001 across 70 paged steps + primary-id-infer + conflicting concrete neon
        // (effort variant "gemini-4-neon-high" did not suppress 9001's learned base name).
        const scratchNeon = byModel.get(`${scratchPath}:gemini-4-neon`);
        assert.isDefined(scratchNeon);
        assert.strictEqual(scratchNeon.records, 72);
        assert.isDefined(byModel.get(`${scratchPath}:gemini-4-neon-high`));

        // Non-concrete slug `gemini-3-flash-agent` preserved and priced as gemini-3.5-flash ($9/M out).
        const flashAgentRow = byModel.get(`${scratchPath}:gemini-3-flash-agent`);
        assert.isDefined(flashAgentRow);
        assert.closeTo(flashAgentRow.estimatedCostUsd ?? -1, 9, 1e-12);

        // Sync payload privacy: no prompt text, raw conversation UUIDs, or local paths leak.
        const payload = yield* ledger.syncPayload(request, client);
        const serialized = JSON.stringify(payload);
        assert.notInclude(serialized, "PRIVATE_PROMPT_NEVER_LEAKS");
        assert.notInclude(serialized, conv1);
        assert.notInclude(serialized, conv2);
        assert.notInclude(serialized, scratchPath);
        assert.notInclude(serialized, "/deleted/worktree/toki2");
        assert.include(serialized, "github.com/example/toki2");
        assert.include(serialized, '"project":"unattributed"');
      }).pipe(Effect.provide(Ledger.layer), Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "merges cross-boundary wired and ID-less duplicates across roots identically in sync, history, reprice, and reversed root order",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ledger = yield* Ledger;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-boundary-" });
        const rootA = path.join(root, "root-a", "conversations");
        const rootB = path.join(root, "root-b", "conversations");

        // Same wired request appears in two different session UUIDs across roots, straddling
        // the 11:00 UTC boundary: rootA has only trajectory timestamp 10:59 (quality 1),
        // rootB has step timestamp 11:01 (quality 2).
        yield* createDatabase(path.join(rootA, "bbbbbbbb-0000-4000-8000-000000000002.db"), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              remoteUrl: "https://github.com/example/zeta.git",
              timestampIso: "2026-11-20T10:59:00.000Z",
            }),
          );
          db.insertStep(
            0,
            protoStep({
              usage: protoUsage({
                modelId: 1532,
                input: 100,
                output: 20,
                requestId: "req-boundary-wired",
              }),
            }),
          );
        });

        yield* createDatabase(path.join(rootB, "aaaaaaaa-0000-4000-8000-000000000001.db"), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              remoteUrl: "https://github.com/example/alpha.git",
              timestampIso: "2026-11-20T11:00:00.000Z",
            }),
          );
          db.insertGen(
            0,
            protoGeneration({
              modelId: 1532,
              slug: "gemini-4-neon",
              timestampIso: "2026-11-20T11:01:00.000Z",
              usage: protoUsage({
                modelId: 1532,
                input: 150,
                output: 30,
                requestId: "req-boundary-wired",
              }),
            }),
          );
        });

        // ID-less copy of the SAME conversation UUID across both roots straddling 11:00 UTC:
        // rootA has fallback trajectory timestamp 10:59 (quality 1), rootB has explicit 11:01 (quality 2).
        const idlessSession = "cccccccc-0000-4000-8000-000000000003";

        yield* createDatabase(path.join(rootA, `${idlessSession}.db`), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              remoteUrl: "https://github.com/example/shared.git",
              timestampIso: "2026-11-20T10:59:00.000Z",
            }),
          );
          db.insertGen(
            0,
            protoGeneration({
              modelId: 1438,
              slug: "gemini-4-carbon",
              usage: protoUsage({ modelId: 1438, input: 50, output: 10 }),
            }),
          );
        });

        yield* createDatabase(path.join(rootB, `${idlessSession}.db`), (db) => {
          db.insertTrajectory(
            protoTrajectory({
              remoteUrl: "https://github.com/example/shared.git",
              timestampIso: "2026-11-20T11:00:00.000Z",
            }),
          );
          db.insertGen(
            0,
            protoGeneration({
              modelId: 1438,
              slug: "gemini-4-carbon",
              timestampIso: "2026-11-20T11:01:00.000Z",
              usage: protoUsage({ modelId: 1438, input: 80, output: 15 }),
            }),
          );
        });

        const makeRequest = (roots: readonly string[]) =>
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: roots.map((dir): Source => ({ provider: "antigravity", path: dir })),
            projects: [],
            pricing: priceBook,
          });

        const forward = makeRequest([rootA, rootB]);
        const reversed = makeRequest([rootB, rootA]);

        const forwardSync = yield* ledger.syncPayload(forward, client);
        const reversedSync = yield* ledger.syncPayload(reversed, client);
        const forwardHistory = yield* ledger.historyPayload(forward, client);
        const forwardReport = yield* ledger.report(forward);
        const reversedReport = yield* ledger.report(reversed);

        // Full bucket keys and totals are identical regardless of root order.
        assert.deepStrictEqual(forwardSync.buckets, reversedSync.buckets);
        assert.deepStrictEqual(forwardHistory.payload.buckets, forwardSync.buckets);
        assert.deepStrictEqual(forwardReport.rows, reversedReport.rows);
        assert.strictEqual(forwardSync.buckets.length, 2);

        // Both requests merged to 11:00 UTC (never 10:00 UTC).
        for (const bucket of forwardSync.buckets)
          assert.strictEqual(bucket.hourStart, "2026-11-20T11:00:00.000Z");

        // Single-hour reprices for 10:00 and 11:00 match full sync in BOTH root orders.
        const hour10 = {
          start: Date.parse("2026-11-20T10:00:00.000Z"),
          end: Date.parse("2026-11-20T11:00:00.000Z"),
        };

        const hour11 = {
          start: Date.parse("2026-11-20T11:00:00.000Z"),
          end: Date.parse("2026-11-20T12:00:00.000Z"),
        };

        for (const req of [forward, reversed]) {
          const r10 = yield* ledger.repriceBuckets(req, "antigravity", hour10);
          const r11 = yield* ledger.repriceBuckets(req, "antigravity", hour11);
          assert.deepStrictEqual(r10.buckets, []);
          assert.deepStrictEqual(r11.buckets, forwardSync.buckets);
        }
      }).pipe(Effect.provide(Ledger.layer), Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads WAL writes, ignores unrelated DBs for missing status, and fails coverage on corrupt or unreadable roots",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ledger = yield* Ledger;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-coverage-" });

        // 1. Directory with only an unrelated DB -> `missing`, not `ok`.
        const emptyDir = path.join(root, "only-unrelated");
        yield* fs.makeDirectory(emptyDir, { recursive: true });
        const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"));
        const other = new DatabaseSync(path.join(emptyDir, "other.db"));
        other.exec("CREATE TABLE unrelated (id INTEGER);");
        other.close();

        const missingReport = yield* ledger.report(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [{ provider: "antigravity", path: emptyDir }],
            projects: [],
            pricing: priceBook,
          }),
        );

        assert.strictEqual(missingReport.coverage[0]?.status, "missing");
        assert.strictEqual(missingReport.coverage[0]?.files, 0);

        // 2. Active WAL-mode DB with uncheckpointed write is read cleanly.
        const walDir = path.join(root, "wal");
        const walFile = path.join(walDir, "wal-session.db");

        const openWalDb = yield* createDatabase(
          walFile,
          (db) => {
            db.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;");
            db.insertGen(
              0,
              protoGeneration({
                modelId: 1532,
                slug: "gemini-4-neon",
                timestampIso: "2026-11-20T12:00:00.000Z",
                usage: protoUsage({ modelId: 1532, input: 300, output: 100, requestId: "wal-req" }),
              }),
            );
          },
          { keepWal: true },
        );

        try {
          const walReport = yield* ledger.report(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [{ provider: "antigravity", path: walDir }],
              projects: [],
              pricing: priceBook,
            }),
          );

          assert.strictEqual(walReport.coverage[0]?.status, "ok");
          assert.strictEqual(walReport.rows.length, 1);
          assert.strictEqual(walReport.rows[0]?.tokens.input, 300);
        } finally {
          openWalDb.close();
        }

        // 3. Corrupt DB marks provider failed (`unreadable: 1`).
        const corruptDir = path.join(root, "corrupt");
        yield* fs.makeDirectory(corruptDir, { recursive: true });
        yield* fs.writeFileString(path.join(corruptDir, "bad.db"), "not-a-sqlite-db");

        const corruptReport = yield* ledger.report(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [{ provider: "antigravity", path: corruptDir }],
            projects: [],
            pricing: priceBook,
          }),
        );

        assert.strictEqual(corruptReport.coverage[0]?.status, "failed");
        assert.strictEqual(corruptReport.coverage[0]?.unreadable, 1);

        // 4. Explicitly named `conversation_summaries.db` is excluded (`missing`, not `failed`),
        // so a healthy companion source still yields `ok`.
        const summaryPath = path.join(emptyDir, "conversation_summaries.db");
        const summaryDb = new DatabaseSync(summaryPath);
        summaryDb.exec("CREATE TABLE summaries (id INTEGER PRIMARY KEY);");
        summaryDb.close();

        const explicitSummary = yield* ledger.report(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [
              {
                provider: "antigravity",
                path: summaryPath,
              },
              { provider: "antigravity", path: walDir },
            ],
            projects: [],
            pricing: priceBook,
          }),
        );

        assert.strictEqual(explicitSummary.coverage[0]?.status, "missing");
        assert.strictEqual(explicitSummary.coverage[0]?.unreadable, 0);
        assert.strictEqual(providerCoverage(explicitSummary.coverage)[0]?.status, "ok");

        // 5. Schema-mismatched `steps(id INTEGER)` and corrupt inner usage protobuf / invalid UTF-8
        // are isolated per file without crashing `Ledger.report`; healthy siblings still report.
        const faultDir = path.join(root, "fault-isolation");
        yield* fs.makeDirectory(faultDir, { recursive: true });

        yield* Effect.tryPromise(() => import("node:sqlite")).pipe(
          Effect.andThen(({ DatabaseSync }) =>
            Effect.sync(() => {
              const wrongSchema = new DatabaseSync(path.join(faultDir, "wrong-schema.db"));

              try {
                wrongSchema.exec(
                  "CREATE TABLE steps (id INTEGER PRIMARY KEY); INSERT INTO steps VALUES (1);",
                );
              } finally {
                wrongSchema.close();
              }

              const badInner = new DatabaseSync(path.join(faultDir, "bad-inner-usage.db"));

              try {
                badInner.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
                // Valid outer wire-2 field 9 (primary usage), truncated varint inside inner usage.
                badInner
                  .prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)")
                  .run(0, new Uint8Array(protoFieldBytes(9, [0x80])));
              } finally {
                badInner.close();
              }
            }),
          ),
        );

        const isolatedBad = yield* ledger.report(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [
              { provider: "antigravity", path: path.join(faultDir, "wrong-schema.db") },
              { provider: "antigravity", path: faultDir },
              { provider: "antigravity", path: walDir },
            ],
            projects: [],
            pricing: priceBook,
          }),
        );

        // `wrong-schema.db` lacks Antigravity columns -> unrecognized (`missing` in dir, `failed` if explicit).
        assert.strictEqual(isolatedBad.coverage[0]?.status, "failed");
        assert.strictEqual(isolatedBad.coverage[1]?.status, "failed");
        assert.strictEqual(isolatedBad.coverage[1]?.files, 0);
        assert.strictEqual(isolatedBad.coverage[1]?.unreadable, 1);
        // 6. Partially compatible schema (empty valid `gen_metadata` + drifted `steps(idx, metadata_v2)`),
        // truncated fallback timestamp, invalid secondary workspace UTF-8, and unrepresentable 2^53
        // token count all fail per-file (and refuse sync replacement) without crashing healthy siblings.
        const mixedSchemaDir = path.join(root, "mixed-schema");
        yield* fs.makeDirectory(mixedSchemaDir, { recursive: true });

        const badFallbackDir = path.join(root, "bad-fallback-ts");
        yield* fs.makeDirectory(badFallbackDir, { recursive: true });

        const badUtf8Dir = path.join(root, "bad-utf8");
        yield* fs.makeDirectory(badUtf8Dir, { recursive: true });

        const overflowDir = path.join(root, "overflow-tokens");
        yield* fs.makeDirectory(overflowDir, { recursive: true });

        yield* Effect.tryPromise(() => import("node:sqlite")).pipe(
          Effect.andThen(({ DatabaseSync }) =>
            Effect.sync(() => {
              const mixed = new DatabaseSync(path.join(mixedSchemaDir, "mixed.db"));

              try {
                mixed.exec(
                  "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);" +
                    "CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata_v2 BLOB);" +
                    "INSERT INTO steps (idx, metadata_v2) VALUES (0, X'0102');",
                );
              } finally {
                mixed.close();
              }

              const badFallback = new DatabaseSync(path.join(badFallbackDir, "fallback.db"));

              try {
                badFallback.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");

                // Valid primary timestamp (field 8) + truncated fallback timestamp (field 1).
                const bytes = new Uint8Array([
                  ...protoFieldBytes(1, [0x08, 0x80]),
                  ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:00:00.000Z")),
                  ...protoFieldBytes(
                    9,
                    protoUsage({ modelId: 1532, input: 10, requestId: "req-bad-fb" }),
                  ),
                ]);

                badFallback
                  .prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)")
                  .run(0, bytes);
              } finally {
                badFallback.close();
              }

              const badUtf8 = new DatabaseSync(path.join(badUtf8Dir, "utf8.db"));

              try {
                badUtf8.exec(
                  "CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);" +
                    "CREATE TABLE trajectory_metadata_blob (data BLOB);",
                );
                badUtf8.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)").run(
                  0,
                  protoStep({
                    modelId: 1532,
                    slug: "gemini-4-neon",
                    primaryTimestampIso: "2026-11-20T12:00:00.000Z",
                    usage: protoUsage({ modelId: 1532, input: 10, requestId: "req-bad-utf8" }),
                  }),
                );
                // Valid first workspace URI + invalid UTF-8 bytes in second workspace URI.
                const validUri = pathToFileURL(path.join(root, "ok-ws")).href;

                const traj = new Uint8Array(
                  protoFieldBytes(1, [
                    ...protoFieldText(1, validUri),
                    ...protoFieldBytes(1, [0xff, 0xfe]),
                  ]),
                );

                badUtf8.prepare("INSERT INTO trajectory_metadata_blob (data) VALUES (?)").run(traj);
              } finally {
                badUtf8.close();
              }

              const overflow = new DatabaseSync(path.join(overflowDir, "overflow.db"));

              try {
                overflow.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");
                // Input token count = 2^53 (exceeds Number.MAX_SAFE_INTEGER): 0x80 x7, 0x10.
                const bigVarint = [0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10];

                const usageWithOverflow = [
                  ...protoFieldVarint(1, 1532),
                  ...protoVarint(2 * 8),
                  ...bigVarint,
                  ...protoFieldText(11, "req-overflow"),
                ];

                const stepBytes = new Uint8Array([
                  ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:00:00.000Z")),
                  ...protoFieldBytes(9, usageWithOverflow),
                ]);

                overflow
                  .prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)")
                  .run(0, stepBytes);
              } finally {
                overflow.close();
              }
            }),
          ),
        );

        const mixedSync = yield* ledger.syncPayload(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [{ provider: "antigravity", path: mixedSchemaDir }],
            projects: [],
            pricing: priceBook,
          }),
          client,
        );

        assert.strictEqual(mixedSync.coverage[0]?.status, "failed");
        assert.strictEqual(mixedSync.coverage[0]?.files, 0);
        assert.strictEqual(mixedSync.coverage[0]?.unreadable, 1);
        assert.deepStrictEqual(mixedSync.buckets, []);

        for (const badDir of [badFallbackDir, badUtf8Dir, overflowDir]) {
          const checked = yield* ledger.report(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [
                { provider: "antigravity", path: badDir },
                { provider: "antigravity", path: walDir },
              ],
              projects: [],
              pricing: priceBook,
            }),
          );

          assert.strictEqual(checked.coverage[0]?.status, "failed");
          assert.strictEqual(checked.coverage[0]?.files, 0);
          assert.strictEqual(checked.coverage[0]?.unreadable, 1);
          assert.strictEqual(checked.coverage[1]?.status, "ok");
          assert.strictEqual(checked.rows[0]?.tokens.input, 300);
        }

        // 7. Sibling empty valid DB beside a drifted DB whose usage columns BOTH changed
        // (`gen_metadata.data_v2` + `steps.metadata_v2` + `trajectory_metadata_blob`) still fails
        // coverage at the sync boundary rather than authorizing empty replacement.
        const bothDriftedDir = path.join(root, "both-drifted");
        yield* fs.makeDirectory(bothDriftedDir, { recursive: true });

        yield* createDatabase(path.join(bothDriftedDir, "empty-valid.db"), () => {});

        const driftedDb = new DatabaseSync(path.join(bothDriftedDir, "drifted.db"));

        try {
          driftedDb.exec(
            "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data_v2 BLOB);" +
              "CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata_v2 BLOB);" +
              "CREATE TABLE trajectory_metadata_blob (data BLOB);" +
              "INSERT INTO steps (idx, metadata_v2) VALUES (0, X'0102');",
          );
        } finally {
          driftedDb.close();
        }

        const driftedSync = yield* ledger.syncPayload(
          ReportRequest.make({
            since: "2026-11-20",
            until: "2026-11-20",
            timeZone: utc,
            sources: [{ provider: "antigravity", path: bothDriftedDir }],
            projects: [],
            pricing: priceBook,
          }),
          client,
        );

        assert.strictEqual(driftedSync.coverage[0]?.status, "failed");
        assert.strictEqual(driftedSync.coverage[0]?.unreadable, 1);
        assert.deepStrictEqual(driftedSync.buckets, []);

        // 8. Invalid protobuf timestamp (`seconds = MAX_SAFE_INTEGER` or `nanos = 1e9`) and
        // derived output overflow (`MAX_SAFE_INTEGER` reasoning + 2 text) fail per-file so they
        // never drop usage or abort healthy siblings.
        const badTsDir = path.join(root, "bad-timestamp");
        yield* fs.makeDirectory(badTsDir, { recursive: true });

        const badDerivedDir = path.join(root, "bad-derived-output");
        yield* fs.makeDirectory(badDerivedDir, { recursive: true });

        const maxSafeVarint = protoVarint(Number.MAX_SAFE_INTEGER);

        const badTsDb = new DatabaseSync(path.join(badTsDir, "bad-ts.db"));

        try {
          badTsDb.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");

          const stepWithHugeTs = new Uint8Array([
            ...protoFieldBytes(8, [...protoVarint(1 * 8), ...maxSafeVarint]),
            ...protoFieldBytes(
              9,
              protoUsage({ modelId: 1532, input: 10, requestId: "req-huge-ts" }),
            ),
          ]);

          badTsDb.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)").run(0, stepWithHugeTs);
        } finally {
          badTsDb.close();
        }

        const badDerivedDb = new DatabaseSync(path.join(badDerivedDir, "bad-derived.db"));

        try {
          badDerivedDb.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");

          const usageWithOverflowSum = [
            ...protoFieldVarint(1, 1532),
            ...protoVarint(9 * 8),
            ...maxSafeVarint,
            ...protoFieldVarint(10, 2),
            ...protoFieldText(11, "req-overflow-sum"),
          ];

          const stepWithOverflowSum = new Uint8Array([
            ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:00:00.000Z")),
            ...protoFieldBytes(9, usageWithOverflowSum),
          ]);

          badDerivedDb
            .prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)")
            .run(0, stepWithOverflowSum);
        } finally {
          badDerivedDb.close();
        }

        for (const badDir of [badTsDir, badDerivedDir]) {
          const checkedSync = yield* ledger.syncPayload(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [{ provider: "antigravity", path: badDir }],
              projects: [],
              pricing: priceBook,
            }),
            client,
          );

          assert.strictEqual(checkedSync.coverage[0]?.status, "failed");
          assert.strictEqual(checkedSync.coverage[0]?.files, 0);
          assert.strictEqual(checkedSync.coverage[0]?.unreadable, 1);
          assert.deepStrictEqual(checkedSync.buckets, []);

          const withSibling = yield* ledger.report(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [
                { provider: "antigravity", path: badDir },
                { provider: "antigravity", path: walDir },
              ],
              projects: [],
              pricing: priceBook,
            }),
          );

          assert.strictEqual(withSibling.coverage[0]?.status, "failed");
          assert.strictEqual(withSibling.coverage[1]?.status, "ok");
          assert.strictEqual(withSibling.rows[0]?.tokens.input, 300);
        }

        // 9. Trajectory-only DB (`trajectory_metadata_blob` + renamed `steps_v2`), empty
        // `gen_metadata.data = X''`, incompatible wire type on field 2, and overlapping directory
        // + explicit unrecognized file in BOTH orders all refuse sync replacement.
        const trajOnlyDir = path.join(root, "traj-only");
        yield* fs.makeDirectory(trajOnlyDir, { recursive: true });

        const emptyGenDir = path.join(root, "empty-gen");
        yield* fs.makeDirectory(emptyGenDir, { recursive: true });

        const badWireDir = path.join(root, "bad-wire");
        yield* fs.makeDirectory(badWireDir, { recursive: true });

        const badFixedWireDir = path.join(root, "bad-fixed-wire");
        yield* fs.makeDirectory(badFixedWireDir, { recursive: true });

        const overlapDir = path.join(root, "overlap-unrecognized");
        yield* fs.makeDirectory(overlapDir, { recursive: true });
        yield* createDatabase(path.join(overlapDir, "empty-ok.db"), () => {});

        const trajOnlyDb = new DatabaseSync(path.join(trajOnlyDir, "traj-only.db"));

        try {
          trajOnlyDb.exec(
            "CREATE TABLE trajectory_metadata_blob (data BLOB);" +
              "CREATE TABLE steps_v2 (idx INTEGER PRIMARY KEY, metadata BLOB);" +
              "INSERT INTO steps_v2 (idx, metadata) VALUES (0, X'0102');",
          );
        } finally {
          trajOnlyDb.close();
        }

        const emptyGenDb = new DatabaseSync(path.join(emptyGenDir, "empty-gen.db"));

        try {
          emptyGenDb.exec(
            "CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);" +
              "INSERT INTO gen_metadata (idx, data) VALUES (0, X'');",
          );
        } finally {
          emptyGenDb.close();
        }

        const badWireDb = new DatabaseSync(path.join(badWireDir, "bad-wire.db"));

        try {
          badWireDb.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");

          // Encode usage field 2 (input tokens) as wire-2 string "100" instead of wire-0 varint.
          const badUsage = [
            ...protoFieldVarint(1, 1532),
            ...protoFieldText(2, "100"),
            ...protoFieldText(11, "req-bad-wire"),
          ];

          const badWireStep = new Uint8Array([
            ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:00:00.000Z")),
            ...protoFieldBytes(9, badUsage),
          ]);

          badWireDb.prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)").run(0, badWireStep);
        } finally {
          badWireDb.close();
        }

        const badFixedWireDb = new DatabaseSync(path.join(badFixedWireDir, "bad-fixed-wire.db"));

        try {
          badFixedWireDb.exec("CREATE TABLE steps (idx INTEGER PRIMARY KEY, metadata BLOB);");

          // Encode usage field 2 (input tokens) as wire-5 fixed32 instead of wire-0 varint.
          const badFixedUsage = [
            ...protoFieldVarint(1, 1532),
            ...protoVarint(2 * 8 + 5),
            100,
            0,
            0,
            0,
            ...protoFieldText(11, "req-bad-fixed-wire"),
          ];

          const badFixedStep = new Uint8Array([
            ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:00:00.000Z")),
            ...protoFieldBytes(9, badFixedUsage),
          ]);

          badFixedWireDb
            .prepare("INSERT INTO steps (idx, metadata) VALUES (?, ?)")
            .run(0, badFixedStep);
        } finally {
          badFixedWireDb.close();
        }

        const overlapBadFile = path.join(overlapDir, "unrelated.db");
        const overlapBadDb = new DatabaseSync(overlapBadFile);

        try {
          overlapBadDb.exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY);");
        } finally {
          overlapBadDb.close();
        }

        for (const badDir of [trajOnlyDir, emptyGenDir, badWireDir, badFixedWireDir]) {
          const checkedSync = yield* ledger.syncPayload(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [{ provider: "antigravity", path: badDir }],
              projects: [],
              pricing: priceBook,
            }),
            client,
          );

          assert.strictEqual(checkedSync.coverage[0]?.status, "failed");
          assert.strictEqual(checkedSync.coverage[0]?.files, 0);
          assert.strictEqual(checkedSync.coverage[0]?.unreadable, 1);
          assert.deepStrictEqual(checkedSync.buckets, []);
        }

        // Overlapping directory + explicit unrecognized file fails in BOTH source orders.
        for (const sources of [
          [
            { provider: "antigravity", path: overlapDir },
            { provider: "antigravity", path: overlapBadFile },
          ] as const,
          [
            { provider: "antigravity", path: overlapBadFile },
            { provider: "antigravity", path: overlapDir },
          ] as const,
        ]) {
          const overlapSync = yield* ledger.syncPayload(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources,
              projects: [],
              pricing: priceBook,
            }),
            client,
          );

          assert.strictEqual(overlapSync.coverage[0]?.status, "failed");
          assert.strictEqual(overlapSync.coverage[0]?.unreadable, 1);
          assert.deepStrictEqual(overlapSync.buckets, []);
        }

        // 10. Message-heavy 4 MiB row (512 x 8 KiB skipped prompt messages) PLUS exact 64 KiB
        // chunk-boundary tests: a multibyte varint (modelId = 1532) placed right at offset 65535
        // and a retained leaf (slug "gemini-4-neon") straddling the next 64 KiB boundary.
        const largePath = path.join(root, "large-skipped.db");
        const chunk = antigravityBlobChunkBytes;
        const messageCount = 512;
        const messageSize = 8192;
        const singleMsgBody = new Uint8Array(messageSize);
        singleMsgBody.fill(0x50);
        const msgPrefix = [...protoVarint(2 * 8 + 2), ...protoVarint(messageSize)];
        const msgStride = msgPrefix.length + messageSize;
        const messagesTotal = messageCount * msgStride;

        const tailUsage = protoUsage({
          modelId: 1532,
          input: 42,
          output: 11,
          requestId: "req-big",
        });

        const modelTag = protoVarint(3 * 8);
        const modelVal = protoVarint(1532);
        const slugText = "gemini-4-neon";
        const slugField = protoFieldText(19, slugText);
        const usageField = protoFieldBytes(4, tailUsage);

        // Compute outer header size (6 bytes for ~4.3 MiB inner payload).
        const outerTagLen = 1;
        const assumedOuterLenBytes = 4;
        const outerPrefixLen = outerTagLen + assumedOuterLenBytes;

        const makeExactPadField = (fieldNumber: number, totalBytes: number, fillByte: number) => {
          const tag = protoVarint(fieldNumber * 8 + 2);

          for (let lenBytes = 1; lenBytes <= 5; lenBytes++) {
            const payloadLen = totalBytes - tag.length - lenBytes;

            if (payloadLen >= 0 && protoVarint(payloadLen).length === lenBytes) {
              return [
                ...tag,
                ...protoVarint(payloadLen),
                ...Array.from({ length: payloadLen }, () => fillByte),
              ];
            }
          }

          throw new Error(`Cannot build exact padding field of ${totalBytes} bytes`);
        };

        // Pad with skipped field 16 so `modelVal` (2-byte varint [0xfc, 0x0b]) starts at chunk - 1
        // (offset 65535 modulo 65536), straddling the exact 64 KiB boundary.
        const afterMsgs = outerPrefixLen + messagesTotal;
        const targetVarintStart = Math.ceil((afterMsgs + 16) / chunk) * chunk - 1;

        const pad1Field = makeExactPadField(
          16,
          targetVarintStart - afterMsgs - modelTag.length,
          0x51,
        );

        assert.strictEqual(
          (afterMsgs + pad1Field.length + modelTag.length) % chunk,
          chunk - 1,
          "multibyte varint must start at offset chunk - 1",
        );

        // Pad a second time so `slugText` ("gemini-4-neon") straddles the NEXT 64 KiB boundary.
        const afterModel = afterMsgs + pad1Field.length + modelTag.length + modelVal.length;
        const nextBoundary = Math.ceil((afterModel + 16) / chunk) * chunk;
        const slugHeaderLen = 2 + 1;

        const pad2Field = makeExactPadField(
          16,
          nextBoundary - slugHeaderLen - 5 - afterModel,
          0x52,
        );

        assert.strictEqual(
          (afterModel + pad2Field.length + slugHeaderLen) % chunk,
          chunk - 5,
          "retained slug leaf must straddle the 64 KiB boundary",
        );

        const innerTail = [
          ...pad1Field,
          ...modelTag,
          ...modelVal,
          ...pad2Field,
          ...slugField,
          ...usageField,
        ];

        const innerLength = messagesTotal + innerTail.length;
        const outerHeader = [...protoVarint(1 * 8 + 2), ...protoVarint(innerLength)];
        assert.strictEqual(outerHeader.length, outerPrefixLen);

        const fullBlob = new Uint8Array(outerHeader.length + innerLength);
        fullBlob.set(outerHeader, 0);

        let writeCursor = outerHeader.length;

        for (let index = 0; index < messageCount; index++) {
          fullBlob.set(msgPrefix, writeCursor);
          fullBlob.set(singleMsgBody, writeCursor + msgPrefix.length);
          writeCursor += msgStride;
        }

        fullBlob.set(innerTail, writeCursor);

        const largeDb = new DatabaseSync(largePath);

        try {
          largeDb.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
          largeDb.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)").run(0, fullBlob);
        } finally {
          largeDb.close();
        }

        const readProcRchar = () =>
          fs.readFileString("/proc/self/io").pipe(
            Effect.map((content) => {
              const match = /rchar:\s*(\d+)/.exec(content);

              return match?.[1] === undefined ? null : Number(match[1]);
            }),
            Effect.orElseSucceed(() => null),
          );

        const beforeIo = yield* readProcRchar();
        const extractedLarge = yield* readAntigravityDatabase(largePath);
        const afterIo = yield* readProcRchar();

        assert.isNotNull(extractedLarge);
        assert.strictEqual(extractedLarge.generations.length, 1);
        assert.strictEqual(extractedLarge.generations[0]?.explicitModelId, 1532);
        assert.strictEqual(
          new TextDecoder().decode(extractedLarge.generations[0]?.slugBytes),
          slugText,
        );
        assert.isDefined(extractedLarge.generations[0]?.primaryUsageBytes);

        if (beforeIo !== null && afterIo !== null)
          assert.isBelow(afterIo - beforeIo, fullBlob.byteLength * 2.5);
      }).pipe(Effect.provide(Ledger.layer), Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "marks combined Antigravity coverage failed when a healthy root sits alongside an unreadable root",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-locked-" });
        const healthyDir = path.join(root, "healthy");
        const lockedDir = path.join(root, "locked");
        yield* fs.makeDirectory(healthyDir, { recursive: true });
        yield* fs.makeDirectory(lockedDir, { recursive: true });

        yield* createDatabase(
          path.join(healthyDir, "55555555-5555-4555-8555-555555555555.db"),
          (db) => {
            db.insertGen(
              0,
              protoGeneration({
                modelId: 1532,
                slug: "gemini-4-neon",
                timestampIso: "2026-11-20T12:00:00.000Z",
                usage: protoUsage({
                  modelId: 1532,
                  input: 300,
                  output: 100,
                  requestId: "healthy-req",
                }),
              }),
            );
          },
        );

        const deniedFs = FileSystem.make({
          ...fs,
          stat: (target) =>
            target === lockedDir || target.startsWith(`${lockedDir}/`)
              ? Effect.fail(
                  PlatformError.badArgument({
                    module: "FileSystem",
                    method: "stat",
                    description: `fixture: permission denied (${target})`,
                  }),
                )
              : fs.stat(target),
          readDirectory: (target, options) =>
            target === lockedDir || target.startsWith(`${lockedDir}/`)
              ? Effect.fail(
                  PlatformError.badArgument({
                    module: "FileSystem",
                    method: "readDirectory",
                    description: `fixture: permission denied (${target})`,
                  }),
                )
              : fs.readDirectory(target, options),
        });

        const mixedReport = yield* Effect.gen(function* () {
          const lockedLedger = yield* Ledger;

          return yield* lockedLedger.report(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources: [
                { provider: "antigravity", path: healthyDir },
                { provider: "antigravity", path: lockedDir },
              ],
              projects: [],
              pricing: priceBook,
            }),
          );
        }).pipe(
          Effect.provide(
            Ledger.layer.pipe(Layer.provide(Layer.succeed(FileSystem.FileSystem, deniedFs))),
          ),
        );

        const summary = providerCoverage(mixedReport.coverage);
        assert.strictEqual(summary.length, 1);
        assert.strictEqual(summary[0]?.status, "failed");
        assert.isAbove(summary[0]?.unreadable ?? 0, 0);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "merges ID-less and wired observations at the same position without merging distinct wire IDs, and keeps primary and retry slots disjoint",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const ledger = yield* Ledger;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-slots-" });
        const snapA = path.join(root, "snap-a");
        const snapB = path.join(root, "snap-b");
        yield* fs.makeDirectory(snapA, { recursive: true });
        yield* fs.makeDirectory(snapB, { recursive: true });

        const conv = "44444444-4444-4444-8444-444444444444";

        // Snapshot A:
        // - idx 0: ID-less primary usage (10 input tokens).
        // - idx 1: retry-only snapshot (no primary usage; retry 0 has 100 input tokens, no wire ID).
        // - idx 2: empty retry 0 + retry 1 (50 input tokens, no wire ID).
        // - idx 3: distinct wire ID "wire-alpha" (7 input tokens).
        yield* createDatabase(path.join(snapA, `${conv}.db`), (db) => {
          db.insertStep(
            0,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:00:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 10 }),
            }),
          );
          db.insertStep(
            1,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:01:00.000Z",
              retries: [protoUsage({ modelId: 1532, input: 100 })],
            }),
          );
          db.insertStep(
            2,
            new Uint8Array([
              ...protoFieldBytes(8, protoTimestamp("2026-11-20T12:02:00.000Z")),
              ...protoFieldBytes(24, [
                ...protoFieldVarint(1, 1532),
                ...protoFieldText(12, "gemini-4-neon"),
              ]),
              ...protoFieldBytes(28, []),
              ...protoFieldBytes(28, protoFieldBytes(2, protoUsage({ modelId: 1532, input: 50 }))),
            ]),
          );
          db.insertStep(
            3,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:03:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 7, requestId: "wire-alpha" }),
            }),
          );
        });

        // Snapshot B:
        // - idx 0: same primary usage, now carrying wire ID "wire-0" (must merge -> 10, not 20).
        // - idx 1: fuller snapshot with primary (1 token) + retry 0 (100 tokens) (must yield 101 across 2 records, not 200).
        // - idx 2: retry 0 now populated (20 tokens) + retry 1 (50 tokens) (must yield 70 across 2 records, not 100).
        // - idx 3: distinct wire ID "wire-beta" at the same position (must stay separate -> 7 + 8 = 15 across 2 records).
        yield* createDatabase(path.join(snapB, `${conv}.db`), (db) => {
          db.insertStep(
            0,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:00:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 10, requestId: "wire-0" }),
            }),
          );
          db.insertStep(
            1,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:01:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 1 }),
              retries: [protoUsage({ modelId: 1532, input: 100 })],
            }),
          );
          db.insertStep(
            2,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:02:00.000Z",
              retries: [
                protoUsage({ modelId: 1532, input: 20 }),
                protoUsage({ modelId: 1532, input: 50 }),
              ],
            }),
          );
          db.insertStep(
            3,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T12:03:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 8, requestId: "wire-beta" }),
            }),
          );
        });

        const run = (sources: readonly Source[]) =>
          ledger.report(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources,
              projects: [],
              pricing: priceBook,
            }),
          );

        const forward = yield* run([
          { provider: "antigravity", path: snapA },
          { provider: "antigravity", path: snapB },
        ]);

        const reversed = yield* run([
          { provider: "antigravity", path: snapB },
          { provider: "antigravity", path: snapA },
        ]);

        // Expected total: 10 (idx 0) + 1 + 100 (idx 1) + 20 + 50 (idx 2) + 7 + 8 (idx 3) = 196 across 7 records.
        assert.strictEqual(forward.rows[0]?.records, 7);
        assert.strictEqual(forward.rows[0]?.tokens.input, 196);
        assert.deepStrictEqual(reversed.rows, forward.rows);

        // Primary step timestamp (11:01) always beats fallback step timestamp (10:59) across backups.
        const tsBackup = path.join(root, "ts-backup");
        const tsCurrent = path.join(root, "ts-current");
        yield* fs.makeDirectory(tsBackup, { recursive: true });
        yield* fs.makeDirectory(tsCurrent, { recursive: true });

        const tsConv = "66666666-6666-4666-8666-666666666666";

        yield* createDatabase(path.join(tsBackup, `${tsConv}.db`), (db) => {
          db.insertStep(
            0,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              fallbackTimestampIso: "2026-11-20T10:59:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 15, requestId: "req-ts-priority" }),
            }),
          );
        });

        yield* createDatabase(path.join(tsCurrent, `${tsConv}.db`), (db) => {
          db.insertStep(
            0,
            protoStep({
              modelId: 1532,
              slug: "gemini-4-neon",
              primaryTimestampIso: "2026-11-20T11:01:00.000Z",
              usage: protoUsage({ modelId: 1532, input: 15, requestId: "req-ts-priority" }),
            }),
          );
        });

        for (const sources of [
          [
            { provider: "antigravity", path: tsBackup },
            { provider: "antigravity", path: tsCurrent },
          ] as const,
          [
            { provider: "antigravity", path: tsCurrent },
            { provider: "antigravity", path: tsBackup },
          ] as const,
        ]) {
          const synced = yield* ledger.syncPayload(
            ReportRequest.make({
              since: "2026-11-20",
              until: "2026-11-20",
              timeZone: utc,
              sources,
              projects: [],
              pricing: priceBook,
            }),
            client,
          );

          assert.strictEqual(synced.buckets.length, 1);
          assert.strictEqual(synced.buckets[0]?.hourStart, "2026-11-20T11:00:00.000Z");
        }
      }).pipe(Effect.provide(Ledger.layer), Effect.provide(NodeServices.layer)),
  );
});
