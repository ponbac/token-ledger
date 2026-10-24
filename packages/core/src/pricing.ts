import { createHash } from "node:crypto";

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { type CopilotRateCard, copilotPrice, copilotRates } from "./copilot-rates.ts";
import {
  ModelPrice,
  PriceBook,
  type PriceTier,
  type PricingBasis,
  type Rates,
  type Tokens,
  type UsageRecord,
  addTokens,
  zeroTokens,
} from "./model.ts";

const ratesUrl =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const PerToken = Schema.optionalKey(Schema.Number);

/**
 * The LiteLLM fields Token Ledger reads, each by its exact name. Matching names by pattern would
 * misread compound keys: `cache_creation_input_token_cost_above_12hr_above_272k_tokens` is
 * OpenAI's twelve-hour cache write above 272K, not the 272K tier's write rate, and is not read,
 * because clients never report twelve-hour writes. `_above_1hr` is Anthropic's one-hour cache
 * write, not a context tier.
 */
const RawPrice = Schema.Struct({
  litellm_provider: Schema.optionalKey(Schema.String),
  input_cost_per_token: PerToken,
  output_cost_per_token: PerToken,
  cache_read_input_token_cost: PerToken,
  cache_creation_input_token_cost: PerToken,
  cache_creation_input_token_cost_above_1hr: PerToken,
  input_cost_per_token_above_100k_tokens: PerToken,
  output_cost_per_token_above_100k_tokens: PerToken,
  cache_read_input_token_cost_above_100k_tokens: PerToken,
  cache_creation_input_token_cost_above_100k_tokens: PerToken,
  cache_creation_input_token_cost_above_1hr_above_100k_tokens: PerToken,
  input_cost_per_token_above_128k_tokens: PerToken,
  output_cost_per_token_above_128k_tokens: PerToken,
  cache_read_input_token_cost_above_128k_tokens: PerToken,
  cache_creation_input_token_cost_above_128k_tokens: PerToken,
  cache_creation_input_token_cost_above_1hr_above_128k_tokens: PerToken,
  input_cost_per_token_above_200k_tokens: PerToken,
  output_cost_per_token_above_200k_tokens: PerToken,
  cache_read_input_token_cost_above_200k_tokens: PerToken,
  cache_creation_input_token_cost_above_200k_tokens: PerToken,
  cache_creation_input_token_cost_above_1hr_above_200k_tokens: PerToken,
  input_cost_per_token_above_272k_tokens: PerToken,
  output_cost_per_token_above_272k_tokens: PerToken,
  cache_read_input_token_cost_above_272k_tokens: PerToken,
  cache_creation_input_token_cost_above_272k_tokens: PerToken,
  cache_creation_input_token_cost_above_1hr_above_272k_tokens: PerToken,
  input_cost_per_token_above_512k_tokens: PerToken,
  output_cost_per_token_above_512k_tokens: PerToken,
  cache_read_input_token_cost_above_512k_tokens: PerToken,
  cache_creation_input_token_cost_above_512k_tokens: PerToken,
  cache_creation_input_token_cost_above_1hr_above_512k_tokens: PerToken,
});

type RawPrice = typeof RawPrice.Type;

/** Each long-context tier LiteLLM publishes, with the exact names of its rates. */
const tierFields = [
  {
    above: 100_000,
    input: "input_cost_per_token_above_100k_tokens",
    output: "output_cost_per_token_above_100k_tokens",
    cacheRead: "cache_read_input_token_cost_above_100k_tokens",
    cacheWrite: "cache_creation_input_token_cost_above_100k_tokens",
    cacheWrite1h: "cache_creation_input_token_cost_above_1hr_above_100k_tokens",
  },
  {
    above: 128_000,
    input: "input_cost_per_token_above_128k_tokens",
    output: "output_cost_per_token_above_128k_tokens",
    cacheRead: "cache_read_input_token_cost_above_128k_tokens",
    cacheWrite: "cache_creation_input_token_cost_above_128k_tokens",
    cacheWrite1h: "cache_creation_input_token_cost_above_1hr_above_128k_tokens",
  },
  {
    above: 200_000,
    input: "input_cost_per_token_above_200k_tokens",
    output: "output_cost_per_token_above_200k_tokens",
    cacheRead: "cache_read_input_token_cost_above_200k_tokens",
    cacheWrite: "cache_creation_input_token_cost_above_200k_tokens",
    cacheWrite1h: "cache_creation_input_token_cost_above_1hr_above_200k_tokens",
  },
  {
    above: 272_000,
    input: "input_cost_per_token_above_272k_tokens",
    output: "output_cost_per_token_above_272k_tokens",
    cacheRead: "cache_read_input_token_cost_above_272k_tokens",
    cacheWrite: "cache_creation_input_token_cost_above_272k_tokens",
    cacheWrite1h: "cache_creation_input_token_cost_above_1hr_above_272k_tokens",
  },
  {
    above: 512_000,
    input: "input_cost_per_token_above_512k_tokens",
    output: "output_cost_per_token_above_512k_tokens",
    cacheRead: "cache_read_input_token_cost_above_512k_tokens",
    cacheWrite: "cache_creation_input_token_cost_above_512k_tokens",
    cacheWrite1h: "cache_creation_input_token_cost_above_1hr_above_512k_tokens",
  },
] as const satisfies ReadonlyArray<{
  readonly above: number;
  readonly input: keyof RawPrice;
  readonly output: keyof RawPrice;
  readonly cacheRead: keyof RawPrice;
  readonly cacheWrite: keyof RawPrice;
  readonly cacheWrite1h: keyof RawPrice;
}>;

const decodeEntry = Schema.decodeUnknownOption(RawPrice);

const decodePrice = Schema.decodeUnknownOption(ModelPrice);

const decodeBook = Schema.decodeUnknownEffect(Schema.fromJsonString(PriceBook));

function perMillion(rate: number): number {
  return rate * 1_000_000;
}

/**
 * One LiteLLM entry as a price. A tier needs its input and output rates; a cache rate it lacks
 * is the base tier's, and a one-hour write rate it lacks is its own write rate. OpenAI's GPT-5.6
 * and later write uncached input to the cache implicitly, and their clients report no cache
 * writes, so OpenAI entries with a cache-write rate bill uncached input at it, whoever pays.
 * So do GitHub Copilot's entries with one, which are a fallback for models missing from its
 * card: GitHub bills Claude's unreported writes as cache writes too.
 */
function vendorPrice(raw: RawPrice): ModelPrice | null {
  if (raw.input_cost_per_token === undefined || raw.output_cost_per_token === undefined)
    return null;

  const cacheRead =
    raw.cache_read_input_token_cost === undefined
      ? null
      : perMillion(raw.cache_read_input_token_cost);

  const cacheWrite =
    raw.cache_creation_input_token_cost === undefined
      ? null
      : perMillion(raw.cache_creation_input_token_cost);

  const tiers = tierFields.flatMap((fields): PriceTier[] => {
    const input = raw[fields.input];
    const output = raw[fields.output];

    if (input === undefined || output === undefined) return [];
    const read = raw[fields.cacheRead];
    const write = raw[fields.cacheWrite];
    const oneHour = raw[fields.cacheWrite1h];

    const tier = {
      above: fields.above,
      input: perMillion(input),
      output: perMillion(output),
      cacheRead: read === undefined ? cacheRead : perMillion(read),
      cacheWrite: write === undefined ? cacheWrite : perMillion(write),
    };

    return [oneHour === undefined ? tier : { ...tier, cacheWrite1h: perMillion(oneHour) }];
  });

  const implicitWrites =
    cacheWrite !== null &&
    (raw.litellm_provider === "openai" || raw.litellm_provider === "github_copilot");

  const base = {
    input: perMillion(raw.input_cost_per_token),
    output: perMillion(raw.output_cost_per_token),
    cacheRead,
    cacheWrite,
    tiers,
  };

  const oneHour = raw.cache_creation_input_token_cost_above_1hr;
  const priced = oneHour === undefined ? base : { ...base, cacheWrite1h: perMillion(oneHour) };

  return Option.getOrNull(
    decodePrice(implicitWrites ? { ...priced, uncachedInput: "cacheWrite" } : priced),
  );
}

/** Running totals. Any unpriced record makes the estimate unknown, never zero; the priced subtotal remains. */
export interface UsageTotals {
  readonly tokens: Tokens;
  readonly records: number;
  readonly estimatedCostUsd: number | null;
  readonly pricedCostUsd: number;
  readonly unpricedRecords: number;
}

/** Adds one record's tokens and its cost, `null` when the record could not be priced. */
export function addUsage(
  previous: UsageTotals | undefined,
  tokens: Tokens,
  cost: number | null,
): UsageTotals {
  const pricedCostUsd = (previous?.pricedCostUsd ?? 0) + (cost ?? 0);
  const unpricedRecords = (previous?.unpricedRecords ?? 0) + (cost === null ? 1 : 0);

  return {
    tokens: addTokens(previous?.tokens ?? zeroTokens, tokens),
    records: (previous?.records ?? 0) + 1,
    estimatedCostUsd: unpricedRecords > 0 ? null : pricedCostUsd,
    pricedCostUsd,
    unpricedRecords,
  };
}

/**
 * Downloads only a public rate table, caching a decoded snapshot; sends nothing about local
 * usage. The snapshot carries long-context tiers, so callers keep it in a file that no earlier
 * version, whose snapshots lack them, has written.
 */
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

  // A snapshot never carries a basis; only configuredPricing establishes one.
  const reused =
    previous === null
      ? null
      : PriceBook.make({
          status: "cached",
          fetchedAt: previous.fetchedAt,
          source: previous.source,
          prices: previous.prices,
        });

  if (
    reused !== null &&
    (offline || (reused.fetchedAt !== null && now - Date.parse(reused.fetchedAt) < 86_400_000))
  ) {
    return reused;
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
      const price = decoded === null ? null : vendorPrice(decoded);

      if (price !== null) Object.defineProperty(prices, model, { value: price, enumerable: true });
    }

    return PriceBook.make({
      status: "fresh",
      source: ratesUrl,
      fetchedAt: new Date(now).toISOString(),
      prices,
    });
  }).pipe(Effect.timeout("15 seconds"), Effect.option);

  if (Option.isNone(fetched)) return reused ?? unavailable;
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

/**
 * Bumped whenever a request's price can change for the same history and rates: the arithmetic,
 * model resolution, or vendor rate decoding of `priceRecord`, or what adapters report for it,
 * such as payer routes, one-hour cache writes, and aggregated requests. A pricing basis names
 * the method that priced a run, so a bump marks earlier uploads for repricing.
 */
const pricingMethod = 1;

function canonicalRates(rates: Rates) {
  return [rates.input, rates.output, rates.cacheRead, rates.cacheWrite, rates.cacheWrite1h ?? null];
}

/**
 * The basis a run's prices rest on: this pricing method, the Copilot rate card's version, and
 * any configuration overrides. LiteLLM's fetch time and contents are not part of it. It is
 * `undefined` unless vendor rates were fetched or cached (`fresh` or `cached`), so a run that
 * priced without them never claims the basis a complete run does.
 */
export function pricingBasis(
  vendor: PriceBook["status"],
  overrides: Readonly<Record<string, ModelPrice>> | undefined,
  rates: CopilotRateCard,
): PricingBasis | undefined {
  if (vendor !== "fresh" && vendor !== "cached") return undefined;

  const configured = Object.entries(overrides ?? {})
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([model, price]) => [
      model,
      ...canonicalRates(price),
      price.uncachedInput ?? "input",
      (price.tiers ?? [])
        .toSorted((a, b) => a.above - b.above)
        .map((tier) => [tier.above, ...canonicalRates(tier)]),
    ]);

  const basis = `token-ledger-pricing@${pricingMethod};copilot-rates@${rates.version};litellm@tiers`;

  if (configured.length === 0) return basis;
  const digest = createHash("sha256").update(JSON.stringify(configured)).digest("hex");

  return `${basis};overrides@${digest.slice(0, 16)}`;
}

/**
 * The rates a run prices with: vendor rates, with configuration overrides of exact model IDs on
 * top, and the basis they establish. Copilot-paid requests use the checked-in Copilot card
 * before either, so overrides do not change them for the models it lists.
 */
export function configuredPricing(
  vendor: PriceBook,
  overrides: Readonly<Record<string, ModelPrice>> | undefined,
): PriceBook {
  const basis = pricingBasis(vendor.status, overrides, copilotRates);
  const source = `${vendor.source}; GitHub Copilot rates ${copilotRates.version}`;

  const book = {
    status: overrides === undefined ? vendor.status : "custom",
    fetchedAt: vendor.fetchedAt,
    source: overrides === undefined ? source : `${source}; configuration overrides`,
    prices: overrides === undefined ? vendor.prices : { ...vendor.prices, ...overrides },
  } satisfies PriceBook;

  return PriceBook.make(basis === undefined ? book : { ...book, basis });
}

/** Everything `priceRecord` reads: vendor rates and GitHub Copilot's rate card. */
export interface Pricer {
  readonly vendor: PriceBook;
  readonly copilot: CopilotRateCard;
}

/** Prices with `vendor` rates and the checked-in Copilot rate card. */
export function pricerFor(vendor: PriceBook): Pricer {
  return { vendor, copilot: copilotRates };
}

// Whether GitHub Copilot paid: Copilot's own requests unless routed elsewhere, and any routed to it.
function copilotPaid(record: Pick<UsageRecord, "provider" | "billingProvider">): boolean {
  return record.billingProvider === undefined
    ? record.provider === "copilot"
    : record.billingProvider === "copilot";
}

// A context-window variant, such as Claude Code's `claude-opus-4-6[1m]`, has the base model's rates.
function withoutVariant(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}

/**
 * Resolves a vendor rate by exact model ID, then without a context-window variant and with a
 * dotted Claude version hyphenated, as GitHub Copilot and OpenCode spell Anthropic's
 * `claude-sonnet-4-6`; each with known upstream provider prefixes. Private aliases are not
 * guessed: Codex's `codex-auto-review` and `gpt-5.3-codex-spark` have no published price and
 * stay unpriced unless configured.
 */
function vendorLookup(book: PriceBook, model: string): ModelPrice | undefined {
  const bare = withoutVariant(model);
  const hyphenated = bare.startsWith("claude-") ? bare.replace(/(\d)\.(?=\d)/g, "$1-") : bare;

  for (const name of new Set([model, bare, hyphenated])) {
    for (const key of [name, `openai/${name}`, `anthropic/${name}`, `xai/${name}`]) {
      if (Object.hasOwn(book.prices, key)) return book.prices[key];
    }
  }

  return undefined;
}

/**
 * Copilot-paid records take GitHub Copilot's card, then LiteLLM's `github_copilot/` rates for a
 * model the card lacks, then the vendor's. Everything else takes the vendor's.
 */
function resolve(record: UsageRecord, pricer: Pricer): ModelPrice | undefined {
  if (!copilotPaid(record)) return vendorLookup(pricer.vendor, record.model);
  const bare = withoutVariant(record.model);
  const fallback = `github_copilot/${bare}`;

  return (
    copilotPrice(pricer.copilot, bare, record.timestamp) ??
    (Object.hasOwn(pricer.vendor.prices, fallback) ? pricer.vendor.prices[fallback] : undefined) ??
    vendorLookup(pricer.vendor, record.model)
  );
}

/** The highest tier whose threshold is below `context`, or the base tier. */
function tierFor(price: ModelPrice, context: number): Rates {
  let rates: Rates = price;
  let above = 0;

  for (const tier of price.tiers ?? []) {
    if (tier.above < context && tier.above > above) {
      rates = tier;
      above = tier.above;
    }
  }

  return rates;
}

/** A price's base-tier rates. */
function baseRates(price: ModelPrice): Rates {
  const { input, output, cacheRead, cacheWrite } = price;

  return price.cacheWrite1h === undefined
    ? { input, output, cacheRead, cacheWrite }
    : { input, output, cacheRead, cacheWrite, cacheWrite1h: price.cacheWrite1h };
}

/** What one record cost, and the base tier of the price that set it. */
export interface RecordCost {
  /** API-equivalent USD, or `null` for an unknown model or an unknown rate the record needed. */
  readonly usd: number | null;
  /** The resolved price's base-tier rates; `null` when the model has none. */
  readonly base: Rates | null;
}

/**
 * Prices one request. Its context, `input + cacheRead + cacheWrite`, chooses the highest tier
 * whose threshold it exceeds (272,000 tokens stays below a 272K tier, 272,001 is above), and
 * that tier's rates apply to every token. A record summing several requests is priced at the
 * base tier. When a record reports no cache writes and its price bills uncached input at the
 * cache-write rate, three tokens are priced at the input rate and the rest of its uncached input
 * at the cache-write rate: GitHub's bills for GPT-6.1 Sol are exactly that, and the three
 * tokens are an inference from a constant 0.00015 credits per request. One-hour cache writes
 * take the one-hour rate where there is one. A cache read or write the price has no rate for
 * leaves the record unpriced, never free.
 */
export function priceRecord(record: UsageRecord, pricer: Pricer): RecordCost {
  const price = resolve(record, pricer);

  if (price === undefined) return { usd: null, base: null };
  const { input, cacheRead, cacheWrite, output } = record.tokens;
  const rates = tierFor(price, record.aggregate === true ? 0 : input + cacheRead + cacheWrite);
  const base = baseRates(price);

  if ((cacheRead > 0 && rates.cacheRead === null) || (cacheWrite > 0 && rates.cacheWrite === null))
    return { usd: null, base };

  const implicitWrite =
    cacheWrite === 0 && price.uncachedInput === "cacheWrite" ? rates.cacheWrite : null;

  const atInput = implicitWrite === null ? input : Math.min(input, 3);
  const writeRate = rates.cacheWrite ?? 0;
  const oneHour = Math.min(record.cacheWrite1h ?? 0, cacheWrite);

  const usd =
    (atInput * rates.input +
      (input - atInput) * (implicitWrite ?? 0) +
      cacheRead * (rates.cacheRead ?? 0) +
      (cacheWrite - oneHour) * writeRate +
      oneHour * (rates.cacheWrite1h ?? writeRate) +
      output * rates.output) /
    1_000_000;

  return { usd, base };
}
