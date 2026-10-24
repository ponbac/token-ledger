import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { CopilotRateCard, copilotRates } from "./copilot-rates.ts";
import { PriceBook, PricingBasis, type Tokens, type UsageRecord } from "./model.ts";
import { configuredPricing, loadPrices, priceRecord, pricerFor, pricingBasis } from "./pricing.ts";

const october = Date.parse("2026-10-20T10:00:00Z");

/** A synthetic request; `route` names its source tool and, when routed, its payer. */
function request(
  model: string,
  tokens: Tokens,
  route: Pick<UsageRecord, "provider" | "billingProvider"> = { provider: "codex" },
  timestamp = october,
): UsageRecord {
  return {
    ...route,
    id: model,
    session: "session",
    timestamp,
    model,
    cwd: null,
    repository: null,
    tokens,
  };
}

function tokens(input: number, cacheRead = 0, cacheWrite = 0, output = 0): Tokens {
  return { input, cacheRead, cacheWrite, output };
}

/** Synthetic LiteLLM entries, with every tier key that compound names could be mistaken for. */
const litellm = {
  "sol-model": {
    litellm_provider: "openai",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.00001,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.0000025,
    cache_creation_input_token_cost_above_12hr: 0.000005,
    input_cost_per_token_above_272k_tokens: 0.000004,
    output_cost_per_token_above_272k_tokens: 0.000015,
    cache_read_input_token_cost_above_272k_tokens: 0.0000002,
    cache_creation_input_token_cost_above_272k_tokens: 0.000005,
    cache_creation_input_token_cost_above_12hr_above_272k_tokens: 0.00001,
  },
  "older-openai": {
    litellm_provider: "openai",
    input_cost_per_token: 0.00000175,
    output_cost_per_token: 0.000014,
    cache_read_input_token_cost: 0.000000175,
  },
  "claude-haiku-9-9": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.0000001,
    output_cost_per_token: 0.0000005,
    cache_read_input_token_cost: 0.00000001,
    cache_creation_input_token_cost: 0.000000125,
    cache_creation_input_token_cost_above_1hr: 0.0000002,
    input_cost_per_token_above_100k_tokens: 0.0000005,
    output_cost_per_token_above_100k_tokens: 0.0000025,
    cache_read_input_token_cost_above_100k_tokens: 0.00000005,
    cache_creation_input_token_cost_above_100k_tokens: 0.000000625,
    cache_creation_input_token_cost_above_1hr_above_100k_tokens: 0.000001,
  },
  "claude-opus-9-9": {
    litellm_provider: "anthropic",
    input_cost_per_token: 0.000004,
    output_cost_per_token: 0.00002,
    cache_read_input_token_cost: 0.0000002,
    cache_creation_input_token_cost: 0.000005,
    cache_creation_input_token_cost_above_1hr: 0.000008,
  },
  "partial-tier": {
    litellm_provider: "gemini",
    input_cost_per_token: 0.000002,
    output_cost_per_token: 0.000012,
    cache_read_input_token_cost: 0.0000002,
    input_cost_per_token_above_128k_tokens: 0.000004,
    output_cost_per_token_above_128k_tokens: 0.000018,
  },
  "gpt-4o-mini-2024-07-18": {
    litellm_provider: "openai",
    input_cost_per_token: 0.00000015,
    output_cost_per_token: 0.0000006,
    cache_read_input_token_cost: 0.000000075,
  },
  "github_copilot/claude-sonnet-4.6": {
    litellm_provider: "github_copilot",
    input_cost_per_token: 0.000003,
    output_cost_per_token: 0.000015,
    cache_read_input_token_cost: 0.0000003,
    cache_creation_input_token_cost: 0.00000375,
  },
  "github_copilot/gpt-9": {
    litellm_provider: "github_copilot",
    input_cost_per_token: 0.000001,
    output_cost_per_token: 0.000004,
    cache_read_input_token_cost: 0.0000001,
    cache_creation_input_token_cost: 0.00000125,
  },
  "invalid-model": { input_cost_per_token: -1, output_cost_per_token: 1 },
  metadata: { description: "Not a model rate" },
};

const fetchLitellm = Effect.fn("Test.fetchLitellm")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();

  const client = HttpClient.make((input) =>
    Effect.succeed(HttpClientResponse.fromWeb(input, Response.json(litellm))),
  );

  return yield* loadPrices(path.join(root, "prices.json"), false).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );
});

const withLitellm = <A, E>(
  test: (pricer: ReturnType<typeof pricerFor>, book: PriceBook) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const book = yield* fetchLitellm();

    return yield* test(pricerFor(book), book);
  }).pipe(Effect.provide(NodeServices.layer));

describe("vendor rates", () => {
  it("does not invent cache rates or treat an unknown model as free", () => {
    const book = PriceBook.make({
      status: "custom",
      fetchedAt: null,
      source: "fixture",
      prices: {
        known: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 3 },
        "no-cache": { input: 2, output: 10, cacheRead: null, cacheWrite: null },
      },
    });

    const pricer = pricerFor(book);
    const used = tokens(40, 60, 10, 20);
    assert.deepStrictEqual(priceRecord(request("unknown", used), pricer), {
      usd: null,
      base: null,
    });
    assert.strictEqual(priceRecord(request("no-cache", used), pricer).usd, null);
    assert.closeTo(priceRecord(request("known", used), pricer).usd ?? -1, 0.000322, 1e-12);
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
        basis: "not-a-snapshot-field",
      });

      yield* fs.writeFileString(cache, JSON.stringify(book));
      const loaded = yield* loadPrices(cache, true);
      assert.strictEqual(loaded.status, "cached");
      // Only configuredPricing establishes a basis, never a stored snapshot.
      assert.isUndefined(loaded.basis);
      const pricer = pricerFor(loaded);
      assert.strictEqual(priceRecord(request("test", tokens(1)), pricer).base?.input, 2);
      assert.isNull(priceRecord(request("unknown", tokens(1)), pricer).base);
      const unavailable = yield* loadPrices(path.join(root, "missing"), true);
      assert.strictEqual(unavailable.status, "unavailable");
    }).pipe(Effect.provide(NodeServices.layer), Effect.provide(FetchHttpClient.layer)),
  );

  it.effect("decodes tiers by exact field name and persists the snapshot", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const cache = path.join(root, "prices.json");

      const client = HttpClient.make((input) =>
        Effect.succeed(HttpClientResponse.fromWeb(input, Response.json(litellm))),
      );

      const loaded = yield* loadPrices(cache, false).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.strictEqual(loaded.status, "fresh");
      const sol = loaded.prices["sol-model"];
      assert.closeTo(sol?.cacheWrite ?? -1, 2.5, 1e-9);
      assert.lengthOf(sol?.tiers ?? [], 1);
      assert.strictEqual(sol?.tiers?.[0]?.above, 272_000);
      // The twelve-hour write above 272K is 10, not the 272K tier's write rate of 5.
      assert.closeTo(sol?.tiers?.[0]?.cacheWrite ?? -1, 5, 1e-9);
      assert.closeTo(sol?.tiers?.[0]?.cacheRead ?? -1, 0.2, 1e-9);
      assert.isUndefined(sol?.cacheWrite1h);
      assert.strictEqual(sol?.uncachedInput, "cacheWrite");

      // Haiku's one-hour write above 100K is a compound key, not a 1-hour context tier.
      const haiku = loaded.prices["claude-haiku-9-9"];
      assert.closeTo(haiku?.cacheWrite1h ?? -1, 0.2, 1e-9);
      assert.lengthOf(haiku?.tiers ?? [], 1);
      assert.strictEqual(haiku?.tiers?.[0]?.above, 100_000);
      assert.closeTo(haiku?.tiers?.[0]?.cacheWrite ?? -1, 0.625, 1e-9);
      assert.closeTo(haiku?.tiers?.[0]?.cacheWrite1h ?? -1, 1, 1e-9);
      assert.isUndefined(haiku?.uncachedInput);

      // A tier without cache rates keeps the base tier's.
      const partial = loaded.prices["partial-tier"];
      assert.lengthOf(partial?.tiers ?? [], 1);
      assert.strictEqual(partial?.tiers?.[0]?.above, 128_000);
      assert.closeTo(partial?.tiers?.[0]?.cacheRead ?? -1, 0.2, 1e-9);
      assert.isNull(partial?.tiers?.[0]?.cacheWrite);

      assert.isUndefined(loaded.prices["older-openai"]?.uncachedInput);
      // Every Copilot entry with a cache-write rate bills unreported writes at it, Claude's too.
      assert.strictEqual(loaded.prices["github_copilot/gpt-9"]?.uncachedInput, "cacheWrite");
      assert.strictEqual(
        loaded.prices["github_copilot/claude-sonnet-4.6"]?.uncachedInput,
        "cacheWrite",
      );
      assert.isUndefined(loaded.prices["invalid-model"]);
      assert.isUndefined(loaded.prices["metadata"]);

      const saved = yield* loadPrices(cache, true).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );

      assert.deepStrictEqual(saved.prices, loaded.prices);
      assert.strictEqual(saved.fetchedAt, loaded.fetchedAt);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("chooses each request's tier: 272,000 tokens stay base, 272,001 are long", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        // OpenAI's rule applies too: three tokens at input, the rest at the cache-write rate.
        const short = priceRecord(request("sol-model", tokens(1_000, 271_000, 0, 100)), pricer);
        const long = priceRecord(request("sol-model", tokens(1_000, 271_001, 0, 100)), pricer);
        assert.closeTo(
          short.usd ?? -1,
          (3 * 2 + 997 * 2.5 + 271_000 * 0.1 + 100 * 10) / 1e6,
          1e-12,
        );
        assert.closeTo(long.usd ?? -1, (3 * 4 + 997 * 5 + 271_001 * 0.2 + 100 * 15) / 1e6, 1e-12);
        // A report shows the base tier, whichever tier priced the request.
        assert.closeTo(long.base?.input ?? -1, 2, 1e-9);

        const partial = priceRecord(request("partial-tier", tokens(30_000, 100_000)), pricer);
        assert.closeTo(partial.usd ?? -1, (30_000 * 4 + 100_000 * 0.2) / 1e6, 1e-12);
      }),
    ),
  );

  it.effect("prices a request summing several at the base tier", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const turn = { ...request("sol-model", tokens(1_000, 400_000, 0, 100)), aggregate: true };
        const usd = priceRecord(turn, pricer).usd;
        assert.closeTo(usd ?? -1, (3 * 2 + 997 * 2.5 + 400_000 * 0.1 + 100 * 10) / 1e6, 1e-12);
      }),
    ),
  );

  it.effect("prices implicit cache writes as min(input, 3) at input and the rest written", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const usd = (input: number, cacheWrite = 0, output = 0) =>
          priceRecord(request("sol-model", tokens(input, 0, cacheWrite, output)), pricer).usd;

        assert.closeTo(usd(10) ?? -1, (3 * 2 + 7 * 2.5) / 1e6, 1e-15);
        assert.closeTo(usd(3) ?? -1, (3 * 2) / 1e6, 1e-15);
        assert.closeTo(usd(2) ?? -1, (2 * 2) / 1e6, 1e-15);
        // No uncached input never goes negative.
        assert.closeTo(usd(0, 0, 10) ?? -1, (10 * 10) / 1e6, 1e-15);
        // Reported cache writes are priced as reported.
        assert.closeTo(usd(10, 50) ?? -1, (10 * 2 + 50 * 2.5) / 1e6, 1e-15);
        // A model without a cache-write rate bills uncached input as input.
        const older = priceRecord(request("older-openai", tokens(1_000)), pricer).usd;
        assert.closeTo(older ?? -1, (1_000 * 1.75) / 1e6, 1e-12);
      }),
    ),
  );

  it.effect("applies OpenAI's implicit cache writes whoever pays, and not Anthropic's", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const written = (3 * 2 + 997 * 2.5) / 1e6;

        for (const route of [
          { provider: "codex" },
          { provider: "pi" },
          { provider: "copilot", billingProvider: "codex" },
          { provider: "opencode", billingProvider: "codex" },
        ] as const)
          assert.closeTo(
            priceRecord(request("sol-model", tokens(1_000), route), pricer).usd ?? -1,
            written,
            1e-12,
            route.provider,
          );

        const claude = priceRecord(
          request("claude-opus-9-9", tokens(1_000), { provider: "claude" }),
          pricer,
        );

        assert.closeTo(claude.usd ?? -1, (1_000 * 4) / 1e6, 1e-12);
      }),
    ),
  );

  it.effect("prices Claude's one-hour cache writes at their own rate, tiered for Haiku", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const claude = { provider: "claude" } as const;

        const opus = (cacheWrite1h: number) =>
          priceRecord(
            { ...request("claude-opus-9-9", tokens(10, 0, 1_000), claude), cacheWrite1h },
            pricer,
          ).usd;

        assert.closeTo(opus(1_000) ?? -1, (10 * 4 + 1_000 * 8) / 1e6, 1e-12);
        assert.closeTo(opus(400) ?? -1, (10 * 4 + 600 * 5 + 400 * 8) / 1e6, 1e-12);
        assert.closeTo(
          priceRecord(request("claude-opus-9-9", tokens(10, 0, 1_000), claude), pricer).usd ?? -1,
          (10 * 4 + 1_000 * 5) / 1e6,
          1e-12,
        );

        const haiku = (cacheRead: number) =>
          priceRecord(
            {
              ...request("claude-haiku-9-9", tokens(1_000, cacheRead, 2_000, 100), claude),
              cacheWrite1h: 1_500,
            },
            pricer,
          ).usd;

        assert.closeTo(
          haiku(10_000) ?? -1,
          (1_000 * 0.1 + 10_000 * 0.01 + 500 * 0.125 + 1_500 * 0.2 + 100 * 0.5) / 1e6,
          1e-12,
        );
        // Above 100K, the compound one-hour key prices the one-hour writes.
        assert.closeTo(
          haiku(100_000) ?? -1,
          (1_000 * 0.5 + 100_000 * 0.05 + 500 * 0.625 + 1_500 * 1 + 100 * 2.5) / 1e6,
          1e-12,
        );
      }),
    ),
  );

  it.effect("resolves dotted Claude IDs, context variants, and no private aliases", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const opus = (model: string) =>
          priceRecord(request(model, tokens(1_000), { provider: "opencode" }), pricer).usd;

        assert.closeTo(opus("claude-opus-9.9") ?? -1, 0.004, 1e-12);
        assert.closeTo(opus("claude-opus-9-9[1m]") ?? -1, 0.004, 1e-12);
        assert.closeTo(opus("claude-opus-9.9[1m]") ?? -1, 0.004, 1e-12);

        for (const model of ["codex-auto-review", "gpt-5.3-codex-spark"])
          assert.deepStrictEqual(priceRecord(request(model, tokens(1_000)), pricer), {
            usd: null,
            base: null,
          });
      }),
    ),
  );
});

describe("Copilot-paid requests", () => {
  it.effect("take Copilot's card, with its cache-write rule and long tier", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const sol = (route: Pick<UsageRecord, "provider" | "billingProvider">, cacheRead: number) =>
          priceRecord(request("gpt-6.1-sol", tokens(10_000, cacheRead, 0, 1_000), route), pricer)
            .usd;

        const short = (3 * 2 + 9_997 * 2.5 + 100_000 * 0.1 + 1_000 * 10) / 1e6;
        assert.closeTo(sol({ provider: "copilot" }, 100_000) ?? -1, short, 1e-12);
        assert.closeTo(
          sol({ provider: "opencode", billingProvider: "copilot" }, 100_000) ?? -1,
          short,
          1e-12,
        );
        // GitHub's bill: 0.00015 credits per request below all uncached input at the write rate.
        assert.closeTo(
          (10_000 * 2.5 + 100_000 * 0.1 + 1_000 * 10) / 1e6 - short,
          0.00015 * 0.01,
          1e-15,
        );

        assert.closeTo(
          sol({ provider: "copilot" }, 300_000) ?? -1,
          (3 * 4 + 9_997 * 5 + 300_000 * 0.2 + 1_000 * 15) / 1e6,
          1e-12,
        );

        // GPT-5.6 Luna's long tier starts above 200K on Copilot.
        const luna = (cacheRead: number) =>
          priceRecord(
            request("gpt-5.6-luna", tokens(1_000, cacheRead), { provider: "copilot" }),
            pricer,
          ).usd;

        assert.closeTo(luna(199_000) ?? -1, (3 * 0.2 + 997 * 0.25 + 199_000 * 0.02) / 1e6, 1e-12);
        assert.closeTo(luna(199_001) ?? -1, (3 * 0.4 + 997 * 0.5 + 199_001 * 0.04) / 1e6, 1e-12);

        // GPT-5.3-Codex has no cache-write rate, so uncached input is billed as input.
        const codex = priceRecord(
          request("gpt-5.3-codex", tokens(1_000), { provider: "copilot" }),
          pricer,
        );

        assert.closeTo(codex.usd ?? -1, (1_000 * 1.75) / 1e6, 1e-12);

        // GitHub bills Claude's unreported cache writes as cache writes too.
        const sonnet = priceRecord(
          request("claude-sonnet-5.5", tokens(10_000, 40_000, 0, 500), { provider: "copilot" }),
          pricer,
        );

        assert.closeTo(
          sonnet.usd ?? -1,
          (3 * 2 + 9_997 * 2.5 + 40_000 * 0.1 + 500 * 10) / 1e6,
          1e-12,
        );
      }),
    ),
  );

  it.effect("use the rate in effect on the request's UTC day", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const sol = (day: string) =>
          priceRecord(
            request(
              "gpt-5.6-sol",
              tokens(1_000),
              { provider: "copilot" },
              Date.parse(`${day}T23:30:00Z`),
            ),
            pricer,
          ).usd;

        const promotion = (3 * 2 + 997 * 2.5) / 1e6;
        assert.closeTo(sol("2026-08-01") ?? -1, promotion, 1e-12);
        assert.closeTo(sol("2026-09-03") ?? -1, promotion, 1e-12);
        assert.closeTo(sol("2026-09-04") ?? -1, (3 * 4 + 997 * 5) / 1e6, 1e-12);

        const sonnet = (day: string) =>
          priceRecord(
            request(
              "claude-sonnet-5.5",
              tokens(1_000, 1_000, 100, 100),
              { provider: "copilot" },
              Date.parse(`${day}T12:00:00Z`),
            ),
            pricer,
          ).usd;

        // GitHub's docs changed the cached rate on 2026-10-07; its bills changed a day later.
        assert.closeTo(sonnet("2026-10-07") ?? -1, (2_000 + 200 + 250 + 1_000) / 1e6, 1e-12);
        assert.closeTo(sonnet("2026-10-08") ?? -1, (2_000 + 100 + 250 + 1_000) / 1e6, 1e-12);
      }),
    ),
  );

  it.effect("cost nothing on free models, which other payers' requests do not share", () =>
    withLitellm((pricer) =>
      Effect.sync(() => {
        const used = tokens(1_000, 500, 0, 100);

        for (const model of ["copilot-nes-lysithea-24", "nes-example-1", "gpt-4o-mini-2024-07-18"])
          assert.strictEqual(
            priceRecord(request(model, used, { provider: "copilot" }), pricer).usd,
            0,
            model,
          );

        // Neither a Copilot request a ChatGPT plan paid nor another tool's own is Copilot-paid.
        for (const route of [
          { provider: "copilot", billingProvider: "codex" },
          { provider: "opencode" },
        ] as const)
          assert.closeTo(
            priceRecord(request("gpt-4o-mini-2024-07-18", used, route), pricer).usd ?? -1,
            (1_000 * 0.15 + 500 * 0.075 + 100 * 0.6) / 1e6,
            1e-12,
            route.provider,
          );
      }),
    ),
  );

  it.effect(
    "fall back to LiteLLM's Copilot rates, then the vendor's, for models off the card",
    () =>
      withLitellm((pricer) =>
        Effect.sync(() => {
          const used = tokens(1_000, 1_000, 100, 100);

          for (const route of [
            { provider: "copilot" },
            { provider: "pi", billingProvider: "copilot" },
          ] as const)
            assert.closeTo(
              priceRecord(request("claude-sonnet-4.6", used, route), pricer).usd ?? -1,
              (1_000 * 3 + 1_000 * 0.3 + 100 * 3.75 + 100 * 15) / 1e6,
              1e-12,
              route.provider,
            );

          // LiteLLM's Copilot rates bill unreported cache writes at the write rate, Claude's too.
          const gpt = priceRecord(request("gpt-9", tokens(1_000), { provider: "copilot" }), pricer);
          assert.closeTo(gpt.usd ?? -1, (3 * 1 + 997 * 1.25) / 1e6, 1e-12);

          const claude = priceRecord(
            request("claude-sonnet-4.6", tokens(1_000), { provider: "copilot" }),
            pricer,
          );

          assert.closeTo(claude.usd ?? -1, (3 * 3 + 997 * 3.75) / 1e6, 1e-12);

          const vendor = priceRecord(
            request("claude-opus-9.9", tokens(1_000), { provider: "copilot" }),
            pricer,
          );

          assert.closeTo(vendor.usd ?? -1, 0.004, 1e-12);
        }),
      ),
  );
});

describe("pricing basis", () => {
  const vendor = PriceBook.make({
    status: "fresh",
    fetchedAt: "2026-10-24T10:00:00.000Z",
    source: "https://example.com/rates.json",
    prices: {},
  });

  const overrides = {
    alpha: { input: 1, output: 2, cacheRead: null, cacheWrite: null },
    beta: {
      input: 3,
      output: 4,
      cacheRead: 0.3,
      cacheWrite: 3.75,
      tiers: [
        { above: 272_000, input: 6, output: 6, cacheRead: 0.6, cacheWrite: 7.5 },
        { above: 128_000, input: 4, output: 5, cacheRead: 0.4, cacheWrite: 5 },
      ],
    },
  };

  it("names the method, rate card, and overrides, and nothing that changes between fetches", () => {
    const basis = configuredPricing(vendor, undefined).basis;
    assert.isTrue(Schema.is(PricingBasis)(basis));
    assert.include(basis, `copilot-rates@${copilotRates.version}`);

    const later = configuredPricing(
      { ...vendor, fetchedAt: "2026-10-25T09:00:00.000Z", prices: overrides },
      undefined,
    );

    assert.strictEqual(later.basis, basis);
    assert.strictEqual(configuredPricing({ ...vendor, status: "cached" }, undefined).basis, basis);
    assert.strictEqual(configuredPricing(vendor, {}).basis, basis);

    const configured = configuredPricing(vendor, overrides);
    assert.strictEqual(configured.status, "custom");
    assert.isTrue(Schema.is(PricingBasis)(configured.basis));
    assert.notStrictEqual(configured.basis, basis);

    // The same overrides in another order establish the same basis; another rate does not.
    const reordered = {
      beta: { ...overrides.beta, tiers: overrides.beta.tiers.toReversed() },
      alpha: overrides.alpha,
    };

    assert.strictEqual(configuredPricing(vendor, reordered).basis, configured.basis);
    assert.notStrictEqual(
      configuredPricing(vendor, { ...overrides, alpha: { ...overrides.alpha, output: 2.5 } }).basis,
      configured.basis,
    );

    assert.notStrictEqual(
      pricingBasis(
        "fresh",
        undefined,
        CopilotRateCard.make({
          version: "2099-01-01",
          description: copilotRates.description,
          entries: copilotRates.entries,
        }),
      ),
      basis,
    );
  });

  it("is omitted when vendor rates are unavailable, overrides or not", () => {
    const unavailable = { ...vendor, status: "unavailable" as const, fetchedAt: null };
    assert.isUndefined(configuredPricing(unavailable, undefined).basis);
    assert.isUndefined(configuredPricing(unavailable, overrides).basis);
    assert.isUndefined(pricingBasis("custom", undefined, copilotRates));
  });

  it("keeps the source readable, naming the rate table and the Copilot card", () => {
    assert.strictEqual(
      configuredPricing(vendor, overrides).source,
      `https://example.com/rates.json; GitHub Copilot rates ${copilotRates.version}; configuration overrides`,
    );
  });
});
