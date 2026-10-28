import { Option, Schema } from "effect";

import type { ChatgptRequest } from "../billing-hints.ts";
import { RepositoryReference, type UsageRecord } from "../model.ts";
import { isOwnerAndName } from "./copilot.ts";
import { decodeJson, empty, skipped, timestamp, type TranscriptParser } from "./shared.ts";

/**
 * The Copilot runtime behind Copilot CLI and VS Code's Copilot harness keeps each session's
 * event log at `session-state/<session id>/events.jsonl` under `COPILOT_HOME`. It records every
 * request's usage whether or not a telemetry export is switched on. Beside the accounting
 * events it holds prompts, responses, and tool output, so only the workspace and usage events
 * are decoded, each through an allowlist of fields.
 */
const Workspace = Schema.Struct({
  cwd: Schema.optionalKey(Schema.String),
  repository: Schema.optionalKey(Schema.String),
  repositoryHost: Schema.optionalKey(Schema.String),
  hostType: Schema.optionalKey(Schema.String),
  /** A preliminary change, always followed by the settled one. */
  pendingGitContext: Schema.optionalKey(Schema.Boolean),
});

const SessionStart = Schema.Struct({
  type: Schema.Literal("session.start"),
  data: Schema.Struct({
    sessionId: Schema.NonEmptyString,
    context: Schema.optionalKey(Workspace),
  }),
});

/** The session moved to another working directory; usage from then on is done there. */
const ContextChanged = Schema.Struct({
  type: Schema.Literal("session.context_changed"),
  data: Workspace,
});

/** The session was resumed, possibly in another working directory. */
const Resumed = Schema.Struct({
  type: Schema.Literal("session.resume"),
  data: Schema.Struct({ context: Schema.optionalKey(Workspace) }),
});

const UsageEvent = Schema.Struct({
  type: Schema.Literal("session.usage_record"),
  timestamp: Schema.String,
  data: Schema.Struct({
    usage: Schema.Struct({
      model: Schema.NonEmptyString,
      inputTokens: Schema.Natural,
      outputTokens: Schema.Natural,
      cacheReadTokens: Schema.optionalKey(Schema.Natural),
      cacheWriteTokens: Schema.optionalKey(Schema.Natural),
      isByok: Schema.optionalKey(Schema.Boolean),
      apiCallId: Schema.optionalKey(Schema.NonEmptyString),
      accounting: Schema.optionalKey(
        Schema.Struct({
          sourceSessionId: Schema.optionalKey(Schema.NonEmptyString),
          usageId: Schema.optionalKey(Schema.NonEmptyString),
        }),
      ),
    }),
  }),
});

/** Only the event's type, to tell accounting events from text that merely names them. */
const Header = Schema.Struct({ type: Schema.String });

const decodeHeader = Schema.decodeUnknownOption(Header);

const decodeStart = Schema.decodeUnknownOption(SessionStart);

const decodeChange = Schema.decodeUnknownOption(ContextChanged);

const decodeResume = Schema.decodeUnknownOption(Resumed);

const decodeUsage = Schema.decodeUnknownOption(UsageEvent);

/**
 * Whether `entry` lies directly in a session's folder: its event log, or its checkpoints,
 * files, and research folders, which never hold usage and can be large.
 */
export function insideSession(entry: string): boolean {
  return entry.split(/[\\/]/).at(-3) === "session-state";
}

/** Event types worth decoding; every other line, prompts among them, is passed over unread. */
const accounting = [
  '"session.start"',
  '"session.resume"',
  '"session.context_changed"',
  '"session.usage_record"',
];

/**
 * The GitHub remote a workspace names, so the project is the one Git discovery and the other
 * tools give it, on github.com or a GitHub Enterprise host. Other hosts are left to discovery
 * from the working directory: their remotes take several forms that name one repository.
 */
function githubRemote(workspace: typeof Workspace.Type): UsageRecord["repository"] {
  const { hostType, repository, repositoryHost = "github.com" } = workspace;

  return hostType === "github" &&
    repository !== undefined &&
    isOwnerAndName(repository) &&
    /^[a-z0-9.-]+(?::\d+)?$/i.test(repositoryHost)
    ? RepositoryReference.Remote({ value: `https://${repositoryHost}/${repository}` })
    : null;
}

/** Whether `file` is a session's event log: `events.jsonl` in a folder of `session-state`. */
export function isSessionEvents(file: string): boolean {
  return insideSession(file) && file.split(/[\\/]/).at(-1) === "events.jsonl";
}

/**
 * Reads one session's event log. Its `session.start`, and any later `session.context_changed`,
 * name the workspace: the working directory, which project mappings and Git discovery read, and
 * the GitHub repository Copilot recorded, which names the project when the directory is gone.
 * Each `session.usage_record` is one request, keyed by the response ID a telemetry export gives
 * the same request, so a request in both is counted once. Input counts include cache reads and
 * writes, as in the export. A request the local proxy routed to a ChatGPT plan is billed to it,
 * as in the export. Other requests on a person's own key (BYOK) are not Copilot's to bill: they
 * are excluded, so an export's copy of one is not counted either.
 */
export function copilotSessionParser(
  file: string,
  chatgptRequests: ReadonlyMap<string, ChatgptRequest> = new Map(),
): TranscriptParser {
  let session: string | undefined;
  let cwd: string | null = null;
  let repository: UsageRecord["repository"] = null;

  const settle = (workspace: typeof Workspace.Type | undefined) => {
    if (workspace?.pendingGitContext === true) return;
    cwd = workspace?.cwd || null;
    repository = workspace === undefined ? null : githubRemote(workspace);
  };

  return {
    parse(line) {
      if (!accounting.some((type) => line.includes(type))) return empty;
      const raw = Option.getOrNull(decodeJson(line));
      const type = Option.getOrNull(decodeHeader(raw))?.type;

      if (type === "session.start") {
        const event = Option.getOrNull(decodeStart(raw));

        if (event === null) return empty;
        session = event.data.sessionId;
        settle(event.data.context);

        return empty;
      }

      if (type === "session.context_changed") {
        settle(Option.getOrNull(decodeChange(raw))?.data ?? undefined);

        return empty;
      }

      if (type === "session.resume") {
        const context = Option.getOrNull(decodeResume(raw))?.data.context;

        if (context !== undefined) settle(context);

        return empty;
      }

      if (type !== "session.usage_record") return empty;
      const event = Option.getOrNull(decodeUsage(raw));

      if (event === null) return skipped;
      const usage = event.data.usage;
      const usageId = usage.accounting?.usageId;

      const id =
        usage.apiCallId !== undefined
          ? `response:${usage.apiCallId}`
          : usageId === undefined
            ? undefined
            : `usage:${usageId}`;

      // The local proxy's hint, keyed by the response ID, names a ChatGPT plan as the payer.
      const routed =
        usage.apiCallId === undefined ? undefined : chatgptRequests.get(usage.apiCallId);

      if (usage.isByok === true && routed === undefined)
        return id === undefined ? empty : { ...empty, excluded: [id] };
      const cacheRead = usage.cacheReadTokens ?? 0;
      const cacheWrite = usage.cacheWriteTokens ?? 0;
      const ms = timestamp(event.timestamp);

      if (ms === null || id === undefined || cacheRead + cacheWrite > usage.inputTokens)
        return skipped;

      const record: UsageRecord = {
        provider: "copilot",
        id,
        session: usage.accounting?.sourceSessionId ?? session ?? file,
        timestamp: ms,
        model: usage.model,
        cwd,
        repository:
          repository ??
          (routed === undefined || routed.repository === null
            ? null
            : RepositoryReference.Remote({ value: routed.repository })),
        tokens: {
          input: usage.inputTokens - cacheRead - cacheWrite,
          output: usage.outputTokens,
          cacheRead,
          cacheWrite,
        },
      };

      return {
        ...empty,
        records: [routed === undefined ? record : { ...record, billingProvider: "codex" }],
      };
    },
  };
}
