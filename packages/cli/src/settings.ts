import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";

import { SyncMachine } from "@token-ledger/core/sync";
import { Config, Effect, FileSystem, Match, Option, Path, Schema } from "effect";

/** Per-user settings could not be read, decoded, or saved; never contains the token. */
export class SettingsError extends Schema.TaggedError<SettingsError>()("SettingsError", {
  message: Schema.String,
}) {}

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A toki2 base URL. Tokens only travel over HTTPS, or plain HTTP to this machine. */
export const ServerUrl = Schema.URLFromString.check(
  Schema.makeFilter(
    (url) => url.protocol === "https:" || (url.protocol === "http:" && loopback.has(url.hostname)),
    { expected: "an https:// URL, or http:// on localhost" },
  ),
);

/** Optional sync settings in `sync.json`; flags and environment variables take precedence. */
const SyncSettings = Schema.Struct({
  server: Schema.optionalKey(ServerUrl),
  token: Schema.optionalKey(Schema.RedactedFromValue(Schema.NonEmptyString)),
});

/**
 * The per-user token-ledger directory: `$XDG_CONFIG_HOME/token-ledger` when set, otherwise
 * `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, or `~/.config`.
 */
export const settingsDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = homedir();

  const xdg = yield* Config.String("XDG_CONFIG_HOME").pipe(
    Config.option,
    Effect.map(Option.filter((directory) => path.isAbsolute(directory))),
  );

  const appData = yield* Config.String("APPDATA").pipe(Config.option);

  const root = Option.getOrElse(xdg, () =>
    Match.value(process.platform).pipe(
      Match.when("win32", () =>
        Option.getOrElse(appData, () => path.join(home, "AppData", "Roaming")),
      ),
      Match.when("darwin", () => path.join(home, "Library", "Application Support")),
      Match.orElse(() => path.join(home, ".config")),
    ),
  );

  return path.join(root, "token-ledger");
});

/**
 * Reads this installation's identity from `machine.json`, creating it with a random UUID and
 * the host name on first use. An invalid file is an error, never replaced: a new ID would
 * upload the same history again as another machine.
 */
export const loadMachine = Effect.fn("Settings.loadMachine")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "machine.json");

  const read = fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SyncMachine))),
    Effect.mapError(() => new SettingsError({ message: `Cannot read ${file}; fix or remove it.` })),
  );

  if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => true))) return yield* read;

  const machine = yield* SyncMachine.makeEffect({
    id: randomUUID(),
    label: hostname().trim() || "machine",
  }).pipe(Effect.orDie);

  // Publish complete bytes exclusively; concurrent runs can only read a finished identity.
  const created = yield* Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });

    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".machine-",
    });

    const temporary = path.join(temporaryDirectory, "machine.json");

    yield* fs.writeFileString(temporary, `${JSON.stringify(machine, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });

    return yield* fs.link(temporary, file).pipe(
      Effect.as(true),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
    );
  }).pipe(
    Effect.scoped,
    Effect.mapError(() => new SettingsError({ message: `Cannot create ${file}.` })),
  );

  return created ? machine : yield* read;
});

/** Reads `sync.json` when present; its absence means no saved server or token. */
export const loadSyncSettings = Effect.fn("Settings.loadSync")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "sync.json");
  const failure = new SettingsError({ message: `Cannot read or decode ${file}.` });

  if (!(yield* fs.exists(file).pipe(Effect.mapError(() => failure)))) return {};

  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(SyncSettings))),
    Effect.mapError(() => failure),
  );
});
