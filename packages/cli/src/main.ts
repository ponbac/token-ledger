#!/usr/bin/env node
import { homedir } from "node:os";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Ledger } from "@token-ledger/core/ledger";
import {
  Configuration,
  Day,
  PriceBook,
  ReportRequest,
  type Source,
} from "@token-ledger/core/model";
import { loadPrices } from "@token-ledger/core/pricing";
import { Clock, Config, Console, Effect, FileSystem, Match, Option, Path, Schema } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import { csv, table } from "./format.ts";

class CliError extends Schema.TaggedError<CliError>()("CliError", { message: Schema.String }) {}

const home = homedir();

const workingDirectory = process.cwd();

const report = Command.make(
  "report",
  {
    since: Flag.String("since").pipe(
      Flag.withSchema(Day),
      Flag.optional,
      Flag.withDescription("First UTC day, inclusive; defaults to this month"),
    ),
    until: Flag.String("until").pipe(
      Flag.withSchema(Day),
      Flag.optional,
      Flag.withDescription("Last UTC day, inclusive; defaults to today"),
    ),
    provider: Flag.Literals("provider", ["all", "codex", "claude", "grok", "copilot"]).pipe(
      Flag.withDefault("all"),
    ),
    source: Flag.String("source").pipe(
      Flag.optional,
      Flag.withDescription("Read one file or directory; requires --provider"),
    ),
    project: Flag.String("project").pipe(
      Flag.optional,
      Flag.withDescription("Assign all selected usage to this project"),
    ),
    config: Flag.String("config").pipe(
      Flag.optional,
      Flag.withDescription("JSON config; otherwise reads ./token-ledger.json when present"),
    ),
    format: Flag.Literals("format", ["table", "json", "csv"]).pipe(Flag.withDefault("table")),
    json: Flag.Boolean("json").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Emit structured JSON to stdout (overrides --format); diagnostics use stderr",
      ),
    ),
    offline: Flag.Boolean("offline").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Use only cached and configured prices"),
    ),
    strict: Flag.Boolean("strict").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Exit 2 for missing/partial sources or unpriced usage"),
    ),
  },
  Effect.fn("CLI.report")(function* (flags) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const now = yield* Clock.currentTimeMillis;
    const today = new Date(now).toISOString().slice(0, 10);

    const expand = (value: string, base = workingDirectory) =>
      path.resolve(base, value.startsWith("~/") ? path.join(home, value.slice(2)) : value);

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

    const defaults: Source[] = [
      { provider: "codex", path: path.join(expand(codexHome), "sessions") },
      { provider: "codex", path: path.join(expand(codexHome), "archived_sessions") },
      { provider: "claude", path: path.join(expand(claudeHome), "projects") },
      { provider: "grok", path: path.join(expand(grokHome), "sessions") },
      {
        provider: "copilot",
        path: Option.match(copilotFile, {
          onNone: () => path.join(expand(copilotHome), "otel"),
          onSome: (value) => expand(value),
        }),
      },
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
          message: "--source requires --provider codex, claude, grok, or copilot.",
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

    const basePrices = yield* loadPrices(
      path.join(expand(cacheRoot), "token-ledger", "prices.json"),
      flags.offline,
    );

    const pricing =
      configuration.prices === undefined
        ? basePrices
        : PriceBook.make({
            ...basePrices,
            status: "custom",
            source: `${basePrices.source}; configuration overrides`,
            prices: { ...basePrices.prices, ...configuration.prices },
          });

    const request = yield* ReportRequest.makeEffect({
      since: Option.getOrElse(flags.since, () => `${today.slice(0, 7)}-01`),
      until: Option.getOrElse(flags.until, () => today),
      sources,
      projects,
      pricing,
    }).pipe(
      Effect.mapError(
        () => new CliError({ message: "Invalid report inputs; --since must not follow --until." }),
      ),
    );

    const ledger = yield* Ledger;
    const result = yield* ledger.report(request);

    const output = Match.value(flags.json ? "json" : flags.format).pipe(
      Match.when("json", () => JSON.stringify(result, null, 2)),
      Match.when("csv", () => csv(result)),
      Match.when("table", () => table(result, process.stdout.columns ?? 120)),
      Match.exhaustive,
    );

    yield* Console.log(output);

    if (pricing.status === "unavailable")
      yield* Console.error(
        "Pricing unavailable: unknown rates remain unpriced. Configure prices or rerun online.",
      );

    for (const source of result.coverage) {
      if (source.status !== "ok" || source.warnings.length > 0)
        yield* Console.error(
          `${source.provider}: ${source.status}; ${source.files} files, ${source.malformedLines} malformed lines, ${source.skippedRecords} skipped records. ${source.warnings.join(" ")}`,
        );
    }

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
  Command.withSubcommands([report, example]),
  Command.run({ version: "0.1.0" }),
  Effect.provide(Ledger.layer),
  Effect.provide(NodeServices.layer),
  Effect.provide(FetchHttpClient.layer),
  NodeRuntime.runMain,
);
