import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import { UsageReport } from "../packages/core/src/model.ts";

const executable = fileURLToPath(new URL("../packages/cli/dist/main.js", import.meta.url));

const decodeReport = Schema.decodeUnknownSync(Schema.fromJsonString(UsageReport));

await test("built CLI exports reports, protects CSV cells, and exposes incomplete pricing through exit codes", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-cli-"));

  try {
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

    const csv = run(["--format", "csv", "--project", "=formula"]);

    assert.equal(csv.status, 0, csv.stderr);
    assert.match(csv.stdout, /"'=formula"/);
    assert.equal(csv.stdout.trim().split("\n").length, 2);

    writeFileSync(configuration, "{}");

    const incomplete = run(["--format", "json", "--strict"]);

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
