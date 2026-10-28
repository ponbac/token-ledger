import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path } from "effect";

import { Ledger } from "./ledger.ts";
import { PriceBook, ReportRequest, totalTokens, type Source, type UsageReport } from "./model.ts";

const runtime = Ledger.layer.pipe(Layer.provideMerge(NodeServices.layer));

const prices = PriceBook.make({
  status: "custom",
  fetchedAt: null,
  source: "test-fixture",
  prices: { "test-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 } },
});

const client = {
  machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
  version: "0.0.0-test",
};

const secret = "PROMPT-SECRET-7f3a";

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

function usage(
  apiCallId: string,
  tokens: { input: number; read: number; write: number },
  isByok = false,
) {
  return JSON.stringify({
    type: "session.usage_record",
    timestamp: "2026-09-22T10:00:00.000Z",
    data: {
      usage: {
        model: "test-model",
        inputTokens: tokens.input,
        outputTokens: 10,
        cacheReadTokens: tokens.read,
        cacheWriteTokens: tokens.write,
        isByok,
        apiCallId,
        accounting: { sourceSessionId: "harness-session", usageId: `usage-${apiCallId}` },
      },
    },
  });
}

/** One Copilot harness session: its event log with a prompt beside the accounting events. */
const fixture = Effect.fn("Test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-session-test-" });

  const write = Effect.fn("Test.write")(function* (name: string, lines: readonly string[]) {
    const file = path.join(root, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, lines.join("\n") + "\n");
  });

  const workspace = path.join(root, "workspace");

  yield* write("session-state/harness-session/events.jsonl", [
    JSON.stringify({
      type: "session.start",
      data: {
        sessionId: "harness-session",
        context: { cwd: workspace, repository: "acme/alpha", hostType: "github" },
      },
    }),
    // A prompt that names the accounting events is still a prompt.
    JSON.stringify({
      type: "user.message",
      data: { content: `${secret} "session.usage_record" "session.start"` },
    }),
    usage("call-1", { input: 100, read: 60, write: 20 }),
    usage("call-byok", { input: 100, read: 0, write: 0 }, true),
    // The session moves to a GitHub Enterprise repository; the preliminary change is settled.
    JSON.stringify({
      type: "session.context_changed",
      data: { cwd: path.join(root, "elsewhere"), pendingGitContext: true },
    }),
    JSON.stringify({
      type: "session.context_changed",
      data: {
        cwd: path.join(root, "review"),
        repository: "acme/review",
        repositoryHost: "ghe.example.com",
        hostType: "github",
      },
    }),
    usage("call-3", { input: 40, read: 0, write: 0 }),
    usage("call-impossible", { input: 10, read: 8, write: 8 }),
    JSON.stringify({ type: "assistant.message", data: { content: secret } }),
  ]);

  // A file the session wrote into its own folder is not its event log.
  yield* write("session-state/harness-session/files/notes.jsonl", [
    usage("call-in-files", { input: 100, read: 0, write: 0 }),
  ]);

  const span = (responseId: string, attributes: Record<string, number>) =>
    JSON.stringify({
      type: "span",
      traceId: "trace",
      spanId: responseId,
      endTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.conversation.id": "harness-session",
        "gen_ai.response.id": responseId,
        "gen_ai.response.model": "test-model",
        "gen_ai.usage.output_tokens": 10,
        ...attributes,
      },
    });

  // The Agent Host's managed export holds the same request without its workspace, and a
  // request of its own that names cache writes as `cache_write`.
  yield* write("otel/vscode-agent-host.jsonl", [
    span("call-1", {
      "gen_ai.usage.input_tokens": 100,
      "gen_ai.usage.cache_read.input_tokens": 60,
      "gen_ai.usage.cache_write.input_tokens": 20,
    }),
    // Not Copilot's to bill, as the session's copy says.
    span("call-byok", { "gen_ai.usage.input_tokens": 100 }),
    span("call-2", {
      "gen_ai.usage.input_tokens": 50,
      "gen_ai.usage.cache_read.input_tokens": 10,
      "gen_ai.usage.cache_write.input_tokens": 30,
    }),
  ]);

  return {
    root,
    sources: [
      { provider: "copilot", path: path.join(root, "session-state") },
      { provider: "copilot", path: path.join(root, "otel") },
    ] satisfies Source[],
  };
});

describe("Copilot session logs through the public interface", () => {
  it.effect("counts each request once, in its session's repository, without reading prompts", () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture();
      const report = yield* (yield* Ledger).report(request(sources));

      assert.deepStrictEqual(
        report.rows.map((row) => [row.project, row.records, row.tokens]),
        [
          [
            "ghe.example.com/acme/review",
            1,
            { input: 40, output: 10, cacheRead: 0, cacheWrite: 0 },
          ],
          ["github.com/acme/alpha", 1, { input: 20, output: 10, cacheRead: 60, cacheWrite: 20 }],
          ["Unassigned", 1, { input: 10, output: 10, cacheRead: 10, cacheWrite: 30 }],
        ],
      );

      assert.deepStrictEqual(
        report.coverage.map((entry) => [entry.status, entry.files, entry.skippedRecords]),
        [
          ["partial", 1, 1],
          ["ok", 1, 0],
        ],
      );
      // The export's copies of the session's request and of its BYOK request.
      assert.strictEqual(report.coverage[1]?.duplicates, 2);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("counts the same whatever the order of sources", () =>
    Effect.gen(function* () {
      const { sources } = yield* fixture();
      const ledger = yield* Ledger;

      const rows = (report: UsageReport) =>
        report.rows.map((row) => [row.project, row.records, totalTokens(row.tokens)]);

      assert.deepStrictEqual(
        rows(yield* ledger.report(request(sources.toReversed()))),
        rows(yield* ledger.report(request(sources))),
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("bills a request the local proxy routed to ChatGPT there, BYOK or not", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, sources } = yield* fixture();
      const hints = path.join(root, "hints");

      yield* fs.makeDirectory(hints);
      yield* fs.writeFileString(
        path.join(hints, "chatgpt-proxy.jsonl"),
        ["call-1", "call-byok"]
          .map((requestId) =>
            JSON.stringify({ requestId, billingProvider: "codex", authMode: "chatgpt" }),
          )
          .join("\n"),
      );

      const payload = yield* (yield* Ledger).syncPayload(
        { ...request(sources), billingHints: { directory: hints, required: true } },
        client,
      );

      assert.deepStrictEqual(
        payload.buckets.map((bucket) => [
          bucket.project,
          bucket.billingProvider ?? null,
          bucket.records,
        ]),
        [
          ["ghe.example.com/acme/review", null, 1],
          ["github.com/acme/alpha", "codex", 2],
          ["unattributed", null, 1],
        ],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("uploads no prompt text, session ID, or local path", () =>
    Effect.gen(function* () {
      const { root, sources } = yield* fixture();
      const payload = yield* (yield* Ledger).syncPayload(request(sources), client);

      assert.deepStrictEqual(
        payload.buckets.map((bucket) => [bucket.project, totalTokens(bucket.tokens)]),
        [
          ["ghe.example.com/acme/review", 50],
          ["github.com/acme/alpha", 110],
          ["unattributed", 60],
        ],
      );
      const encoded = JSON.stringify(payload);

      for (const local of [secret, "harness-session", "call-1", root])
        assert.notInclude(encoded, local);
    }).pipe(Effect.provide(runtime)),
  );
});

describe("VS Code exports that reuse a turn's response ID", () => {
  const turn = Date.parse("2026-09-22T10:00:00Z") / 1000;

  const attributes = (input: number, responseId?: string, repository?: string) => ({
    "gen_ai.operation.name": "chat",
    ...(responseId === undefined ? undefined : { "gen_ai.response.id": responseId }),
    ...(repository === undefined ? undefined : { "github.copilot.git.repository": repository }),
    "gen_ai.response.model": "test-model",
    "gen_ai.usage.input_tokens": input,
    "gen_ai.usage.output_tokens": 10,
  });

  const span = (n: number, responseId?: string) =>
    JSON.stringify({
      traceId: "turn",
      spanId: `request-${n}`,
      endTime: [turn + n, 0],
      attributes: attributes(100 * n, responseId),
    });

  /** Request `n`'s inference event, logged under `spanId` when it names one. */
  const event = (n: number, responseId: string, spanId?: string, repository?: string) =>
    JSON.stringify({
      hrTime: [turn + n, 1_000_000],
      spanContext: spanId === undefined ? undefined : { traceId: "turn", spanId },
      attributes: {
        ...attributes(100 * n, responseId, repository),
        "event.name": "gen_ai.client.inference.operation.details",
      },
    });

  const requests = [1, 2, 3];

  const cases: ReadonlyArray<
    readonly [string, readonly string[], readonly [string, number, number]]
  > = [
    [
      "the Local harness: each request a span, their events under one span",
      requests.flatMap((n) => [span(n, "turn"), event(n, "turn", "agent")]),
      ["Unassigned", 3, 600],
    ],
    [
      "a span missing for one request",
      [span(1, "turn"), ...requests.map((n) => event(n, "turn", "agent"))],
      ["Unassigned", 3, 600],
    ],
    [
      "spans taking the ID from their own events",
      requests.flatMap((n) => [span(n), event(n, "turn", `request-${n}`)]),
      ["Unassigned", 3, 600],
    ],
    [
      "events alone, one of them logged twice",
      [event(1, "turn"), event(2, "turn"), event(2, "turn")],
      ["Unassigned", 2, 300],
    ],
    [
      "an event logged twice beside the spans",
      [span(1, "turn"), span(2, "turn"), ...[1, 2, 2].map((n) => event(n, "turn", "agent"))],
      ["Unassigned", 2, 300],
    ],
    [
      "events under an agent span naming the repository their spans do not",
      [
        JSON.stringify({
          traceId: "turn",
          spanId: "agent",
          endTime: [turn + 4, 0],
          attributes: {
            "gen_ai.operation.name": "invoke_agent",
            "github.copilot.git.repository": "acme/agent",
          },
        }),
        ...requests.flatMap((n) => [span(n, "turn"), event(n, "turn", "agent")]),
      ],
      ["acme/agent", 3, 600],
    ],
    [
      "spans under their own repository, events under another agent's",
      [
        ...[
          ["own", "acme/own"],
          ["agent", "acme/agent"],
        ].map(([spanId, repository]) =>
          JSON.stringify({
            traceId: "turn",
            spanId,
            endTime: [turn + 4, 0],
            attributes: {
              "gen_ai.operation.name": "invoke_agent",
              "github.copilot.git.repository": repository,
            },
          }),
        ),
        ...requests.flatMap((n) => [
          JSON.stringify({
            traceId: "turn",
            spanId: `request-${n}`,
            parentSpanId: "own",
            endTime: [turn + n, 0],
            attributes: attributes(100 * n, "turn"),
          }),
          event(n, "turn", "agent"),
        ]),
      ],
      ["acme/own", 3, 600],
    ],
    [
      "events naming the repository their spans do not",
      requests.flatMap((n) => [span(n, "turn"), event(n, "turn", "agent", "acme/turn")]),
      ["acme/turn", 3, 600],
    ],
  ];

  it.effect("counts each request once beside an export holding only some of its turn", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-turn-test-" });
      const whole = path.join(root, "whole.jsonl");
      const partial = path.join(root, "partial.jsonl");

      yield* fs.writeFileString(whole, [1, 2].map((n) => span(n, "turn")).join("\n"));
      yield* fs.writeFileString(partial, event(1, "turn", "agent"));
      const ledger = yield* Ledger;

      const report = yield* ledger.report(
        request([
          { provider: "copilot", path: partial },
          { provider: "copilot", path: whole },
        ]),
      );

      assert.deepStrictEqual(
        report.rows.map((row) => [row.records, row.tokens.input]),
        [[2, 300]],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("counts each request once with its spans and events in separate sources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-turn-test-" });
      const spans = path.join(root, "spans.jsonl");
      const events = path.join(root, "events-export.jsonl");

      yield* fs.writeFileString(spans, requests.map((n) => span(n, "turn")).join("\n"));
      yield* fs.writeFileString(events, requests.map((n) => event(n, "turn", "agent")).join("\n"));
      const ledger = yield* Ledger;

      const report = yield* ledger.report(
        request([
          { provider: "copilot", path: events },
          { provider: "copilot", path: spans },
        ]),
      );

      assert.deepStrictEqual(
        report.rows.map((row) => [row.records, row.tokens.input]),
        [[3, 600]],
      );
    }).pipe(Effect.provide(runtime)),
  );

  for (const [name, lines, expected] of cases)
    it.effect(`counts each request once: ${name}`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-turn-test-" });
        const file = path.join(root, "vscode-chat.jsonl");

        yield* fs.writeFileString(file, lines.join("\n"));
        const ledger = yield* Ledger;
        const report = yield* ledger.report(request([{ provider: "copilot", path: file }]));

        assert.deepStrictEqual(
          report.rows.map((row) => [row.project, row.records, row.tokens.input]),
          [[...expected]],
        );
      }).pipe(Effect.provide(runtime)),
    );
});
