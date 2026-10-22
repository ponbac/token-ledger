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
    repository: Schema.optionalKey(Schema.NonEmptyString),
  }),
);

/** What the proxy knows about one ChatGPT-routed request. */
export interface ChatgptRequest {
  /** The Git remote the request's workspace works in, when the proxy could tell. */
  readonly repository: string | null;
}

/**
 * ChatGPT-routed requests by exact incoming X-Request-Id, local only; no upstream response IDs
 * or model inference. Rows naming different repositories for one request keep none.
 */
export const readBillingHints = Effect.fn("BillingHints.read")(function* (location: {
  readonly directory: string;
  readonly required: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(location.directory).pipe(Effect.result);

  if (Result.isFailure(entries)) {
    if (!location.required && Predicate.isTagged(entries.failure.reason, "NotFound"))
      return new Map<string, ChatgptRequest>();

    return yield* new BillingHintsError({ message: "Cannot read the billing hints directory." });
  }

  const repositories = new Map<string, Set<string>>();

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

      const named = repositories.get(hint.requestId) ?? new Set<string>();

      if (hint.repository !== undefined) named.add(hint.repository);
      repositories.set(hint.requestId, named);
    }
  }

  return new Map(
    [...repositories].map(([requestId, named]): [string, ChatgptRequest] => [
      requestId,
      { repository: named.size === 1 ? ([...named][0] ?? null) : null },
    ]),
  );
});
