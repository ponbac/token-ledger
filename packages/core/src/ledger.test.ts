import { DatabaseSync } from "node:sqlite";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path, Result, Schema } from "effect";

import { Ledger } from "./ledger.ts";
import { PriceBook, ReportRequest, UsageReport, totalTokens, type Source } from "./model.ts";

const runtime = Ledger.layer.pipe(Layer.provideMerge(NodeServices.layer));

const prices = PriceBook.make({
  status: "custom",
  fetchedAt: null,
  source: "test-fixture",
  prices: {
    "test-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 },
  },
});

const fixture = Effect.fn("Test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-test-" });

  const write = Effect.fn("Test.write")(function* (name: string, lines: readonly string[]) {
    const file = path.join(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, lines.join("\n") + "\n");

    return file;
  });

  return { fs, path, root, write };
});

function codexUsage(time: string, input = 100, output = 20, cumulative = 100) {
  return JSON.stringify({
    type: "event_msg",
    timestamp: `2026-09-22T${time}Z`,
    payload: {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: input, cached_input_tokens: 60, output_tokens: output },
        total_token_usage: { input_tokens: cumulative, output_tokens: output },
      },
    },
  });
}

function request(sources: readonly Source[]) {
  return ReportRequest.make({
    since: "2026-09-01",
    until: "2026-09-30",
    timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    sources,
    projects: [],
    pricing: prices,
  });
}

describe("Ledger reports through the public interface", () => {
  it.effect("attributes corrected VS Code spans across files before deduplicating logs", () =>
    Effect.gen(function* () {
      const { write, root } = yield* fixture();
      const endTime = [Date.parse("2026-09-22T10:00:00Z") / 1000, 0];

      const usage = {
        "gen_ai.operation.name": "chat",
        "gen_ai.response.id": "response-a",
        "gen_ai.response.model": "test-model",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
      };

      const event = {
        hrTime: endTime,
        spanContext: { traceId: "a", spanId: "chat" },
        attributes: { ...usage, "event.name": "gen_ai.client.inference.operation.details" },
      };

      const spans = [
        {
          traceId: "a",
          spanId: "chat",
          parentSpanContext: { traceId: "a", spanId: "middle" },
          endTime,
          attributes: { ...usage, "gen_ai.usage.cache_read.input_tokens": 60 },
        },
        {
          traceId: "a",
          spanId: "middle",
          parentSpanContext: { traceId: "a", spanId: "root" },
          endTime,
          attributes: {},
        },
        {
          traceId: "a",
          spanId: "root",
          endTime,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "github.copilot.git.repository": "acme/alpha",
          },
        },
        {
          traceId: "b",
          spanId: "root",
          endTime,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "github.copilot.git.repository": "acme/beta",
          },
        },
      ];

      yield* write("a-logs.jsonl", [
        JSON.stringify(event),
        JSON.stringify({
          ...event,
          spanContext: { traceId: "b", spanId: "root" },
          attributes: { ...event.attributes, "gen_ai.response.id": "response-b" },
        }),
        JSON.stringify({
          ...event,
          spanContext: undefined,
          attributes: { ...event.attributes, "gen_ai.response.id": "background" },
        }),
      ]);
      yield* write(
        "z-spans.jsonl",
        [
          ...spans,
          {
            traceId: "cycle",
            spanId: "chat",
            parentSpanContext: { traceId: "cycle", spanId: "chat" },
            endTime,
            attributes: { ...usage, "gen_ai.response.id": "cycle" },
          },
          {
            traceId: "other",
            spanId: "chat",
            parentSpanContext: { traceId: "a", spanId: "root" },
            endTime,
            attributes: { ...usage, "gen_ai.response.id": "invalid-parent" },
          },
        ].map((span) => JSON.stringify(span)),
      );
      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "copilot", path: root }]));
      assert.deepStrictEqual(
        report.rows.map((row) => [row.project, row.records, totalTokens(row.tokens)]),
        [
          ["acme/alpha", 1, 120],
          ["acme/beta", 1, 120],
          ["Unassigned", 3, 360],
        ],
      );
      assert.strictEqual(report.rows[0]?.tokens.cacheRead, 60);
      assert.strictEqual(report.coverage[0]?.duplicates, 1);
      assert.strictEqual(report.coverage[0]?.status, "ok");
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("reads a Copilot SQLite export with JSONL logs without changing the database", () =>
    Effect.gen(function* () {
      const { fs, write, root, path } = yield* fixture();
      const file = path.join(root, "agent-traces.db");
      const ms = Date.parse("2026-09-22T10:00:00Z");

      const attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.response.id": "db-response",
        "gen_ai.response.model": "test-model",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read.input_tokens": 60,
      };

      yield* Effect.gen(function* () {
        const db = yield* Effect.acquireRelease(
          Effect.sync(() => new DatabaseSync(file)),
          (connection) => Effect.sync(() => connection.close()),
        );

        yield* Effect.sync(() => {
          db.exec(`CREATE TABLE spans (span_id TEXT PRIMARY KEY, trace_id TEXT, parent_span_id TEXT, end_time_ms INTEGER);
            CREATE TABLE span_attributes (span_id TEXT, key TEXT, value TEXT);`);
          const span = db.prepare("INSERT INTO spans VALUES (?, ?, ?, ?)");
          const attribute = db.prepare("INSERT INTO span_attributes VALUES (?, ?, ?)");
          span.run("chat", "trace", "root", ms);
          span.run("root", "trace", null, ms + 10);

          for (const [key, value] of Object.entries(attributes))
            attribute.run("chat", key, String(value));
          attribute.run("root", "gen_ai.operation.name", "invoke_agent");
          attribute.run(
            "root",
            "github.copilot.git.repository",
            "https://github.com/acme/database.git",
          );
          attribute.run("chat", "unrelated.attribute", "not-accounting-data");
        });
      }).pipe(Effect.scoped);
      const before = yield* fs.readFile(file);
      yield* write("a-log.jsonl", [
        JSON.stringify({
          hrTime: [ms / 1000, 0],
          attributes: {
            ...attributes,
            "event.name": "gen_ai.client.inference.operation.details",
            "gen_ai.usage.cache_read.input_tokens": undefined,
          },
        }),
      ]);
      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "copilot", path: root }]));
      assert.lengthOf(report.rows, 1);
      assert.strictEqual(report.rows[0]?.project, "github.com/acme/database");
      assert.deepStrictEqual(report.rows[0]?.tokens, {
        input: 40,
        output: 20,
        cacheRead: 60,
        cacheWrite: 0,
      });
      assert.strictEqual(report.rows[0]?.records, 1);
      assert.strictEqual(report.coverage[0]?.duplicates, 1);
      assert.strictEqual(report.coverage[0]?.status, "ok");
      assert.deepStrictEqual(yield* fs.readFile(file), before);
      const broken = yield* write("broken.db", ["not a SQLite database"]);
      const failure = yield* ledger.report(request([{ provider: "copilot", path: broken }]));
      assert.strictEqual(failure.coverage[0]?.status, "partial");
      assert.lengthOf(failure.rows, 0);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("imports VS Code inference events once and diagnoses incomplete usage", () =>
    Effect.gen(function* () {
      const { write } = yield* fixture();

      const attributes = {
        "event.name": "gen_ai.client.inference.operation.details",
        "gen_ai.operation.name": "chat",
        "gen_ai.response.id": "response-a",
        "gen_ai.response.model": "test-model",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read.input_tokens": 60,
        "copilot_chat.repo.remote_url": "https://github.com/acme/example.git",
      };

      const event = {
        hrTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
        attributes,
      };

      const file = yield* write("vscode.jsonl", [
        JSON.stringify({ type: "span", name: "custom_notification", attributes: {} }),
        JSON.stringify({ resource: {}, scopeMetrics: [] }),
        JSON.stringify(event),
        JSON.stringify(event),
        JSON.stringify({
          ...event,
          attributes: { ...attributes, "gen_ai.response.id": "response-b" },
        }),
        JSON.stringify({
          type: "span",
          traceId: "trace",
          spanId: "span",
          endTime: event.hrTime,
          attributes,
        }),
        JSON.stringify({
          ...event,
          attributes: { ...attributes, "event.name": "copilot_chat.agent.turn" },
        }),
        JSON.stringify({
          ...event,
          attributes: { ...attributes, "gen_ai.usage.input_tokens": undefined },
        }),
        JSON.stringify({
          ...event,
          attributes: { ...attributes, "gen_ai.response.id": undefined },
        }),
      ]);

      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "copilot", path: file }]));
      assert.strictEqual(report.rows[0]?.project, "github.com/acme/example");
      assert.strictEqual(report.rows[0]?.records, 2);
      assert.deepStrictEqual(report.rows[0]?.tokens, {
        input: 80,
        cacheRead: 120,
        cacheWrite: 0,
        output: 40,
      });
      assert.strictEqual(report.coverage[0]?.duplicates, 2);
      assert.strictEqual(report.coverage[0]?.skippedRecords, 2);
      assert.strictEqual(report.coverage[0]?.status, "partial");
    }).pipe(Effect.provide(runtime)),
  );

  it.effect(
    "counts cached tokens once, deduplicates copied files, and preserves equal-sized distinct requests",
    () =>
      Effect.gen(function* () {
        const { write, root } = yield* fixture();

        const lines = [
          JSON.stringify({
            type: "session_meta",
            timestamp: "2026-09-22T09:00:00Z",
            payload: {
              id: "session-1",
              cwd: root,
              git: { repository_url: "git@github.com:acme/project.git" },
            },
          }),
          JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
          codexUsage("09:01:00"),
          codexUsage("09:01:00"),
          codexUsage("09:02:00", 100, 20, 200),
        ];

        const source = yield* write("sessions/a.jsonl", lines);
        const copy = yield* write("archived/b.jsonl", lines);
        const ledger = yield* Ledger;

        const report = yield* ledger.report(
          request([
            { provider: "codex", path: source },
            { provider: "codex", path: copy },
          ]),
        );

        assert.lengthOf(report.rows, 1);
        assert.deepStrictEqual(report.rows[0]?.tokens, {
          input: 80,
          cacheRead: 120,
          cacheWrite: 0,
          output: 40,
        });
        assert.strictEqual(report.rows[0]?.project, "github.com/acme/project");
        assert.deepStrictEqual(report.rows[0]?.pricePerMillion, prices.prices["test-model"]);
        assert.strictEqual(report.rows[0]?.records, 2);
        assert.closeTo(report.rows[0]?.estimatedCostUsd ?? -1, 0.000584, 1e-12);
        assert.strictEqual(report.coverage[1]?.duplicates, 2);
        yield* Schema.decodeUnknownEffect(UsageReport)(JSON.parse(JSON.stringify(report)));
      }).pipe(Effect.provide(runtime)),
  );

  it.effect("ignores empty Codex usage updates without losing counts or hiding invalid usage", () =>
    Effect.gen(function* () {
      const { write } = yield* fixture();

      const emptyUsage = JSON.stringify({
        type: "event_msg",
        timestamp: "2026-09-22T09:01:30Z",
        payload: { type: "token_count", info: null },
      });

      const file = yield* write("empty-usage.jsonl", [
        JSON.stringify({ type: "session_meta", payload: { id: "empty-updates" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
        emptyUsage,
        codexUsage("09:01:00"),
        emptyUsage,
        codexUsage("09:01:00"),
        codexUsage("09:02:00", 100, 20, 200),
      ]);

      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "codex", path: file }]));
      assert.strictEqual(report.coverage[0]?.status, "ok");
      assert.strictEqual(report.coverage[0]?.skippedRecords, 0);
      assert.strictEqual(report.rows[0]?.records, 2);
      assert.strictEqual(
        totalTokens(report.rows[0]?.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }),
        240,
      );

      const invalid = yield* write("invalid-usage.jsonl", [
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-22T09:03:00Z",
          payload: { type: "token_count", info: {} },
        }),
      ]);

      const partial = yield* ledger.report(request([{ provider: "codex", path: invalid }]));
      assert.strictEqual(partial.coverage[0]?.status, "partial");
      assert.strictEqual(partial.coverage[0]?.skippedRecords, 1);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("excludes copied fork bursts and retains later model switches", () =>
    Effect.gen(function* () {
      const { write } = yield* fixture();

      const file = yield* write("fork.jsonl", [
        JSON.stringify({
          type: "session_meta",
          timestamp: "2026-09-22T09:00:00Z",
          payload: { id: "fork", forked_from_id: "parent" },
        }),
        JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
        codexUsage("09:00:00.010"),
        codexUsage("09:00:05", 101, 21, 201),
        JSON.stringify({ type: "turn_context", payload: { model: "private-model" } }),
        codexUsage("09:00:10", 102, 22, 303),
      ]);

      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "codex", path: file }]));
      assert.strictEqual(
        report.rows.reduce((sum, row) => sum + row.records, 0),
        2,
      );
      assert.strictEqual(
        report.rows.find((row) => row.model === "private-model")?.estimatedCostUsd,
        null,
      );
      assert.strictEqual(report.coverage[0]?.status, "partial");
      assert.strictEqual(report.coverage[0]?.skippedRecords, 1);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("handles Claude block repeats, Grok model breakdowns, and Copilot child spans", () =>
    Effect.gen(function* () {
      const { write } = yield* fixture();

      const claude = JSON.stringify({
        type: "assistant",
        timestamp: "2026-09-22T10:00:00Z",
        sessionId: "claude-session",
        requestId: "req-1",
        message: {
          id: "message-1",
          model: "test-model",
          usage: {
            input_tokens: 40,
            cache_read_input_tokens: 60,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
          },
        },
      });

      const claudeFile = yield* write("claude.jsonl", [claude, claude, "{invalid"]);

      const grok = JSON.stringify({
        timestamp: 1758535200,
        params: {
          sessionId: "grok-session",
          _meta: { agentTimestampMs: Date.parse("2026-09-22T10:00:00Z") },
          update: {
            sessionUpdate: "turn_completed",
            prompt_id: "prompt",
            usage: {
              inputTokens: 100,
              outputTokens: 20,
              modelUsage: {
                "test-model": { inputTokens: 100, cachedReadTokens: 60, outputTokens: 20 },
              },
            },
          },
        },
      });

      const grokFile = yield* write("grok.jsonl", [grok, grok]);

      const attributes = {
        "gen_ai.operation.name": "chat",
        "gen_ai.response.model": "test-model",
        "gen_ai.conversation.id": "copilot-session",
        "gen_ai.usage.input_tokens": 100,
        "gen_ai.usage.output_tokens": 20,
        "gen_ai.usage.cache_read_input_tokens": 60,
      };

      const span = {
        type: "span",
        traceId: "trace",
        spanId: "span",
        endTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
        attributes,
      };

      const copilot = JSON.stringify(span);

      const copilotFile = yield* write("copilot.jsonl", [
        copilot,
        copilot,
        JSON.stringify({
          ...span,
          spanId: "parent",
          attributes: { ...attributes, "gen_ai.operation.name": "invoke_agent" },
        }),
      ]);

      const ledger = yield* Ledger;

      const report = yield* ledger.report(
        request([
          { provider: "claude", path: claudeFile, project: "Client A" },
          { provider: "grok", path: grokFile, project: "Client A" },
          { provider: "copilot", path: copilotFile, project: "Client A" },
        ]),
      );

      assert.lengthOf(report.rows, 3);
      assert.strictEqual(
        report.rows.reduce((sum, row) => sum + totalTokens(row.tokens), 0),
        370,
      );
      assert.strictEqual(
        report.rows.reduce((sum, row) => sum + row.records, 0),
        3,
      );
      assert.strictEqual(report.coverage[0]?.malformedLines, 1);
      assert.isTrue(report.coverage.every((source) => source.duplicates === 1));
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("attributes Copilot requests from later parent spans without crossing traces", () =>
    Effect.gen(function* () {
      const { write } = yield* fixture();
      const endTime = [Date.parse("2026-09-22T10:00:00Z") / 1000, 0];

      const chat = (traceId: string, parentSpanId: string) =>
        JSON.stringify({
          type: "span",
          traceId,
          spanId: "chat",
          parentSpanId,
          endTime,
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.response.model": "test-model",
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20,
          },
        });

      const parent = (traceId: string, spanId: string, repository: string) =>
        JSON.stringify({
          type: "span",
          traceId,
          spanId,
          endTime,
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "github.copilot.git.repository": repository,
            "gen_ai.usage.input_tokens": 100,
            "gen_ai.usage.output_tokens": 20,
          },
        });

      const file = yield* write("copilot-parent.jsonl", [
        chat("trace-a", "parent-a"),
        chat("trace-b", "parent-b"),
        chat("trace-c", "missing-parent"),
        parent("trace-b", "parent-b", "acme/beta"),
        parent("trace-a", "parent-a", "acme/alpha"),
      ]);

      const ledger = yield* Ledger;
      const report = yield* ledger.report(request([{ provider: "copilot", path: file }]));

      assert.deepStrictEqual(
        report.rows.map((row) => [row.project, row.records]),
        [
          ["acme/alpha", 1],
          ["acme/beta", 1],
          ["Unassigned", 1],
        ],
      );
      assert.strictEqual(report.coverage[0]?.status, "ok");
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("groups Git worktrees and honors most-specific path mappings", () =>
    Effect.gen(function* () {
      const { write, root, path } = yield* fixture();
      yield* write("repo/.git/config", [
        '[remote "origin"]',
        "url = https://user:secret@example.com/company/app.git",
      ]);
      yield* write("worktree/.git", ["gitdir: ../repo/.git/worktrees/feature"]);
      yield* write("repo/.git/worktrees/feature/commondir", ["../.."]);

      const session = (id: string, cwd: string) => [
        JSON.stringify({ type: "session_meta", payload: { id, cwd } }),
        JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
        codexUsage("10:00:00"),
      ];

      const fileA = yield* write("a.jsonl", session("a", path.join(root, "repo")));
      const fileB = yield* write("b.jsonl", session("b", path.join(root, "worktree")));
      const ledger = yield* Ledger;

      const input = request([
        { provider: "codex", path: fileA },
        { provider: "codex", path: fileB },
      ]);

      const report = yield* ledger.report(input);
      assert.lengthOf(report.rows, 1);
      assert.strictEqual(report.rows[0]?.project, "example.com/company/app");

      const mapped = yield* ledger.report({
        ...input,
        projects: [
          { project: "General", paths: [root], repositories: [] },
          { project: "Client B", paths: [path.join(root, "worktree")], repositories: [] },
        ],
      });

      assert.deepStrictEqual(
        mapped.rows.map((row) => row.project),
        ["Client B", "General"],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("rejects reversed date windows and labels missing histories", () =>
    Effect.gen(function* () {
      const { root, path } = yield* fixture();
      const ledger = yield* Ledger;
      const input = request([{ provider: "codex", path: path.join(root, "absent") }]);
      const report = yield* ledger.report(input);
      assert.strictEqual(report.coverage[0]?.status, "missing");
      assert.lengthOf(report.rows, 0);
      const invalid = yield* ledger.report({ ...input, since: "2026-10-01" }).pipe(Effect.result);
      assert.isTrue(Result.isFailure(invalid));
      assert.isFalse(Schema.is(ReportRequest)({ ...input, since: "2026-02-30" }));
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("windows and groups by local days and detects overlapping source paths", () =>
    Effect.gen(function* () {
      const { write, root } = yield* fixture();

      // 23:59:59.999 and 00:00 in Stockholm, both on September 22 in UTC.
      const file = yield* write("sessions/only.jsonl", [
        JSON.stringify({ type: "session_meta", payload: { id: "boundary" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "test-model" } }),
        codexUsage("21:59:59.999", 100, 20, 100),
        codexUsage("22:00:00", 100, 20, 200),
      ]);

      const ledger = yield* Ledger;

      const input = {
        ...request([
          { provider: "codex", path: root },
          { provider: "codex", path: file },
        ]),
        since: "2026-09-22",
        until: "2026-09-22",
        timeZone: DateTime.zoneMakeNamedUnsafe("Europe/Stockholm"),
      };

      const report = yield* ledger.report(input);
      assert.strictEqual(report.timeZone, "Europe/Stockholm");
      assert.deepStrictEqual(
        report.rows.map((row) => [row.day, row.records]),
        [["2026-09-22", 1]],
      );
      assert.strictEqual(report.coverage[1]?.files, 0);
      assert.isTrue((report.coverage[1]?.warnings.length ?? 0) > 0);

      const extended = yield* ledger.report({ ...input, until: "2026-09-23" });
      assert.deepStrictEqual(
        extended.rows.map((row) => [row.day, row.records]),
        [
          ["2026-09-22", 1],
          ["2026-09-23", 1],
        ],
      );
    }).pipe(Effect.provide(runtime)),
  );
});
