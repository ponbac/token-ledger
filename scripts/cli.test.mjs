import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { Match, Schema } from "effect";

import { UsageReport } from "../packages/core/src/model.ts";
import { RepricePayload, SyncMachine, SyncPayload } from "../packages/core/src/sync.ts";

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

const decodeReprice = Schema.decodeUnknownSync(Schema.fromJsonString(RepricePayload));

const decodeAddress = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Number }));

const decodeSettings = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ server: Schema.String, token: Schema.String })),
);

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

await test("sync uploads the same usage on every run, rescans once when superseded and exits 4 when refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-sync-"));
  const token = "toki_fixture_secret";
  /** @type {{ method: string | undefined; url: string | undefined; authorization: string | undefined; body: string }[]} */
  const requests = [];
  let status = 200;
  /** @type {number[]} Statuses for the next uploads, before `status` applies. */
  const answers = [];

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
      const answer = answers.shift() ?? status;
      response.writeHead(answer, { "content-type": "application/json" });
      response.end(JSON.stringify(answer === 200 ? { storedBuckets: 1 } : {}));
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

    const { snapshotAt, ...payload } = decodePayload(requests[0]?.body ?? "");

    assert.deepEqual(payload.machine, machine);
    assert.equal(payload.buckets.length, 1);
    assert.match(first.stdout, /server stored 1/);

    const second = await run([]);

    assert.equal(second.status, 0, second.stderr);
    const { snapshotAt: later, ...resent } = decodePayload(requests[1]?.body ?? "");
    assert.deepEqual(resent, payload);
    // The server keeps the upload whose scan began last.
    assert.ok(snapshotAt !== undefined && later !== undefined && later > snapshotAt);

    const dryRun = await run(["--dry-run"]);

    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(requests.length, 2);
    const { snapshotAt: _shown, ...shown } = decodePayload(dryRun.stdout);
    assert.deepEqual(shown, payload);

    // A newer upload need not hold this window, so a superseded one is scanned and sent again.
    answers.push(409);
    const rescanned = await run([]);

    assert.equal(rescanned.status, 0, rescanned.stderr);
    assert.equal(requests.length, 4);
    assert.match(rescanned.stderr, /reached the server first; scanning/);
    assert.match(rescanned.stdout, /Synced/);
    const { snapshotAt: stale } = decodePayload(requests[2]?.body ?? "");
    const { snapshotAt: fresh } = decodePayload(requests[3]?.body ?? "");
    assert.ok(stale !== undefined && fresh !== undefined && fresh > stale);

    status = 409;
    const superseded = await run([]);

    assert.equal(superseded.status, 7, superseded.stderr);
    assert.equal(requests.length, 6);
    assert.match(superseded.stderr, /superseded by a newer sync from this machine/);
    assert.doesNotMatch(superseded.stdout, /Synced/);

    status = 401;
    const refused = await run([]);

    assert.equal(refused.status, 4);

    for (const output of [first, second, dryRun, rescanned, superseded, refused])
      assert.doesNotMatch(output.stdout + output.stderr, new RegExp(token));
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("a machine's first sync uploads all its history, and only while the server holds nothing for it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-first-"));
  /** @type {string[]} */
  const bodies = [];
  /** @type {number[]} */
  const refusals = [];
  /** Machines the server has stored an upload from, as toki2 registers them. @type {Set<string>} */
  const registered = new Set();
  /** How the next questions are answered; the last entry answers every later one. @type {("list" | "error" | "redirect" | "partial")[]} */
  let answers = ["list"];
  let asked = 0;
  const statuses = { list: 200, error: 500, partial: 206, redirect: 302 };

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/elsewhere") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ staleAfterDays: 7, from: "2026-09-01", to: "2026-09-30", machines: [] }),
        );

        return;
      }

      if (request.method === "GET") {
        const answer = answers[Math.min(asked, answers.length - 1)];

        asked += 1;

        if (answer === "redirect") {
          response.writeHead(302, { location: "/elsewhere" });
          response.end();

          return;
        }

        response.writeHead(statuses[answer ?? "list"], { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            staleAfterDays: 7,
            from: "2026-09-01",
            to: "2026-09-30",
            machines: [...registered].map((machineId) => ({ machineId })),
          }),
        );

        return;
      }

      const status = refusals.shift() ?? 200;

      bodies.push(body);

      if (status === 200) registered.add(decodePayload(body).machine.id);

      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(status === 200 ? { storedBuckets: 1 } : {}));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));

  try {
    const history = join(directory, "history.jsonl");

    // Codex takes a token event equal to the one before it for a repeat, so the counts differ.
    /** @param {string} timestamp @param {number} input */
    const usage = (timestamp, input) =>
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: input, output_tokens: 20 } },
        },
      });

    writeFileSync(
      history,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "fixture-session" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "fixture-model" } }),
        usage("2026-03-05T12:00:00Z", 100),
        usage("2026-09-22T12:00:00Z", 150),
      ].join("\n") + "\n",
    );

    const configuration = join(directory, "token-ledger.json");

    writeFileSync(
      configuration,
      JSON.stringify({ sources: [{ provider: "codex", path: history }] }),
    );

    /** @param {string} home @param {string[]} args @param {boolean} credentials @returns {Promise<{ status: number | null; stdout: string; stderr: string }>} */
    const run = (home, args, credentials = true) =>
      new Promise((resolve) => {
        const { TOKEN_LEDGER_SERVER: _server, TOKI_API_TOKEN: _token, ...env } = process.env;

        const settings = {
          ...env,
          HOME: directory,
          XDG_CACHE_HOME: directory,
          XDG_CONFIG_HOME: join(directory, home),
        };

        const child = spawn(
          process.execPath,
          [
            join(packageDirectory, "dist/main.js"),
            "sync",
            "--config",
            configuration,
            "--offline",
            "--until",
            "2026-09-22",
            "--time-zone",
            "UTC",
            ...args,
          ],
          {
            cwd: directory,
            env: credentials
              ? {
                  ...settings,
                  TOKEN_LEDGER_SERVER: `http://127.0.0.1:${decodeAddress(server.address()).port}`,
                  TOKI_API_TOKEN: "toki_fixture_secret",
                }
              : settings,
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

    /** @param {string | undefined} body */
    const sent = (body) => {
      const { window, buckets } = decodePayload(body ?? "");

      return [window.start, window.end, buckets.map((bucket) => bucket.hourStart)];
    };

    const march = "2026-03-05T12:00:00.000Z";
    const september = "2026-09-22T12:00:00.000Z";
    const all = ["2026-03-05T00:00:00.000Z", "2026-09-23T00:00:00.000Z", [march, september]];
    const fortnight = ["2026-09-09T00:00:00.000Z", "2026-09-23T00:00:00.000Z", [september]];

    // With no server to ask, a dry run says so and shows the usual window.
    const blind = await run("config", ["--dry-run"], false);

    assert.equal(blind.status, 0, blind.stderr);
    assert.match(blind.stderr, /No server and API token to ask/);
    assert.deepEqual(sent(blind.stdout), fortnight);

    // With one, it shows the whole history a first upload would send, and uploads nothing.
    const preview = await run("config", ["--dry-run"]);

    assert.equal(preview.status, 0, preview.stderr);
    assert.deepEqual(sent(preview.stdout), all);
    assert.equal(bodies.length, 0);

    const first = await run("config", []);

    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /First upload from this machine.*from 2026-03-05/);
    assert.match(first.stdout, /2026-03-05 through 2026-09-22/);
    assert.deepEqual(sent(bodies[0]), all);

    // The server now lists the machine, whatever the settings directory remembers: restored
    // settings, a lost acknowledgement, or another version of the CLI change nothing.
    const second = await run("config", []);

    assert.equal(second.status, 0, second.stderr);
    assert.doesNotMatch(second.stderr, /First upload|Could not ask/);
    assert.deepEqual(sent(bodies[1]), fortnight);

    // The same settings pointed at a server that holds nothing get their history there too.
    registered.clear();

    const moved = await run("config", []);

    assert.equal(moved.status, 0, moved.stderr);
    assert.deepEqual(sent(bodies[2]), all);

    // A reply that is not plainly the server's own list is no licence for a long window: an
    // error, a partial response, and a redirect to something that answers with an empty list.
    for (const [index, answer] of /** @type {const} */ ([
      "error",
      "partial",
      "redirect",
    ]).entries()) {
      asked = 0;
      answers = [answer];

      const unanswered = await run(`unanswered-${answer}`, []);

      assert.equal(unanswered.status, 0, unanswered.stderr);
      assert.match(unanswered.stderr, /Could not ask the server.*--since/, answer);
      assert.deepEqual(sent(bodies[3 + index]), fortnight, answer);
    }

    // An upload that arrives from this machine while its history is being scanned is not
    // replaced: the server is asked again just before sending.
    await run("overtaken", ["--dry-run"], false);

    const overtaken = decodeMachine(
      readFileSync(join(directory, "overtaken/token-ledger/machine.json"), "utf8"),
    );

    asked = 0;
    answers = ["list", "list"];
    registered.clear();

    const asking = run("overtaken", []);

    // Registered after the first question has certainly been answered, before the second.
    while (asked < 1) await new Promise((resolve) => setTimeout(resolve, 5));

    registered.add(overtaken.id);

    const late = await asking;

    assert.equal(late.status, 0, late.stderr);
    assert.match(late.stderr, /has uploaded since it was asked about/);
    assert.deepEqual(sent(bodies[6]), fortnight);

    // A history the server refuses must not keep a machine from syncing at all.
    refusals.push(413);

    const refused = await run("large", []);

    assert.equal(refused.status, 0, refused.stderr);
    assert.match(refused.stderr, /rejected the upload \(413\).*--since and --until/);
    assert.deepEqual(sent(bodies[7]), all);
    assert.deepEqual(sent(bodies[8]), fortnight);

    // A first upload narrowed to one tool says that the others are not sent in full later.
    const narrowed = await run("narrowed", ["--provider", "codex", "--dry-run"]);

    assert.equal(narrowed.status, 0, narrowed.stderr);
    assert.match(narrowed.stderr, /Only codex is included.*--provider and --since/);
    assert.deepEqual(sent(narrowed.stdout), all);

    // An explicit --since is the window, on a first upload as on any other, with no question.
    asked = 0;

    const chosen = await run("chosen", ["--since", "2026-09-20"]);

    assert.equal(chosen.status, 0, chosen.stderr);
    assert.doesNotMatch(chosen.stderr, /First upload/);
    assert.equal(asked, 0);
    assert.deepEqual(sent(bodies[9]), [
      "2026-09-20T00:00:00.000Z",
      "2026-09-23T00:00:00.000Z",
      [september],
    ]);
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("sync reprices stored usage before its window once per pricing basis, and never fails for it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-reprice-"));
  const token = "toki_fixture_secret";
  /** @type {{ method: string | undefined; url: URL; body: string }[]} */
  const requests = [];
  /** Where the server says the machine's stale codex usage starts. */
  let from = "2026-09-15T08:00:00Z";
  let discoveryStatus = 200;
  let repriceStatus = 200;

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      requests.push({ method: request.method, url, body });

      /** @param {number} status @param {unknown} answer */
      const reply = (status, answer) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(answer));
      };

      if (request.method === "PUT") return reply(200, { storedBuckets: 1 });

      if (request.method === "GET")
        return reply(discoveryStatus, {
          floor: "2026-09-01T00:00:00Z",
          providers: [
            // Not a source of this sync, so it is left alone.
            { provider: "claude", from: "2026-09-10T00:00:00Z", staleBuckets: 4 },
            { provider: "codex", from, staleBuckets: 1 },
          ],
        });

      return reply(
        repriceStatus,
        repriceStatus === 200
          ? { updated: decodeReprice(body).buckets.length, unmatched: 0, beforeFloor: 0 }
          : { error: "refused" },
      );
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));

  try {
    const history = join(directory, "history.jsonl");

    /** @param {string} timestamp @param {number} input */
    const usage = (timestamp, input) =>
      JSON.stringify({
        type: "event_msg",
        timestamp,
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: input, output_tokens: 20 } },
        },
      });

    writeFileSync(
      history,
      [
        JSON.stringify({ type: "session_meta", payload: { id: "fixture-session" } }),
        JSON.stringify({ type: "turn_context", payload: { model: "fixture-model" } }),
        usage("2026-09-15T08:10:00Z", 100),
        usage("2026-09-22T12:00:00Z", 150),
      ].join("\n") + "\n",
    );

    const configuration = join(directory, "token-ledger.json");

    writeFileSync(
      configuration,
      JSON.stringify({ sources: [{ provider: "codex", path: history }] }),
    );

    // Cached vendor rates establish a pricing basis offline, as fetched ones do.
    mkdirSync(join(directory, "token-ledger"), { recursive: true });
    writeFileSync(
      join(directory, "token-ledger/prices-v2.json"),
      JSON.stringify({
        status: "fresh",
        fetchedAt: "2026-09-22T00:00:00.000Z",
        source: "fixture-rates",
        prices: { "fixture-model": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: null } },
      }),
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
            "UTC",
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

    /** @param {number} start */
    const methods = (start) => requests.slice(start).map((request) => request.method);

    const first = await run([]);

    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(methods(0), ["PUT", "GET", "POST"]);

    const machine = decodeMachine(
      readFileSync(join(directory, "config/token-ledger/machine.json"), "utf8"),
    );

    const uploaded = decodePayload(requests[0]?.body ?? "");
    const basis = uploaded.pricing.basis;

    assert.match(basis ?? "", /^token-ledger-pricing@\d+;copilot-rates@[\d-]+;litellm@tiers$/);
    assert.equal(requests[1]?.url.pathname, `/ai-usage/machines/${machine.id}/repricing`);
    assert.equal(requests[1]?.url.searchParams.get("basis"), basis);
    assert.equal(requests[2]?.url.pathname, `/ai-usage/machines/${machine.id}/repricing`);

    const repriced = decodeReprice(requests[2]?.body ?? "");

    assert.equal(repriced.pricing.basis, basis);
    // The hour before the window, built as the upload that stored it built it.
    assert.deepEqual(
      repriced.buckets.map((bucket) => [bucket.hourStart, bucket.provider, bucket.records]),
      [["2026-09-15T08:00:00.000Z", "codex", 1]],
    );
    assert.equal(repriced.buckets[0]?.sessionKey, uploaded.buckets[0]?.sessionKey);
    assert.match(first.stdout, /Synced/);
    assert.match(
      first.stdout,
      /Repriced codex from 2026-09-15 08:00 UTC · 1 bucket stored on an older pricing basis · sent 1 · 1 updated · 0 unmatched/,
    );
    assert.ok(existsSync(join(directory, "config/token-ledger/repricing.json")));

    // The same hour on the same basis: what is left cannot be reproduced here.
    const second = await run([]);

    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(methods(3), ["PUT", "GET"]);
    assert.match(second.stdout, /Repricing codex skipped/);

    // A dry run uploads nothing and reprices nothing.
    const dryRun = await run(["--dry-run"]);

    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(requests.length, 5);

    // A refused reprice is reported; the sync still succeeds, and the next one tries again.
    from = "2026-09-14T00:00:00Z";
    repriceStatus = 400;
    const refused = await run([]);

    assert.equal(refused.status, 0, refused.stderr);
    assert.deepEqual(methods(5), ["PUT", "GET", "POST"]);
    assert.match(refused.stdout, /Synced/);
    assert.match(
      refused.stderr,
      /Repricing codex from 2026-09-14 00:00 UTC did not finish: The server refused the request \(400\)\. The next sync tries again\./,
    );

    repriceStatus = 200;
    const retried = await run([]);

    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(methods(8), ["PUT", "GET", "POST"]);
    assert.match(retried.stdout, /Repriced codex from 2026-09-14 00:00 UTC/);

    // A server without repricing does not fail the sync either.
    discoveryStatus = 404;
    const older = await run([]);

    assert.equal(older.status, 0, older.stderr);
    assert.deepEqual(methods(11), ["PUT", "GET"]);
    assert.match(
      older.stderr,
      /Could not ask the server what to reprice: The server does not offer repricing/,
    );

    for (const output of [first, second, dryRun, refused, retried, older]) {
      assert.doesNotMatch(output.stdout + output.stderr, new RegExp(token));
      assert.doesNotMatch(output.stdout + output.stderr, new RegExp(directory));
    }
  } finally {
    server.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("login saves what a scheduled sync needs, and schedule install changes nothing without it", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-schedule-"));
  const token = "toki_fixture_secret";
  const configuration = join(directory, "token-ledger.json");

  try {
    writeFileSync(configuration, "{}");

    /** @param {string[]} args @param {Record<string, string>} variables */
    const run = (args, variables = {}) =>
      spawnSync(process.execPath, [join(packageDirectory, "dist/main.js"), ...args], {
        cwd: directory,
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          HOME: directory,
          USERPROFILE: directory,
          XDG_CONFIG_HOME: join(directory, "config"),
          ...variables,
        },
      });

    const plan = run([
      "schedule",
      "install",
      "--dry-run",
      "--at",
      "07:05",
      "--every",
      "6h",
      "--config",
      configuration,
    ]);

    assert.equal(plan.status, 0, plan.stderr);
    assert.match(plan.stdout, /npx --yes @ponbac\/token-ledger@latest sync --config /);

    // Windows prints a JScript string literal; its backslashes are escaped in the plan.
    /** @param {string} path */
    const printedPath = (path) =>
      process.platform === "win32" ? path.replaceAll("\\", "\\\\") : path;

    assert.ok(plan.stdout.includes(printedPath(configuration)));
    assert.ok(plan.stdout.includes(`XDG_CONFIG_HOME=${printedPath(join(directory, "config"))}`));
    // systemd lists the hours, launchd has an entry per time, and Task Scheduler starts the
    // day at the earliest and repeats.
    assert.match(
      plan.stdout,
      /01,07,13,19:05:00|<integer>19<\/integer>|-At '01:05' -RepetitionInterval \(New-TimeSpan -Hours 6\)/,
    );

    const refused = run(["schedule", "install", "--config", configuration]);

    assert.equal(refused.status, 1);
    assert.match(refused.stdout + refused.stderr, /token-ledger login/);

    const login = run(["login", "--server", "https://toki.example.com"], { TOKI_API_TOKEN: token });

    assert.equal(login.status, 0, login.stderr);
    assert.deepEqual(readdirSync(join(directory, "config")), ["token-ledger"]);
    assert.deepEqual(
      decodeSettings(readFileSync(join(directory, "config/token-ledger/sync.json"), "utf8")),
      { server: "https://toki.example.com/", token },
    );

    for (const output of [plan, refused, login])
      assert.doesNotMatch(output.stdout + output.stderr, new RegExp(token));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("copilot enable sets the export up once, and reports then read both exports together", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-copilot-"));
  const appData = join(directory, "AppData", "Roaming");

  const roots = {
    win32: appData,
    darwin: join(directory, "Library", "Application Support"),
  };

  const settings = join(
    process.platform === "win32" || process.platform === "darwin"
      ? roots[process.platform]
      : join(directory, "config"),
    "Code",
    "User",
    "settings.json",
  );

  const exports = join(directory, ".copilot", "otel");

  try {
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      '{\n  // appearance\n  "workbench.colorTheme": "Dark", // the good one\n  "editor.rulers": [80, 120,],\n}\n',
    );

    /** @param {string[]} args @param {Record<string, string>} variables */
    const run = (args, variables = {}) => {
      // The developer's own Copilot setup must neither be read nor changed.
      const {
        COPILOT_HOME: _home,
        COPILOT_OTEL_FILE_EXPORTER_PATH: _file,
        ZDOTDIR: _zsh,
        ...env
      } = process.env;

      return spawnSync(process.execPath, [join(packageDirectory, "dist/main.js"), ...args], {
        cwd: directory,
        encoding: "utf8",
        timeout: 60_000,
        env: {
          ...env,
          HOME: directory,
          USERPROFILE: directory,
          APPDATA: appData,
          XDG_CONFIG_HOME: join(directory, "config"),
          XDG_CACHE_HOME: join(directory, "cache"),
          SHELL: "/bin/zsh",
          ...variables,
        },
      });
    };

    // Windows keeps the variable in the user's own environment, which a test must not touch.
    const parts = process.platform === "win32" ? ["--vscode"] : ["--cli", "--vscode"];
    const plan = run(["copilot", "enable", ...parts, "--dry-run"]);

    assert.equal(plan.status, 0, plan.stderr);
    assert.ok(plan.stdout.includes(settings));
    assert.equal(existsSync(exports), false);

    const unasked = run(["copilot", "enable", ...parts]);

    assert.equal(unasked.status, 1);
    assert.match(unasked.stderr, /--yes/);
    assert.equal(existsSync(exports), false);

    const enabled = run(["copilot", "enable", ...parts, "--yes"]);

    assert.equal(enabled.status, 0, enabled.stderr);

    const outfile = `${exports.replaceAll("\\", "/")}/vscode-chat.jsonl`;
    const edited = readFileSync(settings, "utf8");

    assert.equal(
      edited,
      `{\n  // appearance\n  "workbench.colorTheme": "Dark", // the good one\n  "editor.rulers": [80, 120,],\n  "github.copilot.chat.otel.enabled": true,\n  "github.copilot.chat.otel.exporterType": "file",\n  "github.copilot.chat.otel.outfile": ${JSON.stringify(outfile)},\n  "github.copilot.chat.otel.captureContent": false,\n  "settingsSync.ignoredSettings": ["github.copilot.chat.otel.outfile"],\n}\n`,
    );

    const startup = join(directory, ".zshrc");

    if (process.platform !== "win32")
      assert.match(
        readFileSync(startup, "utf8"),
        /\nexport COPILOT_OTEL_FILE_EXPORTER_PATH="\$HOME\/\.copilot\/otel\/usage\.jsonl"\n$/,
      );

    const again = run(["copilot", "enable", ...parts, "--yes"]);

    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /nothing to change/);
    assert.equal(readFileSync(settings, "utf8"), edited);

    if (process.platform !== "win32")
      assert.equal(
        readFileSync(startup, "utf8").split("COPILOT_OTEL_FILE_EXPORTER_PATH=").length,
        2,
      );

    /** @param {string} id */
    const inference = (id) =>
      `${JSON.stringify({
        hrTime: [Date.parse("2026-09-22T10:00:00Z") / 1000, 0],
        attributes: {
          "event.name": "gen_ai.client.inference.operation.details",
          "gen_ai.operation.name": "chat",
          "gen_ai.response.id": id,
          "gen_ai.response.model": "fixture-model",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 20,
        },
      })}\n`;

    const configuration = join(directory, "token-ledger.json");

    writeFileSync(
      configuration,
      JSON.stringify({
        prices: { "fixture-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null } },
      }),
    );
    writeFileSync(join(exports, "usage.jsonl"), inference("cli"));
    writeFileSync(join(exports, "vscode-chat.jsonl"), inference("chat-1") + inference("chat-2"));

    /** @param {string} exporter */
    const read = (exporter) => {
      const report = run(
        [
          "report",
          "--provider",
          "copilot",
          "--offline",
          "--json",
          "--strict",
          "--config",
          configuration,
          "--since",
          "2026-09-22",
          "--until",
          "2026-09-22",
          "--time-zone",
          "UTC",
        ],
        { COPILOT_OTEL_FILE_EXPORTER_PATH: exporter },
      );

      assert.equal(report.status, 0, report.stderr);

      const { rows, coverage } = decodeReport(report.stdout);

      return {
        records: rows.reduce((total, row) => total + row.records, 0),
        sources: coverage.map((source) => [source.source, source.status, source.files]),
      };
    };

    // The variable `--cli` persists names one file; the VS Code export beside it still counts.
    assert.deepEqual(read(join(exports, "usage.jsonl")), {
      records: 3,
      sources: [[exports, "ok", 2]],
    });

    // A file a scan of the folder would pass over is still read, beside the folder.
    const log = join(exports, "usage.log");

    writeFileSync(log, inference("cli-log"));
    assert.deepEqual(read(log), {
      records: 4,
      sources: [
        [exports, "ok", 2],
        [log, "ok", 1],
      ],
    });

    // A file outside the folder is a deliberate choice of that one export, read alone.
    const elsewhere = join(directory, "elsewhere.jsonl");

    writeFileSync(elsewhere, inference("elsewhere"));
    assert.deepEqual(read(elsewhere), { records: 1, sources: [[elsewhere, "ok", 1]] });

    // Copilot CLI and VS Code's Copilot harness keep session logs, read without setup. A
    // request the export holds too counts once.
    const sessions = join(directory, ".copilot", "session-state");

    /** @param {string} apiCallId */
    const usage = (apiCallId) =>
      JSON.stringify({
        type: "session.usage_record",
        timestamp: "2026-09-22T10:00:00.000Z",
        data: {
          usage: { model: "fixture-model", inputTokens: 100, outputTokens: 20, apiCallId },
        },
      });

    mkdirSync(join(sessions, "harness"), { recursive: true });
    writeFileSync(
      join(sessions, "harness", "events.jsonl"),
      [
        JSON.stringify({ type: "session.start", data: { sessionId: "harness" } }),
        usage("harness-1"),
        usage("chat-1"),
      ].join("\n"),
    );
    assert.deepEqual(read(join(exports, "usage.jsonl")), {
      records: 4,
      sources: [
        [sessions, "ok", 1],
        [exports, "ok", 2],
      ],
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

await test("packaged sync discovers local proxy hints and resolves configured paths from the config file", () => {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-hints-"));

  try {
    const source = join(directory, "otel.jsonl");
    const configuration = join(directory, "token-ledger.json");
    const localData = join(directory, "local-data");
    const xdgData = join(directory, "xdg-data");

    const hintRoot = Match.value(process.platform).pipe(
      Match.when("win32", () => localData),
      Match.when("darwin", () => join(directory, "Library", "Application Support")),
      Match.orElse(() => xdgData),
    );

    const hints = join(hintRoot, "token-ledger", "billing-hints");

    const hint = JSON.stringify({
      requestId: "local-request",
      billingProvider: "codex",
      authMode: "chatgpt",
    });

    writeFileSync(
      source,
      JSON.stringify({
        traceId: "trace",
        spanId: "span",
        endTime: [Date.parse("2026-09-22T12:00:00Z") / 1000, 0],
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.response.id": "local-request",
          "gen_ai.response.model": "fixture-model",
          "gen_ai.usage.input_tokens": 100,
          "gen_ai.usage.output_tokens": 20,
        },
      }) + "\n",
    );
    const config = { sources: [{ provider: "copilot", path: source }] };

    writeFileSync(configuration, JSON.stringify(config));
    const { TOKEN_LEDGER_SERVER: _server, TOKI_API_TOKEN: _token, ...environment } = process.env;

    const run = () =>
      spawnSync(
        process.execPath,
        [
          join(packageDirectory, "dist/main.js"),
          "sync",
          "--config",
          configuration,
          "--since",
          "2026-09-22",
          "--until",
          "2026-09-22",
          "--time-zone",
          "UTC",
          "--offline",
          "--dry-run",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
          env: {
            ...environment,
            HOME: directory,
            USERPROFILE: directory,
            LOCALAPPDATA: localData,
            XDG_DATA_HOME: xdgData,
            XDG_CONFIG_HOME: join(directory, "config"),
            XDG_CACHE_HOME: join(directory, "cache"),
          },
        },
      );

    const plain = run();

    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(decodePayload(plain.stdout).version, 1);
    mkdirSync(hints, { recursive: true });
    writeFileSync(join(hints, "chatgpt-proxy.jsonl"), hint + "\n");
    const discovered = run();

    assert.equal(discovered.status, 0, discovered.stderr);
    assert.equal(decodePayload(discovered.stdout).version, 2);
    assert.equal(decodePayload(discovered.stdout).buckets[0]?.billingProvider, "codex");
    assert.doesNotMatch(discovered.stdout, /local-request|requestId|authMode/);

    mkdirSync(join(directory, "custom"));
    writeFileSync(join(directory, "custom", "proxy.jsonl"), hint + "\n");
    writeFileSync(configuration, JSON.stringify({ ...config, billingHintsDirectory: "custom" }));
    const configured = run();

    assert.equal(configured.status, 0, configured.stderr);
    assert.equal(decodePayload(configured.stdout).buckets[0]?.billingProvider, "codex");
    writeFileSync(join(directory, "custom", "proxy.jsonl"), hint + '\n{"truncated\n' + hint + "\n");
    const broken = run();

    assert.equal(broken.status, 0, broken.stderr);
    assert.equal(decodePayload(broken.stdout).coverage[0]?.status, "failed");
    assert.match(broken.stderr, /Billing hints: Invalid row in "proxy.jsonl" at line 2/);
    assert.match(broken.stderr, /--since <first missed day>/);
    assert.doesNotMatch(broken.stderr, /local-request|truncated/);
    writeFileSync(join(directory, "custom", "proxy.jsonl"), hint + "\n");
    const repaired = run();

    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(decodePayload(repaired.stdout).version, 2);
    writeFileSync(configuration, JSON.stringify({ ...config, billingHintsDirectory: "missing" }));
    const missing = run();

    assert.equal(missing.status, 0, missing.stderr);
    assert.equal(decodePayload(missing.stdout).buckets.length, 0);
    assert.equal(decodePayload(missing.stdout).coverage[0]?.status, "failed");
    assert.match(missing.stderr, /Billing hints: Cannot read the billing hints directory/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
