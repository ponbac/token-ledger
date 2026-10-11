import { Option, Schema } from "effect";
import { totalTokens, type UsageRecord } from "../model.ts";
import {
  decodeJson,
  empty,
  malformed,
  skipped,
  timestamp,
  type TranscriptParser,
} from "./shared.ts";

const decodeKind = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

const decodeHeader = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.optionalKey(Schema.String),
    timestamp: Schema.optionalKey(Schema.String),
    cwd: Schema.optionalKey(Schema.String),
    parentSession: Schema.optionalKey(Schema.String),
  }),
);

// Usage, route, and model sit on the entry itself or on the message it wraps. Usage is located
// before anything else is decoded, so an entry known to carry it is never dropped as unrelated.
const decodeWrapper = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.Unknown }));

const decodeCarrier = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Schema.Unknown),
  }),
);

const decodeStamp = Schema.decodeUnknownOption(
  Schema.Struct({ id: Schema.optionalKey(Schema.String), timestamp: Schema.String }),
);

const decodeNames = Schema.decodeUnknownOption(
  Schema.Struct({
    provider: Schema.optionalKey(Schema.String),
    model: Schema.optionalKey(Schema.String),
    responseModel: Schema.optionalKey(Schema.String),
  }),
);

// Pi reports cached tokens apart from `input`, and reasoning inside `output`.
const decodeCounts = Schema.decodeUnknownOption(
  Schema.Struct({
    input: Schema.Natural,
    output: Schema.Natural,
    cacheRead: Schema.Natural,
    cacheWrite: Schema.Natural,
  }),
);

const unattributedModel = "unknown";

// Pi's "OpenAI (ChatGPT Plus/Pro)" route: OAuth only, so its usage ran on a ChatGPT plan. Pi does
// not record which plan. Other routes prove nothing: `anthropic`, for one, also takes API keys.
const chatGptSignIn = "openai-codex";

/**
 * Reads Pi session trees: assistant messages and `usage` entries name their model, while nested
 * tool work and compaction or branch summaries do not, as in Pi's own totals. Every branch of a
 * tree was paid for, so all are counted. `/fork` and `/clone` copy entries into a new session
 * with their IDs and timestamps intact, so the two together identify a request across files, and
 * an entry older than its forked session is a copy that the parent's file should account for.
 */
export function piParser(file: string): TranscriptParser {
  let session = file;
  let cwd: string | null = null;
  let sawHeader = false;
  // When this session was forked from another; null for a session that was not.
  let forked: number | null = null;

  return {
    parse(line, lineNumber) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      // Undefined when the entry names no kind.
      const type = Option.getOrNull(decodeKind(raw))?.type;

      if (type === "session") {
        if (sawHeader) return empty;
        const header = Option.getOrNull(decodeHeader(raw));

        if (header === null) return malformed;
        sawHeader = true;
        session = header.id ?? file;
        cwd = header.cwd ?? null;
        forked = header.parentSession === undefined ? null : timestamp(header.timestamp);

        return empty;
      }

      const wrapper = type === "message" ? Option.getOrNull(decodeWrapper(raw)) : { message: raw };
      const carrier = wrapper === null ? null : Option.getOrNull(decodeCarrier(wrapper.message));

      if (wrapper === null || carrier === null) return type === "message" ? malformed : empty;
      const assistant = type === "message" && carrier.role === "assistant";

      if (type === "message" && !assistant && carrier.role !== "toolResult") return empty;
      // Only assistant messages and `usage` entries name a model, and they always carry usage.
      const attributed = assistant || type === "usage";
      const usage = carrier.usage;

      if (usage === undefined || usage === null) return attributed ? skipped : empty;

      // Usage on a kind of entry this adapter does not know cannot be read as none.
      if (
        type !== "message" &&
        type !== "usage" &&
        type !== "compaction" &&
        type !== "branch_summary"
      ) {
        return skipped;
      }

      const stamp = Option.getOrNull(decodeStamp(raw));
      const names = Option.getOrNull(decodeNames(wrapper.message));
      const count = Option.getOrNull(decodeCounts(usage));
      const ms = timestamp(stamp?.timestamp);

      if (stamp === null || names === null || count === null || ms === null) return skipped;
      const model = attributed ? (names.responseModel ?? names.model) : undefined;

      const record: UsageRecord = {
        provider: "pi",
        id: stamp.id === undefined ? `${file}:${lineNumber}` : `${stamp.id}:${stamp.timestamp}`,
        session,
        timestamp: ms,
        model: model ?? unattributedModel,
        cwd,
        repository: null,
        tokens: count,
      };

      const copied = forked !== null && ms < forked;

      return {
        ...empty,
        records: copied ? [] : [record],
        inherited: copied ? [record] : [],
        // A failed or aborted request used no plan, whatever route it names.
        hints:
          attributed && names.provider === chatGptSignIn && totalTokens(count) > 0
            ? [{ timestamp: ms, plan: names.provider }]
            : [],
        warnings: [
          ...(sawHeader
            ? []
            : ["Pi session header is missing; attribution uses the file identity."]),
          ...(stamp.id === undefined
            ? ["Some Pi entries lack stable IDs; forked sessions may overlap."]
            : []),
          ...(model === undefined
            ? [
                "Pi tool and summary usage names no model; these tokens remain unpriced unless an explicit rate is supplied.",
              ]
            : []),
        ],
      };
    },
  };
}
