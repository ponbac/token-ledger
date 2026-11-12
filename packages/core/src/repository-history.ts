import { createHash } from "node:crypto";

import { Effect, FileSystem, Option, Path, Predicate, Schema } from "effect";
import type { ReportRequest } from "./model.ts";

/** Local repository history could not be read or saved; uploading would risk losing attribution. */
export class RepositoryHistoryError extends Schema.TaggedError<RepositoryHistoryError>()(
  "RepositoryHistoryError",
  { message: Schema.String },
) {}

const Entry = Schema.Struct({
  version: Schema.Literal(1),
  // An identity is host/path, not a URL: SCP paths can contain spaces and Unicode,
  // and a port must not be removed using another transport's default.
  // Null records an observed loss of a network origin, preventing an old identity's revival.
  repository: Schema.NullOr(Schema.NonEmptyString.check(Schema.isPattern(/^[^/\s@]+\/[^\r\n]+$/u))),
});

/**
 * One scan's durable repository history. Each normalized directory has its own atomically
 * replaced file, so concurrent scans of different repositories cannot erase each other's facts.
 * Only canonical network identities are stored; paths are hashed and credentials never persist.
 */
export const repositoryHistory = Effect.fn("RepositoryHistory.open")(function* (
  config: ReportRequest["repositoryHistory"],
  onWarning?: (message: string) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pending = new Map<string, typeof Entry.Type>();
  const loaded = new Map<string, typeof Entry.Type | null>();
  const directory = config?.directory;

  const filename = (root: string) =>
    `${createHash("sha256").update(path.resolve(root)).digest("hex")}.json`;

  const recover = (error: RepositoryHistoryError) =>
    config?.required ? Effect.fail(error) : (onWarning?.(error.message) ?? Effect.void);

  const read = Effect.fn("RepositoryHistory.read")(function* (root: string) {
    if (directory === undefined) return null;

    const key = filename(root);
    const observed = pending.get(key);

    if (observed !== undefined) return observed;

    const cached = loaded.get(key);

    if (cached !== undefined) return cached;

    const file = path.join(directory, key);

    const saved = yield* fs.readFileString(file).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Predicate.isTagged(error.reason, "NotFound") ? Effect.succeed(null) : Effect.fail(error),
      ),
      Effect.flatMap((text) =>
        text === null
          ? Effect.succeed(null)
          : Schema.decodeUnknownEffect(Schema.fromJsonString(Entry))(text),
      ),
      Effect.mapError(
        () =>
          new RepositoryHistoryError({
            message: `Cannot read repository history at ${file}. Fix its permissions or repair its contents before syncing. If it is damaged beyond repair, remove only this file; attribution for that deleted directory will then be unknown until restored.`,
          }),
      ),
      Effect.catchTag("RepositoryHistoryError", (error) => recover(error).pipe(Effect.as(null))),
    );

    loaded.set(key, saved);

    return saved;
  });

  const remember = (root: string, repository: string | null) => {
    const entry = Schema.decodeUnknownOption(Entry)({ version: 1, repository });

    if (directory !== undefined && Option.isSome(entry)) pending.set(filename(root), entry.value);
  };

  const flush = Effect.fn("RepositoryHistory.save")(function* () {
    if (directory === undefined || pending.size === 0) return;
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });

      for (const [key, entry] of pending) {
        const temporary = yield* fs.makeTempFileScoped({ directory, prefix: ".repository-" });
        yield* fs.writeFileString(temporary, JSON.stringify(entry) + "\n");
        yield* fs.chmod(temporary, 0o600);
        yield* fs.rename(temporary, path.join(directory, key));
      }
    }).pipe(
      Effect.scoped,
      Effect.mapError(
        () =>
          new RepositoryHistoryError({
            message: `Cannot save repository history in ${directory}.${config?.required ? " Sync stopped to preserve attribution." : ""}`,
          }),
      ),
      Effect.catchTag("RepositoryHistoryError", recover),
    );
  });

  return { read, remember, flush };
});
