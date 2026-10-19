import { SyncPayload } from "@token-ledger/core/sync";
import { Effect, Match, Option, Predicate, type Redacted, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

/** The server was unreachable, too slow, or temporarily failing after retries; a later run may succeed. */
export class SyncUnreachable extends Schema.TaggedError<SyncUnreachable>()("SyncUnreachable", {
  message: Schema.String,
}) {}

/** The server refused the API token (401) or this machine for this user (403). */
export class SyncUnauthorized extends Schema.TaggedError<SyncUnauthorized>()("SyncUnauthorized", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The server and client need compatible payload versions. */
export class SyncUnsupportedVersion extends Schema.TaggedError<SyncUnsupportedVersion>()(
  "SyncUnsupportedVersion",
  { message: Schema.String },
) {}

/**
 * The server already applied an upload from this machine whose scan began later (409), so this
 * one's older snapshot was not stored. The usage the server keeps is newer; nothing failed.
 */
export class SyncSuperseded extends Schema.TaggedError<SyncSuperseded>()("SyncSuperseded", {
  message: Schema.String,
}) {}

/** The server rejected the payload or failed to store it. */
export class SyncRejected extends Schema.TaggedError<SyncRejected>()("SyncRejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const Acknowledgement = Schema.Struct({ storedBuckets: Schema.Natural });

/** toki2's list of the caller's machines; the fields beside `machines` tell it from a stand-in. */
const MachineList = Schema.Struct({
  staleAfterDays: Schema.Number,
  from: Schema.String,
  to: Schema.String,
  machines: Schema.Array(Schema.Struct({ machineId: Schema.String.check(Schema.isUUID()) })),
});

/** `path` under the server's base URL, whose own path may or may not end in a slash. */
function endpoint(server: URL, path: string) {
  const base = new URL(server);

  base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;

  return new URL(path, base);
}

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
    Match.when(409, () =>
      Effect.fail(
        new SyncSuperseded({
          message:
            "Not stored: superseded by a newer sync from this machine, which the server keeps. If every sync says this, check this machine's clock.",
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
                  message: `The server accepts payload versions ${rejection.supportedVersions.join(", ") || "none"}, not ${version}; update Toki or use a compatible token-ledger version.`,
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
 * replaces the payload's window, so retrying transient failures is safe; refusals, a
 * superseded snapshot included, are final. Errors never contain the token.
 */
export const upload = Effect.fn("Sync.upload")(function* (
  server: URL,
  token: Redacted.Redacted<string>,
  payload: SyncPayload,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const url = endpoint(server, `ai-usage/machines/${payload.machine.id}/usage`);

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

/**
 * Whether the server has stored an upload from the machine `id`. The server registers a machine
 * in the transaction that stores its first upload, so one it does not list has nothing a long
 * window could replace.
 *
 * Fails with `SyncUnreachable` whenever the answer is not plainly the server's own: any status
 * but 200, a redirect, or a document that is not its machine list. The caller must then assume
 * the machine has uploaded.
 */
export const hasUploaded = Effect.fn("Sync.hasUploaded")(function* (
  server: URL,
  token: Redacted.Redacted<string>,
  id: string,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);
  const url = endpoint(server, "ai-usage/machines");

  const unanswered = new SyncUnreachable({
    message: `Could not ask ${url.origin} whether this machine has uploaded before.`,
  });

  return yield* client
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    )
    .pipe(
      Effect.filterOrFail(
        (response) => response.status === 200,
        () => unanswered,
      ),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(MachineList)),
      Effect.map(({ machines }) =>
        machines.some((machine) => machine.machineId.toLowerCase() === id.toLowerCase()),
      ),
      Effect.scoped,
      Effect.timeout("20 seconds"),
      // Another host's answer says nothing about what this server holds.
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.mapError(() => unanswered),
    );
});
