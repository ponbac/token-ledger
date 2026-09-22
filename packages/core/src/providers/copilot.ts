import { Option, Schema } from "effect";

import { decodeJson, empty, malformed, skipped, type TranscriptParser } from "./shared.ts";

const Attributes = Schema.Struct({
  "gen_ai.operation.name": Schema.String,
  "gen_ai.response.model": Schema.optionalKey(Schema.String),
  "gen_ai.request.model": Schema.optionalKey(Schema.String),
  "gen_ai.conversation.id": Schema.optionalKey(Schema.String),
  "gen_ai.usage.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.output_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_read.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_creation.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_read_input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_creation_input_tokens": Schema.optionalKey(Schema.Natural),
  "github.copilot.git.repository": Schema.optionalKey(Schema.String),
});

const Span = Schema.Struct({
  type: Schema.Literal("span"),
  traceId: Schema.NonEmptyString,
  spanId: Schema.NonEmptyString,
  endTime: Schema.Tuple([Schema.Natural, Schema.Natural]),
  attributes: Attributes,
});

/** Imports Copilot CLI's JSONL span export. Counts request spans, never parent totals or metrics. */
export function copilotParser(file: string): TranscriptParser {
  return {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const span = Option.getOrNull(Schema.decodeUnknownOption(Span)(raw));

      if (span === null) return line.includes('"span"') ? skipped : empty;
      const a = span.attributes;

      if (a["gen_ai.operation.name"] !== "chat") return empty;
      const input = a["gen_ai.usage.input_tokens"];
      const output = a["gen_ai.usage.output_tokens"];

      if (input === undefined || output === undefined) return skipped;

      const cacheRead =
        a["gen_ai.usage.cache_read.input_tokens"] ?? a["gen_ai.usage.cache_read_input_tokens"] ?? 0;

      const cacheWrite =
        a["gen_ai.usage.cache_creation.input_tokens"] ??
        a["gen_ai.usage.cache_creation_input_tokens"] ??
        0;

      if (cacheRead + cacheWrite > input) return skipped;
      const ms = span.endTime[0] * 1000 + Math.floor(span.endTime[1] / 1_000_000);

      if (!Number.isFinite(new Date(ms).getTime())) return skipped;

      return {
        ...empty,
        records: [
          {
            provider: "copilot",
            id: `${span.traceId}:${span.spanId}`,
            session: a["gen_ai.conversation.id"] ?? file,
            timestamp: ms,
            model: a["gen_ai.response.model"] ?? a["gen_ai.request.model"] ?? "unknown",
            cwd: null,
            repository: a["github.copilot.git.repository"] ?? null,
            tokens: { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite },
          },
        ],
        warnings: [
          "Copilot CLI coverage starts when file telemetry was enabled; only request spans are counted.",
        ],
      };
    },
  };
}
