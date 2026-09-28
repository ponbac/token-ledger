import { Option, Schema } from "effect";

import type { UsageRecord } from "../model.ts";
import { decodeJson, empty, malformed, skipped, type TranscriptParser } from "./shared.ts";

const Attributes = Schema.Struct({
  "gen_ai.operation.name": Schema.String,
  "gen_ai.response.model": Schema.optionalKey(Schema.String),
  "gen_ai.response.id": Schema.optionalKey(Schema.NonEmptyString),
  "gen_ai.request.model": Schema.optionalKey(Schema.String),
  "gen_ai.conversation.id": Schema.optionalKey(Schema.String),
  "gen_ai.usage.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.output_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_read.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_creation.input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_read_input_tokens": Schema.optionalKey(Schema.Natural),
  "gen_ai.usage.cache_creation_input_tokens": Schema.optionalKey(Schema.Natural),
  "github.copilot.git.repository": Schema.optionalKey(Schema.String),
  "copilot_chat.repo.remote_url": Schema.optionalKey(Schema.String),
  "session.id": Schema.optionalKey(Schema.String),
});

const Span = Schema.Struct({
  type: Schema.Literal("span"),
  traceId: Schema.NonEmptyString,
  spanId: Schema.NonEmptyString,
  parentSpanId: Schema.optionalKey(Schema.NonEmptyString),
  endTime: Schema.Tuple([Schema.Natural, Schema.Natural]),
  attributes: Attributes,
});

const InferenceEvent = Schema.Struct({
  hrTime: Schema.Tuple([Schema.Natural, Schema.Natural]),
  attributes: Schema.Struct({
    ...Attributes.fields,
    "event.name": Schema.Literal("gen_ai.client.inference.operation.details"),
    "gen_ai.response.id": Schema.NonEmptyString,
  }),
});

const Header = Schema.Struct({
  type: Schema.optionalKey(Schema.String),
  attributes: Schema.Struct({
    "event.name": Schema.optionalKey(Schema.String),
    "gen_ai.operation.name": Schema.optionalKey(Schema.String),
  }),
});

/** Imports Copilot CLI spans and VS Code inference events, excluding summaries and metrics. */
export function copilotParser(file: string): TranscriptParser {
  const repositories = new Map<string, string>();
  const pending = new Map<string, UsageRecord[]>();

  const warning =
    "Copilot coverage starts when file telemetry was enabled; only inference requests are counted.";

  return {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const header = Option.getOrNull(Schema.decodeUnknownOption(Header)(raw));

      if (header === null) return empty;
      const operation = header.attributes["gen_ai.operation.name"];

      if (
        header.attributes["event.name"] !== "gen_ai.client.inference.operation.details" &&
        !(header.type === "span" && (operation === "chat" || operation === "invoke_agent"))
      )
        return empty;

      let span = Option.getOrNull(Schema.decodeUnknownOption(Span)(raw));

      if (span === null) {
        const event = Option.getOrNull(Schema.decodeUnknownOption(InferenceEvent)(raw));

        if (event === null) return skipped;
        span = {
          type: "span",
          traceId: "response",
          spanId: event.attributes["gen_ai.response.id"],
          endTime: event.hrTime,
          attributes: event.attributes,
        };
      }

      const a = span.attributes;

      if (a["gen_ai.operation.name"] === "invoke_agent") {
        const key = `${span.traceId}:${span.spanId}`;
        const repository = a["github.copilot.git.repository"] ?? a["copilot_chat.repo.remote_url"];

        if (repository !== undefined) repositories.set(key, repository);
        const children = pending.get(key) ?? [];
        pending.delete(key);

        return {
          ...empty,
          records: children.map((record) => ({ ...record, repository: repository ?? null })),
          warnings: children.length > 0 ? [warning] : [],
        };
      }

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

      let record: UsageRecord = {
        provider: "copilot",
        id:
          a["gen_ai.response.id"] === undefined
            ? `${span.traceId}:${span.spanId}`
            : `response:${a["gen_ai.response.id"]}`,
        session: a["gen_ai.conversation.id"] ?? a["session.id"] ?? file,
        timestamp: ms,
        model: a["gen_ai.response.model"] ?? a["gen_ai.request.model"] ?? "unknown",
        cwd: null,
        repository: a["github.copilot.git.repository"] ?? a["copilot_chat.repo.remote_url"] ?? null,
        tokens: { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite },
      };

      if (record.repository === null && span.parentSpanId !== undefined) {
        const key = `${span.traceId}:${span.parentSpanId}`;
        const repository = repositories.get(key);

        if (repository !== undefined) record = { ...record, repository };
        else {
          const children = pending.get(key);

          if (children === undefined) pending.set(key, [record]);
          else children.push(record);

          return empty;
        }
      }

      return { ...empty, records: [record], warnings: [warning] };
    },
    finish() {
      const records = [...pending.values()].flat();
      pending.clear();

      return { ...empty, records, warnings: records.length > 0 ? [warning] : [] };
    },
  };
}
