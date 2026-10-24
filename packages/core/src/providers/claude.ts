import { Option, Schema } from "effect";
import type { UsageRecord } from "../model.ts";
import {
  decodeJson,
  empty,
  malformed,
  skipped,
  timestamp,
  type TranscriptParser,
} from "./shared.ts";

const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  timestamp: Schema.String,
  sessionId: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  requestId: Schema.optionalKey(Schema.String),
  message: Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    model: Schema.NonEmptyString,
    usage: Schema.Struct({
      input_tokens: Schema.Natural,
      output_tokens: Schema.Natural,
      cache_read_input_tokens: Schema.optionalKey(Schema.Natural),
      cache_creation_input_tokens: Schema.optionalKey(Schema.Natural),
      // Decoded apart, so that a change in this breakdown can never lose token counts.
      cache_creation: Schema.optionalKey(Schema.Unknown),
    }),
  }),
});

// How cache writes split by lifetime. Claude Code writes one-hour caches, which cost more.
const decodeCacheCreation = Schema.decodeUnknownOption(
  Schema.Struct({ ephemeral_1h_input_tokens: Schema.optionalKey(Schema.Natural) }),
);

/** Claude usage repeats per content block; stable message/request IDs prevent double counting. */
export function claudeParser(file: string): TranscriptParser {
  return {
    parse(line, lineNumber) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const event = Option.getOrNull(Schema.decodeUnknownOption(Assistant)(raw));

      if (event === null) return line.includes('"usage"') ? skipped : empty;
      const ms = timestamp(event.timestamp);

      if (ms === null) return skipped;
      const usage = event.message.usage;
      const session = event.sessionId ?? file;

      const id =
        event.message.id === undefined && event.requestId === undefined
          ? `${file}:${lineNumber}`
          : `${event.message.id ?? ""}:${event.requestId ?? ""}`;

      const cacheWrite = usage.cache_creation_input_tokens ?? 0;

      const oneHour = Math.min(
        Option.getOrNull(decodeCacheCreation(usage.cache_creation))?.ephemeral_1h_input_tokens ?? 0,
        cacheWrite,
      );

      const record: UsageRecord = {
        provider: "claude",
        id,
        session,
        timestamp: ms,
        model: event.message.model,
        cwd: event.cwd ?? null,
        repository: null,
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite,
        },
      };

      return {
        ...empty,
        records: [oneHour > 0 ? { ...record, cacheWrite1h: oneHour } : record],
        warnings:
          event.message.id === undefined && event.requestId === undefined
            ? ["Some Claude records lack stable IDs; copied histories may overlap."]
            : [],
      };
    },
  };
}
