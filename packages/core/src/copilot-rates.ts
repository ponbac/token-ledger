import { Schema } from "effect";

import card from "./copilot-rates.json" with { type: "json" };
import { Day, type ModelPrice, PriceTier, Rates, UncachedInput } from "./model.ts";

/** A Copilot model ID, or a family of them when it ends in `-*`, such as `copilot-nes-*`. */
const CopilotModel = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9.-]*(-\*)?$/));

const entryFields = {
  model: CopilotModel,
  // The UTC day the rate took effect, as far as GitHub's documentation shows.
  effectiveFrom: Day,
  // Provisional until GitHub's bills or usage report have been matched against it.
  status: Schema.Literals(["confirmed", "provisional"]),
  source: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/)),
  note: Schema.optionalKey(Schema.NonEmptyString),
};

const PricedEntry = Schema.Struct({
  ...entryFields,
  free: Schema.optionalKey(Schema.Literal(false)),
  uncachedInput: UncachedInput,
  base: Rates,
  long: Schema.optionalKey(PriceTier),
}).check(
  Schema.makeFilter(
    (entry) =>
      entry.uncachedInput === "input" ||
      (entry.base.cacheWrite !== null &&
        (entry.long === undefined || entry.long.cacheWrite !== null)),
    { expected: "a cache-write rate in every tier that bills uncached input at it" },
  ),
);

const FreeEntry = Schema.Struct({ ...entryFields, free: Schema.Literal(true) });

/** One dated rate for a Copilot model: its base and long-context tiers, or free. */
export const CopilotRate = Schema.Union([FreeEntry, PricedEntry]);

/** A dated Copilot rate. */
export type CopilotRate = typeof CopilotRate.Type;

/**
 * GitHub Copilot's per-token AI credit rates, versioned by the day they were last checked.
 * Rates apply retroactively, so each is dated, and a model's earliest entry also prices usage
 * from before it.
 */
export const CopilotRateCard = Schema.Struct({
  version: Day,
  description: Schema.String,
  entries: Schema.Array(CopilotRate).check(Schema.isMinLength(1)),
}).check(
  Schema.makeFilter(
    (rates) =>
      new Set(rates.entries.map((entry) => `${entry.model} ${entry.effectiveFrom}`)).size ===
      rates.entries.length,
    { expected: "one entry per model and day" },
  ),
);

/** A decoded Copilot rate card. */
export interface CopilotRateCard extends Schema.Schema.Type<typeof CopilotRateCard> {}

/**
 * The checked-in rate card. Unknown keys are refused, so a misspelt field fails the test suite
 * rather than pricing silently without it.
 */
export const copilotRates: CopilotRateCard = Schema.decodeUnknownSync(CopilotRateCard, {
  onExcessProperty: "error",
})(card);

const free: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * Copilot's price for `model` on the UTC day of `timestamp`, or `undefined` when the card does
 * not list it. An exact model ID wins over a family; among a model's dated entries the latest
 * in effect wins, and the earliest prices days before any. Free models cost nothing.
 */
export function copilotPrice(
  rates: CopilotRateCard,
  model: string,
  timestamp: number,
): ModelPrice | undefined {
  const exact = rates.entries.filter((entry) => entry.model === model);

  const family = rates.entries
    .filter((entry) => entry.model.endsWith("-*") && model.startsWith(entry.model.slice(0, -1)))
    .toSorted((a, b) => b.model.length - a.model.length);

  const named =
    exact.length > 0 ? exact : family.filter((entry) => entry.model === family[0]?.model);

  const dated = named.toSorted((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const day = Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : null;

  const entry =
    dated.findLast((candidate) => day === null || candidate.effectiveFrom <= day) ?? dated[0];

  if (entry === undefined) return undefined;

  if (entry.free === true) return free;

  return {
    ...entry.base,
    tiers: entry.long === undefined ? [] : [entry.long],
    uncachedInput: entry.uncachedInput,
  };
}
