import { Schema } from "effect";
import type { UsageRecord } from "../model.ts";

/** A billing plan the provider reported at an instant; never tied to a session. */
export interface PlanHint {
  readonly timestamp: number;
  readonly plan: string;
}

/** Internal parser output distinguishes unrelated lines from lost usage. */
export interface ParseResult {
  readonly records: readonly UsageRecord[];
  readonly hints: readonly PlanHint[];
  readonly malformed: number;
  readonly skipped: number;
  readonly warnings: readonly string[];
}

/** Mutable state belongs to one transcript or provider source, never shared across reports. */
export interface TranscriptParser {
  readonly parse: (line: string, lineNumber: number) => ParseResult;
  readonly finish?: () => ParseResult;
}

/** An unrelated or already-counted provider event. */
export const empty: ParseResult = {
  records: [],
  hints: [],
  malformed: 0,
  skipped: 0,
  warnings: [],
};

/** A recognized usage event that could not be normalized. */
export const skipped: ParseResult = { ...empty, skipped: 1 };

/** Invalid JSON or invalid usage structure, with no raw data in diagnostics. */
export const malformed: ParseResult = { ...empty, malformed: 1 };

/** Decode a JSONL line without retaining arbitrary provider data. */
export const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** Parse an ISO timestamp; invalid values remain explicitly absent. */
export function timestamp(value: string | undefined): number | null {
  if (value === undefined) return null;
  const ms = Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}
