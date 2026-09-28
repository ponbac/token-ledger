import { Effect, Option, Schema } from "effect";

import { CopilotAttributes } from "./copilot.ts";

/** A Copilot span database could not be read or decoded; never contains database payloads. */
export class CopilotDatabaseError extends Schema.TaggedError<CopilotDatabaseError>()(
  "CopilotDatabaseError",
  { message: Schema.String },
) {}

const Row = Schema.Struct({
  span_id: Schema.NonEmptyString,
  trace_id: Schema.NonEmptyString,
  parent_span_id: Schema.NullOr(Schema.NonEmptyString),
  end_time_ms: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0), Schema.isFinite()),
  attributes_json: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
});

const databaseError = () =>
  new CopilotDatabaseError({ message: "Cannot read the Copilot span database." });

/** Reads only accounting attributes from a VS Code agent-traces.db snapshot, without modifying it. */
export const copilotDatabaseLines = Effect.fn("Copilot.readDatabase")(function* (file: string) {
  return yield* Effect.gen(function* () {
    const { DatabaseSync } = yield* Effect.tryPromise({
      try: () => import("node:sqlite"),
      catch: databaseError,
    });

    const db = yield* Effect.acquireRelease(
      Effect.try({ try: () => new DatabaseSync(file, { readOnly: true }), catch: databaseError }),
      (connection) => Effect.sync(() => connection.close()),
    );

    const keys = Object.keys(CopilotAttributes.fields);

    const rows = yield* Effect.try({
      try: () =>
        db
          .prepare(`
        SELECT span_id, trace_id, parent_span_id, end_time_ms,
          COALESCE((SELECT json_group_object(key, value) FROM span_attributes a
            WHERE a.span_id = s.span_id AND a.key IN (${keys.map(() => "?").join(",")})), '{}') AS attributes_json
        FROM spans s ORDER BY end_time_ms, span_id
      `)
          .all(...keys),
      catch: databaseError,
    });

    const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(rows).pipe(
      Effect.mapError(databaseError),
    );

    return decoded.map((row) =>
      JSON.stringify({
        traceId: row.trace_id,
        spanId: row.span_id,
        parentSpanId: row.parent_span_id ?? undefined,
        endTime: [
          Math.floor(row.end_time_ms / 1000),
          Math.round((row.end_time_ms % 1000) * 1_000_000),
        ],
        attributes: Object.fromEntries(
          Object.entries(row.attributes_json).map(([key, value]) => [
            key,
            key.startsWith("gen_ai.usage.")
              ? Option.getOrElse(
                  Schema.decodeUnknownOption(Schema.NumberFromString)(value),
                  () => value,
                )
              : value,
          ]),
        ),
      }),
    );
  }).pipe(Effect.scoped);
});
