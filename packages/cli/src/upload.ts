import { SyncPayload } from "@token-ledger/core/sync";
import { Effect, Match, Option, Predicate, type Redacted, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** The server was unreachable, too slow, or temporarily failing after retries; a later run may succeed. */
export class SyncUnreachable extends Schema.TaggedError<SyncUnreachable>()("SyncUnreachable", {
  message: Schema.String,
}) {}

/** The server refused the API token (401) or this machine for this user (403). */
export class SyncUnauthorized extends Schema.TaggedError<SyncUnauthorized>()("SyncUnauthorized", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The server does not accept this payload version; token-ledger must be upgraded. */
export class SyncUnsupportedVersion extends Schema.TaggedError<SyncUnsupportedVersion>()(
  "SyncUnsupportedVersion",
  { message: Schema.String },
) {}

/** The server rejected the payload or failed to store it. */
export class SyncRejected extends Schema.TaggedError<SyncRejected>()("SyncRejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const Acknowledgement = Schema.Struct({ storedBuckets: Schema.Natural });

const VersionRejection = Schema.Struct({ supportedVersions: Schema.Array(Schema.Int) });

const readResponse = Effect.fn("Sync.readResponse")(function* (
  response: HttpClientResponse.HttpClientResponse,
  version: SyncPayload["version"],
) {
  const status = response.status;

  if (status >= 200 && status < 300)
    return yield* HttpClientResponse.schemaBodyJson(Acknowledgement)(response).pipe(
      Effect.map((acknowledgement) => Option.some(acknowledgement.storedBuckets)),
      Effect.orElseSucceed(() => Option.none<number>()),
    );

  if (status >= 500 || status === 408 || status === 429)
    return yield* new SyncUnreachable({
      message: `The server is temporarily unavailable (${status}); try again later.`,
    });

  return yield* Match.value(status).pipe(
    Match.when(401, () =>
      Effect.fail(
        new SyncUnauthorized({
          status,
          message: "The server rejected the API token; create a new one in toki2.",
        }),
      ),
    ),
    Match.when(403, () =>
      Effect.fail(
        new SyncUnauthorized({
          status,
          message: "This API token may not upload for this machine ID.",
        }),
      ),
    ),
    Match.when(422, () =>
      HttpClientResponse.schemaBodyJson(VersionRejection)(response).pipe(
        Effect.mapError(
          () =>
            new SyncRejected({ status, message: `The server rejected the upload (${status}).` }),
        ),
        Effect.flatMap((rejection) =>
          Effect.fail(
            rejection.supportedVersions.includes(version)
              ? new SyncRejected({ status, message: `The server rejected the upload (${status}).` })
              : new SyncUnsupportedVersion({
                  message: `The server accepts payload versions ${rejection.supportedVersions.join(", ") || "none"}, not ${version}; upgrade token-ledger.`,
                }),
          ),
        ),
      ),
    ),
    Match.orElse(() =>
      Effect.fail(
        new SyncRejected({ status, message: `The server rejected the upload (${status}).` }),
      ),
    ),
  );
});

/**
 * PUTs a payload to toki2 and returns the number of buckets it stored, when reported. Each
 * attempt owns its response and has a timeout covering both headers and body. The server
 * replaces the payload's window, so retrying transient failures is safe. Errors never
 * contain the token.
 */
export const upload = Effect.fn("Sync.upload")(function* (
  server: URL,
  token: Redacted.Redacted<string>,
  payload: SyncPayload,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const base = new URL(server);
  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  const url = new URL(`ai-usage/machines/${payload.machine.id}/usage`, base);

  const request = yield* HttpClientRequest.put(url).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.acceptJson,
    HttpClientRequest.schemaBodyJson(SyncPayload)(payload),
    Effect.orDie,
  );

  return yield* client.execute(request).pipe(
    Effect.flatMap((response) => readResponse(response, payload.version)),
    Effect.scoped,
    Effect.timeout("60 seconds"),
    Effect.catchTag(["HttpClientError", "TimeoutError"], () =>
      Effect.fail(new SyncUnreachable({ message: `Cannot reach ${url.origin}; try again later.` })),
    ),
    Effect.retry({
      while: Predicate.isTagged("SyncUnreachable"),
      schedule: Schedule.exponential("2 seconds"),
      times: 3,
    }),
  );
});
