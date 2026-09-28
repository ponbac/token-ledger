import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Path } from "effect";

import { Ledger } from "./ledger.ts";
import { ReportRequest } from "./model.ts";

const runtime = Ledger.layer.pipe(Layer.provideMerge(NodeServices.layer));

it.effect("keeps local Git transports private and preserves network and Copilot identities", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "token-ledger-privacy-test-" });

    const write = Effect.fn("Test.write")(function* (name: string, lines: readonly string[]) {
      const file = path.join(root, name);
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(file, lines.join("\n") + "\n");
    });

    const remotes: readonly (readonly [string, string])[] = [
      ["internal-worktrees/private-project.git", "unattributed"],
      ["private-project.bundle", "unattributed"],
      ["../private-project.git", "unattributed"],
      ["/srv/git/private-project.git", "unattributed"],
      ["file:///srv/git/private-project.git", "unattributed"],
      ["file://fileserver/srv/git/private-project.git", "unattributed"],
      ["C:\\private-project.git", "unattributed"],
      ["C:/private-project.git", "unattributed"],
      ["\\\\fileserver\\private-project.git", "unattributed"],
      ["local-helper://fileserver/private-project.git", "unattributed"],
      ["http://example.com/team/project.git", "example.com/team/project"],
      ["https://user:secret@example.com/team/project.git", "example.com/team/project"],
      ["ssh://git@example.com/team/project.git", "example.com/team/project"],
      ["git://example.com/team/project.git", "example.com/team/project"],
      ["ftp://example.com/team/project.git", "example.com/team/project"],
      ["ftps://example.com/team/project.git", "example.com/team/project"],
      ["git@example.com:team/project.git", "example.com/team/project"],
      ["example.com:team/project.git", "example.com/team/project"],
    ];

    const expected = remotes.flatMap(([, project], index) => [
      [`origin-${index}`, project],
      [`metadata-${index}`, project],
      [`copilot-${index}`, project],
    ]);

    const usage = JSON.stringify({
      type: "event_msg",
      timestamp: "2026-09-22T10:00:00Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 1, output_tokens: 1 },
          total_token_usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    });

    for (const [index, [remote]] of remotes.entries()) {
      const cwd = path.join(root, `repo-${index}`);
      yield* write(`repo-${index}/.git/config`, ['[remote "origin"]', `url = ${remote}`]);

      for (const metadata of [
        { id: `origin-${index}`, cwd },
        { id: `metadata-${index}`, git: { repository_url: remote } },
      ])
        yield* write(`codex/${metadata.id}.jsonl`, [
          JSON.stringify({ type: "session_meta", payload: metadata }),
          JSON.stringify({ type: "turn_context", payload: { model: metadata.id } }),
          usage,
        ]);

      yield* write(`copilot/remote-${index}.jsonl`, [
        JSON.stringify({
          type: "span",
          traceId: `copilot-${index}`,
          spanId: "chat",
          endTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
          attributes: {
            "gen_ai.operation.name": "chat",
            "gen_ai.response.model": `copilot-${index}`,
            "gen_ai.usage.input_tokens": 1,
            "gen_ai.usage.output_tokens": 1,
            "copilot_chat.repo.remote_url": remote,
          },
        }),
      ]);
    }

    yield* write("copilot/identity.jsonl", [
      JSON.stringify({
        type: "span",
        traceId: "copilot-identity",
        spanId: "chat",
        endTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.model": "copilot-identity",
          "gen_ai.usage.input_tokens": 1,
          "gen_ai.usage.output_tokens": 1,
          "github.copilot.git.repository": "team/project",
        },
      }),
    ]);

    const ledger = yield* Ledger;

    const payload = yield* ledger.syncPayload(
      ReportRequest.make({
        since: "2026-09-22",
        until: "2026-09-22",
        timeZone: DateTime.zoneMakeNamedUnsafe("UTC"),
        sources: [
          { provider: "codex", path: path.join(root, "codex") },
          { provider: "copilot", path: path.join(root, "copilot") },
        ],
        projects: [],
        pricing: { status: "custom", fetchedAt: null, source: "fixture", prices: {} },
      }),
      {
        machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
        version: "0.0.0-test",
      },
    );

    assert.deepStrictEqual(
      payload.buckets
        .map((bucket) => [bucket.model, bucket.project])
        .toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      [...expected, ["copilot-identity", "team/project"]].toSorted((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    );
  }).pipe(Effect.provide(runtime)),
);
