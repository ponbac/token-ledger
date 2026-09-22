// Fork-copy handling is adapted from T3 Code (MIT); see THIRD_PARTY_NOTICES.md.
import { Option, Schema } from "effect";
import type { Tokens } from "../model.ts";
import {
  decodeJson,
  empty,
  malformed,
  skipped,
  timestamp,
  type TranscriptParser,
} from "./shared.ts";

const Envelope = Schema.Struct({
  type: Schema.String,
  timestamp: Schema.optionalKey(Schema.String),
  payload: Schema.Unknown,
});

const Meta = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  session_id: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
  forked_from_id: Schema.optionalKey(Schema.String),
  git: Schema.optionalKey(Schema.Struct({ repository_url: Schema.optionalKey(Schema.String) })),
  source: Schema.optionalKey(Schema.Unknown),
});

const Spawn = Schema.Struct({
  subagent: Schema.Struct({ thread_spawn: Schema.Struct({ parent_thread_id: Schema.String }) }),
});

const Context = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  cwd: Schema.optionalKey(Schema.String),
});

const Counts = Schema.Struct({
  input_tokens: Schema.Natural,
  output_tokens: Schema.Natural,
  cached_input_tokens: Schema.optionalKey(Schema.Natural),
  cache_write_input_tokens: Schema.optionalKey(Schema.Natural),
});

const Usage = Schema.Struct({
  type: Schema.Literal("token_count"),
  info: Schema.Struct({
    last_token_usage: Counts,
    total_token_usage: Schema.optionalKey(Counts),
  }),
});

/** Reads Codex rollout metadata and token events, preserving per-turn working directories. */
export function codexParser(file: string): TranscriptParser {
  let session = file;
  let model = "unknown";
  let cwd: string | null = null;
  let repository: string | null = null;
  let sawMeta = false;
  let copyAnchor: number | null = null;
  let lastSignature: string | null = null;

  return {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const event = Option.getOrNull(Schema.decodeUnknownOption(Envelope)(raw));

      if (event === null) return empty;

      if (event.type === "session_meta") {
        if (sawMeta) return empty;
        const meta = Option.getOrNull(Schema.decodeUnknownOption(Meta)(event.payload));

        if (meta === null) return malformed;
        sawMeta = true;
        session = meta.id ?? meta.session_id ?? file;
        cwd = meta.cwd ?? null;
        repository = meta.git?.repository_url ?? null;

        if (
          meta.forked_from_id !== undefined ||
          Option.getOrNull(Schema.decodeUnknownOption(Spawn)(meta.source)) !== null
        ) {
          copyAnchor = timestamp(event.timestamp);
        }

        return empty;
      }

      if (event.type === "turn_context") {
        const context = Option.getOrNull(Schema.decodeUnknownOption(Context)(event.payload));

        if (context === null) return malformed;
        model = context.model ?? model;

        if (context.cwd !== undefined && cwd !== context.cwd) {
          cwd = context.cwd;
          repository = null;
        }

        return empty;
      }

      const usage = Option.getOrNull(Schema.decodeUnknownOption(Usage)(event.payload));

      if (usage === null) return line.includes('"token_count"') ? skipped : empty;
      const ms = timestamp(event.timestamp);

      if (ms === null) return skipped;
      const count = usage.info.last_token_usage;
      const signature = JSON.stringify([count, usage.info.total_token_usage ?? null]);

      if (signature === lastSignature) return empty;
      lastSignature = signature;

      // Forks contain a leading re-stamped burst of their parent's history.
      // This is a heuristic, so expose its use rather than claiming exact coverage.
      if (copyAnchor !== null) {
        if (ms - copyAnchor < 1000) {
          copyAnchor = ms;

          return {
            ...empty,
            skipped: 1,
            warnings: ["Codex fork-history copies were excluded using T3's timing heuristic."],
          };
        }

        copyAnchor = null;
      }

      const cacheRead = count.cached_input_tokens ?? 0;
      const cacheWrite = count.cache_write_input_tokens ?? 0;

      if (cacheRead + cacheWrite > count.input_tokens) return skipped;

      const tokens: Tokens = {
        input: count.input_tokens - cacheRead - cacheWrite,
        cacheRead,
        cacheWrite,
        output: count.output_tokens,
      };

      return {
        ...empty,
        records: [
          {
            provider: "codex",
            id: `${session}:${ms}:${signature}`,
            session,
            model,
            cwd,
            repository,
            timestamp: ms,
            tokens,
          },
        ],
        warnings: sawMeta ? [] : ["Codex metadata is missing; attribution uses the file identity."],
      };
    },
  };
}
