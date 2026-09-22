import { Schema } from "effect";

/** Supported local history formats; editor telemetry is outside this contract. */
export const Provider = Schema.Literals(["codex", "claude", "grok", "copilot"]);

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

/** A directory to scan, or one JSONL file. A fixed project overrides inference. */
export const Source = Schema.Struct({
  provider: Provider,
  path: Schema.NonEmptyString,
  project: Schema.optionalKey(Schema.NonEmptyString),
});

/** A configured source, independent of the machine's conventional home paths. */
export interface Source extends Schema.Schema.Type<typeof Source> {}

/** Explicit project ownership; paths are directory prefixes, repositories are remote URLs. */
export const ProjectMapping = Schema.Struct({
  project: Schema.NonEmptyString,
  paths: Schema.Array(Schema.NonEmptyString),
  repositories: Schema.Array(Schema.NonEmptyString),
});

/** Maps multiple clones and repositories to one consulting project. */
export interface ProjectMapping extends Schema.Schema.Type<typeof ProjectMapping> {}

const Rate = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));

/** USD per million tokens; absent cache pricing stays unknown, never silently free. */
export const ModelPrice = Schema.Struct({
  input: Rate,
  output: Rate,
  cacheRead: Schema.NullOr(Rate),
  cacheWrite: Schema.NullOr(Rate),
});

/** One explicit API-equivalent rate, not a subscription or credit price. */
export interface ModelPrice extends Schema.Schema.Type<typeof ModelPrice> {}

/** Optional source overrides replace auto-discovery; project mappings and prices are additive. */
export const Configuration = Schema.Struct({
  sources: Schema.optionalKey(Schema.Array(Source)),
  projects: Schema.optionalKey(Schema.Array(ProjectMapping)),
  prices: Schema.optionalKey(Schema.Record(Schema.String, ModelPrice)),
});

/** The serialized configuration accepted by both CLI and future applications. */
export interface Configuration extends Schema.Schema.Type<typeof Configuration> {}

/** Pricing provenance travels with every report for reproducible interpretation. */
export const PriceBook = Schema.Struct({
  status: Schema.Literals(["fresh", "cached", "unavailable", "custom"]),
  fetchedAt: Schema.NullOr(Schema.String),
  source: Schema.String,
  prices: Schema.Record(Schema.String, ModelPrice),
});

/** A decoded rate snapshot. */
export interface PriceBook extends Schema.Schema.Type<typeof PriceBook> {}

/** One decoded observation; identifiers only, never prompts or responses. */
export interface UsageRecord {
  readonly provider: Provider;
  readonly id: string;
  readonly session: string;
  readonly timestamp: number;
  readonly model: string;
  readonly cwd: string | null;
  readonly repository: string | null;
  readonly tokens: Tokens;
}

/** UTC calendar day. Invalid dates such as February 30 are rejected. */
export const Day = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
  Schema.makeFilter((s) => {
    const date = new Date(`${s}T00:00:00Z`);

    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === s;
  }),
);

/** Inclusive UTC day window and all inputs to a report. Paths must be absolute. */
export const ReportRequest = Schema.Struct({
  since: Day,
  until: Day,
  sources: Schema.Array(Source),
  projects: Schema.Array(ProjectMapping),
  pricing: PriceBook,
}).check(Schema.makeFilter((request) => request.since <= request.until));

/** Public request shared by the CLI and later UI. */
export interface ReportRequest extends Schema.Schema.Type<typeof ReportRequest> {}

/** A bounded coverage summary per source, including skipped data. */
export const Coverage = Schema.Struct({
  provider: Provider,
  source: Schema.String,
  status: Schema.Literals(["ok", "missing", "partial", "failed"]),
  files: Schema.Natural,
  malformedLines: Schema.Natural,
  skippedRecords: Schema.Natural,
  duplicates: Schema.Natural,
  warnings: Schema.Array(Schema.String),
});

/** Completeness evidence, not a guarantee that the provider retained all history. */
export interface Coverage extends Schema.Schema.Type<typeof Coverage> {}

/** One project/day/provider/model aggregate. Null cost means some tokens could not be priced. */
export const ReportRow = Schema.Struct({
  project: Schema.String,
  day: Day,
  provider: Provider,
  model: Schema.String,
  pricePerMillion: Schema.NullOr(ModelPrice),
  tokens: Tokens,
  records: Schema.Natural,
  estimatedCostUsd: Schema.NullOr(Schema.Number),
  pricedCostUsd: Schema.Number,
  unpricedRecords: Schema.Natural,
});

/** Serializable aggregate usable by terminal and browser clients. */
export interface ReportRow extends Schema.Schema.Type<typeof ReportRow> {}

/** Versioned report; contains no raw transcript content. */
export const UsageReport = Schema.Struct({
  version: Schema.Literal(1),
  since: Day,
  until: Day,
  currency: Schema.Literal("USD"),
  costBasis: Schema.Literal("api-equivalent"),
  pricing: Schema.Struct({
    status: PriceBook.fields.status,
    fetchedAt: PriceBook.fields.fetchedAt,
    source: Schema.String,
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
