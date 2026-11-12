import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path, Result } from "effect";

import { Ledger } from "./ledger.ts";
import { ReportRequest, RepositoryReference, type UsageRecord } from "./model.ts";
import { projectResolver } from "./projects.ts";

const runtime = Ledger.layer.pipe(Layer.provideMerge(NodeServices.layer));

const client = {
  machine: { id: "fbd63df0-64bb-484c-aa8d-f7c37bd6bfe7", label: "fixture" },
  version: "test",
};

function record(cwd: string): UsageRecord {
  return {
    provider: "claude",
    id: cwd,
    session: "fixture",
    timestamp: 0,
    model: "test",
    cwd,
    repository: null,
    tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
  };
}

const fixture = Effect.fn("Test.historyFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-history-" });
  const worktree = path.join(root, "worktree");
  const history = path.join(root, "history");
  const git = path.join(root, "repo", ".git");
  yield* fs.makeDirectory(path.join(git, "worktrees", "feature"), { recursive: true });
  yield* fs.makeDirectory(worktree);
  yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${git}/worktrees/feature\n`);
  yield* fs.writeFileString(path.join(git, "worktrees", "feature", "commondir"), "../..\n");
  yield* fs.writeFileString(
    path.join(git, "config"),
    '[remote "origin"]\nurl = https://user:secret@example.com/team/app.git\n',
  );
  const transcript = path.join(root, "session.jsonl");
  yield* fs.writeFileString(
    transcript,
    JSON.stringify({
      type: "assistant",
      sessionId: "session",
      cwd: path.join(worktree, "src"),
      timestamp: "2026-09-22T10:00:00Z",
      message: {
        id: "message",
        model: "test",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    }) + "\n",
  );
  const localHistory = { repositoryHistory: { directory: history, required: true } };

  const request = ReportRequest.make({
    ...localHistory,
    since: "2026-09-22",
    until: "2026-09-22",
    timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
    sources: [{ provider: "claude", path: transcript }],
    projects: [],
    pricing: { status: "custom", source: "fixture", fetchedAt: null, prices: {} },
  });

  return { fs, path, root, worktree, history, git, request };
});

it.effect("keeps a worktree's repository across independent scans after deletion", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, history, request } = yield* fixture();
    const ledger = yield* Ledger;
    const first = yield* ledger.syncPayload(request, client);
    assert.strictEqual(first.buckets[0]?.project, "example.com/team/app");
    yield* fs.remove(worktree, { recursive: true });
    const second = yield* ledger.syncPayload(request, client);
    assert.deepStrictEqual(second.buckets, first.buckets);

    for (const name of yield* fs.readDirectory(history)) {
      const saved = yield* fs.readFileString(path.join(history, name));
      assert.notInclude(saved, "secret");
      assert.notInclude(saved, worktree);
    }

    const overridden = yield* ledger.syncPayload(
      {
        ...request,
        projects: [{ project: "Explicit client", paths: [worktree], repositories: [] }],
      },
      client,
    );

    assert.strictEqual(overridden.buckets[0]?.project, "Explicit client");
  }).pipe(Effect.provide(runtime)),
);

it.effect("uses live repository changes and refuses an unreadable history before uploading", () =>
  Effect.gen(function* () {
    const { fs, path, git, worktree, history, request } = yield* fixture();
    const ledger = yield* Ledger;
    yield* ledger.syncPayload(request, client);
    yield* fs.writeFileString(
      path.join(git, "config"),
      '[remote "origin"]\nurl = https://example.com/team/renamed.git\n',
    );
    const changed = yield* ledger.syncPayload(request, client);
    assert.strictEqual(changed.buckets[0]?.project, "example.com/team/renamed");
    yield* fs.remove(worktree, { recursive: true });
    const remembered = yield* ledger.syncPayload(request, client);
    assert.deepStrictEqual(remembered.buckets, changed.buckets);

    for (const name of yield* fs.readDirectory(history))
      yield* fs.writeFileString(path.join(history, name), "damaged");

    const unreadable = yield* ledger.syncPayload(request, client).pipe(Effect.result);
    assert.isTrue(Result.isFailure(unreadable));

    if (Result.isFailure(unreadable)) {
      assert.strictEqual(unreadable.failure._tag, "RepositoryHistoryError");
      assert.include(unreadable.failure.message, "repository history");
    }

    yield* fs.remove(history, { recursive: true });
    yield* fs.writeFileString(history, "not a directory");
    yield* fs.makeDirectory(worktree);
    yield* fs.writeFileString(path.join(worktree, ".git"), `gitdir: ${git}/worktrees/feature\n`);
    const unsaved = yield* ledger.syncPayload(request, client).pipe(Effect.result);
    assert.isTrue(Result.isFailure(unsaved));
  }).pipe(Effect.provide(runtime)),
);

it.effect("retains concurrent scans and does not reuse history for a repurposed directory", () =>
  Effect.gen(function* () {
    const first = yield* fixture();
    const second = yield* fixture();
    const ledger = yield* Ledger;

    const requests = [
      first.request,
      {
        ...second.request,
        repositoryHistory: { directory: first.history, required: true },
      },
    ];

    const initial = yield* Effect.all(
      requests.map((request) => ledger.syncPayload(request, client)),
      { concurrency: 2 },
    );

    yield* first.fs.remove(first.worktree, { recursive: true });
    yield* second.fs.remove(second.worktree, { recursive: true });

    const restored = yield* Effect.all(
      requests.map((request) => ledger.syncPayload(request, client)),
      { concurrency: 2 },
    );

    assert.deepStrictEqual(
      restored.map((payload) => payload.buckets),
      initial.map((payload) => payload.buckets),
    );

    yield* first.fs.makeDirectory(first.worktree);
    const reused = yield* ledger.syncPayload(first.request, client);
    assert.strictEqual(reused.buckets[0]?.project, "unattributed");
    yield* first.fs.remove(first.worktree, { recursive: true });
    const deletedAgain = yield* ledger.syncPayload(first.request, client);
    assert.deepStrictEqual(deletedAgain.buckets, reused.buckets);
  }).pipe(Effect.provide(runtime)),
);

it.effect("keeps the more specific deleted worktree inside an outer Git repository", () =>
  Effect.gen(function* () {
    const { fs, path, root, worktree, request } = yield* fixture();
    yield* fs.makeDirectory(path.join(root, ".git"));
    yield* fs.writeFileString(
      path.join(root, ".git", "config"),
      '[remote "origin"]\nurl = https://example.com/me/dotfiles.git\n',
    );
    const ledger = yield* Ledger;
    const first = yield* ledger.syncPayload(request, client);
    yield* fs.remove(worktree, { recursive: true });
    const second = yield* ledger.syncPayload(request, client);
    assert.deepStrictEqual(second.buckets, first.buckets);
  }).pipe(Effect.provide(runtime)),
);

it.effect(
  "remembers supported SCP paths and non-HTTPS default ports without changing identities",
  () =>
    Effect.gen(function* () {
      const ledger = yield* Ledger;

      for (const [remote, expected] of [
        ["git@host.example:café/repo.git", "host.example/café/repo"],
        [
          "git@ssh.dev.azure.com:v3/org/My Project/repo",
          "ssh.dev.azure.com/v3/org/My Project/repo",
        ],
        ["git@host.example:team/back\\slash.git", "host.example/team/back\\slash"],
        ["ssh://host.example:443/team/app.git", "host.example:443/team/app"],
      ]) {
        const { fs, path, git, worktree, request } = yield* fixture();
        yield* fs.writeFileString(path.join(git, "config"), `[remote "origin"]\nurl = ${remote}\n`);
        const first = yield* ledger.syncPayload(request, client);
        assert.strictEqual(first.buckets[0]?.project, expected);
        yield* fs.remove(worktree, { recursive: true });
        const second = yield* ledger.syncPayload(request, client);
        assert.deepStrictEqual(second.buckets, first.buckets);
      }
    }).pipe(Effect.provide(runtime)),
);

it.effect("uses facts observed earlier in the same scan before its final save", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, history } = yield* fixture();
    const projects = yield* projectResolver([], { directory: history, required: true });
    const first = yield* projects.resolve(record(path.join(worktree, "src")), undefined);
    yield* fs.remove(worktree, { recursive: true });
    const second = yield* projects.resolve(record(path.join(worktree, "tests")), undefined);
    assert.deepStrictEqual(second, first);
    assert.isTrue(second.shareable);
  }).pipe(Effect.provide(runtime)),
);

it.effect("uses recorded repository metadata without consulting damaged directory history", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, history, request } = yield* fixture();
    const ledger = yield* Ledger;
    yield* ledger.syncPayload(request, client);
    yield* fs.remove(worktree, { recursive: true });

    for (const name of yield* fs.readDirectory(history))
      yield* fs.writeFileString(path.join(history, name), "damaged");

    const projects = yield* projectResolver(
      [
        {
          project: "Explicit repository",
          paths: [],
          repositories: ["https://example.com/team/app.git"],
        },
      ],
      { directory: history, required: true },
    );

    const attribution = yield* projects.resolve(
      {
        ...record(worktree),
        repository: RepositoryReference.Remote({ value: "https://example.com/team/app.git" }),
      },
      undefined,
    );

    assert.strictEqual(attribution.project, "Explicit repository");
  }).pipe(Effect.provide(runtime)),
);

it.effect("reports live usage when repository history cannot be saved", () =>
  Effect.gen(function* () {
    const { fs, history, worktree, request } = yield* fixture();
    yield* fs.writeFileString(history, "not a directory");
    const ledger = yield* Ledger;
    const warnings: string[] = [];

    const warn = (message: string) =>
      Effect.sync(() => {
        warnings.push(message);
      });

    const report = yield* ledger.report(request, warn);
    assert.strictEqual(report.rows[0]?.project, "example.com/team/app");
    assert.include(warnings[0] ?? "", history);
    yield* fs.remove(worktree, { recursive: true });
    const missing = yield* ledger.report(request, warn);
    assert.strictEqual(missing.rows[0]?.records, 1);
    assert.isAbove(warnings.length, 1);
  }).pipe(Effect.provide(runtime)),
);

it.effect("warns once for a damaged root used by many working directories in one scan", () =>
  Effect.gen(function* () {
    const { fs, path, worktree, history, request } = yield* fixture();
    const ledger = yield* Ledger;
    yield* ledger.syncPayload(request, client);
    yield* fs.remove(worktree, { recursive: true });

    for (const name of yield* fs.readDirectory(history))
      yield* fs.writeFileString(path.join(history, name), "damaged");
    const warnings: string[] = [];

    const projects = yield* projectResolver(
      [],
      { directory: history, required: false },
      (message) =>
        Effect.sync(() => {
          warnings.push(message);
        }),
    );

    for (let index = 0; index < 20; index++)
      yield* projects.resolve(record(path.join(worktree, `folder-${index}`)), undefined);
    assert.lengthOf(warnings, 1);
  }).pipe(Effect.provide(runtime)),
);

it.effect("does not revive a network origin after observing a local or absent origin", () =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;

    for (const config of ['[remote "origin"]\nurl = ../local.git\n', "[core]\nbare = false\n"]) {
      const { fs, path, root, git, worktree, request } = yield* fixture();
      yield* fs.makeDirectory(path.join(root, ".git"));
      yield* fs.writeFileString(
        path.join(root, ".git", "config"),
        '[remote "origin"]\nurl = https://example.com/me/outer.git\n',
      );
      const first = yield* ledger.syncPayload(request, client);
      assert.strictEqual(first.buckets[0]?.project, "example.com/team/app");
      yield* fs.writeFileString(path.join(git, "config"), config);
      const repurposed = yield* ledger.syncPayload(request, client);
      assert.strictEqual(repurposed.buckets[0]?.project, "unattributed");
      yield* fs.remove(worktree, { recursive: true });
      const deleted = yield* ledger.syncPayload(request, client);
      assert.deepStrictEqual(deleted.buckets, repurposed.buckets);
    }
  }).pipe(Effect.provide(runtime)),
);
