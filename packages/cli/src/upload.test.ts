import { assert, describe, it } from "@effect/vitest";
import { SyncPayload } from "@token-ledger/core/sync";
import { Effect, Fiber, Option, Predicate, Redacted, Result } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { upload } from "./upload.ts";

const payload = SyncPayload.make({
  version: 1,
  machine: { id: "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", label: "test-machine" },
  clientVersion: "0.0.0-test",
  timeZone: "Europe/Stockholm",
  window: { start: "2026-09-21T22:00:00.000Z", end: "2026-09-22T22:00:00.000Z" },
  currency: "USD",
  costBasis: "api-equivalent",
  pricing: { status: "custom", fetchedAt: null, source: "fixture" },
  buckets: [],
  coverage: [],
});

const token = Redacted.make("toki_fixture");

function server(respond: (request: HttpClientRequest.HttpClientRequest) => Response | null) {
  const requests: HttpClientRequest.HttpClientRequest[] = [];

  const client = HttpClient.make((request) => {
    requests.push(request);
    const response = respond(request);

    return response === null
      ? Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request }),
          }),
        )
      : Effect.succeed(HttpClientResponse.fromWeb(request, response));
  });

  return { client, requests };
}

describe("upload", () => {
  it.effect("PUTs the payload under the server's path with the bearer token", () =>
    Effect.gen(function* () {
      for (const url of [
        "https://toki.example/api",
        "https://toki.example/api/",
        "https://toki.example/api?tenant=1",
        "https://toki.example/api#machine",
        "https://toki.example/api/?tenant=1#machine",
      ]) {
        const { client, requests } = server(() => Response.json({ storedBuckets: 7 }));

        const stored = yield* upload(new URL(url), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );

        assert.deepStrictEqual(stored, Option.some(7));
        assert.strictEqual(requests.length, 1);
        assert.strictEqual(requests[0]?.method, "PUT");
        assert.strictEqual(
          requests[0]?.url,
          `https://toki.example/api/ai-usage/machines/${payload.machine.id}/usage`,
        );
        assert.strictEqual(requests[0]?.headers["authorization"], "Bearer toki_fixture");
        assert.deepStrictEqual(
          requests[0]?.body._tag === "Uint8Array"
            ? JSON.parse(new TextDecoder().decode(requests[0].body.body))
            : undefined,
          JSON.parse(JSON.stringify(payload)),
        );
      }
    }),
  );

  it.effect("classifies refusals so each maps to its own exit code", () =>
    Effect.gen(function* () {
      for (const [response, tag] of [
        [new Response(null, { status: 401 }), "SyncUnauthorized"],
        [new Response(null, { status: 403 }), "SyncUnauthorized"],
        [Response.json({ supportedVersions: [2] }, { status: 422 }), "SyncUnsupportedVersion"],
        [Response.json({ supportedVersions: [1] }, { status: 422 }), "SyncRejected"],
        [new Response(null, { status: 422 }), "SyncRejected"],
        [new Response(null, { status: 400 }), "SyncRejected"],
      ] as const) {
        const { client } = server(() => response.clone());

        const result = yield* upload(new URL("https://toki.example"), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
        );

        assert.isTrue(Result.isFailure(result) && Predicate.isTagged(result.failure, tag), tag);
        assert.notInclude(JSON.stringify(result), "toki_fixture");
      }
    }),
  );

  it.effect("retries transient failures before reporting the server unreachable", () =>
    Effect.gen(function* () {
      const flaky = server(() =>
        flaky.requests.length < 3 ? null : Response.json({ storedBuckets: 0 }, { status: 200 }),
      );

      const recovered = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, flaky.client),
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      assert.deepStrictEqual(yield* Fiber.join(recovered), Option.some(0));

      const down = server(() => null);

      const failed = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, down.client),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      const result = yield* Fiber.join(failed);
      assert.isTrue(
        Result.isFailure(result) && Predicate.isTagged(result.failure, "SyncUnreachable"),
      );
      assert.strictEqual(down.requests.length, 4);

      const unavailable = server(() => new Response(null, { status: 503 }));

      const overloaded = yield* upload(new URL("https://toki.example"), token, payload).pipe(
        Effect.provideService(HttpClient.HttpClient, unavailable.client),
        Effect.result,
        Effect.forkChild,
      );

      yield* TestClock.adjust("1 minute");
      const outage = yield* Fiber.join(overloaded);
      assert.isTrue(
        Result.isFailure(outage) && Predicate.isTagged(outage.failure, "SyncUnreachable"),
      );
      assert.strictEqual(unavailable.requests.length, 4);
    }),
  );

  it.effect("times out stalled response bodies and closes every retry attempt", () =>
    Effect.gen(function* () {
      for (const status of [200, 422]) {
        const signals: AbortSignal[] = [];

        const client = HttpClient.make((request, _url, signal) => {
          signals.push(signal);

          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              signal.addEventListener("abort", () => controller.close(), { once: true });
            },
          });

          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(body, { status })),
          );
        });

        const failed = yield* upload(new URL("https://toki.example"), token, payload).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
          Effect.forkChild,
        );

        yield* TestClock.adjust("10 minutes");
        assert.strictEqual(signals.length, 4, `stalled ${status} body`);
        assert.isTrue(signals.every((signal) => signal.aborted));

        const result = yield* Fiber.join(failed);
        assert.isTrue(
          Result.isFailure(result) && Predicate.isTagged(result.failure, "SyncUnreachable"),
        );
      }
    }),
  );
});
