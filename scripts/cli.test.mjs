import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { UsageReport } from "../packages/core/src/model.ts";

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
          env: { ...process.env, HOME: directory, XDG_CACHE_HOME: directory },
        },
      );

    const json = run(["--format", "json", "--project", "Client A", "--strict"]);

    assert.equal(json.error, undefined);
    assert.equal(json.status, 0, json.stderr);

    const report = decodeReport(json.stdout);

    assert.equal(report.rows[0]?.project, "Client A");
    assert.equal(report.rows[0]?.tokens.cacheRead, 60);
    assert.equal(report.rows[0]?.estimatedCostUsd, 0.000292);

    const shortcut = run(["--json", "--format", "csv", "--project", "Client A", "--strict"]);

    assert.equal(shortcut.status, 0, shortcut.stderr);
    assert.deepEqual(decodeReport(shortcut.stdout), report);

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
