import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { UsageReport } from "../packages/core/src/model.ts";
import { SyncMachine, SyncPayload } from "../packages/core/src/sync.ts";

const packageDirectory = fileURLToPath(new URL("../dist/npm", import.meta.url));

const PackedArchive = Schema.Struct({
  filename: Schema.String,
  files: Schema.Array(Schema.Struct({ path: Schema.String })),
});

const decodePack = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Union([Schema.Array(PackedArchive), Schema.Record(Schema.String, PackedArchive)]),
  ),
);

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.String,
      dependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(UsageReport));

const decodePayload = Schema.decodeUnknownSync(Schema.fromJsonString(SyncPayload));

const decodeMachine = Schema.decodeUnknownSync(Schema.fromJsonString(SyncMachine));

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

await test("npm artifact installs offline and exports reports with correct coverage and exit codes", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-cli-"));

  try {
    /** @param {string[]} args */
    const npm = (args) => {
      const result = spawnSync("npm", args, {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        shell: process.platform === "win32",
      });

      assert.equal(result.error, undefined);
      assert.equal(result.status, 0, result.stderr);

      return result.stdout;
    };

    const packed = Object.values(
      decodePack(npm(["pack", packageDirectory, "--json", "--ignore-scripts", "--offline"])),
    );

    assert.equal(packed.length, 1);
    const archive = packed[0];
    assert.ok(archive);
    assert.deepEqual(archive.files.map((file) => file.path).toSorted(), [
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.txt",
      "dist/main.js",
      "package.json",
    ]);
    npm([
      "install",
      join(directory, archive.filename),
      "--offline",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const installed = join(directory, "node_modules/@ponbac/token-ledger");
    const manifest = decodeManifest(readFileSync(join(installed, "package.json"), "utf8"));
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.scripts, undefined);
    assert.equal(
      npm(["exec", "--offline", "--", "token-ledger", "--version"]).trim(),
      `token-ledger v${manifest.version}`,
    );
    const executable = join(installed, "dist/main.js");
    const history = join(directory, "history.jsonl");
    const configuration = join(directory, "token-ledger.json");

    writeFileSync(
      history,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "fixture-session" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "fixture-model" } }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-22T12:00:00Z",
          payload: {
            type: "token_count",
            info: {
              last_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 20 },
            },
          },
        }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      configuration,
      JSON.stringify({
        prices: { "fixture-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null } },
      }),
    );

    /** @param {string[]} args */
    const run = (args) =>
      spawnSync(
        process.execPath,
        [
          executable,
          "report",
          "--provider",
          "codex",
          "--source",
          history,
          "--config",
          configuration,
          "--offline",
          "--since",
          "2026-09-22",
          "--until",
          "2026-09-22",
          ...args,
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, HOME: directory, XDG_CACHE_HOME: directory, TZ: "Asia/Tokyo" },
        },
      );

    const json = run(["--format", "json", "--project", "Client A", "--strict"]);

    assert.equal(json.error, undefined);
    assert.equal(json.status, 0, json.stderr);

    const report = decodeReport(json.stdout);

    assert.equal(report.timeZone, "Asia/Tokyo");
    assert.equal(report.rows[0]?.project, "Client A");
    assert.equal(report.rows[0]?.tokens.cacheRead, 60);
    assert.equal(report.rows[0]?.estimatedCostUsd, 0.000292);

    const shortcut = run(["--json", "--format", "csv", "--project", "Client A", "--strict"]);

    assert.equal(shortcut.status, 0, shortcut.stderr);
    assert.deepEqual(decodeReport(shortcut.stdout), report);

    const zoned = run(["--json", "--time-zone", "Europe/Stockholm"]);

    assert.equal(zoned.status, 0, zoned.stderr);
    assert.equal(decodeReport(zoned.stdout).timeZone, "Europe/Stockholm");
    assert.equal(run(["--time-zone", "Mars/Olympus"]).status, 1);

    const csv = run(["--format", "csv", "--project", "=formula"]);

    assert.equal(csv.status, 0, csv.stderr);
    assert.match(csv.stdout, /"'=formula"/);
    assert.equal(csv.stdout.trim().split("\n").length, 3);
    assert.doesNotMatch(csv.stderr, /ExperimentalWarning.*SQLite/);

    writeFileSync(configuration, "{}");

    const incomplete = run(["--json", "--strict"]);

    assert.equal(incomplete.status, 2);
    assert.equal(decodeReport(incomplete.stdout).rows[0]?.estimatedCostUsd, null);
    assert.match(incomplete.stderr, /Pricing unavailable/);

    writeFileSync(configuration, "{invalid");

    const invalid = run([]);

    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr + invalid.stdout, /Cannot read or decode configuration/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("sync uploads an identical payload on every run and exits 4 when refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-sync-"));
  const token = "toki_fixture_secret";
  /** @type {{ method: string | undefined; url: string | undefined; authorization: string | undefined; body: string }[]} */
  const requests = [];
  let status = 200;

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { storedBuckets: 1 } : {}));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));

  try {
    const history = join(directory, "history.jsonl");

    writeFileSync(
      history,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "fixture-session" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "fixture-model" } }),
        JSON.stringify({
          type: "event_msg",
          timestamp: "2026-09-22T12:00:00Z",
          payload: {
            type: "token_count",
            info: { last_token_usage: { input_tokens: 100, output_tokens: 20 } },
          },
        }),
      ].join("\n") + "\n",
    );

    const configuration = join(directory, "token-ledger.json");

    writeFileSync(
      configuration,
      JSON.stringify({ sources: [{ provider: "codex", path: history }] }),
    );

    /** @param {string[]} args @returns {Promise<{ status: number | null; stdout: string; stderr: string }>} */
    const run = (args) =>
      new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            join(packageDirectory, "dist/main.js"),
            "sync",
            "--config",
            configuration,
            "--offline",
            "--since",
            "2026-09-22",
            "--until",
            "2026-09-22",
            "--time-zone",
            "Europe/Stockholm",
            ...args,
          ],
          {
            cwd: directory,
            env: {
              ...process.env,
              HOME: directory,
              XDG_CACHE_HOME: directory,
              XDG_CONFIG_HOME: join(directory, "config"),
              TOKEN_LEDGER_SERVER: `http://127.0.0.1:${decodeAddress(server.address()).port}`,
              TOKI_API_TOKEN: token,
            },
          },
        );

        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => resolve({ status: code, stdout, stderr }));
      });

    const first = await run([]);

    assert.equal(first.status, 0, first.stderr);

    const machine = decodeMachine(
      readFileSync(join(directory, "config/token-ledger/machine.json"), "utf8"),
    );

    assert.equal(requests[0]?.method, "PUT");
    assert.equal(requests[0]?.url, `/ai-usage/machines/${machine.id}/usage`);
    assert.equal(requests[0]?.authorization, `Bearer ${token}`);

    const payload = decodePayload(requests[0]?.body ?? "");

    assert.deepEqual(payload.machine, machine);
    assert.equal(payload.buckets.length, 1);
    assert.match(first.stdout, /server stored 1/);

    const second = await run([]);

    assert.equal(second.status, 0, second.stderr);
    assert.equal(requests[1]?.body, requests[0]?.body);

    const dryRun = await run(["--dry-run"]);

    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(requests.length, 2);
    assert.deepEqual(decodePayload(dryRun.stdout), payload);

    status = 401;
    const refused = await run([]);

    assert.equal(refused.status, 4);

    for (const output of [first, second, dryRun, refused])
      assert.doesNotMatch(output.stdout + output.stderr, new RegExp(token));
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
