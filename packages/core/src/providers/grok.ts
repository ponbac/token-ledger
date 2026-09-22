import { Option, Schema } from "effect";
import type { UsageRecord } from "../model.ts";
import { decodeJson, empty, malformed, skipped, type TranscriptParser } from "./shared.ts";

const Counts = Schema.Struct({
  inputTokens: Schema.Natural,
  outputTokens: Schema.Natural,
  cachedReadTokens: Schema.optionalKey(Schema.Natural),
  cacheCreationTokens: Schema.optionalKey(Schema.Natural),
});

const Turn = Schema.Struct({
  timestamp: Schema.optionalKey(Schema.Number),
  params: Schema.Struct({
    sessionId: Schema.optionalKey(Schema.String),
    _meta: Schema.optionalKey(Schema.Struct({ agentTimestampMs: Schema.Number })),
    update: Schema.Struct({
      sessionUpdate: Schema.Literal("turn_completed"),
      prompt_id: Schema.optionalKey(Schema.String),
      usage: Schema.Struct({
        ...Counts.fields,
        modelUsage: Schema.optionalKey(Schema.Record(Schema.String, Counts)),
      }),
    }),
  }),
});

/** Reads completed Grok turns; absent project metadata can be supplied by a source override. */
export function grokParser(file: string): TranscriptParser {
  return {
    parse(line, lineNumber) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const event = Option.getOrNull(Schema.decodeUnknownOption(Turn)(raw));

      if (event === null) return line.includes('"turn_completed"') ? skipped : empty;

      const ms =
        event.params._meta?.agentTimestampMs ??
        (event.timestamp === undefined
          ? NaN
          : event.timestamp > 1e12
            ? event.timestamp
            : event.timestamp * 1000);

      if (!Number.isFinite(ms) || !Number.isFinite(new Date(ms).getTime())) return skipped;
      const { usage, prompt_id: promptId } = event.params.update;
      const session = event.params.sessionId ?? file;
      const models = Object.entries(usage.modelUsage ?? {});
      const entries = models.length ? models : [["unknown", usage] as const];
      const records: UsageRecord[] = [];

      for (const [model, count] of entries) {
        const cacheRead = count.cachedReadTokens ?? 0;
        const cacheWrite = count.cacheCreationTokens ?? 0;

        if (cacheRead + cacheWrite > count.inputTokens) return skipped;
        records.push({
          provider: "grok",
          id: `${session}:${promptId ?? `${file}:${lineNumber}`}:${model}`,
          session,
          timestamp: ms,
          model,
          cwd: null,
          repository: null,
          tokens: {
            input: count.inputTokens - cacheRead - cacheWrite,
            cacheRead,
            cacheWrite,
            output: count.outputTokens,
          },
        });
      }

      return {
        ...empty,
        records,
        warnings: [
          "Grok project metadata is unavailable; configure a source project when needed.",
          ...(models.length
            ? []
            : [
                "Grok model breakdown is missing; these tokens remain unpriced unless an explicit rate is supplied.",
              ]),
        ],
      };
    },
  };
}
