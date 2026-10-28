#!/usr/bin/env node
import { homedir } from "node:os";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { addDays } from "@token-ledger/core/calendar";
import { Ledger } from "@token-ledger/core/ledger";
import {
  Configuration,
  Day,
  ProjectName,
  type Provider,
  ReportRequest,
  type Source,
} from "@token-ledger/core/model";
import { configuredPricing, loadPrices } from "@token-ledger/core/pricing";
import { opencodeDatabaseName } from "@token-ledger/core/providers/opencode-db";
import type { SyncPayload } from "@token-ledger/core/sync";
import {
  Config,
  Console,
  DateTime,
  Effect,
  FileSystem,
  Match,
  Option,
  Path,
  Predicate,
  Result,
  Schema,
} from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import metadata from "../package.json" with { type: "json" };
import { billingHintsDirectory, dataHome } from "./billing-hints.ts";

import {
  type Host,
  Step,
  copilotSources,
  describe as describeEnabling,
  perform as enable,
  plan as planEnabling,
  summarize,
} from "./copilot.ts";
import { csv, repriceLine, syncSummary, table, unpricedModels } from "./format.ts";
import { repriceStoredUsage } from "./reprice.ts";
import {
  TimeOfDay,
  defaultInterval,
  describe,
  describeTimes,
  hostScheduler,
  intervals,
  perform,
  retimeDailySchedule,
} from "./schedule.ts";
import {
  ServerUrl,
  configHome,
  loadMachine,
  loadSyncSettings,
  saveSyncSettings,
  settingsDirectory,
  settleSchedule,
} from "./settings.ts";
import { hasUploaded, upload } from "./upload.ts";

class CliError extends Schema.TaggedError<CliError>()("CliError", { message: Schema.String }) {}

const home = homedir();

const workingDirectory = process.cwd();

// Node reports an unset or unknown TZ as undefined or Etc/Unknown; neither names a zone.
const systemTimeZone = Effect.sync(() => Intl.DateTimeFormat().resolvedOptions().timeZone).pipe(
  Effect.flatMap(Schema.decodeUnknownEffect(Schema.TimeZoneNamedFromString)),
  Effect.mapError(
    () =>
      new CliError({
        message:
          "Cannot determine the system time zone; pass --time-zone, such as --time-zone Europe/Stockholm.",
      }),
  ),
);

/** Resolves a path as typed in a shell: `~/` is the home directory, and the rest is relative to `base`. */
const expandPath = (path: Path.Path, value: string, base = workingDirectory) =>
  path.resolve(base, value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

/** Flags selecting usage, shared by `report` and `sync`. */
function usageFlags(sinceDefault: string, strict: string) {
  return {
    since: Flag.String("since").pipe(
      Flag.withSchema(Day),
      Flag.optional,
      Flag.withDescription(`First local day, inclusive; defaults to ${sinceDefault}`),
    ),
    until: Flag.String("until").pipe(
      Flag.withSchema(Day),
      Flag.optional,
      Flag.withDescription("Last local day, inclusive; defaults to today"),
    ),
    timeZone: Flag.String("time-zone").pipe(
      Flag.withSchema(Schema.TimeZoneNamedFromString),
      Flag.optional,
      Flag.withDescription(
        "IANA time zone for days and the window, such as Europe/Stockholm; defaults to the system zone",
      ),
    ),
    provider: Flag.Literals("provider", [
      "all",
      "codex",
      "claude",
      "grok",
      "copilot",
      "pi",
      "opencode",
    ]).pipe(Flag.withDefault("all")),
    project: Flag.String("project").pipe(
      Flag.withSchema(ProjectName),
      Flag.optional,
      Flag.withDescription("Assign all selected usage to this project"),
    ),
    config: Flag.String("config").pipe(
      Flag.optional,
      Flag.withDescription("JSON config; otherwise reads ./token-ledger.json when present"),
    ),
    offline: Flag.Boolean("offline").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Use only cached and configured prices"),
    ),
    strict: Flag.Boolean("strict").pipe(Flag.withDefault(false), Flag.withDescription(strict)),
  };
}

/** Parsed usage flags. */
interface UsageOptions {
  readonly since: Option.Option<string>;
  readonly until: Option.Option<string>;
  readonly timeZone: Option.Option<DateTime.TimeZone.Named>;
  readonly provider: "all" | Provider;
  readonly source: Option.Option<string>;
  readonly project: Option.Option<string>;
  readonly config: Option.Option<string>;
  readonly offline: boolean;
}

/** Resolves configuration, discovery, pricing, and the local-day window into a ledger request. */
const usageRequest = Effect.fn("CLI.usageRequest")(function* (
  flags: UsageOptions,
  defaultSince: (today: Day) => Day,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const timeZone = Option.isSome(flags.timeZone) ? flags.timeZone.value : yield* systemTimeZone;

  const today = DateTime.formatIsoDate(DateTime.setZone(yield* DateTime.now, timeZone));

  const expand = (value: string, base?: string) => expandPath(path, value, base);

  const configFile = expand(Option.getOrElse(flags.config, () => "token-ledger.json"));
  let configuration: Configuration = {};

  if (Option.isSome(flags.config) || (yield* fs.exists(configFile))) {
    configuration = yield* fs.readFileString(configFile).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration))),
      Effect.mapError(
        () =>
          new CliError({
            message: "Cannot read or decode configuration. See token-ledger config-example.",
          }),
      ),
    );
  }

  const codexHome = yield* Config.String("CODEX_HOME").pipe(
    Config.withDefault(path.join(home, ".codex")),
  );

  const claudeHome = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(
    Config.withDefault(path.join(home, ".claude")),
  );

  const grokHome = yield* Config.String("GROK_HOME").pipe(
    Config.withDefault(path.join(home, ".grok")),
  );

  const copilotHome = yield* Config.String("COPILOT_HOME").pipe(
    Config.withDefault(path.join(home, ".copilot")),
  );

  const copilotFile = yield* Config.String("COPILOT_OTEL_FILE_EXPORTER_PATH").pipe(Config.option);

  const copilotSessions = path.join(expand(copilotHome), "session-state");

  const piHome = yield* Config.String("PI_CODING_AGENT_DIR").pipe(
    Config.withDefault(path.join(home, ".pi", "agent")),
  );

  const piSessions = yield* Config.String("PI_CODING_AGENT_SESSION_DIR").pipe(Config.option);

  // OpenCode follows XDG on every platform, Windows and macOS included.
  const opencodeData = path.join(
    Option.getOrElse(yield* dataHome, () => path.join(home, ".local", "share")),
    "opencode",
  );

  // Names the database file, relative to the data directory, in place of `opencode.db`.
  const opencodeDatabase = Option.map(
    Option.filter(
      yield* Config.String("OPENCODE_DB").pipe(Config.option),
      (value) => value !== "" && value !== ":memory:",
    ),
    (value) => path.resolve(opencodeData, value),
  );

  const defaults: Source[] = [
    { provider: "codex", path: path.join(expand(codexHome), "sessions") },
    { provider: "codex", path: path.join(expand(codexHome), "archived_sessions") },
    { provider: "claude", path: path.join(expand(claudeHome), "projects") },
    { provider: "grok", path: path.join(expand(grokHome), "sessions") },
    // Session logs first: where a telemetry export holds the same request, the session's copy,
    // which names its workspace, is the one counted. Only Copilot CLI and VS Code's Copilot
    // harness keep them, so a machine without the folder reads only the export, as before.
    ...((yield* fs.exists(copilotSessions))
      ? [{ provider: "copilot", path: copilotSessions } satisfies Source]
      : []),
    ...(yield* copilotSources(
      path.join(expand(copilotHome), "otel"),
      Option.map(copilotFile, (value) => expand(value)),
    )).map((source): Source => ({ provider: "copilot", path: source })),
    {
      provider: "pi",
      path: Option.match(piSessions, {
        onNone: () => path.join(expand(piHome), "sessions"),
        onSome: (value) => expand(value),
      }),
    },
    { provider: "opencode", path: opencodeData },
    ...Option.match(opencodeDatabase, {
      onNone: (): Source[] => [],
      // The data directory's walk already reads a channel database beside the others.
      onSome: (file): Source[] =>
        path.dirname(file) === opencodeData && opencodeDatabaseName.test(path.basename(file))
          ? []
          : [{ provider: "opencode", path: file }],
    }),
  ];

  let sources: readonly Source[] =
    configuration.sources === undefined
      ? defaults
      : configuration.sources.map((source) => ({
          ...source,
          path: expand(source.path, path.dirname(configFile)),
        }));

  if (flags.provider !== "all")
    sources = sources.filter((source) => source.provider === flags.provider);

  if (Option.isSome(flags.source)) {
    if (flags.provider === "all")
      return yield* new CliError({
        message: "--source requires --provider codex, claude, grok, copilot, pi, or opencode.",
      });
    sources = [{ provider: flags.provider, path: expand(flags.source.value) }];
  }

  if (Option.isSome(flags.project)) {
    const project = flags.project.value;
    sources = sources.map((source) => ({
      provider: source.provider,
      path: source.path,
      project,
    }));
  }

  const projects = (configuration.projects ?? []).map((mapping) => ({
    ...mapping,
    paths: mapping.paths.map((prefix) => expand(prefix, path.dirname(configFile))),
  }));

  const cacheRoot = yield* Config.String("XDG_CACHE_HOME").pipe(
    Config.withDefault(path.join(home, ".cache")),
  );

  // Snapshots from before long-context tiers were decoded lack them, so they live elsewhere.
  const basePrices = yield* loadPrices(
    path.join(expand(cacheRoot), "token-ledger", "prices-v2.json"),
    flags.offline,
  );

  const pricing = configuredPricing(basePrices, configuration.prices);

  if (pricing.status === "unavailable")
    yield* Console.error(
      "Pricing unavailable: unknown rates remain unpriced. Configure prices or rerun online.",
    );

  const request = yield* ReportRequest.makeEffect({
    billingHints:
      configuration.billingHintsDirectory === undefined
        ? {
            directory: billingHintsDirectory(
              process.platform,
              home,
              yield* Config.String("LOCALAPPDATA").pipe(Config.option),
              yield* dataHome,
            ),
            required: false,
          }
        : {
            directory: expand(configuration.billingHintsDirectory, path.dirname(configFile)),
            required: true,
          },
    since: Option.getOrElse(flags.since, () => defaultSince(today)),
    until: Option.getOrElse(flags.until, () => today),
    timeZone,
    sources,
    projects,
    pricing,
  }).pipe(
    Effect.mapError(
      () => new CliError({ message: "Invalid usage inputs; --since must not follow --until." }),
    ),
  );

  return { request, today };
});

const report = Command.make(
  "report",
  {
    ...usageFlags(
      "the start of this month",
      "Exit 2 for missing/partial sources or unpriced usage",
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription("Read one file or directory; requires --provider"),
    ),
    format: Flag.Literals("format", ["table", "json", "csv"]).pipe(Flag.withDefault("table")),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Emit structured JSON to stdout (overrides --format); diagnostics use stderr",
      ),
    ),
  },
  Effect.fn("CLI.report")(function* (flags) {
    const { request } = yield* usageRequest(flags, (today) => `${today.slice(0, 7)}-01`);
    const ledger = yield* Ledger;
    const result = yield* ledger.report(request);

    const output = Match.value(flags.json ? "json" : flags.format).pipe(
      Match.when("json", () => JSON.stringify(result, null, 2)),
      Match.when("csv", () => csv(result)),
      Match.when("table", () =>
        table(
          result,
          process.stdout.columns ?? 120,
          process.stdout.isTTY && process.stdout.hasColors(),
        ),
      ),
      Match.exhaustive,
    );

    yield* Console.log(output);

    for (const source of result.coverage) {
      if (source.status !== "ok" || source.warnings.length > 0)
        yield* Console.error(
          `${source.provider}: ${source.status}; ${source.files} files, ${source.filesBeforeWindow} older files not opened, ${source.malformedLines} malformed lines, ${source.skippedRecords} skipped records. ${source.warnings.join(" ")}`,
        );
    }

    const unpriced = unpricedModels(result.rows);

    if (unpriced !== undefined) yield* Console.error(unpriced);

    if (
      flags.strict &&
      (result.coverage.some((entry) => entry.status !== "ok") ||
        result.rows.some((row) => row.unpricedRecords > 0))
    )
      process.exitCode = 2;
  }),
).pipe(
  Command.withDescription("Report local token consumption and API-equivalent cost by project"),
);

const serverFlag = Flag.String("server").pipe(
  Flag.withSchema(ServerUrl),
  Flag.withFallbackConfig(Config.schema(ServerUrl, "TOKEN_LEDGER_SERVER")),
  Flag.optional,
);

const tokenFlag = Flag.Redacted("token").pipe(
  Flag.withFallbackConfig(Config.Redacted("TOKI_API_TOKEN")),
  Flag.optional,
);

// Claude Code deletes transcripts after `cleanupPeriodDays`, 30 by default.
const claudeRetentionDays = 30;

const sync = Command.make(
  "sync",
  {
    ...usageFlags(
      "13 days before --until; a machine's first sync goes back to its earliest usage",
      "Exit 2 without uploading for missing/partial sources or unpriced usage",
    ),
    server: serverFlag.pipe(
      Flag.withDescription("toki2 URL; otherwise TOKEN_LEDGER_SERVER or sync.json"),
    ),
    token: tokenFlag.pipe(
      Flag.withDescription("toki2 API token; prefer TOKI_API_TOKEN or sync.json"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the payload as JSON and upload nothing"),
    ),
  },
  Effect.fn("CLI.sync")(function* (flags) {
    const directory = yield* settingsDirectory;
    const until = Option.getOrUndefined(flags.until);

    // One file cannot stand in for a provider's history: the server would replace the rest.
    const { request, today } = yield* usageRequest({ ...flags, source: Option.none() }, (today) =>
      addDays(until ?? today, -13),
    );

    const machine = yield* loadMachine(directory);
    const ledger = yield* Ledger;
    const client = { machine, version: metadata.version };

    // Read before scanning: the server decides the window. A dry run uploads nothing, so
    // settings it cannot read only cost it that answer.
    const unsaved: Effect.Success<ReturnType<typeof loadSyncSettings>> = {};

    const saved =
      Option.isSome(flags.server) && Option.isSome(flags.token)
        ? Result.succeed(unsaved)
        : yield* loadSyncSettings(directory).pipe(Effect.result);

    const settings = Result.isSuccess(saved) ? saved.success : unsaved;
    const server = Option.orElse(flags.server, () => Option.fromUndefinedOr(settings.server));
    const token = Option.orElse(flags.token, () => Option.fromUndefinedOr(settings.token));

    // A machine's first upload takes in all its history. Only the server knows whether it
    // holds anything for this machine; unless it plainly says it holds nothing, a window longer
    // than the usual one could replace usage since pruned here. --since is the caller's window.
    const unlisted =
      Option.isSome(flags.since) || Option.isNone(server) || Option.isNone(token)
        ? Option.none<boolean>()
        : yield* hasUploaded(server.value, token.value, machine.id).pipe(
            Effect.map((listed) => !listed),
            Effect.option,
          );

    const whole = Option.contains(unlisted, true);

    const reachable = Option.isSome(server) && Option.isSome(token);

    // Without credentials a real sync stops below with its own message; a dry run goes on.
    if (Option.isNone(unlisted) && Option.isNone(flags.since) && (reachable || flags.dryRun))
      yield* Console.error(
        `${
          reachable
            ? "Could not ask the server whether this machine has uploaded before"
            : "No server and API token to ask whether this machine has uploaded before"
        }, so the window is ${request.since} through ${request.until}. If this is its first upload, send its earlier history with --since.`,
      );

    const first = whole
      ? yield* ledger.historyPayload(request, client, Console.error)
      : {
          payload: yield* ledger.syncPayload(request, client, Console.error),
          since: request.since,
        };

    if (whole)
      yield* Console.error(
        `First upload from this machine: taking in all the history found, from ${first.since}. Later syncs cover the last 14 days.${
          flags.provider === "all"
            ? ""
            : ` Only ${flags.provider} is included; the other tools' earlier history is not sent later by itself, so send it with --provider and --since.`
        }`,
      );

    /** Reports what could not be read, and says whether the payload falls short of --strict. */
    const examine = Effect.fn("CLI.examine")(function* (payload: SyncPayload) {
      for (const entry of payload.coverage) {
        if (entry.status !== "ok")
          yield* Console.error(
            `${entry.provider}: ${entry.status}; ${entry.files} files, ${entry.filesBeforeWindow ?? 0} older files not opened, ${entry.unreadable} unreadable, ${entry.malformedLines} malformed lines, ${entry.skippedRecords} skipped records.${entry.status === "failed" ? " Not uploaded; the server keeps its stored usage." : ""}`,
          );

        // Later syncs cover two weeks, so history that is unreadable now needs sending by hand.
        if (whole && entry.status === "failed")
          yield* Console.error(
            `${entry.provider}: once its history can be read, send the earlier part with token-ledger sync --provider ${entry.provider} --since <first day>.`,
          );
      }

      return (
        payload.coverage.some((entry) => entry.status !== "ok") ||
        payload.buckets.some((bucket) => bucket.unpricedRecords > 0)
      );
    });

    const incomplete = yield* examine(first.payload);

    if (
      !whole &&
      request.sources.some((source) => source.provider === "claude") &&
      request.since < addDays(today, 1 - claudeRetentionDays)
    )
      yield* Console.error(
        `Warning: the window starts more than ${claudeRetentionDays} days ago. Claude Code deletes older transcripts by default, and the server replaces the whole window, so pruned history would lower its totals.`,
      );

    if (flags.dryRun) {
      yield* Console.log(JSON.stringify(first.payload, null, 2));

      const unpriced = unpricedModels(first.payload.buckets);

      if (unpriced !== undefined) yield* Console.error(unpriced);

      if (flags.strict && incomplete) process.exitCode = 2;

      return;
    }

    // Before the upload, which can end the sync early. Failing leaves the sync's outcome alone.
    yield* retimeDailySchedule(directory).pipe(
      Effect.matchEffect({
        onSuccess: Option.match({
          onNone: () => Effect.void,
          onSome: (retimed) =>
            Console.log(
              `Moved the scheduled sync from once a day at ${retimed.at} to ${describeTimes(retimed)}, as a ${retimed.scheduler}. To keep a daily sync, run token-ledger schedule install --every 24h.`,
            ),
        }),
        onFailure: (error) =>
          Console.error(
            `Cannot move the once-a-day scheduled sync to every ${defaultInterval} hours: ${error.message} Run token-ledger schedule install to replace it.`,
          ),
      }),
    );

    const refused = Effect.gen(function* () {
      yield* Console.error("Not syncing: coverage is incomplete or usage is unpriced (--strict).");
      process.exitCode = 2;
    });

    if (flags.strict && incomplete) return yield* refused;

    if (Result.isFailure(saved)) return yield* Effect.fail(saved.failure);

    if (Option.isNone(server) || Option.isNone(token))
      return yield* new CliError({
        message: `Missing ${Option.isNone(server) ? "server" : "API token"}: pass --server/--token, set TOKEN_LEDGER_SERVER/TOKI_API_TOKEN, or add it to ${directory}/sync.json.`,
      });

    const send = (payload: SyncPayload) =>
      upload(server.value, token.value, payload).pipe(Effect.result);

    /** Sends the usual window in place of a whole history, unless --strict forbids it. */
    const usual = Effect.fn("CLI.usual")(function* (reason: string) {
      yield* Console.error(
        `${reason} Uploading ${request.since} through ${request.until} instead; send earlier history in parts with --since and --until.`,
      );

      const payload = yield* ledger.syncPayload(request, client, Console.error);

      return (yield* examine(payload)) && flags.strict
        ? Option.none()
        : Option.some({ sent: { payload, since: request.since }, outcome: yield* send(payload) });
    });

    // The scan took a while. An upload from this machine that arrived meanwhile, from another
    // run, would be replaced by this one, so the server is asked once more before sending.
    const still =
      !whole ||
      !(yield* hasUploaded(server.value, token.value, machine.id).pipe(
        Effect.orElseSucceed(() => true),
      ));

    let result = still
      ? Option.some({ sent: first, outcome: yield* send(first.payload) })
      : yield* usual("This machine has uploaded since it was asked about.");

    // A history the server will not take must not keep this machine from ever syncing.
    if (
      whole &&
      Option.isSome(result) &&
      Result.isFailure(result.value.outcome) &&
      Match.value(result.value.outcome.failure).pipe(
        Match.tag("SyncRejected", () => still),
        Match.orElse(() => false),
      )
    )
      result = yield* usual(result.value.outcome.failure.message);

    // A newer upload from this machine landed during the scan, but it need not hold this
    // upload's window or tools. A fresh scan of the same window is newer still, so it is sent.
    if (
      Option.isSome(result) &&
      Result.isFailure(result.value.outcome) &&
      Predicate.isTagged(result.value.outcome.failure, "SyncSuperseded")
    ) {
      const { since } = result.value.sent;

      yield* Console.error(
        `A newer sync from this machine reached the server first; scanning ${since} through ${request.until} again.`,
      );

      const payload = yield* ledger.syncPayload({ ...request, since }, client, Console.error);

      result =
        (yield* examine(payload)) && flags.strict
          ? Option.none()
          : Option.some({ sent: { payload, since }, outcome: yield* send(payload) });
    }

    if (Option.isNone(result)) return yield* refused;

    const { sent, outcome } = result.value;

    if (Result.isFailure(outcome)) {
      yield* Console.error(outcome.failure.message);

      process.exitCode = Match.value(outcome.failure).pipe(
        Match.tag("SyncUnreachable", () => 3),
        Match.tag("SyncUnauthorized", () => 4),
        Match.tag("SyncUnsupportedVersion", () => 5),
        Match.tag("SyncRejected", () => 6),
        Match.tag("SyncSuperseded", () => 7),
        Match.exhaustive,
      );

      return;
    }

    const unpriced = unpricedModels(sent.payload.buckets);

    if (unpriced !== undefined) yield* Console.error(unpriced);

    yield* Console.log(
      syncSummary(sent.payload, { ...request, since: sent.since }, outcome.success),
    );

    // Stored hours before the window may rest on an older pricing basis. Rebuilding them only
    // changes the costs of buckets the server holds exactly as built here, and a reprice that
    // does not finish leaves the sync's outcome alone; the next sync tries again.
    const repriced = yield* repriceStoredUsage({
      server: server.value,
      token: token.value,
      payload: sent.payload,
      providers: new Set(request.sources.map((source) => source.provider)),
      directory,
      scan: (provider, range) => ledger.repriceBuckets(request, provider, range),
    });

    for (const { text, problem } of repriced.map(repriceLine))
      yield* problem ? Console.error(text) : Console.log(text);
  }),
).pipe(
  Command.withDescription(
    "Upload hourly usage buckets from this machine to toki2; the server replaces the window",
  ),
);

const interactive = <A>(prompt: Prompt.Prompt<A>) =>
  Prompt.run(prompt).pipe(
    Effect.mapError(
      () =>
        new CliError({
          message: "Nothing was saved. Without a terminal, pass --server and set TOKI_API_TOKEN.",
        }),
    ),
  );

const login = Command.make(
  "login",
  {
    server: serverFlag.pipe(
      Flag.withDescription("toki2 URL; otherwise TOKEN_LEDGER_SERVER or a prompt"),
    ),
    token: tokenFlag.pipe(
      Flag.withDescription("toki2 API token; prefer the prompt or TOKI_API_TOKEN"),
    ),
  },
  Effect.fn("CLI.login")(function* (flags) {
    const directory = yield* settingsDirectory;

    // An unreadable sync.json is what login replaces, so it only loses the suggested server.
    const suggestion = yield* loadSyncSettings(directory).pipe(
      Effect.map((saved) => saved.server?.href ?? ""),
      Effect.orElseSucceed(() => ""),
    );

    const server = Option.isSome(flags.server)
      ? flags.server.value
      : yield* interactive(
          Prompt.String({
            message: "toki2 server URL",
            default: suggestion,
            validate: (value) =>
              Schema.decodeUnknownEffect(ServerUrl)(value).pipe(
                Effect.as(value),
                Effect.mapError(() => "Enter an https:// URL, or http:// on localhost."),
              ),
          }),
        ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ServerUrl)), Effect.orDie);

    const token = Option.isSome(flags.token)
      ? flags.token.value
      : yield* interactive(
          Prompt.Password({
            message: "toki2 API token",
            validate: (value) =>
              value.trim() === "" ? Effect.fail("Paste the token.") : Effect.succeed(value.trim()),
          }),
        );

    const file = yield* saveSyncSettings(directory, server, token);

    yield* Console.log(
      `Saved the server and API token to ${file}.\nNext: token-ledger sync --dry-run, then token-ledger schedule install.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Save the toki2 server and API token in sync.json for sync and scheduled syncs",
  ),
);

const scheduleInstall = Command.make(
  "install",
  {
    every: Flag.ChoiceWithValue("every", intervals).pipe(
      Flag.withDefault(defaultInterval),
      Flag.withDescription(`Time between syncs; defaults to ${defaultInterval}h`),
    ),
    at: Flag.String("at").pipe(
      Flag.withDefault("12:30"),
      Flag.withSchema(TimeOfDay),
      Flag.withDescription("A local time, as HH:MM, that a sync runs at; defaults to 12:30"),
    ),
    config: Flag.String("config").pipe(
      Flag.optional,
      Flag.withDescription("JSON config for the scheduled sync; ./token-ledger.json is not read"),
    ),
    timeZone: Flag.String("time-zone").pipe(
      Flag.withSchema(Schema.TimeZoneNamedFromString),
      Flag.optional,
      Flag.withDescription("IANA time zone for the scheduled sync; defaults to the system zone"),
    ),
    provider: Flag.Literals("provider", [
      "all",
      "codex",
      "claude",
      "grok",
      "copilot",
      "pi",
      "opencode",
    ]).pipe(Flag.withDefault("all")),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the files and commands; change nothing"),
    ),
  },
  Effect.fn("CLI.scheduleInstall")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scheduler = yield* hostScheduler;
    const config = Option.map(flags.config, (value) => expandPath(path, value));

    // The job runs elsewhere and later; a config that is missing now would fail every run.
    if (
      Option.isSome(config) &&
      !(yield* fs.exists(config.value).pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* new CliError({ message: `Cannot find the configuration ${config.value}.` });

    const actions = yield* scheduler.install({
      at: flags.at,
      every: flags.every,
      nodeDirectory: path.dirname(process.execPath),
      configHome: yield* configHome,
      dataHome: yield* dataHome,
      flags: [
        ...Option.match(config, { onNone: () => [], onSome: (file) => ["--config", file] }),
        ...Option.match(flags.timeZone, {
          onNone: () => [],
          onSome: (zone) => ["--time-zone", zone.id],
        }),
        ...(flags.provider === "all" ? [] : ["--provider", flags.provider]),
      ],
    });

    if (flags.dryRun) return yield* Console.log(describe(actions));

    const directory = yield* settingsDirectory;
    const settings = yield* loadSyncSettings(directory);

    if (settings.server === undefined || settings.token === undefined)
      return yield* new CliError({
        message:
          "No saved server and API token. Run token-ledger login first: a scheduled sync cannot read --token or your shell's environment.",
      });

    yield* perform(actions);

    // A chosen schedule, even a daily one, is never moved by a later sync.
    yield* settleSchedule(directory).pipe(Effect.ignore);

    yield* Console.log(
      `Scheduled a sync ${describeTimes(flags)} as a ${scheduler.name}, replacing any earlier schedule. Inspect it with token-ledger schedule status.`,
    );
  }),
).pipe(
  Command.withDescription(
    "Install or replace the scheduled sync; it needs the server and token saved by login",
  ),
);

const scheduleStatus = Command.make(
  "status",
  {},
  Effect.fn("CLI.scheduleStatus")(function* () {
    const scheduler = yield* hostScheduler;

    yield* perform(scheduler.status);
  }),
).pipe(Command.withDescription("Show the scheduler's own report of the scheduled sync"));

const scheduleUninstall = Command.make(
  "uninstall",
  {},
  Effect.fn("CLI.scheduleUninstall")(function* () {
    const scheduler = yield* hostScheduler;

    yield* perform(scheduler.uninstall);

    yield* Console.log(`Removed the ${scheduler.name}. Saved settings were kept.`);
  }),
).pipe(Command.withDescription("Remove the scheduled sync; saved settings stay"));

const schedule = Command.make("schedule").pipe(
  Command.withDescription("Run sync every few hours with systemd, launchd, or Task Scheduler"),
  Command.withSubcommands([scheduleInstall, scheduleStatus, scheduleUninstall]),
);

const copilotEnable = Command.make(
  "enable",
  {
    cli: Flag.Boolean("cli").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Copilot CLI: export its usage from every new terminal"),
    ),
    vscode: Flag.Boolean("vscode").pipe(
      Flag.withDefault(false),
      Flag.withDescription("VS Code Copilot Chat: set its export in the user settings.json"),
    ),
    yes: Flag.Boolean("yes").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Make the listed changes without asking"),
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Print the changes; change nothing"),
    ),
    allowRoot: Flag.Boolean("allow-root").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Run as root, where root is the account that uses Copilot"),
    ),
  },
  Effect.fn("CLI.copilotEnable")(function* (flags) {
    const path = yield* Path.Path;

    const copilotHome = yield* Config.String("COPILOT_HOME").pipe(
      Config.withDefault(path.join(home, ".copilot")),
    );

    const host: Host = {
      platform: process.platform,
      home,
      uid: Option.fromUndefinedOr(process.getuid?.()),
      copilotHome: expandPath(path, copilotHome),
      shell: yield* Config.String("SHELL").pipe(Config.option),
      zshDirectory: yield* Config.String("ZDOTDIR").pipe(Config.option),
      configHome: yield* configHome,
      appData: yield* Config.String("APPDATA").pipe(Config.option),
      exporter: Option.map(
        yield* Config.String("COPILOT_OTEL_FILE_EXPORTER_PATH").pipe(Config.option),
        (file) => expandPath(path, file),
      ),
    };

    // These outcomes are expected, so they are said plainly, without a failure's stack trace.
    const stop = (message: string) =>
      Console.error(message).pipe(
        Effect.andThen(
          Effect.sync(() => {
            process.exitCode = 1;
          }),
        ),
      );

    // Neither flag asks for both, as does naming both.
    const planned = yield* planEnabling(host, {
      cli: flags.cli || !flags.vscode,
      vscode: flags.vscode || !flags.cli,
      allowRoot: flags.allowRoot,
    }).pipe(Effect.result);

    if (Result.isFailure(planned)) return yield* stop(planned.failure.message);

    const { directory, steps } = planned.success;

    const incomplete = (results: ReadonlyArray<Step>) => {
      if (results.some(Step.$is("ByHand"))) process.exitCode = 2;
    };

    if (!steps.some(Step.$is("Change"))) {
      yield* Console.log(
        steps.some(Step.$is("ByHand"))
          ? describeEnabling(steps)
          : `Copilot's usage export is already on; nothing to change.\n\n${describeEnabling(steps)}`,
      );

      return incomplete(steps);
    }

    yield* Console.log(`${describeEnabling(steps)}\n`);

    if (flags.dryRun) return incomplete(steps);

    if (!flags.yes) {
      if (!process.stdin.isTTY)
        return yield* stop(
          "Nothing was changed: there is no terminal to ask on. Run it again with --yes to make these changes.",
        );

      // Leaving the question with Ctrl-C declines it.
      const agreed = yield* Prompt.run(
        Prompt.Confirm({ message: "Make these changes?", initial: true }),
      ).pipe(Effect.orElseSucceed(() => false));

      if (!agreed) return yield* stop("Nothing was changed.");
    }

    const results = yield* enable(steps).pipe(Effect.result);

    if (Result.isFailure(results)) return yield* stop(results.failure.message);

    yield* Console.log(summarize(results.success, directory));

    return incomplete(results.success);
  }),
).pipe(
  Command.withDescription(
    "Switch on Copilot's local usage export, after listing the changes and asking",
  ),
);

const copilot = Command.make("copilot").pipe(
  Command.withDescription("Set up Copilot CLI and VS Code Copilot Chat to record usage"),
  Command.withSubcommands([copilotEnable]),
);

const example = Command.make("config-example", {}, () =>
  Console.log(
    JSON.stringify(
      {
        projects: [
          {
            project: "Client A",
            paths: ["~/work/client-a"],
            repositories: ["https://github.com/example/client-a.git"],
          },
        ],
        prices: { "example-model": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null } },
      },
      null,
      2,
    ),
  ),
).pipe(Command.withDescription("Print an example configuration to customize"));

Command.make("token-ledger").pipe(
  Command.withDescription(
    "Local token accounting across coding agents. API estimates, not subscription bills.",
  ),
  Command.withSubcommands([report, sync, login, schedule, copilot, example]),
  Command.run({ version: metadata.version }),
  Effect.provide(Ledger.layer),
  Effect.provide(NodeServices.layer),
  Effect.provide(FetchHttpClient.layer),
  NodeRuntime.runMain,
);
