import { Option, Schema } from "effect";

import type { ChatgptRequest } from "../billing-hints.ts";
import { RepositoryReference, type UsageRecord } from "../model.ts";
import { decodeJson, empty, malformed, skipped, type TranscriptParser } from "./shared.ts";

/** Allowlisted Copilot accounting attributes, shared by JSONL and SQLite decoding. */
export const CopilotAttributes = Schema.Struct({
  "gen_ai.operation.name": Schema.optionalKey(Schema.String),
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
  "gen_ai.usage.cache_write.input_tokens": Schema.optionalKey(Schema.Natural),
  "github.copilot.git.repository": Schema.optionalKey(Schema.String),
  "copilot_chat.repo.remote_url": Schema.optionalKey(Schema.String),
  "session.id": Schema.optionalKey(Schema.String),
});

const SpanContext = Schema.Struct({
  traceId: Schema.NonEmptyString,
  spanId: Schema.NonEmptyString,
});

const Span = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("span")),
  traceId: Schema.NonEmptyString,
  spanId: Schema.NonEmptyString,
  parentSpanId: Schema.optionalKey(Schema.NonEmptyString),
  parentSpanContext: Schema.optionalKey(SpanContext),
  endTime: Schema.Tuple([Schema.Natural, Schema.Natural]),
  attributes: CopilotAttributes,
});

const InferenceEvent = Schema.Struct({
  spanContext: Schema.optionalKey(SpanContext),
  hrTime: Schema.Tuple([Schema.Natural, Schema.Natural]),
  attributes: Schema.Struct({
    ...CopilotAttributes.fields,
    "event.name": Schema.Literal("gen_ai.client.inference.operation.details"),
    "gen_ai.response.id": Schema.NonEmptyString,
  }),
});

const Header = Schema.Struct({
  attributes: Schema.Struct({
    "event.name": Schema.optionalKey(Schema.String),
    "gen_ai.operation.name": Schema.optionalKey(Schema.String),
  }),
});

interface AttributionSpan {
  readonly repository: UsageRecord["repository"];
  readonly parent: string | undefined;
}

interface Candidate {
  readonly record: UsageRecord;
  readonly spanKey: string | undefined;
  readonly responseId: string | undefined;
  readonly isSpan: boolean;
  /** The repository the proxy hinted for this request, used only when Copilot names none. */
  readonly hinted?: UsageRecord["repository"];
}

/** Whether Copilot named a GitHub repository as `owner/name`, its identity on GitHub. */
export const isOwnerAndName = (repository: string) =>
  /^[A-Za-z0-9-]+\/(?!\.{1,2}$)[A-Za-z0-9_.-]+$/.test(repository);

function repositoryReference(attributes: typeof CopilotAttributes.Type): UsageRecord["repository"] {
  const repository = attributes["github.copilot.git.repository"];

  if (repository !== undefined)
    return isOwnerAndName(repository)
      ? RepositoryReference.Identity({ value: repository })
      : RepositoryReference.Remote({ value: repository });

  const remote = attributes["copilot_chat.repo.remote_url"];

  return remote === undefined ? null : RepositoryReference.Remote({ value: remote });
}

/** Buffers one Copilot source to resolve out-of-order spans before request deduplication. */
export function copilotParser(
  file: string,
  chatgptRequests: ReadonlyMap<string, ChatgptRequest> = new Map(),
): TranscriptParser {
  const spans = new Map<string, AttributionSpan>();
  const candidates: Candidate[] = [];

  const warning =
    "Copilot coverage starts when telemetry was enabled; only inference requests are counted.";

  return {
    parse(line) {
      const raw = Option.getOrNull(decodeJson(line));

      if (raw === null) return malformed;
      const event = Option.getOrNull(Schema.decodeUnknownOption(InferenceEvent)(raw));
      const exportedSpan = Option.getOrNull(Schema.decodeUnknownOption(Span)(raw));

      const span =
        exportedSpan ??
        (event === null
          ? null
          : {
              traceId: event.spanContext?.traceId ?? "response",
              spanId: event.spanContext?.spanId ?? event.attributes["gen_ai.response.id"],
              endTime: event.hrTime,
              attributes: event.attributes,
            });

      if (span === null) {
        const header = Option.getOrNull(Schema.decodeUnknownOption(Header)(raw));

        return header?.attributes["event.name"] === "gen_ai.client.inference.operation.details" ||
          (header?.attributes["event.name"] === undefined &&
            header?.attributes["gen_ai.operation.name"] === "chat")
          ? skipped
          : empty;
      }

      const a = span.attributes;

      const spanKey =
        exportedSpan !== null || event?.spanContext !== undefined
          ? `${span.traceId}:${span.spanId}`
          : undefined;

      if (exportedSpan !== null && spanKey !== undefined) {
        const parent = exportedSpan.parentSpanContext;
        spans.set(spanKey, {
          repository: repositoryReference(a),
          parent:
            parent !== undefined
              ? parent.traceId === span.traceId
                ? `${parent.traceId}:${parent.spanId}`
                : undefined
              : exportedSpan.parentSpanId === undefined
                ? undefined
                : `${span.traceId}:${exportedSpan.parentSpanId}`,
        });
      }

      if (a["gen_ai.operation.name"] !== "chat") return empty;
      const input = a["gen_ai.usage.input_tokens"];
      const output = a["gen_ai.usage.output_tokens"];

      if (input === undefined || output === undefined) return skipped;

      const cacheRead =
        a["gen_ai.usage.cache_read.input_tokens"] ?? a["gen_ai.usage.cache_read_input_tokens"] ?? 0;

      // The Copilot harness's Agent Host export names cache writes `cache_write`.
      const cacheWrite =
        a["gen_ai.usage.cache_creation.input_tokens"] ??
        a["gen_ai.usage.cache_creation_input_tokens"] ??
        a["gen_ai.usage.cache_write.input_tokens"] ??
        0;

      if (cacheRead + cacheWrite > input) return skipped;
      const ms = span.endTime[0] * 1000 + Math.floor(span.endTime[1] / 1_000_000);

      if (!Number.isFinite(new Date(ms).getTime())) return skipped;

      const record: UsageRecord = {
        provider: "copilot",
        id: `${span.traceId}:${span.spanId}`,
        session: a["gen_ai.conversation.id"] ?? a["session.id"] ?? file,
        timestamp: ms,
        model: a["gen_ai.response.model"] ?? a["gen_ai.request.model"] ?? "unknown",
        cwd: null,
        repository: repositoryReference(a),
        tokens: { input: input - cacheRead - cacheWrite, output, cacheRead, cacheWrite },
      };

      candidates.push({
        record,
        spanKey,
        responseId: a["gen_ai.response.id"],
        isSpan: exportedSpan !== null,
      });

      return empty;
    },
    finish() {
      // A request span may lack the response ID its inference event carries. It takes the
      // ID when exactly one event shares its span key, so the request counts once. Events keep
      // their own IDs: separate requests can log events under one non-request span.
      const eventResponses = new Map<string, Set<string>>();

      for (const { spanKey, responseId, isSpan } of candidates)
        if (!isSpan && spanKey !== undefined && responseId !== undefined)
          eventResponses.set(spanKey, (eventResponses.get(spanKey) ?? new Set()).add(responseId));

      // The ID each request goes by, a span taking its event's as above.
      const responses = candidates.map((candidate) => {
        const shared =
          candidate.isSpan && candidate.responseId === undefined && candidate.spanKey !== undefined
            ? eventResponses.get(candidate.spanKey)
            : undefined;

        return shared?.size === 1 ? [...shared][0] : candidate.responseId;
      });

      // VS Code's Local harness gives every request of a turn the turn's response ID. Where
      // one ID carries several requests, each goes by the ID and its prompt and output token
      // counts, which differ between a turn's requests as its context grows. A request's span
      // and event, in one export or two, then share an identity and count once, while the
      // turn's other requests count separately.
      const usage = ({ tokens }: UsageRecord) =>
        `${tokens.input + tokens.cacheRead + tokens.cacheWrite}:${tokens.output}`;

      const usages = new Map<string, Set<string>>();

      candidates.forEach((candidate, index) => {
        const responseId = responses[index];

        if (responseId !== undefined)
          usages.set(
            responseId,
            (usages.get(responseId) ?? new Set()).add(usage(candidate.record)),
          );
      });

      const identified = candidates.map((candidate, index): Candidate => {
        const responseId = responses[index];

        if (responseId === undefined) return candidate;

        const id =
          (usages.get(responseId)?.size ?? 0) > 1
            ? `response:${responseId}#${usage(candidate.record)}`
            : `response:${responseId}`;

        const record = { ...candidate.record, id };
        const routed = chatgptRequests.get(responseId);

        if (routed === undefined) return { ...candidate, responseId, record };

        return {
          ...candidate,
          responseId,
          record: { ...record, billingProvider: "codex" },
          hinted:
            routed.repository === null
              ? null
              : RepositoryReference.Remote({ value: routed.repository }),
        };
      });

      // A request's own repository, or else the nearest one among the spans enclosing it.
      const inheritedRepository = (candidate: Candidate) => {
        let repository = candidate.record.repository;
        let key = candidate.spanKey;
        const visited = new Set<string>();

        while (repository === null && key !== undefined && !visited.has(key)) {
          visited.add(key);
          const ancestor = spans.get(key);
          repository = ancestor?.repository ?? null;
          key = ancestor?.parent;
        }

        return repository;
      };

      const preferred = new Map<string, Candidate>();

      for (const candidate of identified) {
        const repository = inheritedRepository(candidate);
        const resolved = { ...candidate, record: { ...candidate.record, repository } };
        const previous = preferred.get(resolved.record.id);

        if (previous === undefined) preferred.set(resolved.record.id, resolved);
        else {
          // Request spans include cache details omitted by inference log events.
          const best = resolved.isSpan && !previous.isSpan ? resolved : previous;
          preferred.set(resolved.record.id, {
            ...best,
            record: {
              ...best.record,
              repository: best.record.repository ?? repository ?? previous.record.repository,
            },
          });
        }
      }

      // Some custom-model requests have no agent span, so only the proxy knows the repository.
      // Applied after merging, so Copilot's own repository on either copy still wins.
      for (const [id, merged] of preferred)
        if (merged.record.repository === null && merged.hinted)
          preferred.set(id, { ...merged, record: { ...merged.record, repository: merged.hinted } });

      // Preserve duplicate accounting in Ledger while presenting the enriched record first.
      const records = identified.map(
        (candidate) => preferred.get(candidate.record.id)?.record ?? candidate.record,
      );

      candidates.length = 0;
      spans.clear();

      return { ...empty, records, warnings: records.length > 0 ? [warning] : [] };
    },
  };
}
