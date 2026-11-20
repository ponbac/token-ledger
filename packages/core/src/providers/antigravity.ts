import { fileURLToPath } from "node:url";

import { RepositoryReference, type Tokens, totalTokens, type UsageRecord } from "../model.ts";
import { repositoryIdentity } from "../projects.ts";
import {
  type BlobSliceReader,
  type RawAntigravityDatabase,
  type RawAntigravityMetadata,
  walkProtoMessage,
} from "./antigravity-db.ts";

const utf8 = new TextDecoder("utf-8", { fatal: true });

// Offline fallback for records without names. New names are learned from scanned metadata.
// Cross-checked against T3 Code's Antigravity reader and local Neon / Carbon databases.
const modelIds = new Map<number, string>([
  [246, "gemini-2.5-pro"],
  [312, "gemini-2.5-flash"],
  [313, "gemini-2.5-flash-thinking"],
  [329, "gemini-2.5-flash-thinking"],
  [330, "gemini-2.5-flash-lite"],
  [281, "claude-sonnet-4"],
  [282, "claude-sonnet-4"],
  [290, "claude-opus-4"],
  [291, "claude-opus-4"],
  [333, "claude-sonnet-4-5"],
  [334, "claude-sonnet-4-5"],
  [340, "claude-haiku-4-5"],
  [341, "claude-haiku-4-5"],
  [342, "gpt-oss-120b-medium"],
  [1026, "claude-opus-4-6"],
  [1035, "claude-sonnet-4-6"],
  [1016, "gemini-3.1-pro"],
  [1036, "gemini-3.1-pro"],
  [1037, "gemini-3.1-pro"],
  [1018, "gemini-3-flash-preview"],
  [1084, "gemini-3-flash-preview"],
  [1047, "gemini-3-flash-preview"],
  [1020, "gemini-3.5-flash-medium"],
  [1021, "gemini-3.1-flash-image"],
  [1050, "gemini-3.1-flash-lite"],
  [1071, "gemini-3.6-flash-high"],
  [1072, "gemini-3.6-flash-medium"],
  [1073, "gemini-3.6-flash-low"],
  [1132, "gemini-3.5-flash-high"],
  [1133, "gemini-3.5-flash-high"],
  [1187, "gemini-3.5-flash-extra-low"],
  [1196, "gemini-3.6-flash"],
  [1266, "gemini-3.6-flash"],
  [1298, "gemini-3.7-flash-high"],
  [1299, "gemini-3.7-flash-medium"],
  [1300, "gemini-3.7-flash-low"],
  [1301, "gemini-3.7-flash-tiered"],
  [1318, "gemini-3.8-flash-high"],
  [1319, "gemini-3.8-flash-medium"],
  [1320, "gemini-3.8-flash-low"],
  [1322, "gemini-3.8-flash-tiered"],
  [1402, "claude-opus-5-5"],
  [1417, "gemini-4-argon"],
  [1418, "gemini-4-argon"],
  [1419, "gemini-4-argon"],
  [1438, "gemini-4-carbon"],
  [1532, "gemini-4-neon"],
]);

/**
 * Maps an Antigravity effort or routing alias onto the base model whose vendor rate applies.
 * Matches `gemini-3-flash-agent` before generic `-agent` stripping so it resolves to
 * `gemini-3.5-flash` rather than `gemini-3-flash-preview`.
 */
export function antigravityRateModel(model: string): string {
  if (/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)) return "gemini-3.5-flash";

  if (model === "gemini-3.7-flash-safety-le") return "gemini-3.7-flash";
  const base = model.replace(/-(?:extra-low|low|medium|high|tiered|control|thinking|agent)$/, "");

  return base === "gemini-3-flash" ? "gemini-3-flash-preview" : base;
}

function normalizeModelName(name: string): string {
  if (!name) return "";

  const normalized = name
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");

  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }

  return normalized;
}

function isConcreteModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

function bytesReader(bytes: Uint8Array): BlobSliceReader {
  return {
    byteLength: bytes.byteLength,
    slice: (offset, length) => bytes.subarray(offset, offset + length),
  };
}

function decodeText(bytes: Uint8Array | undefined): string {
  return bytes === undefined ? "" : utf8.decode(bytes).trim();
}

/** Google Protobuf Timestamp upper bound (`9999-12-31T23:59:59Z`). */
const maxTimestampSeconds = 253_402_300_799;

const maxSafeInt = BigInt(Number.MAX_SAFE_INTEGER);

function decodeTimestamp(bytes: Uint8Array | undefined): number | null {
  if (bytes === undefined) return null;
  let seconds = 0;
  let nanos = 0;

  walkProtoMessage(bytesReader(bytes), 0, bytes.byteLength, (field) => {
    if (field.number === 1) {
      if (field.wire !== 0) throw new Error("Unexpected Antigravity timestamp wire type");

      if (field.varintValue === undefined) throw new Error("Unrepresentable Antigravity timestamp");

      if (seconds === 0) seconds = field.varintValue;
    } else if (field.number === 2) {
      if (field.wire !== 0) throw new Error("Unexpected Antigravity timestamp wire type");

      if (field.varintValue === undefined) throw new Error("Unrepresentable Antigravity timestamp");

      if (nanos === 0) nanos = field.varintValue;
    }
  });

  if (seconds > maxTimestampSeconds || nanos >= 1_000_000_000)
    throw new Error("Out-of-range Antigravity timestamp");

  return seconds > 0 ? seconds * 1000 + Math.floor(nanos / 1_000_000) : null;
}

interface DecodedUsage {
  readonly modelId: number;
  readonly tokens: Tokens;
  readonly wireKeys: readonly string[];
}

function decodeUsage(bytes: Uint8Array): DecodedUsage {
  let modelId = 0;
  let input = 0;
  let outputReported = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let reasoning = 0;
  let textOutput = 0;
  const ids = new Map<number, string>();
  const reader = bytesReader(bytes);

  const requireSafeCounter = (value: number | undefined): number => {
    if (value === undefined) throw new Error("Unrepresentable Antigravity usage counter");

    return value;
  };

  walkProtoMessage(reader, 0, bytes.byteLength, (field) => {
    if (
      field.number === 1 ||
      field.number === 2 ||
      field.number === 3 ||
      field.number === 4 ||
      field.number === 5 ||
      field.number === 9 ||
      field.number === 10
    ) {
      if (field.wire !== 0) throw new Error("Unexpected Antigravity usage counter wire type");
      const value = requireSafeCounter(field.varintValue);

      if (field.number === 1 && modelId === 0) modelId = value;
      else if (field.number === 2 && input === 0) input = value;
      else if (field.number === 3 && outputReported === 0) outputReported = value;
      else if (field.number === 4 && cacheWrite === 0) cacheWrite = value;
      else if (field.number === 5 && cacheRead === 0) cacheRead = value;
      else if (field.number === 9 && reasoning === 0) reasoning = value;
      else if (field.number === 10 && textOutput === 0) textOutput = value;
    } else if (field.number === 7 || field.number === 11 || field.number === 12) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity usage ID wire type");

      if (
        !ids.has(field.number) &&
        field.payloadStart !== undefined &&
        field.payloadLength !== undefined
      ) {
        const value = utf8.decode(reader.slice(field.payloadStart, field.payloadLength)).trim();

        if (value) ids.set(field.number, value);
      }
    }
  });

  const wireKeys: string[] = [];

  for (const fieldNumber of [11, 12, 7] as const) {
    const id = ids.get(fieldNumber);

    if (id !== undefined) wireKeys.push(`antigravity:${fieldNumber}:${id}`);
  }

  const derivedOutput = BigInt(reasoning) + BigInt(textOutput);

  if (derivedOutput > maxSafeInt) throw new Error("Unrepresentable Antigravity output token count");

  return {
    modelId,
    tokens: {
      input,
      cacheRead,
      cacheWrite,
      output: Math.max(outputReported, Number(derivedOutput)),
    },
    wireKeys,
  };
}

function decodeFileUri(raw: string, nativePath: (value: string) => string): string | null {
  if (!raw) return null;

  try {
    const parsed = new URL(raw);

    if (parsed.protocol !== "file:") return null;

    return nativePath(fileURLToPath(parsed));
  } catch {
    return null;
  }
}

function rememberModel(models: Map<number, string | null>, id: number, model: string): void {
  const previous = models.get(id);

  if (previous === undefined || previous === model) {
    models.set(id, model);

    return;
  }

  if (previous === null) return;

  // Effort/display-name variants of the same base model (e.g. `gemini-4-neon` and
  // `gemini-4-neon-high`) agree on their base model rather than triggering conflict suppression.
  const base = antigravityRateModel(model);
  models.set(id, antigravityRateModel(previous) === base ? base : null);
}

interface SlottedUsage {
  readonly slot: string;
  readonly usage: DecodedUsage;
}

interface ParsedEntry {
  readonly idx: number;
  readonly model: string;
  /** Explicit metadata ID, falling back to the primary usage ID (never retries). */
  readonly modelId: number;
  readonly timestampMs: number | null;
  /** 3 for primary metadata timestamp, 2 for fallback step timestamp, 0 when absent. */
  readonly timestampQuality: number;
  readonly usages: readonly SlottedUsage[];
}

function parseEntry(raw: RawAntigravityMetadata): ParsedEntry {
  const names = [decodeText(raw.slugBytes), decodeText(raw.displayNameBytes)].map(
    normalizeModelName,
  );

  const model =
    names.find(isConcreteModel) ??
    names.find((name) => name !== "" && !/^model[_-]/.test(name)) ??
    "";

  const primaryUsage =
    raw.primaryUsageBytes === undefined ? undefined : decodeUsage(raw.primaryUsageBytes);

  const usages: SlottedUsage[] =
    primaryUsage === undefined ? [] : [{ slot: "primary", usage: primaryUsage }];

  for (const [retryOrdinal, retryBytes] of raw.retryUsageBytes.entries()) {
    if (retryBytes !== undefined)
      usages.push({ slot: `retry:${retryOrdinal}`, usage: decodeUsage(retryBytes) });
  }

  const primaryTimestamp = decodeTimestamp(raw.primaryTimestampBytes);
  const fallbackTimestamp = decodeTimestamp(raw.fallbackTimestampBytes);

  return {
    idx: raw.idx,
    model,
    modelId: raw.explicitModelId || (primaryUsage?.modelId ?? 0),
    timestampMs: primaryTimestamp ?? fallbackTimestamp,
    timestampQuality: primaryTimestamp !== null ? 3 : fallbackTimestamp !== null ? 2 : 0,
    usages,
  };
}

interface ParsedCandidateInput {
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly timestampQuality: number;
  readonly model: string;
  readonly modelId: number;
  readonly modelQuality: number;
  readonly cwd: string | null;
  readonly repository: RepositoryReference | null;
  readonly tokens: Tokens;
  readonly wireKeys: readonly string[];
  readonly positionKey: string;
}

/** Validated accounting data decoded from one Antigravity conversation database. */
export interface ParsedAntigravityDatabase {
  readonly learnedModels: readonly { readonly id: number; readonly model: string }[];
  readonly candidates: readonly ParsedCandidateInput[];
}

/**
 * Decodes and validates all nested protobuf leaves and UTF-8 strings from one Antigravity
 * database before it enters the scan accumulator. Throws on corrupt inner payloads so callers
 * can isolate per-file failures without mutating scan state.
 */
export function parseAntigravityDatabase(
  sessionId: string,
  fallbackTimestamp: number,
  database: RawAntigravityDatabase,
  nativePath: (value: string) => string,
): ParsedAntigravityDatabase {
  const trajectoryTimestamp = decodeTimestamp(database.trajectory.timestampBytes);

  // Decode and validate all retained trajectory text leaves before picking the preferred values.
  const workspaceTexts = [
    ...database.trajectory.workspaceUris,
    ...database.trajectory.gitRootUris,
    ...(database.trajectory.fallbackWorkspaceUri === undefined
      ? []
      : [database.trajectory.fallbackWorkspaceUri]),
  ].map(decodeText);

  let cwd: string | null = null;

  for (const text of workspaceTexts) {
    const resolved = decodeFileUri(text, nativePath);

    if (resolved !== null) {
      cwd = resolved;
      break;
    }
  }

  const remoteTexts = database.trajectory.remoteUrls.map(decodeText);
  let repository: RepositoryReference | null = null;

  for (const remote of remoteTexts) {
    if (remote !== "") {
      repository = RepositoryReference.Remote({ value: remote });
      break;
    }
  }

  const generations = database.generations.map(parseEntry);
  const steps = database.steps.map(parseEntry);

  const learnedModels: { readonly id: number; readonly model: string }[] = [];

  for (const entry of [...generations, ...steps]) {
    if (entry.modelId > 0 && isConcreteModel(entry.model))
      learnedModels.push({ id: entry.modelId, model: entry.model });
  }

  const candidates: ParsedCandidateInput[] = [];

  for (const [table, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const entry of entries) {
      for (const { slot, usage } of entry.usages) {
        if (totalTokens(usage.tokens) === 0) continue;

        const modelId = usage.modelId || entry.modelId;

        // A retry may switch models; only inherit enclosing names when the ID matches.
        const model =
          (modelId === 0 || entry.modelId === modelId) && entry.model !== "" ? entry.model : "";

        candidates.push({
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          timestampQuality:
            entry.timestampMs !== null
              ? entry.timestampQuality
              : trajectoryTimestamp !== null
                ? 1
                : 0,
          model,
          modelId,
          modelQuality: isConcreteModel(model) ? 4 : model !== "" ? 1 : 0,
          cwd,
          repository,
          tokens: usage.tokens,
          wireKeys: usage.wireKeys,
          positionKey: `antigravity:fallback:${sessionId}:${table}:${entry.idx}:${slot}`,
        });
      }
    }
  }

  return { learnedModels, candidates };
}

interface Candidate extends ParsedCandidateInput {
  readonly sourceIndex: number;
  readonly fixedProject: string | undefined;
}

/** One deduplicated Antigravity request ready for window placement and project attribution. */
export interface MergedAntigravityRecord {
  readonly record: UsageRecord;
  readonly fixedProject: string | undefined;
  /** Source indices of the duplicate observations folded into this request. */
  readonly duplicateSources: readonly number[];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRepository(a: RepositoryReference | null, b: RepositoryReference | null): number {
  if (a === null && b === null) return 0;

  if (a === null) return 1;

  if (b === null) return -1;

  return (
    compareText(repositoryIdentity(a.value), repositoryIdentity(b.value)) ||
    compareText(a.value, b.value)
  );
}

function compareNullableString(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;

  if (a === null) return 1;

  if (b === null) return -1;

  return compareText(a, b);
}

function keyPriority(key: string): number {
  if (key.startsWith("antigravity:11:")) return 0;

  if (key.startsWith("antigravity:12:")) return 1;

  if (key.startsWith("antigravity:7:")) return 2;

  return 3;
}

function compareKey(a: string, b: string): number {
  return keyPriority(a) - keyPriority(b) || compareText(a, b);
}

/**
 * Accumulates decoded Antigravity databases across every source of one scan, learns numeric
 * model IDs across files, and merges duplicate step/generation/multi-root observations before
 * time-window filtering. Deterministic regardless of root traversal order or host locale.
 */
export function antigravityHistory() {
  const models = new Map<number, string | null>();
  const pending: Candidate[] = [];

  const addDatabase = (
    database: ParsedAntigravityDatabase,
    sourceIndex: number,
    fixedProject: string | undefined,
  ): void => {
    for (const learned of database.learnedModels) rememberModel(models, learned.id, learned.model);

    for (const candidate of database.candidates)
      pending.push({ ...candidate, sourceIndex, fixedProject });
  };

  const finish = (): readonly MergedAntigravityRecord[] => {
    interface Group {
      parent: number;
      size: number;
      canonicalId: string;
      sessionId: string;
      timestampMs: number;
      timestampQuality: number;
      model: string;
      modelQuality: number;
      cwd: string | null;
      repository: RepositoryReference | null;
      fixedProject: string | undefined;
      fixedProjectSource: number;
      tokens: Tokens;
      readonly sources: number[];
    }

    const groups: Group[] = [];
    const wireIdentities = new Map<string, number>();
    const positions = new Map<string, { readonly wired: number[]; readonly idless: number[] }>();

    const find = (index: number): number => {
      let root = index;

      while (true) {
        const node = groups[root];

        if (node === undefined || node.parent === root) break;
        root = node.parent;
      }

      let cursor = index;

      while (cursor !== root) {
        const node = groups[cursor];

        if (node === undefined) break;
        const parent = node.parent;
        node.parent = root;
        cursor = parent;
      }

      return root;
    };

    const merge = (left: number, right: number): number => {
      let a = find(left);
      let b = find(right);

      if (a === b) return a;
      const firstNode = groups[a];
      const secondNode = groups[b];

      if (firstNode === undefined || secondNode === undefined) return a;

      if (firstNode.size < secondNode.size) {
        const swap = a;
        a = b;
        b = swap;
      }

      const target = groups[a];
      const source = groups[b];

      if (target === undefined || source === undefined) return a;

      if (compareKey(source.canonicalId, target.canonicalId) < 0)
        target.canonicalId = source.canonicalId;

      if (compareText(source.sessionId, target.sessionId) < 0) target.sessionId = source.sessionId;

      if (
        source.modelQuality > target.modelQuality ||
        (source.modelQuality === target.modelQuality && compareText(source.model, target.model) < 0)
      ) {
        target.model = source.model;
        target.modelQuality = source.modelQuality;
      }

      if (
        source.timestampQuality > target.timestampQuality ||
        (source.timestampQuality === target.timestampQuality &&
          source.timestampMs < target.timestampMs)
      ) {
        target.timestampMs = source.timestampMs;
        target.timestampQuality = source.timestampQuality;
      }

      if (compareRepository(source.repository, target.repository) < 0)
        target.repository = source.repository;

      if (compareNullableString(source.cwd, target.cwd) < 0) target.cwd = source.cwd;

      if (
        source.fixedProject !== undefined &&
        (target.fixedProject === undefined || source.fixedProjectSource < target.fixedProjectSource)
      ) {
        target.fixedProject = source.fixedProject;
        target.fixedProjectSource = source.fixedProjectSource;
      }

      target.tokens = {
        input: Math.max(target.tokens.input, source.tokens.input),
        cacheRead: Math.max(target.tokens.cacheRead, source.tokens.cacheRead),
        cacheWrite: Math.max(target.tokens.cacheWrite, source.tokens.cacheWrite),
        output: Math.max(target.tokens.output, source.tokens.output),
      };

      for (const sourceIdx of source.sources) target.sources.push(sourceIdx);
      target.size += source.size;
      source.parent = a;

      return a;
    };

    // Phase 1: create groups and merge observations that share a wire request ID.
    for (const candidate of pending) {
      const learned = models.get(candidate.modelId);
      const fallback = learned === null ? undefined : modelIds.get(candidate.modelId);

      const model =
        (candidate.modelQuality === 4 ? candidate.model : "") ||
        learned ||
        fallback ||
        candidate.model ||
        (candidate.modelId > 0 ? `antigravity-model-${candidate.modelId}` : "antigravity-unknown");

      const modelQuality =
        candidate.modelQuality === 4 ? 4 : learned ? 3 : fallback ? 2 : candidate.modelQuality;

      const sortedWire = candidate.wireKeys.toSorted(compareKey);
      const canonicalId = sortedWire[0] ?? candidate.positionKey;
      const index = groups.length;

      groups.push({
        parent: index,
        size: 1,
        canonicalId,
        sessionId: candidate.sessionId,
        timestampMs: candidate.timestampMs,
        timestampQuality: candidate.timestampQuality,
        model,
        modelQuality,
        cwd: candidate.cwd,
        repository: candidate.repository,
        fixedProject: candidate.fixedProject,
        fixedProjectSource: candidate.sourceIndex,
        tokens: candidate.tokens,
        sources: [candidate.sourceIndex],
      });

      const slotGroup = positions.get(candidate.positionKey) ?? { wired: [], idless: [] };
      positions.set(candidate.positionKey, slotGroup);

      if (candidate.wireKeys.length > 0) {
        slotGroup.wired.push(index);

        for (const key of candidate.wireKeys) {
          const existing = wireIdentities.get(key);

          if (existing !== undefined) merge(index, existing);
          wireIdentities.set(key, index);
        }
      } else {
        slotGroup.idless.push(index);
      }
    }

    // Phase 2: merge ID-less observations at the same `(session, table, idx, slot)`, and fold them
    // into a wired component at that exact position only when the wired match is unambiguous.
    for (const { wired, idless } of positions.values()) {
      const firstIdless = idless[0];

      if (firstIdless === undefined) continue;

      for (const other of idless.slice(1)) merge(firstIdless, other);

      const wiredRoots = new Set(wired.map(find));

      if (wiredRoots.size === 1) {
        const onlyWired = wiredRoots.values().next().value;

        if (onlyWired !== undefined) merge(firstIdless, onlyWired);
      }
    }

    const merged: MergedAntigravityRecord[] = [];

    for (const [index, group] of groups.entries()) {
      if (group.parent !== index) continue;
      // Credit the first-configured source as owner and the remaining observations as duplicates.
      const duplicateSources = group.sources.toSorted((a, b) => a - b).slice(1);

      merged.push({
        record: {
          provider: "antigravity",
          id: group.canonicalId,
          session: group.sessionId,
          timestamp: group.timestampMs,
          model: group.model,
          cwd: group.cwd,
          repository: group.repository,
          tokens: group.tokens,
        },
        fixedProject: group.fixedProject,
        duplicateSources,
      });
    }

    return merged.toSorted(
      (a, b) =>
        a.record.timestamp - b.record.timestamp ||
        compareText(a.record.session, b.record.session) ||
        compareText(a.record.id, b.record.id),
    );
  };

  return { addDatabase, finish };
}
