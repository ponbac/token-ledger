import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";

import { PricingBasis, Provider } from "@token-ledger/core/model";
import { SyncMachine } from "@token-ledger/core/sync";
import { Config, Effect, FileSystem, Match, Option, Path, type Redacted, Schema } from "effect";

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

/** `XDG_CONFIG_HOME` when it is set to an absolute path; a relative value is ignored. */
export const configHome = Effect.gen(function* () {
  const path = yield* Path.Path;

  return yield* Config.String("XDG_CONFIG_HOME").pipe(
    Config.option,
    Effect.map(Option.filter((directory) => path.isAbsolute(directory))),
  );
});

/**
 * The per-user token-ledger directory: `$XDG_CONFIG_HOME/token-ledger` when set, otherwise
 * `%APPDATA%` on Windows, `~/Library/Application Support` on macOS, or `~/.config`.
 */
export const settingsDirectory = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = homedir();
  const xdg = yield* configHome;

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

/**
 * Replaces `sync.json` with the server and token, with mode 600. Windows ignores the mode, so
 * there the file is as private as its directory. The file is complete before it takes the
 * name, so a concurrent sync never reads half of it. Errors never contain the token.
 */
export const saveSyncSettings = Effect.fn("Settings.saveSync")(function* (
  directory: string,
  server: URL,
  token: Redacted.Redacted<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "sync.json");

  yield* Effect.gen(function* () {
    const settings = yield* Schema.encodeEffect(SyncSettings)({ server, token });

    yield* fs.makeDirectory(directory, { recursive: true });

    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({ directory, prefix: ".sync-" });
    const temporary = path.join(temporaryDirectory, "sync.json");

    yield* fs.writeFileString(temporary, `${JSON.stringify(settings, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    yield* fs.rename(temporary, file);
  }).pipe(
    Effect.scoped,
    Effect.mapError(() => new SettingsError({ message: `Cannot save ${file}.` })),
  );

  return file;
});

/**
 * A reprice this installation finished: it sent `server`, an origin, every bucket of
 * `provider` it could build from `from` up to its sync's window, priced on `basis`, and that
 * sync uploaded the window, which ends at `coveredUntil`. `from` is the hour the server named,
 * so the same answer on the same basis later, for a window starting by `coveredUntil`, means
 * only buckets this machine cannot reproduce are left.
 */
export const CompletedReprice = Schema.Struct({
  server: Schema.String,
  provider: Provider,
  basis: PricingBasis,
  from: Schema.DateTimeUtcFromString,
  coveredUntil: Schema.DateTimeUtcFromString,
});

/** One finished reprice per server and provider. */
export interface CompletedReprice extends Schema.Schema.Type<typeof CompletedReprice> {}

const Repricing = Schema.Struct({
  version: Schema.Literal(1),
  completed: Schema.Array(CompletedReprice),
});

/**
 * Reads `repricing.json`, the reprices this installation finished. A missing, unreadable, or
 * undecodable file holds none: forgetting one only sends its buckets again, and the server
 * applies a repeated reprice as it did the first.
 */
export const loadRepricing = Effect.fn("Settings.loadRepricing")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(path.join(directory, "repricing.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Repricing))),
    Effect.map((repricing): ReadonlyArray<CompletedReprice> => repricing.completed),
    Effect.orElseSucceed((): ReadonlyArray<CompletedReprice> => []),
  );
});

/**
 * Replaces `repricing.json` with `completed`. The file is complete before it takes the name,
 * so a concurrent sync never reads half of it; two syncs saving at once keep the later list.
 */
export const saveRepricing = Effect.fn("Settings.saveRepricing")(function* (
  directory: string,
  completed: ReadonlyArray<CompletedReprice>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "repricing.json");

  yield* Effect.gen(function* () {
    const repricing = yield* Schema.encodeEffect(Repricing)({ version: 1, completed });

    yield* fs.makeDirectory(directory, { recursive: true });

    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      prefix: ".repricing-",
    });

    const temporary = path.join(temporaryDirectory, "repricing.json");

    yield* fs.writeFileString(temporary, `${JSON.stringify(repricing, null, 2)}\n`, { flag: "wx" });
    yield* fs.rename(temporary, file);
  }).pipe(
    Effect.scoped,
    // Sync output names no local paths beyond the settings directory's own files.
    Effect.mapError(
      () => new SettingsError({ message: "Cannot save repricing.json in the settings directory." }),
    ),
  );
});

/**
 * `schedule.json` records that this installation's schedule is the user's choice: `schedule
 * install` set it, or a sync already moved a once-a-day job from before `--every` to the
 * default interval. Either way, no sync changes the schedule again.
 */
const ScheduleSettings = Schema.Struct({ version: Schema.Literal(1) });

/** Whether `schedule.json` holds a valid record; a missing or unreadable one holds none. */
export const scheduleSettled = Effect.fn("Settings.scheduleSettled")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  return yield* fs.readFileString(path.join(directory, "schedule.json")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(ScheduleSettings))),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
});

/** Writes `schedule.json`, so that no sync changes the schedule again. */
export const settleSchedule = Effect.fn("Settings.settleSchedule")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* fs.makeDirectory(directory, { recursive: true }).pipe(
    Effect.andThen(
      fs.writeFileString(
        path.join(directory, "schedule.json"),
        `${JSON.stringify({ version: 1 }, null, 2)}\n`,
      ),
    ),
    Effect.mapError(
      () => new SettingsError({ message: "Cannot save schedule.json in the settings directory." }),
    ),
  );
});
