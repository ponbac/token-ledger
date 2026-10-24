import { Data, Schema } from "effect";

/** Supported local histories and Copilot CLI / VS Code Chat telemetry exports. */
export const Provider = Schema.Literals(["codex", "claude", "grok", "copilot", "pi", "opencode"]);

/** Providers for which a user can declare a subscription. */
export const BillingProvider = Schema.Literals(["codex", "claude", "grok", "copilot"]);

/** A provider's local history format. */
export type Provider = typeof Provider.Type;

/** Disjoint token categories. Reasoning, when reported, is already inside output. */
export const Tokens = Schema.Struct({
  input: Schema.Natural,
  cacheRead: Schema.Natural,
  cacheWrite: Schema.Natural,
  output: Schema.Natural,
});

/** Normalized token counts, with cached tokens excluded from ordinary input. */
export interface Tokens extends Schema.Schema.Type<typeof Tokens> {}

/** A configured project name, trimmed: it becomes a shared key when usage is synced. */
export const ProjectName = Schema.Trim.check(Schema.isMinLength(1));

/** A directory to scan, or one JSONL file. A fixed project overrides inference. */
export const Source = Schema.Struct({
  provider: Provider,
  path: Schema.NonEmptyString,
  project: Schema.optionalKey(ProjectName),
});

/** A configured source, independent of the machine's conventional home paths. */
export interface Source extends Schema.Schema.Type<typeof Source> {}

/** Explicit project ownership; paths are directory prefixes, repositories are remote URLs. */
export const ProjectMapping = Schema.Struct({
  project: ProjectName,
  paths: Schema.Array(Schema.NonEmptyString),
  repositories: Schema.Array(Schema.NonEmptyString),
});

/** Maps multiple clones and repositories to one consulting project. */
export interface ProjectMapping extends Schema.Schema.Type<typeof ProjectMapping> {}

const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

const rateFields = {
  input: Rate,
  output: Rate,
  cacheRead: Schema.NullOr(Rate),
  cacheWrite: Schema.NullOr(Rate),
  // Claude's one-hour cache writes; without it they cost what other cache writes do.
  cacheWrite1h: Schema.optionalKey(Rate),
};

/** USD per million tokens of each kind; absent cache pricing stays unknown, never silently free. */
export const Rates = Schema.Struct(rateFields);

/** One tier's rates, such as a price's base tier. */
export interface Rates extends Schema.Schema.Type<typeof Rates> {}

/**
 * Rates for a request whose context, `input + cacheRead + cacheWrite`, exceeds `above` tokens.
 * They apply to the whole request, as OpenAI, Anthropic, and GitHub Copilot bill long context.
 */
export const PriceTier = Schema.Struct({
  above: Schema.Int.check(Schema.isGreaterThan(0)),
  ...rateFields,
});

/** A long-context tier. */
export interface PriceTier extends Schema.Schema.Type<typeof PriceTier> {}

/**
 * How uncached input is billed when a record reports no cache writes. `cacheWrite`: the
 * provider wrote it to the cache implicitly, as OpenAI's GPT-5.6 and later do and GitHub
 * Copilot bills, so all but three tokens are priced at the cache-write rate. `input`: at the
 * input rate, for providers whose clients report their cache writes.
 */
export const UncachedInput = Schema.Literals(["cacheWrite", "input"]);

/** The billing rule for uncached input. */
export type UncachedInput = typeof UncachedInput.Type;

/**
 * USD per million tokens at the base tier, with optional long-context tiers. The tier is chosen
 * per request: the highest whose `above` is below its context. `uncachedInput` defaults to
 * `input`. Absent cache pricing stays unknown, never silently free.
 */
export const ModelPrice = Schema.Struct({
  ...rateFields,
  tiers: Schema.optionalKey(Schema.Array(PriceTier)),
  uncachedInput: Schema.optionalKey(UncachedInput),
}).check(
  Schema.makeFilter(
    (price) =>
      new Set((price.tiers ?? []).map((tier) => tier.above)).size === (price.tiers ?? []).length,
    { expected: "long-context tiers with distinct thresholds" },
  ),
);

/** One explicit API-equivalent rate, not a subscription or credit price. */
export interface ModelPrice extends Schema.Schema.Type<typeof ModelPrice> {}

/**
 * Which pricing method, Copilot rate card, and configuration overrides priced a run, opaque to
 * the server and compared for equality. Absent when the run used no vendor rates, so such a run
 * never claims the current basis.
 */
export const PricingBasis = Schema.String.check(Schema.isPattern(/^[\x21-\x7e]{1,128}$/));

/** A pricing basis: printable ASCII, 1 to 128 characters. */
export type PricingBasis = typeof PricingBasis.Type;

/** Optional source overrides replace auto-discovery; project mappings and prices are additive. */
export const Configuration = Schema.Struct({
  billingHintsDirectory: Schema.optionalKey(Schema.NonEmptyString),
  sources: Schema.optionalKey(Schema.Array(Source)),
  projects: Schema.optionalKey(Schema.Array(ProjectMapping)),
  prices: Schema.optionalKey(Schema.Record(Schema.String, ModelPrice)),
});

/** The serialized configuration accepted by both CLI and future applications. */
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

/**
 * Pricing provenance travels with every report for reproducible interpretation. `basis` is set
 * only on a book whose vendor rates were fetched or cached, never on a downloaded snapshot.
 */
export const PriceBook = Schema.Struct({
  status: Schema.Literals(["fresh", "cached", "unavailable", "custom"]),
  fetchedAt: Schema.NullOr(Schema.String),
  source: Schema.String,
  prices: Schema.Record(Schema.String, ModelPrice),
  basis: Schema.optionalKey(PricingBasis),
});

/** A decoded rate snapshot. */
export interface PriceBook extends Schema.Schema.Type<typeof PriceBook> {}

/** Repository metadata distinguishes Git transports from provider-reported repository names. */
export type RepositoryReference = Data.TaggedEnum<{
  Remote: { readonly value: string };
  Identity: { readonly value: string };
}>;

/** Preserves adapter knowledge of whether repository metadata is a Git transport or a name. */
export const RepositoryReference = Data.taggedEnum<RepositoryReference>();

/** One decoded observation; identifiers only, never prompts or responses. */
export interface UsageRecord {
  readonly provider: Provider;
  readonly billingProvider?: typeof BillingProvider.Type;
  readonly id: string;
  readonly session: string;
  readonly timestamp: number;
  readonly model: string;
  readonly cwd: string | null;
  readonly repository: RepositoryReference | null;
  readonly tokens: Tokens;
  /** How many of `tokens.cacheWrite` were one-hour cache writes; at most that many. Claude only. */
  readonly cacheWrite1h?: number;
  /**
   * The record sums several requests, as a Grok turn or Pi's tool usage can, so its context
   * says nothing about any one request's: it is priced at the base tier.
   */
  readonly aggregate?: boolean;
}

/** Zone-free `YYYY-MM-DD` calendar day. Invalid dates such as February 30 are rejected. */
export const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((s) => {
    const date = new Date(`${s}T00:00:00Z`);

    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
  }),
);

/** A calendar day; a time zone gives it instants. */
export type Day = typeof Day.Type;

/** Inclusive local calendar days in a named time zone and all inputs to a report. Paths must be absolute. */
export const ReportRequest = Schema.Struct({
  billingHints: Schema.optionalKey(
    Schema.Struct({ directory: Schema.NonEmptyString, required: Schema.Boolean }),
  ),
  since: Day,
  until: Day,
  timeZone: Schema.TimeZoneNamed,
  sources: Schema.Array(Source),
  projects: Schema.Array(ProjectMapping),
  pricing: PriceBook,
}).check(Schema.makeFilter((request) => request.since <= request.until));

/** Public request shared by the CLI and later UI. */
export interface ReportRequest extends Schema.Schema.Type<typeof ReportRequest> {}

/**
 * A bounded coverage summary per source, including skipped data. `files` and the diagnostic
 * counts describe the files opened; `filesBeforeWindow` counts those left unopened because they
 * were last modified too long before the window to hold usage in it.
 */
export const Coverage = Schema.Struct({
  provider: Provider,
  source: Schema.String,
  status: Schema.Literals(["ok", "missing", "partial", "failed"]),
  files: Schema.Natural,
  filesBeforeWindow: Schema.Natural,
  unreadable: Schema.Natural,
  malformedLines: Schema.Natural,
  skippedRecords: Schema.Natural,
  duplicates: Schema.Natural,
  warnings: Schema.Array(Schema.String),
});

/** Completeness evidence, not a guarantee that the provider retained all history. `unreadable` counts existing paths that could not be read. */
export interface Coverage extends Schema.Schema.Type<typeof Coverage> {}

/** One project/day/provider/model aggregate, by local day. Null cost means some tokens could not be priced. */
export const ReportRow = Schema.Struct({
  project: Schema.String,
  day: Day,
  provider: Provider,
  model: Schema.String,
  // The base tier; a request with a longer context may have been priced at a higher one.
  pricePerMillion: Schema.NullOr(Rates),
  tokens: Tokens,
  records: Schema.Natural,
  estimatedCostUsd: Schema.NullOr(Schema.Number),
  pricedCostUsd: Schema.Number,
  unpricedRecords: Schema.Natural,
});

/** Serializable aggregate usable by terminal and browser clients. */
export interface ReportRow extends Schema.Schema.Type<typeof ReportRow> {}

/** Versioned report; contains no raw transcript content. Version 2 days are local to `timeZone`, an IANA name; version 1 used UTC days. */
export const UsageReport = Schema.Struct({
  version: Schema.Literal(2),
  since: Day,
  until: Day,
  timeZone: Schema.NonEmptyString,
  currency: Schema.Literal("USD"),
  costBasis: Schema.Literal("api-equivalent"),
  pricing: Schema.Struct({
    status: PriceBook.fields.status,
    fetchedAt: PriceBook.fields.fetchedAt,
    source: Schema.String,
    basis: PriceBook.fields.basis,
  }),
  rows: Schema.Array(ReportRow),
  coverage: Schema.Array(Coverage),
});

/** Public report data, ready to encode as JSON or serve through a local backend. */
export interface UsageReport extends Schema.Schema.Type<typeof UsageReport> {}

/** No observed tokens. */
export const zeroTokens: Tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };

/** Adds disjoint token categories without counting reasoning twice. */
export function addTokens(a: Tokens, b: Tokens): Tokens {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/** Total processed tokens, including cache reads and writes exactly once. */
export function totalTokens(tokens: Tokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;
}
