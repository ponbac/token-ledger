import { Option, Schema } from "effect";
import { type BillingProvider, totalTokens, type UsageRecord } from "../model.ts";
import { decodeJson, empty, malformed, skipped, type TranscriptParser } from "./shared.ts";

// Usage is located before anything else is decoded, so a message known to carry it is never
// dropped as unrelated. A user message carries none. A newer `compaction` message carries the
// usage of the summary it wrote; one that failed names no model.
const decodeCarrier = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.optionalKey(Schema.NullOr(Schema.String)),
    tokens: Schema.optionalKey(Schema.Unknown),
  }),
);

const Count = Schema.Natural;

const unattributedModel = "unknown";

/** A legacy `storage/session` file: only when the session began, never its title or summary. */
const decodeSession = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.NonEmptyString,
    time: Schema.Struct({ created: Schema.Number.check(Schema.isFinite()) }),
  }),
);

/** A deferred legacy message, once every source is read: a fork's copy or an original. */
export interface Classified {
  readonly record: UsageRecord;
  readonly copy: boolean;
}

/** What an OpenCode file holds: a database's rows, or one legacy message or session. */
export type OpencodeFile = "database" | "message" | "session";

/**
 * One message with usage, as OpenCode stores an assistant message in `message.data` and in
 * legacy `storage/message` files. The database reader puts newer messages in the same shape and
 * adds the session's directory and whether the message is a copy a fork made. OpenCode's
 * `input` excludes cache reads and writes, and its `output` excludes `reasoning`. On Windows it
 * stores paths with forward slashes.
 */
const decodeMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.NonEmptyString,
    sessionID: Schema.NonEmptyString,
    providerID: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
    modelID: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
    time: Schema.Struct({ created: Schema.Number.check(Schema.isFinite()) }),
    tokens: Schema.Struct({
      input: Count,
      output: Count,
      reasoning: Count,
      cache: Schema.Struct({ read: Count, write: Count }),
    }),
    cost: Schema.optionalKey(
      Schema.NullOr(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
    ),
    path: Schema.optionalKey(
      Schema.NullOr(Schema.Struct({ cwd: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
    ),
    directory: Schema.optionalKey(Schema.NullOr(Schema.String)),
    forked: Schema.optionalKey(Schema.Boolean),
  }),
);

/**
 * The subscription that paid for a request, from the route OpenCode recorded. GitHub Copilot
 * takes only a sign-in. OpenCode's ChatGPT sign-in for `openai` clears every model's rates, so
 * such a request costs exactly zero; an API key is charged at the rates models.dev lists.
 */
function payer(
  providerID: string | null | undefined,
  cost: number | null | undefined,
): typeof BillingProvider.Type | undefined {
  if (providerID === "github-copilot") return "copilot";

  if (providerID === "openai" && cost === 0) return "codex";

  return undefined;
}

/**
 * Reads OpenCode usage across every source of one scan. A fork copies its parent's messages
 * under new IDs with their timestamps and usage intact, into a session begun after them. A copy
 * is matched to its original by timestamp, route, model, and tokens, in any database or legacy
 * file, so it is returned as inherited under a provisional ID that `settle` resolves once every
 * source is read; until then it waits, and is counted only where no original is read. Copies of
 * a deleted parent share that ID, so sibling forks count them once. A database marks its own
 * copies; a legacy message is known as one only by its session's start, which may be read from
 * any source in any order, so legacy messages are deferred and `classify` decides once every
 * source is read, before any copy is settled.
 */
export function opencodeHistory(nativePath: (path: string) => string) {
  // When each legacy session began, by ID; databases mark copies themselves.
  const sessions = new Map<string, number>();
  // The first original read for each provisional copy ID.
  const originals = new Map<string, string>();
  // Message IDs a database marked as a fork's copies, which legacy files may repeat.
  const copied = new Set<string>();
  // Each deferred legacy message's provisional copy ID.
  const pending = new Map<UsageRecord, string>();

  const native = (value: string | null | undefined) =>
    value === undefined || value === null || value === "" ? null : nativePath(value);

  const sessionParser: TranscriptParser = {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));
      const session = raw === null ? null : Option.getOrNull(decodeSession(raw));

      if (session === null) return malformed;
      sessions.set(session.id, session.time.created);

      return empty;
    },
  };

  const messageParser: TranscriptParser = {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const carrier = Option.getOrNull(decodeCarrier(raw));

      if (carrier === null) return malformed;
      const assistant = carrier.role === "assistant";

      if (carrier.tokens === undefined || carrier.tokens === null)
        return assistant ? skipped : empty;

      // Usage on a message role this adapter does not know cannot be read as none.
      if (!assistant && carrier.role !== "compaction") return skipped;
      const message = Option.getOrNull(decodeMessage(raw));

      // Every assistant message names the model that answered it.
      if (message === null || (assistant && (!message.providerID || !message.modelID)))
        return skipped;
      const { tokens } = message;

      const counts = {
        input: tokens.input,
        cacheRead: tokens.cache.read,
        cacheWrite: tokens.cache.write,
        output: tokens.output + tokens.reasoning,
      };

      // An aborted request used nothing, whatever its route.
      const billingProvider =
        totalTokens(counts) > 0 ? payer(message.providerID, message.cost) : undefined;

      const own: UsageRecord = {
        provider: "opencode",
        id: message.id,
        session: message.sessionID,
        timestamp: message.time.created,
        model: message.modelID ?? unattributedModel,
        cwd: native(message.path?.cwd) ?? native(message.directory),
        repository: null,
        tokens: counts,
      };

      const record = billingProvider === undefined ? own : { ...own, billingProvider };

      const copyId = `fork:${JSON.stringify([
        message.time.created,
        message.providerID,
        message.modelID,
        tokens.input,
        tokens.output,
        tokens.reasoning,
        tokens.cache.read,
        tokens.cache.write,
      ])}`;

      const warnings =
        message.modelID === undefined || message.modelID === null
          ? [
              "OpenCode compactions that failed name no model; these tokens remain unpriced unless an explicit rate is supplied.",
            ]
          : [];

      if (message.forked === undefined) {
        pending.set(record, copyId);

        return { ...empty, deferred: [record], warnings };
      }

      if (message.forked) {
        copied.add(message.id);

        return { ...empty, inherited: [{ ...record, id: copyId }], warnings };
      }

      if (!originals.has(copyId)) originals.set(copyId, message.id);

      return { ...empty, records: [record], warnings };
    },
  };

  return {
    parser: (file: OpencodeFile): TranscriptParser =>
      file === "session" ? sessionParser : messageParser,
    /** Whether a deferred legacy message is a copy, under its provisional ID, or an original. */
    classify: (record: UsageRecord): Classified => {
      const copyId = pending.get(record) ?? record.id;
      const started = sessions.get(record.session);

      if (copied.has(record.id) || (started !== undefined && record.timestamp < started))
        return { record: { ...record, id: copyId }, copy: true };

      if (!originals.has(copyId)) originals.set(copyId, record.id);

      return { record, copy: false };
    },
    /** A copy under its original's ID once every source is read, or under its provisional one. */
    settle: (record: UsageRecord): UsageRecord =>
      record.provider === "opencode"
        ? { ...record, id: originals.get(record.id) ?? record.id }
        : record,
  };
}
