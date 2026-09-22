import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { ModelPrice, PriceBook, type Tokens } from "./model.ts";

const ratesUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const RawPrice = Schema.Struct({
  input_cost_per_token: Schema.optionalKey(Schema.Number),
  output_cost_per_token: Schema.optionalKey(Schema.Number),
  cache_read_input_token_cost: Schema.optionalKey(Schema.Number),
  cache_creation_input_token_cost: Schema.optionalKey(Schema.Number),
});

const decodeEntry = Schema.decodeUnknownOption(RawPrice);

const decodePrice = Schema.decodeUnknownOption(ModelPrice);

const decodeBook = Schema.decodeUnknownEffect(Schema.fromJsonString(PriceBook));

/** Computes base-tier API-equivalent cost. Unknown required cache rates make the whole observation unpriced. */
export function priceTokens(tokens: Tokens, price: ModelPrice | undefined): number | null {
  if (
    price === undefined ||
    (tokens.cacheRead > 0 && price.cacheRead === null) ||
    (tokens.cacheWrite > 0 && price.cacheWrite === null)
  )
    return null;

  return (
    (tokens.input * price.input +
      tokens.output * price.output +
      tokens.cacheRead * (price.cacheRead ?? 0) +
      tokens.cacheWrite * (price.cacheWrite ?? 0)) /
    1_000_000
  );
}

/** Downloads only a public rate table, caching a decoded snapshot. Provider histories never leave the machine. */
export const loadPrices = Effect.fn("Pricing.load")(function* (
  cachePath: string,
  offline: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const now = yield* Clock.currentTimeMillis;

  const cached = yield* fs
    .readFileString(cachePath)
    .pipe(Effect.flatMap(decodeBook), Effect.option);

  const previous = Option.getOrNull(cached);

  if (
    previous !== null &&
    (offline || (previous.fetchedAt !== null && now - Date.parse(previous.fetchedAt) < 86_400_000))
  ) {
    return PriceBook.make({ ...previous, status: "cached" });
  }

  const unavailable = PriceBook.make({
    status: "unavailable",
    source: ratesUrl,
    fetchedAt: null,
    prices: {},
  });

  if (offline) return unavailable;

  const fetched = yield* Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
    const response = yield* client.get(ratesUrl);

    const entries = yield* HttpClientResponse.schemaBodyJson(
      Schema.Record(Schema.String, Schema.Unknown),
    )(response);

    const prices: Record<string, ModelPrice> = {};

    for (const [model, entry] of Object.entries(entries)) {
      const decoded = Option.getOrNull(decodeEntry(entry));

      if (
        decoded?.input_cost_per_token === undefined ||
        decoded.output_cost_per_token === undefined
      )
        continue;

      const price = Option.getOrNull(
        decodePrice({
          input: decoded.input_cost_per_token * 1_000_000,
          output: decoded.output_cost_per_token * 1_000_000,
          cacheRead:
            decoded.cache_read_input_token_cost === undefined
              ? null
              : decoded.cache_read_input_token_cost * 1_000_000,
          cacheWrite:
            decoded.cache_creation_input_token_cost === undefined
              ? null
              : decoded.cache_creation_input_token_cost * 1_000_000,
        }),
      );

      if (price !== null) Object.defineProperty(prices, model, { value: price, enumerable: true });
    }

    return PriceBook.make({
      status: "fresh",
      source: ratesUrl,
      fetchedAt: new Date(now).toISOString(),
      prices,
    });
  }).pipe(Effect.timeout("15 seconds"), Effect.option);

  if (Option.isNone(fetched))
    return previous === null ? unavailable : PriceBook.make({ ...previous, status: "cached" });
  const book = fetched.value;
  // A read-only or unavailable cache must not discard successfully fetched rates.
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(path.dirname(cachePath), { recursive: true });

    const temporary = yield* fs.makeTempFileScoped({
      directory: path.dirname(cachePath),
      prefix: "prices-",
    });

    yield* fs.writeFileString(temporary, JSON.stringify(book));
    yield* fs.rename(temporary, cachePath);
  }).pipe(Effect.scoped, Effect.option);

  return book;
});

/** Resolves exact model IDs, then known upstream provider prefixes; avoids guessing private model aliases. */
export function lookupPrice(book: PriceBook, model: string): ModelPrice | undefined {
  for (const key of [model, `openai/${model}`, `anthropic/${model}`, `xai/${model}`]) {
    if (Object.hasOwn(book.prices, key)) return book.prices[key];
  }

  return undefined;
}
