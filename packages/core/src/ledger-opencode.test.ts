import { DatabaseSync } from "node:sqlite";

import { NodeFileSystem, NodePath, NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path } from "effect";

import { Ledger } from "./ledger.ts";
import { PriceBook, ReportRequest, totalTokens } from "./model.ts";

const runtime = Ledger.layer.pipe(Layer.provideMerge(NodeServices.layer));

// Windows path semantics over this machine's file system, for paths OpenCode stored on Windows.
// Fresh, so it is not shared with the POSIX ledger the test itself runs in.
const windows = Layer.fresh(Ledger.layer).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layerWin32)),
);

const client = {
  machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
  version: "0.0.0-test",
};

const secret = "PRIVATE-PROMPT-AND-TOOL-OUTPUT";

const at = (time: string) => Date.parse(`2026-09-22T${time}Z`);

function tokens(input: number, output: number, reasoning = 0, read = 0, write = 0) {
  return { input, output, reasoning, cache: { read, write } };
}

/** Token counts as OpenCode records them, or a damaged record of them. */
type Usage = ReturnType<typeof tokens> | { readonly input: string };

/** OpenCode's `auth.json`, beside its database. */
interface Credentials {
  readonly openai: { readonly type: string; readonly access: string };
}

/** A stored message or legacy file; the rest of its fields are OpenCode's. */
interface Stored {
  readonly time: { readonly created: number };
}

/** An assistant message as OpenCode stores it in `message.data`. */
function assistant(
  time: string,
  providerID: string,
  modelID: string,
  usage: Usage,
  extra: { readonly path?: { readonly cwd: string; readonly root: string } } = {},
) {
  return {
    role: "assistant",
    providerID,
    modelID,
    cost: 0,
    tokens: usage,
    time: { created: at(time), completed: at(time) + 1000 },
    ...extra,
  };
}

/** A newer `session_message` assistant row, which also stores the response it streamed. */
function stepData(time: string, providerID: string, id: string, usage: Usage) {
  return {
    type: "assistant",
    model: { providerID, id, variant: "default" },
    content: [{ type: "text", text: secret }],
    cost: 0,
    tokens: usage,
    time: { created: at(time) },
  };
}

const fixture = Effect.fn("Test.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-opencode-test-" });
  const data = path.join(root, "opencode");

  const write = Effect.fn("Test.write")(function* <A extends Stored | Credentials>(
    name: string,
    value: A,
  ) {
    const file = path.join(data, name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    // OpenCode writes its legacy files indented, one document over several lines.
    yield* fs.writeFileString(file, JSON.stringify(value, null, 2));

    return file;
  });

  const database = Effect.fn("Test.database")(function* (name: string, statements: string) {
    const file = path.join(data, name);
    yield* fs.makeDirectory(data, { recursive: true });

    const db = yield* Effect.acquireRelease(
      Effect.sync(() => new DatabaseSync(file)),
      (connection) => Effect.sync(() => connection.close()),
    );

    yield* Effect.sync(() => db.exec(statements));

    return { file, db };
  });

  return { fs, path, root, data, write, database };
});

const schema = `
  CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL);
  CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
    fork_session_id TEXT);
  CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
    time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
    seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
  CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
    data TEXT NOT NULL);`;

/** One OpenCode data directory exercising every store, route, and kind of copy. */
const history = Effect.fn("Test.history")(function* () {
  const { fs, path, root, data, write, database } = yield* fixture();
  const projectA = path.join(root, "work", "a");
  const projectB = path.join(root, "work", "b");

  const chatgpt = assistant("10:01:00", "openai", "chatgpt-model", tokens(100, 20, 5, 60, 10), {
    path: { cwd: projectA, root: projectA },
  });

  yield* Effect.gen(function* () {
    const { file, db } = yield* database("opencode.db", schema);

    yield* Effect.sync(() => {
      const session = db.prepare("INSERT INTO session VALUES (?, ?, ?)");
      const sessionV2 = db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, ?)");
      const message = db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)");
      const step = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)");

      const insert = <A extends Stored>(id: string, sessionId: string, value: A) =>
        message.run(id, sessionId, value.time.created, value.time.created, JSON.stringify(value));

      const insertStep = <A extends Stored & { readonly type: string }>(
        id: string,
        sessionId: string,
        seq: number,
        value: A,
      ) =>
        step.run(
          id,
          sessionId,
          value.type,
          seq,
          value.time.created,
          value.time.created,
          JSON.stringify(value),
        );

      session.run("ses_a", projectA, at("09:00:00"));
      sessionV2.run("ses_a", projectA, at("09:00:00"), null);
      sessionV2.run("ses_b", projectB, at("09:00:00"), null);
      sessionV2.run("ses_fork", projectB, at("12:00:00"), "ses_b");
      // Two forks of a session that has since been deleted.
      sessionV2.run("ses_orphan_1", projectB, at("12:00:00"), "ses_gone");
      sessionV2.run("ses_orphan_2", projectB, at("12:00:00"), "ses_gone");

      insert("msg_user", "ses_a", { role: "user", time: { created: at("10:00:00") } });
      insert("msg_chatgpt", "ses_a", chatgpt);
      // No recorded working directory: the session's directory stands in.
      insert("msg_api", "ses_a", {
        ...assistant("10:02:00", "openai", "api-model", tokens(10, 5)),
        cost: 0.5,
      });
      insert(
        "msg_copilot",
        "ses_a",
        assistant("10:03:00", "github-copilot", "copilot-model", tokens(10, 5)),
      );
      insert("msg_zen", "ses_a", assistant("10:04:00", "opencode", "zen-model", tokens(10, 5)));
      // An aborted request used no tokens.
      insert(
        "msg_aborted",
        "ses_a",
        assistant("10:05:00", "openai", "aborted-model", tokens(0, 0)),
      );
      insert(
        "msg_broken",
        "ses_a",
        assistant("10:06:00", "openai", "broken-model", { input: "many" }),
      );

      // The newer store repeats `message` rows under the same IDs, with their content.
      insertStep(
        "msg_chatgpt",
        "ses_a",
        1,
        stepData("10:01:00", "openai", "chatgpt-model", chatgpt.tokens),
      );
      insertStep(
        "v2_only",
        "ses_b",
        1,
        stepData("10:10:00", "anthropic", "v2-model", tokens(7, 3)),
      );
      insertStep("v2_user", "ses_b", 2, {
        type: "user",
        text: secret,
        time: { created: at("10:11:00") },
      });
      // A summary's usage sits on its compaction message; a failed one names no model.
      insertStep("v2_compacted", "ses_b", 3, {
        ...stepData("10:12:00", "anthropic", "compaction-model", tokens(50, 8)),
        type: "compaction",
        summary: secret,
      });
      insertStep("v2_compaction_failed", "ses_b", 4, {
        type: "compaction",
        status: "failed",
        tokens: tokens(6, 0),
        time: { created: at("10:13:00") },
      });
      // A fork copies its parent's settled history under new IDs.
      insertStep(
        "evt_fork_1",
        "ses_fork",
        1,
        stepData("10:10:00", "anthropic", "v2-model", tokens(7, 3)),
      );
      insertStep(
        "evt_fork_3",
        "ses_fork",
        3,
        stepData("12:30:00", "anthropic", "fork-model", tokens(4, 2)),
      );
      insertStep(
        "evt_orphan_1",
        "ses_orphan_1",
        1,
        stepData("08:00:00", "anthropic", "orphan-model", tokens(9, 1)),
      );
      insertStep(
        "evt_orphan_2",
        "ses_orphan_2",
        1,
        stepData("08:00:00", "anthropic", "orphan-model", tokens(9, 1)),
      );

      db.prepare("INSERT INTO part VALUES (?, ?, ?, ?)").run(
        "prt_1",
        "msg_chatgpt",
        "ses_a",
        JSON.stringify({ type: "text", text: secret }),
      );
    });

    // A live database's modification time lags the rows in its write-ahead log.
    yield* fs.utimes(file, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  }).pipe(Effect.scoped);

  // The pre-SQLite store, whose files hold the system prompt.
  yield* write("storage/message/ses_a/msg_chatgpt.json", {
    id: "msg_chatgpt",
    sessionID: "ses_a",
    ...chatgpt,
    system: [secret],
  });

  yield* write("storage/message/ses_old/msg_legacy.json", {
    id: "msg_legacy",
    sessionID: "ses_old",
    ...assistant("10:20:00", "google", "legacy-model", tokens(3, 1), {
      path: { cwd: projectA, root: projectA },
    }),
    system: [secret],
  });

  const settled = yield* write("storage/message/ses_old/msg_settled.json", {
    id: "msg_settled",
    sessionID: "ses_old",
    ...assistant("10:21:00", "google", "settled-model", tokens(3, 1)),
  });

  yield* fs.utimes(settled, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

  // Never history: file snapshots can hold anything, and credentials sit beside the database.
  yield* write("snapshot/storage/message/ses_a/msg_snapshot.json", {
    id: "msg_snapshot",
    sessionID: "ses_a",
    ...assistant("10:30:00", "openai", "snapshot-model", tokens(1, 1)),
  });
  yield* write("auth.json", { openai: { type: "oauth", access: secret } });

  const request = ReportRequest.make({
    since: "2026-09-01",
    until: "2026-09-30",
    timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    sources: [{ provider: "opencode", path: data }],
    projects: [
      { project: "A", paths: [projectA], repositories: [] },
      { project: "B", paths: [projectB], repositories: [] },
    ],
    pricing: PriceBook.make({
      status: "custom",
      fetchedAt: null,
      source: "test-fixture",
      prices: {},
    }),
  });

  return { request, root, data, path, fs, write, database };
});

describe("OpenCode usage through the Ledger", () => {
  it.effect("counts each request once across stores and forks, and skips what is not history", () =>
    Effect.gen(function* () {
      const { request, root } = yield* history();
      const report = yield* (yield* Ledger).report(request);

      assert.deepStrictEqual(
        report.rows.map((row) => [row.project, row.model, row.records, row.tokens]),
        [
          ["A", "api-model", 1, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }],
          // Reasoning is part of output; cache reads and writes stay apart from input.
          ["A", "chatgpt-model", 1, { input: 100, cacheRead: 60, cacheWrite: 10, output: 25 }],
          ["A", "copilot-model", 1, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }],
          ["A", "legacy-model", 1, { input: 3, cacheRead: 0, cacheWrite: 0, output: 1 }],
          ["A", "zen-model", 1, { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 }],
          ["B", "compaction-model", 1, { input: 50, cacheRead: 0, cacheWrite: 0, output: 8 }],
          ["B", "fork-model", 1, { input: 4, cacheRead: 0, cacheWrite: 0, output: 2 }],
          ["B", "orphan-model", 1, { input: 9, cacheRead: 0, cacheWrite: 0, output: 1 }],
          ["B", "unknown", 1, { input: 6, cacheRead: 0, cacheWrite: 0, output: 0 }],
          ["B", "v2-model", 1, { input: 7, cacheRead: 0, cacheWrite: 0, output: 3 }],
        ],
      );

      const coverage = report.coverage[0];
      assert.strictEqual(coverage?.status, "partial");
      assert.strictEqual(coverage?.skippedRecords, 1);
      // The database and two legacy files; the settled legacy file is counted, not opened.
      assert.strictEqual(coverage?.files, 3);
      assert.strictEqual(coverage?.filesBeforeWindow, 1);
      // The legacy copy of a database message, a fork's copy, and an orphaned sibling copy.
      assert.strictEqual(coverage?.duplicates, 3);
      assert.notInclude(JSON.stringify(report.rows), secret);
      assert.notInclude(JSON.stringify(report.rows), root);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("routes Copilot and zero-cost OpenAI requests to their subscriptions", () =>
    Effect.gen(function* () {
      const { request, root } = yield* history();
      const payload = yield* (yield* Ledger).syncPayload(request, client);

      assert.strictEqual(payload.version, 2);
      assert.deepStrictEqual(
        payload.buckets
          .map((bucket) => [
            bucket.model,
            bucket.provider,
            bucket.billingProvider ?? null,
            totalTokens(bucket.tokens),
          ])
          .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        [
          ["api-model", "opencode", null, 15],
          ["chatgpt-model", "opencode", "codex", 195],
          ["compaction-model", "opencode", null, 58],
          ["copilot-model", "opencode", "copilot", 15],
          ["fork-model", "opencode", null, 6],
          ["legacy-model", "opencode", null, 4],
          ["orphan-model", "opencode", null, 10],
          ["unknown", "opencode", null, 6],
          ["v2-model", "opencode", null, 10],
          ["zen-model", "opencode", null, 15],
        ],
      );

      const encoded = JSON.stringify(payload);

      for (const local of [secret, root, "ses_a", "msg_chatgpt"]) assert.notInclude(encoded, local);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("labels absent history missing and withholds a database it cannot read", () =>
    Effect.gen(function* () {
      const { request, root, path, database } = yield* history();
      const ledger = yield* Ledger;

      const missing = yield* ledger.report({
        ...request,
        sources: [{ provider: "opencode", path: path.join(root, "absent") }],
      });

      assert.strictEqual(missing.coverage[0]?.status, "missing");

      yield* database("opencode-beta.db", "CREATE TABLE unrelated (id TEXT);").pipe(Effect.scoped);
      const payload = yield* ledger.syncPayload(request, client);

      assert.deepStrictEqual(
        payload.coverage.map((entry) => [entry.provider, entry.status, entry.unreadable]),
        [["opencode", "failed", 1]],
      );
      assert.lengthOf(payload.buckets, 0);
    }).pipe(Effect.provide(runtime)),
  );

  const report = (input: ReportRequest) =>
    Effect.gen(function* () {
      return yield* (yield* Ledger).report(input);
    });

  const v1Schema = `
    CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, data TEXT NOT NULL);`;

  const v2Schema = `
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT NOT NULL, time_created INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`;

  /** Adds sessions and messages to a database with the v1 or v2 store. */
  const fill = (
    db: DatabaseSync,
    store: "v1" | "v2",
    sessions: readonly (readonly [string, string, number])[],
    messages: readonly (readonly [string, string, Stored])[],
  ) =>
    Effect.sync(() => {
      const session = db.prepare(
        `INSERT INTO ${store === "v1" ? "session" : "session_v2"} VALUES (?, ?, ?)`,
      );

      for (const [id, directory, created] of sessions) session.run(id, directory, created);

      for (const [index, [id, sessionId, value]] of messages.entries())
        if (store === "v1")
          db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
            id,
            sessionId,
            value.time.created,
            value.time.created,
            JSON.stringify(value),
          );
        else
          db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            id,
            sessionId,
            "assistant",
            index,
            value.time.created,
            value.time.created,
            JSON.stringify(value),
          );
    });

  it.effect("reads databases holding only the v1 store or only the v2 store", () =>
    Effect.gen(function* () {
      const { request, root, path, database } = yield* history();
      const projectA = path.join(root, "work", "a");
      const projectB = path.join(root, "work", "b");

      const v1 = yield* Effect.gen(function* () {
        const { file, db } = yield* database("v1.db", v1Schema);
        const answer = assistant("10:00:00", "openai", "v1-model", tokens(5, 5));

        yield* fill(
          db,
          "v1",
          [
            ["ses_parent", projectA, at("09:00:00")],
            // A v1 fork records no parent; its copies predate it.
            ["ses_fork", projectB, at("11:00:00")],
          ],
          [
            ["msg_original", "ses_parent", answer],
            ["msg_copy", "ses_fork", answer],
            // After the window: never selected, so never diagnosed.
            ["msg_later", "ses_parent", assistant("10:00:00", "openai", "late", { input: "x" })],
          ],
        );
        yield* Effect.sync(() =>
          db
            .prepare("UPDATE message SET time_created = ? WHERE id = 'msg_later'")
            .run(Date.parse("2026-10-02T00:00:00Z")),
        );

        return file;
      }).pipe(Effect.scoped);

      const v2 = yield* Effect.gen(function* () {
        const { file, db } = yield* database("v2.db", v2Schema);

        yield* fill(
          db,
          "v2",
          [["ses_v2", projectB, at("09:00:00")]],
          [["v2_step", "ses_v2", stepData("10:00:00", "anthropic", "v2-model", tokens(3, 4))]],
        );

        return file;
      }).pipe(Effect.scoped);

      const result = yield* report({
        ...request,
        sources: [
          { provider: "opencode", path: v1 },
          { provider: "opencode", path: v2 },
        ],
      });

      assert.deepStrictEqual(
        result.rows.map((row) => [row.project, row.model, row.records]),
        [
          ["A", "v1-model", 1],
          ["B", "v2-model", 1],
        ],
      );
      assert.deepStrictEqual(
        result.coverage.map((entry) => [entry.status, entry.skippedRecords, entry.duplicates]),
        [
          ["ok", 0, 1],
          ["ok", 0, 0],
        ],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("matches a fork's copies to their original in another database or legacy file", () =>
    Effect.gen(function* () {
      const { fs, path, root, data, write, database } = yield* fixture();
      const projectA = path.join(root, "work", "a");
      const projectB = path.join(root, "work", "b");
      const answer = assistant("10:00:00", "openai", "shared-model", tokens(8, 2));

      yield* Effect.gen(function* () {
        const { db } = yield* database("opencode.db", v1Schema);
        yield* fill(
          db,
          "v1",
          [["ses_parent", projectA, at("09:00:00")]],
          [["msg_a", "ses_parent", answer]],
        );
      }).pipe(Effect.scoped);

      // Read before `opencode.db`: its copy waits for the original.
      yield* Effect.gen(function* () {
        const { db } = yield* database("opencode-beta.db", v1Schema);
        yield* fill(
          db,
          "v1",
          [["ses_beta", projectB, at("11:00:00")]],
          [["msg_b", "ses_beta", answer]],
        );
      }).pipe(Effect.scoped);

      // A legacy fork: only the session's ID and start are read, never its title.
      yield* write("storage/session/project/ses_legacy.json", {
        id: "ses_legacy",
        title: secret,
        time: { created: at("12:00:00") },
      });
      yield* write("storage/message/ses_legacy/msg_c.json", {
        id: "msg_c",
        sessionID: "ses_legacy",
        ...answer,
        path: { cwd: projectB, root: projectB },
      });

      const result = yield* report(
        ReportRequest.make({
          since: "2026-09-01",
          until: "2026-09-30",
          timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
          sources: [{ provider: "opencode", path: data }],
          projects: [
            { project: "A", paths: [projectA], repositories: [] },
            { project: "B", paths: [projectB], repositories: [] },
          ],
          pricing: PriceBook.make({
            status: "custom",
            fetchedAt: null,
            source: "test",
            prices: {},
          }),
        }),
      );

      assert.deepStrictEqual(
        result.rows.map((row) => [row.project, row.model, row.records]),
        [["A", "shared-model", 1]],
      );
      assert.strictEqual(result.coverage[0]?.duplicates, 2);
      assert.strictEqual(result.coverage[0]?.status, "ok");
      assert.isTrue(yield* fs.exists(path.join(data, "opencode-beta.db")));
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("opens a named database whatever its extension, and never reads one as text", () =>
    Effect.gen(function* () {
      const { request, root, path, data, write, database } = yield* history();

      const custom = yield* Effect.gen(function* () {
        const { file, db } = yield* database("custom.sqlite", v1Schema);
        yield* fill(
          db,
          "v1",
          [["ses_custom", path.join(root, "work", "a"), at("09:00:00")]],
          [
            [
              "msg_custom",
              "ses_custom",
              assistant("10:00:00", "openai", "custom-model", tokens(1, 1)),
            ],
          ],
        );

        return file;
      }).pipe(Effect.scoped);

      const ledger = yield* Ledger;

      const read = yield* ledger.report({
        ...request,
        sources: [{ provider: "opencode", path: custom }],
      });

      assert.deepStrictEqual(
        read.rows.map((row) => [row.project, row.model]),
        [["A", "custom-model"]],
      );

      // Not a database, though it holds a message: unreadable history, so stored usage is kept.
      const text = yield* write("broken.sqlite", {
        id: "msg_text",
        sessionID: "ses_text",
        ...assistant("10:00:00", "openai", "text-model", tokens(1, 1)),
      });

      const payload = yield* ledger.syncPayload(
        { ...request, sources: [{ provider: "opencode", path: text }] },
        client,
      );

      assert.deepStrictEqual(
        payload.coverage.map((entry) => [entry.provider, entry.status, entry.unreadable]),
        [["opencode", "failed", 1]],
      );
      assert.lengthOf(payload.buckets, 0);
      assert.strictEqual(path.dirname(text), data);
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("maps working directories OpenCode stored with forward slashes on Windows", () =>
    Effect.gen(function* () {
      const { request, database } = yield* history();

      const file = yield* Effect.gen(function* () {
        const { file, db } = yield* database("windows.db", v2Schema);
        yield* fill(
          db,
          "v2",
          [["ses_win", "C:/work/client/project", at("09:00:00")]],
          [
            [
              "win_step",
              "ses_win",
              stepData("10:00:00", "anthropic", "windows-model", tokens(2, 2)),
            ],
          ],
        );

        return file;
      }).pipe(Effect.scoped);

      const result = yield* report({
        ...request,
        sources: [{ provider: "opencode", path: file }],
        projects: [{ project: "Client", paths: ["C:\\work\\client"], repositories: [] }],
      }).pipe(Effect.provide(windows));

      assert.deepStrictEqual(
        result.rows.map((row) => [row.project, row.model]),
        [["Client", "windows-model"]],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("takes each store's session from its own generation when the two diverge", () =>
    Effect.gen(function* () {
      const { request, root, path, database } = yield* history();

      const file = yield* Effect.gen(function* () {
        const { file, db } = yield* database("diverged.db", schema);

        yield* Effect.sync(() => {
          // The same session, moved to B after the v2 store took it over.
          db.prepare("INSERT INTO session VALUES (?, ?, ?)").run(
            "ses_moved",
            path.join(root, "work", "a"),
            at("09:00:00"),
          );
          db.prepare("INSERT INTO session_v2 VALUES (?, ?, ?, NULL)").run(
            "ses_moved",
            path.join(root, "work", "b"),
            at("09:30:00"),
          );
          db.prepare("INSERT INTO message VALUES (?, ?, ?, ?, ?)").run(
            "msg_v1",
            "ses_moved",
            at("09:15:00"),
            at("09:15:00"),
            JSON.stringify(assistant("09:15:00", "anthropic", "v1-model", tokens(1, 1))),
          );
          db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            "v2_step",
            "ses_moved",
            "assistant",
            1,
            at("10:00:00"),
            at("10:00:00"),
            JSON.stringify(stepData("10:00:00", "anthropic", "v2-model", tokens(1, 1))),
          );
        });

        return file;
      }).pipe(Effect.scoped);

      const result = yield* report({ ...request, sources: [{ provider: "opencode", path: file }] });

      // Neither message predates its own generation's session, so neither is a fork's copy.
      assert.deepStrictEqual(
        result.rows.map((row) => [row.project, row.model, row.records]),
        [
          ["A", "v1-model", 1],
          ["B", "v2-model", 1],
        ],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("reads legacy history wherever a source is rooted, in any order of sources", () =>
    Effect.gen(function* () {
      const { fs, path, root, data, write } = yield* fixture();
      const projectA = path.join(root, "work", "a");
      const answer = assistant("10:00:00", "openai", "legacy-shared", tokens(8, 2));

      yield* write("storage/session/project/ses_parent.json", {
        id: "ses_parent",
        time: { created: at("09:00:00") },
      });
      yield* write("storage/session/project/ses_fork.json", {
        id: "ses_fork",
        time: { created: at("12:00:00") },
      });
      yield* write("storage/message/ses_parent/msg_a.json", {
        id: "msg_a",
        sessionID: "ses_parent",
        ...answer,
        path: { cwd: projectA, root: projectA },
      });
      yield* write("storage/message/ses_fork/msg_b.json", {
        id: "msg_b",
        sessionID: "ses_fork",
        ...answer,
      });
      yield* fs.makeDirectory(path.join(root, "unrelated"));
      yield* fs.writeFileString(path.join(root, "unrelated", "notes.txt"), "not history");

      const messages = path.join(data, "storage", "message");
      const sessions = path.join(data, "storage", "session", "project");

      const read = (paths: readonly string[]) =>
        report(
          ReportRequest.make({
            since: "2026-09-01",
            until: "2026-09-30",
            timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
            sources: paths.map((source) => ({ provider: "opencode" as const, path: source })),
            projects: [{ project: "A", paths: [projectA], repositories: [] }],
            pricing: PriceBook.make({
              status: "custom",
              fetchedAt: null,
              source: "test",
              prices: {},
            }),
          }),
        );

      // The fork's copy is known only from its session, whichever source is read first.
      for (const order of [
        [messages, sessions],
        [sessions, messages],
      ]) {
        const result = yield* read(order);

        assert.deepStrictEqual(
          result.rows.map((row) => [row.project, row.model, row.records]),
          [["A", "legacy-shared", 1]],
        );
        assert.deepStrictEqual(
          result.coverage.map((entry) => entry.status),
          ["ok", "ok"],
        );
        assert.strictEqual(
          result.coverage.reduce((sum, entry) => sum + entry.duplicates, 0),
          1,
        );
      }

      const single = yield* read([
        path.join(messages, "ses_parent"),
        sessions,
        path.join(root, "unrelated"),
      ]);

      assert.deepStrictEqual(
        single.coverage.map((entry) => [entry.status, entry.files]),
        [
          ["ok", 1],
          ["ok", 2],
          // Holding no OpenCode history is not evidence of none, so sync keeps stored usage.
          ["missing", 0],
        ],
      );
      assert.deepStrictEqual(
        single.rows.map((row) => [row.project, row.model, row.records]),
        [["A", "legacy-shared", 1]],
      );
    }).pipe(Effect.provide(runtime)),
  );

  it.effect("reads legacy files by name beside a database, wherever an export puts them", () =>
    Effect.gen(function* () {
      const { path, root, data, write, database } = yield* fixture();
      const projectA = path.join(root, "work", "a");

      const message = (id: string, model: string) => ({
        id,
        sessionID: "ses_parent",
        ...assistant("10:00:00", "openai", model, tokens(8, 2)),
        path: { cwd: projectA, root: projectA },
      });

      // A copied `storage` directory, and loose files, each beside an empty database.
      yield* write(
        "export/storage/message/ses_parent/msg_tree.json",
        message("msg_tree", "tree-model"),
      );
      yield* write("export/loose/msg_loose.json", message("msg_loose", "loose-model"));

      for (const directory of ["export/storage", "export/loose"])
        yield* database(path.join(directory, "opencode.db"), v1Schema).pipe(Effect.scoped);

      const result = yield* report(
        ReportRequest.make({
          since: "2026-09-01",
          until: "2026-09-30",
          timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
          sources: ["export/storage", "export/loose"].map((directory) => ({
            provider: "opencode" as const,
            path: path.join(data, directory),
          })),
          projects: [{ project: "A", paths: [projectA], repositories: [] }],
          pricing: PriceBook.make({
            status: "custom",
            fetchedAt: null,
            source: "test",
            prices: {},
          }),
        }),
      );

      assert.deepStrictEqual(
        result.rows.map((row) => [row.project, row.model, row.records]),
        [
          ["A", "loose-model", 1],
          ["A", "tree-model", 1],
        ],
      );
      assert.deepStrictEqual(
        result.coverage.map((entry) => [entry.status, entry.files]),
        [
          ["ok", 2],
          ["ok", 2],
        ],
      );
    }).pipe(Effect.provide(runtime)),
  );
});
