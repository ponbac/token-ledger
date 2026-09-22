import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/unstable/http";

import { PriceBook } from "./model.ts";
import { loadPrices, lookupPrice, priceTokens } from "./pricing.ts";

it("does not invent cache rates or treat an unknown model as free", () => {
  const tokens = { input: 40, cacheRead: 60, cacheWrite: 10, output: 20 };
  assert.strictEqual(priceTokens(tokens, undefined), null);
  assert.strictEqual(
    priceTokens(tokens, { input: 2, output: 10, cacheRead: null, cacheWrite: null }),
    null,
  );
  assert.closeTo(
    priceTokens(tokens, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 }) ?? -1,
    0.000322,
    1e-12,
  );
});

it.effect("reads a saved rate snapshot offline without needing a provider account", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();
    const cache = path.join(root, "prices.json");

    const book = PriceBook.make({
      status: "fresh",
      source: "fixture",
      fetchedAt: "2026-09-01T00:00:00Z",
      prices: { "anthropic/test": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: null } },
    });

    yield* fs.writeFileString(cache, JSON.stringify(book));
    const loaded = yield* loadPrices(cache, true);
    assert.strictEqual(loaded.status, "cached");
    assert.strictEqual(lookupPrice(loaded, "test")?.input, 2);
    assert.strictEqual(lookupPrice(loaded, "unknown"), undefined);
    const unavailable = yield* loadPrices(path.join(root, "missing"), true);
    assert.strictEqual(unavailable.status, "unavailable");
  }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
);

it.effect(
  "decodes public rates, persists the snapshot, and keeps unknown cache rates unknown",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const cache = path.join(root, "prices.json");

      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              "test-model": {
                input_cost_per_token: 0.000002,
                output_cost_per_token: 0.00001,
                cache_read_input_token_cost: 0.0000002,
              },
              "invalid-model": { input_cost_per_token: -1, output_cost_per_token: 1 },
              metadata: { description: "Not a model rate" },
            }),
          ),
        ),
      );

      const loaded = yield* loadPrices(cache, false).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.strictEqual(loaded.status, "fresh");
      const price = lookupPrice(loaded, "test-model");
      assert.strictEqual(price?.input, 2);
      assert.strictEqual(price?.output, 10);
      assert.closeTo(price?.cacheRead ?? -1, 0.2, 1e-12);
      assert.strictEqual(price?.cacheWrite, null);
      assert.strictEqual(lookupPrice(loaded, "invalid-model"), undefined);
      assert.strictEqual(lookupPrice(loaded, "metadata"), undefined);

      const saved = yield* loadPrices(cache, true).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.deepStrictEqual(saved.prices, loaded.prices);
      assert.strictEqual(saved.fetchedAt, loaded.fetchedAt);
    }).pipe(Effect.provide(NodeServices.layer)),
);
