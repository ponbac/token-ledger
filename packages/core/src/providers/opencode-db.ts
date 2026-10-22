import { Effect, Schema } from "effect";

/** An OpenCode database could not be read or holds no messages; never contains database payloads. */
export class OpencodeDatabaseError extends Schema.TaggedError<OpencodeDatabaseError>()(
  "OpencodeDatabaseError",
  { message: Schema.String },
) {}

/** `opencode.db`, or a release channel's `opencode-<channel>.db`; not its WAL or shared memory. */
export const opencodeDatabaseName = /^opencode(?:-[A-Za-z0-9._-]+)?\.db$/;

const Names = Schema.Array(Schema.Struct({ name: Schema.String }));

const Lines = Schema.Array(Schema.Struct({ line: Schema.String }));

const databaseError = () =>
  new OpencodeDatabaseError({ message: "Cannot read the OpenCode database." });

/** A `$.tokens` object holding only OpenCode's token counts, whatever else the message stores. */
const tokens = (data: string) => `json_object(
  'input', json_extract(${data}, '$.tokens.input'),
  'output', json_extract(${data}, '$.tokens.output'),
  'reasoning', json_extract(${data}, '$.tokens.reasoning'),
  'cache', json_object(
    'read', json_extract(${data}, '$.tokens.cache.read'),
    'write', json_extract(${data}, '$.tokens.cache.write')))`;

/**
 * Reads accounting fields of OpenCode messages created in `[since, until)`, as JSON lines in
 * the shape of a legacy message file, without modifying the database. Prompts, responses, and
 * tool output never leave SQLite: only scalar fields are selected, never `part` rows or
 * `session_message.data.content`. `message` holds every message; `session_message` is the
 * newer store, whose assistant rows are mostly copies of `message` rows under the same IDs, and
 * is the only store in a database from OpenCode's `next` channel.
 */
export const opencodeDatabaseLines = Effect.fn("Opencode.readDatabase")(function* (
  file: string,
  since: number,
  until: number,
) {
  return yield* Effect.gen(function* () {
    const { DatabaseSync } = yield* Effect.tryPromise({
      try: () => import("node:sqlite"),
      catch: databaseError,
    });

    const db = yield* Effect.acquireRelease(
      Effect.try({
        // OpenCode may be writing; wait briefly for its lock rather than failing at once.
        try: () => new DatabaseSync(file, { readOnly: true, timeout: 5000 }),
        catch: databaseError,
      }),
      (connection) => Effect.sync(() => connection.close()),
    );

    const columns = yield* Effect.try({
      try: () =>
        db
          .prepare(
            "SELECT t.name || '.' || c.name AS name FROM sqlite_master t, pragma_table_info(t.name) c WHERE t.type = 'table'",
          )
          .all(),
      catch: databaseError,
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Names)),
      Effect.mapError(databaseError),
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );

    const has = (table: string, ...names: readonly string[]) =>
      names.every((name) => columns.has(`${table}.${name}`));

    const messages = has("message", "id", "session_id", "time_created", "data");
    const v2 = has("session_message", "id", "session_id", "type", "time_created", "data");

    if (!messages && !v2)
      return yield* new OpencodeDatabaseError({
        message: "The OpenCode database has no message table.",
      });

    // A session's working directory, and when it began: a fork's copies predate their session.
    // Each store prefers its own generation's session row, which may have diverged from the other.
    const sessions = (alias: string) =>
      (alias === "v" ? ["session_v2", "session"] : ["session", "session_v2"]).filter((table) =>
        has(table, "id", "directory", "time_created"),
      );

    const joins = (alias: string) =>
      sessions(alias)
        .map((table, index) => `LEFT JOIN ${table} s${index} ON s${index}.id = ${alias}.session_id`)
        .join(" ");

    // The first session table holding the session; SQLite's COALESCE takes two or more.
    const sessionField = (alias: string, field: string) =>
      `COALESCE(${[...sessions(alias).map((_, index) => `s${index}.${field}`), "NULL"].join(", ")})`;

    const line = (alias: string, role: string, provider: string, model: string, cwd: string) =>
      `json_object(
        'id', ${alias}.id,
        'sessionID', ${alias}.session_id,
        'role', ${role},
        'providerID', json_extract(${alias}.data, '${provider}'),
        'modelID', json_extract(${alias}.data, '${model}'),
        'time', json_object('created', ${alias}.time_created),
        'cost', json_extract(${alias}.data, '$.cost'),
        'tokens', ${tokens(`${alias}.data`)},
        'path', json_object('cwd', ${cwd}),
        'directory', ${sessionField(alias, "directory")},
        'forked', json(CASE WHEN ${alias}.time_created < ${sessionField(alias, "time_created")} THEN 'true' ELSE 'false' END)
      ) AS line, ${alias}.time_created AS created, ${alias}.id AS id`;

    const queries = [
      ...(messages
        ? [
            `SELECT ${line("m", "json_extract(m.data, '$.role')", "$.providerID", "$.modelID", "json_extract(m.data, '$.path.cwd')")}
            FROM message m ${joins("m")}
            WHERE m.time_created >= ? AND m.time_created < ?
              AND (json_extract(m.data, '$.role') = 'assistant' OR json_type(m.data, '$.tokens') IS NOT NULL)`,
          ]
        : []),
      ...(v2
        ? [
            `SELECT ${line("v", "v.type", "$.model.providerID", "$.model.id", "NULL")}
            FROM session_message v ${joins("v")}
            WHERE v.time_created >= ? AND v.time_created < ?
              AND (v.type = 'assistant' OR json_type(v.data, '$.tokens') IS NOT NULL)
              ${messages ? "AND NOT EXISTS (SELECT 1 FROM message m WHERE m.id = v.id)" : ""}`,
          ]
        : []),
    ];

    const rows = yield* Effect.try({
      try: () =>
        db
          .prepare(`${queries.join(" UNION ALL ")} ORDER BY created, id`)
          .all(...queries.flatMap(() => [since, until])),
      catch: databaseError,
    });

    const decoded = yield* Schema.decodeUnknownEffect(Lines)(rows).pipe(
      Effect.mapError(databaseError),
    );

    return decoded.map((row) => row.line);
  }).pipe(Effect.scoped);
});
