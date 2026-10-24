import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import card from "./copilot-rates.json" with { type: "json" };
import { CopilotRateCard, copilotPrice, copilotRates } from "./copilot-rates.ts";
import { loadPrices } from "./pricing.ts";

const decode = Schema.decodeUnknownOption(CopilotRateCard, { onExcessProperty: "error" });

it("decodes the checked-in card and refuses fields or rules it cannot price", () => {
  assert.isTrue(Option.isSome(decode(card)));
  const [first, ...rest] = card.entries;

  assert.isTrue(
    Option.isNone(decode({ ...card, entries: [{ ...first, discount: 0.1 }, ...rest] })),
  );
  assert.isTrue(
    Option.isNone(
      decode({
        ...card,
        entries: [{ ...first, base: { ...first?.base, cacheWrite: null } }, ...rest],
      }),
    ),
  );
  assert.isTrue(Option.isNone(decode({ ...card, entries: [...card.entries, first] })));

  assert.isTrue(
    Option.isNone(
      decode({
        ...card,
        entries: [{ ...first, model: "copilot-nes*" }, ...rest],
      }),
    ),
  );
});

it("prices a model family's members, preferring an exact model ID, then the longest family", () => {
  const at = Date.parse("2026-10-20T00:00:00Z");
  const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  assert.deepStrictEqual(copilotPrice(copilotRates, "copilot-nes-pandia-25", at), free);
  assert.isUndefined(copilotPrice(copilotRates, "copilot-nes", at));
  assert.isUndefined(copilotPrice(copilotRates, "auto", at));

  const entry = {
    effectiveFrom: "2026-01-01",
    status: "provisional",
    source: "https://example.com/rates",
  } as const;

  const priced = (input: number) => ({
    ...entry,
    uncachedInput: "input" as const,
    base: { input, output: 1, cacheRead: null, cacheWrite: null },
  });

  const rates = CopilotRateCard.make({
    version: "2026-10-24",
    description: "Synthetic",
    entries: [
      { ...entry, model: "example-*", free: true },
      { ...priced(2), model: "example-pro-*" },
      { ...priced(3), model: "example-pro-max" },
    ],
  });

  assert.deepStrictEqual(copilotPrice(rates, "example-mini", at), free);
  assert.strictEqual(copilotPrice(rates, "example-pro-1", at)?.input, 2);
  assert.strictEqual(copilotPrice(rates, "example-pro-max", at)?.input, 3);
});

it("lists every model GitHub billed or Copilot-paid requests named in October 2026", () => {
  for (const model of [
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "claude-sonnet-5.5",
    "claude-haiku-5.5",
    "mai-code-1.1-flash",
    "gpt-4o-mini-2024-07-18",
    "copilot-nes-lysithea-24",
    "copilot-nes-pandia-25",
  ])
    assert.isDefined(copilotPrice(copilotRates, model, Date.parse("2026-10-20T00:00:00Z")), model);
});

/**
 * LiteLLM's public `github_copilot/` rates on 2026-10-24, per token. It has none for GPT-5.2,
 * which only the vendor's `gpt-5.2` prices.
 */
const rates = {
  "github_copilot/gpt-6.1-sol": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 2.5e-6,
    input_cost_per_token_above_272k_tokens: 4e-6,
    output_cost_per_token_above_272k_tokens: 1.5e-5,
    cache_read_input_token_cost_above_272k_tokens: 2e-7,
    cache_creation_input_token_cost_above_272k_tokens: 5e-6,
  },
  "github_copilot/gpt-6-sol": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 2.5e-6,
    input_cost_per_token_above_272k_tokens: 4e-6,
    output_cost_per_token_above_272k_tokens: 1.5e-5,
    cache_read_input_token_cost_above_272k_tokens: 4e-7,
    cache_creation_input_token_cost_above_272k_tokens: 5e-6,
  },
  "github_copilot/gpt-6-astra": {
    input_cost_per_token: 1e-5,
    output_cost_per_token: 5e-5,
    cache_read_input_token_cost: 1e-6,
    cache_creation_input_token_cost: 1.25e-5,
    input_cost_per_token_above_272k_tokens: 2e-5,
    output_cost_per_token_above_272k_tokens: 7.5e-5,
    cache_read_input_token_cost_above_272k_tokens: 2e-6,
    cache_creation_input_token_cost_above_272k_tokens: 2.5e-5,
  },
  "github_copilot/gpt-6-luna": {
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    cache_read_input_token_cost: 1e-8,
    cache_creation_input_token_cost: 1.25e-7,
    input_cost_per_token_above_272k_tokens: 2e-7,
    output_cost_per_token_above_272k_tokens: 7.5e-7,
    cache_read_input_token_cost_above_272k_tokens: 2e-8,
    cache_creation_input_token_cost_above_272k_tokens: 2.5e-7,
  },
  "github_copilot/gpt-5.6-sol": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 4e-7,
    cache_creation_input_token_cost: 5e-6,
    input_cost_per_token_above_272k_tokens: 8e-6,
    output_cost_per_token_above_272k_tokens: 3e-5,
    cache_read_input_token_cost_above_272k_tokens: 8e-7,
    cache_creation_input_token_cost_above_272k_tokens: 1e-5,
  },
  "github_copilot/gpt-5.6-terra": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1.2e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 2.5e-6,
    input_cost_per_token_above_272k_tokens: 4e-6,
    output_cost_per_token_above_272k_tokens: 1.8e-5,
    cache_read_input_token_cost_above_272k_tokens: 4e-7,
    cache_creation_input_token_cost_above_272k_tokens: 5e-6,
  },
  "github_copilot/gpt-5.6-luna": {
    input_cost_per_token: 2e-7,
    output_cost_per_token: 1.2e-6,
    cache_read_input_token_cost: 2e-8,
    cache_creation_input_token_cost: 2.5e-7,
    input_cost_per_token_above_200k_tokens: 4e-7,
    output_cost_per_token_above_200k_tokens: 1.8e-6,
    cache_read_input_token_cost_above_200k_tokens: 4e-8,
    cache_creation_input_token_cost_above_200k_tokens: 5e-7,
  },
  "github_copilot/gpt-5.5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 3e-5,
    cache_read_input_token_cost: 5e-7,
    input_cost_per_token_above_272k_tokens: 1e-5,
    output_cost_per_token_above_272k_tokens: 4.5e-5,
    cache_read_input_token_cost_above_272k_tokens: 1e-6,
  },
  "github_copilot/gpt-5.4": {
    input_cost_per_token: 2.5e-6,
    output_cost_per_token: 1.5e-5,
    cache_read_input_token_cost: 2.5e-7,
    input_cost_per_token_above_272k_tokens: 5e-6,
    output_cost_per_token_above_272k_tokens: 2.25e-5,
    cache_read_input_token_cost_above_272k_tokens: 5e-7,
  },
  "github_copilot/gpt-5.3-codex": {
    input_cost_per_token: 1.75e-6,
    output_cost_per_token: 1.4e-5,
    cache_read_input_token_cost: 1.75e-7,
  },
  "github_copilot/gpt-5.4-mini": {
    input_cost_per_token: 7.5e-7,
    output_cost_per_token: 4.5e-6,
    cache_read_input_token_cost: 7.5e-8,
  },
  "github_copilot/claude-opus-5.5": {
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
    cache_creation_input_token_cost: 5e-6,
  },
  "github_copilot/claude-opus-5": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "github_copilot/claude-opus-4.8": {
    input_cost_per_token: 5e-6,
    output_cost_per_token: 2.5e-5,
    cache_read_input_token_cost: 5e-7,
    cache_creation_input_token_cost: 6.25e-6,
  },
  "github_copilot/claude-sonnet-5.5": {
    input_cost_per_token: 2e-6,
    output_cost_per_token: 1e-5,
    cache_read_input_token_cost: 1e-7,
    cache_creation_input_token_cost: 2.5e-6,
  },
  "github_copilot/claude-haiku-5.5": {
    input_cost_per_token: 1e-7,
    output_cost_per_token: 5e-7,
    cache_read_input_token_cost: 1e-8,
    cache_creation_input_token_cost: 1.25e-7,
    input_cost_per_token_above_100k_tokens: 5e-7,
    output_cost_per_token_above_100k_tokens: 2.5e-6,
    cache_read_input_token_cost_above_100k_tokens: 5e-8,
    cache_creation_input_token_cost_above_100k_tokens: 6.25e-7,
  },
  "github_copilot/mai-code-1.1-flash": {
    input_cost_per_token: 2e-7,
    output_cost_per_token: 1.2e-6,
    cache_read_input_token_cost: 2e-8,
  },
};

const litellm = Object.fromEntries(
  Object.entries(rates).map(([model, entry]) => [
    model,
    { litellm_provider: "github_copilot", ...entry },
  ]),
);

it.effect("agrees with LiteLLM's Copilot rates for every priced model in effect now", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped();

    const client = HttpClient.make((input) =>
      Effect.succeed(HttpClientResponse.fromWeb(input, Response.json(litellm))),
    );

    const book = yield* loadPrices(path.join(root, "prices.json"), false).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
    );

    const at = Date.parse("2026-10-24T00:00:00Z");

    // Card models LiteLLM has no Copilot rates for are not compared; every LiteLLM entry is.
    const models = new Set(
      copilotRates.entries.flatMap((entry) =>
        entry.free || !Object.hasOwn(litellm, `github_copilot/${entry.model}`) ? [] : [entry.model],
      ),
    );

    assert.strictEqual(models.size, Object.keys(litellm).length);

    for (const model of models) {
      const card = copilotPrice(copilotRates, model, at);
      const reference = book.prices[`github_copilot/${model}`];
      assert.isDefined(reference, model);
      // The fallback bills unreported cache writes as the card does.
      assert.strictEqual(card?.uncachedInput, reference?.uncachedInput ?? "input", model);

      const rates = (price: typeof card) =>
        [price, ...(price?.tiers ?? [])].map((tier) => [
          tier?.input,
          tier?.output,
          tier?.cacheRead,
          tier?.cacheWrite,
        ]);

      const expected = rates(reference).flat();

      for (const [index, value] of rates(card).flat().entries()) {
        const other = expected[index];

        if (value === null || value === undefined || other === null || other === undefined)
          assert.strictEqual(value, other, model);
        else assert.closeTo(value, other, 1e-9, model);
      }

      assert.deepStrictEqual(
        card?.tiers?.map((tier) => tier.above),
        reference?.tiers?.map((tier) => tier.above),
        model,
      );
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);
