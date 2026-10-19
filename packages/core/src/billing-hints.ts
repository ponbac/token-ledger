import { Effect, FileSystem, Path, Predicate, Result, Schema } from "effect";

/** Hint failures preserve stored Copilot usage without exposing local log contents. */
export class BillingHintsError extends Schema.TaggedError<BillingHintsError>()(
  "BillingHintsError",
  {
    message: Schema.String,
  },
) {}

const Hint = Schema.fromJsonString(
  Schema.Struct({
    requestId: Schema.NonEmptyString,
    billingProvider: Schema.Literal("codex"),
    authMode: Schema.Literal("chatgpt"),
  }),
);

/** Exact incoming X-Request-Id values, local only; no upstream response IDs or model inference. */
export const readBillingHints = Effect.fn("BillingHints.read")(function* (location: {
  readonly directory: string;
  readonly required: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(location.directory).pipe(Effect.result);

  if (Result.isFailure(entries)) {
    if (!location.required && Predicate.isTagged(entries.failure.reason, "NotFound"))
      return new Set<string>();

    return yield* new BillingHintsError({ message: "Cannot read the billing hints directory." });
  }

  const requests = new Set<string>();

  for (const entry of entries.success.toSorted()) {
    if (!entry.endsWith(".jsonl")) continue;

    const contents = yield* fs
      .readFileString(path.join(location.directory, entry))
      .pipe(
        Effect.mapError(
          () => new BillingHintsError({ message: `Cannot read ${JSON.stringify(entry)}.` }),
        ),
      );

    let lineNumber = 0;

    for (const line of contents.split("\n")) {
      lineNumber++;

      if (!line.trim()) continue;

      // A partial append fails only Copilot for this sync. If telemetry precedes its
      // complete hint, the next sync repairs the route by replacing the same window.
      const hint = yield* Schema.decodeUnknownEffect(Hint)(line).pipe(
        Effect.mapError(
          () =>
            new BillingHintsError({
              message: `Invalid row in ${JSON.stringify(entry)} at line ${lineNumber}.`,
            }),
        ),
      );

      requests.add(hint.requestId);
    }
  }

  return requests;
});
