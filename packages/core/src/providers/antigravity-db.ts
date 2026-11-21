import { Effect, Schema } from "effect";

/** An Antigravity database could not be read or decoded; never contains database payloads. */
export class AntigravityDatabaseError extends Schema.TaggedError<AntigravityDatabaseError>()(
  "AntigravityDatabaseError",
  { message: Schema.String },
) {}

const databaseError = () =>
  new AntigravityDatabaseError({ message: "Cannot read the Antigravity database." });

const decodeNames = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ name: Schema.String })),
);

const decodeMetaRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      row_id: Schema.Number,
      idx: Schema.Number,
      byte_length: Schema.NullOr(Schema.Number),
    }),
  ),
);

const decodeTrajectoryRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      row_id: Schema.Number,
      byte_length: Schema.NullOr(Schema.Number),
    }),
  ),
);

const decodeBlobRow = Schema.decodeUnknownSync(Schema.Struct({ chunk: Schema.Uint8Array }));

const pageRows = 64;

/** Block size (64 KiB) for in-memory SQLite chunking so repeated slices stay O(1) on huge rows. */
export const antigravityBlobChunkBytes = 65_536;

/** Bounded random-access reader over a BLOB column; callers never fetch skipped field payloads. */
export interface BlobSliceReader {
  readonly byteLength: number;
  readonly slice: (offset: number, length: number) => Uint8Array;
  /**
   * Optional single-query varint reader returning only the varint bytes up to its terminating byte
   * (at most `maxLength`, never reading past `offset + maxLength`).
   */
  readonly readVarintBytes?: (offset: number, maxLength: number) => Uint8Array;
}

/** Accounting fields extracted from one `gen_metadata` or `steps` row; never prompts or text. */
export interface RawAntigravityMetadata {
  readonly idx: number;
  readonly explicitModelId: number;
  readonly slugBytes: Uint8Array | undefined;
  readonly displayNameBytes: Uint8Array | undefined;
  readonly primaryTimestampBytes: Uint8Array | undefined;
  readonly fallbackTimestampBytes: Uint8Array | undefined;
  readonly primaryUsageBytes: Uint8Array | undefined;
  /** Preserves each retry entry's ordinal even when an entry lacks usage bytes. */
  readonly retryUsageBytes: readonly (Uint8Array | undefined)[];
}

/** Mutable accumulator filled by `extractTrajectoryMetadata`. */
export interface MutableAntigravityTrajectory {
  timestampBytes: Uint8Array | undefined;
  readonly workspaceUris: Uint8Array[];
  readonly gitRootUris: Uint8Array[];
  readonly remoteUrls: Uint8Array[];
  fallbackWorkspaceUri: Uint8Array | undefined;
}

/** Workspace and start-time fields extracted from `trajectory_metadata_blob`. */
export interface RawAntigravityTrajectory {
  readonly timestampBytes: Uint8Array | undefined;
  readonly workspaceUris: readonly Uint8Array[];
  readonly gitRootUris: readonly Uint8Array[];
  readonly remoteUrls: readonly Uint8Array[];
  readonly fallbackWorkspaceUri: Uint8Array | undefined;
}

/** Creates an empty trajectory metadata accumulator. */
export function emptyAntigravityTrajectory(): MutableAntigravityTrajectory {
  return {
    timestampBytes: undefined,
    workspaceUris: [],
    gitRootUris: [],
    remoteUrls: [],
    fallbackWorkspaceUri: undefined,
  };
}

/** Minimal accounting metadata extracted from one Antigravity conversation database. */
export interface RawAntigravityDatabase {
  readonly generations: readonly RawAntigravityMetadata[];
  readonly steps: readonly RawAntigravityMetadata[];
  readonly trajectory: RawAntigravityTrajectory;
}

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);

interface DecodedVarint {
  /** Safe JS integer value, or `undefined` when the 64-bit varint exceeds `MAX_SAFE_INTEGER`. */
  readonly safeValue: number | undefined;
  readonly next: number;
}

/**
 * Reads a protobuf varint strictly within `[offset, end)`, stopping at its terminating byte so no
 * bytes of a following excluded payload ever cross the reader boundary.
 */
function readVarint(reader: BlobSliceReader, offset: number, end: number): DecodedVarint {
  if (offset >= end) throw new Error("Truncated Antigravity protobuf varint");

  if (reader.readVarintBytes !== undefined) {
    const maxLength = Math.min(10, end - offset);
    const bytes = reader.readVarintBytes(offset, maxLength);
    let value = 0n;

    for (let index = 0; index < bytes.byteLength; index++) {
      const byte = bytes[index];
      const shift = BigInt(index) * 7n;

      if (byte === undefined || (shift === 63n && byte > 1))
        throw new Error("Invalid Antigravity protobuf varint");
      value |= BigInt(byte & 127) << shift;

      if (byte < 128)
        return {
          safeValue: value > maxSafe ? undefined : Number(value),
          next: offset + index + 1,
        };
    }

    throw new Error("Truncated Antigravity protobuf varint");
  }

  let value = 0n;
  let position = offset;

  for (let shift = 0n; shift < 70n; shift += 7n) {
    if (position >= end) throw new Error("Truncated Antigravity protobuf varint");
    const chunk = reader.slice(position, 1);
    const byte = chunk[0];

    if (byte === undefined || (shift === 63n && byte > 1))
      throw new Error("Invalid Antigravity protobuf varint");
    position++;
    value |= BigInt(byte & 127) << shift;

    if (byte < 128)
      return {
        safeValue: value > maxSafe ? undefined : Number(value),
        next: position,
      };
  }

  throw new Error("Invalid Antigravity protobuf varint");
}

interface ProtoField {
  readonly number: number;
  readonly wire: number;
  readonly varintValue?: number;
  readonly payloadStart?: number;
  readonly payloadLength?: number;
}

/**
 * Walks one protobuf message strictly within `[start, end)`, advancing past non-allowlisted
 * wire-2, wire-1, and wire-5 payloads without reading their bytes.
 */
export function walkProtoMessage(
  reader: BlobSliceReader,
  start: number,
  end: number,
  onField: (field: ProtoField) => void,
): void {
  if (start < 0 || end < start || end > reader.byteLength)
    throw new Error("Invalid Antigravity protobuf bounds");
  let offset = start;

  while (offset < end) {
    const tag = readVarint(reader, offset, end);

    if (tag.safeValue === undefined) throw new Error("Invalid Antigravity protobuf tag");
    const number = Math.floor(tag.safeValue / 8);
    const wire = tag.safeValue % 8;

    if (number === 0) throw new Error("Invalid Antigravity protobuf field");
    offset = tag.next;

    if (wire === 0) {
      const value = readVarint(reader, offset, end);
      offset = value.next;
      onField(
        value.safeValue === undefined
          ? { number, wire }
          : { number, wire, varintValue: value.safeValue },
      );
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;

      if (length > end - offset) throw new Error("Truncated Antigravity protobuf fixed field");
      offset += length;
      onField({ number, wire });
    } else if (wire === 2) {
      const length = readVarint(reader, offset, end);

      if (length.safeValue === undefined) throw new Error("Invalid Antigravity protobuf length");
      offset = length.next;

      if (length.safeValue > end - offset) throw new Error("Truncated Antigravity protobuf field");
      const payloadStart = offset;
      offset += length.safeValue;
      onField({ number, wire, payloadStart, payloadLength: length.safeValue });
    } else {
      throw new Error("Unsupported Antigravity protobuf wire type");
    }
  }
}

function readLeaf(reader: BlobSliceReader, field: ProtoField): Uint8Array {
  if (field.payloadStart === undefined || field.payloadLength === undefined)
    throw new Error("Missing Antigravity protobuf payload bounds");

  return reader.slice(field.payloadStart, field.payloadLength);
}

/**
 * Extracts only allowlisted accounting fields from `gen_metadata.data` (inside top-level field
 * 1: model ID, primary/retry usage, timestamp, and model names). Prompt fields `1.1`, `1.2`,
 * and `1.16` are skipped by byte offset and never read from SQLite.
 */
export function extractGenerationMetadata(
  idx: number,
  reader: BlobSliceReader,
): RawAntigravityMetadata {
  let sawRoot = false;
  let explicitModelId = 0;
  let slugBytes: Uint8Array | undefined;
  let displayNameBytes: Uint8Array | undefined;
  let primaryTimestampBytes: Uint8Array | undefined;
  let primaryUsageBytes: Uint8Array | undefined;
  const retryUsageBytes: (Uint8Array | undefined)[] = [];

  walkProtoMessage(reader, 0, reader.byteLength, (outer) => {
    if (outer.number !== 1) return;

    if (outer.wire !== 2) throw new Error("Unexpected Antigravity generation wire type");

    if (sawRoot || outer.payloadStart === undefined || outer.payloadLength === undefined) return;
    sawRoot = true;

    walkProtoMessage(
      reader,
      outer.payloadStart,
      outer.payloadStart + outer.payloadLength,
      (field) => {
        if (field.number === 3) {
          if (field.wire !== 0) throw new Error("Unexpected Antigravity model ID wire type");

          if (field.varintValue === undefined)
            throw new Error("Unrepresentable Antigravity model ID");

          if (explicitModelId === 0) explicitModelId = field.varintValue;
        } else if (field.number === 4) {
          if (field.wire !== 2) throw new Error("Unexpected Antigravity usage wire type");

          if (primaryUsageBytes === undefined) primaryUsageBytes = readLeaf(reader, field);
        } else if (field.number === 9) {
          if (field.wire !== 2) throw new Error("Unexpected Antigravity timestamp wire type");

          if (
            primaryTimestampBytes === undefined &&
            field.payloadStart !== undefined &&
            field.payloadLength !== undefined
          ) {
            walkProtoMessage(
              reader,
              field.payloadStart,
              field.payloadStart + field.payloadLength,
              (tsContainer) => {
                if (tsContainer.number !== 4) return;

                if (tsContainer.wire !== 2)
                  throw new Error("Unexpected Antigravity timestamp wire type");

                if (primaryTimestampBytes === undefined)
                  primaryTimestampBytes = readLeaf(reader, tsContainer);
              },
            );
          }
        } else if (field.number === 17) {
          if (field.wire !== 2) throw new Error("Unexpected Antigravity retry wire type");

          if (field.payloadStart !== undefined && field.payloadLength !== undefined) {
            let retryUsage: Uint8Array | undefined;

            walkProtoMessage(
              reader,
              field.payloadStart,
              field.payloadStart + field.payloadLength,
              (retryField) => {
                if (retryField.number !== 2) return;

                if (retryField.wire !== 2)
                  throw new Error("Unexpected Antigravity retry usage wire type");

                if (retryUsage === undefined) retryUsage = readLeaf(reader, retryField);
              },
            );

            retryUsageBytes.push(retryUsage);
          }
        } else if (field.number === 19) {
          if (field.wire !== 2) throw new Error("Unexpected Antigravity slug wire type");

          if (slugBytes === undefined) slugBytes = readLeaf(reader, field);
        } else if (field.number === 21) {
          if (field.wire !== 2) throw new Error("Unexpected Antigravity display name wire type");

          if (displayNameBytes === undefined) displayNameBytes = readLeaf(reader, field);
        }
      },
    );
  });

  if (!sawRoot) throw new Error("Missing Antigravity generation metadata");

  return {
    idx,
    explicitModelId,
    slugBytes,
    displayNameBytes,
    primaryTimestampBytes,
    fallbackTimestampBytes: undefined,
    primaryUsageBytes,
    retryUsageBytes,
  };
}

/**
 * Extracts only allowlisted accounting fields from `steps.metadata`: timestamps (`1`, `8`),
 * primary usage (`9`), model info (`24.{1,8,12}`), and retry usages (`28.2`).
 */
export function extractStepMetadata(idx: number, reader: BlobSliceReader): RawAntigravityMetadata {
  let explicitModelId = 0;
  let slugBytes: Uint8Array | undefined;
  let displayNameBytes: Uint8Array | undefined;
  let primaryTimestampBytes: Uint8Array | undefined;
  let fallbackTimestampBytes: Uint8Array | undefined;
  let primaryUsageBytes: Uint8Array | undefined;
  const retryUsageBytes: (Uint8Array | undefined)[] = [];

  walkProtoMessage(reader, 0, reader.byteLength, (field) => {
    if (field.number === 1) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity step timestamp wire type");

      if (fallbackTimestampBytes === undefined) fallbackTimestampBytes = readLeaf(reader, field);
    } else if (field.number === 8) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity step timestamp wire type");

      if (primaryTimestampBytes === undefined) primaryTimestampBytes = readLeaf(reader, field);
    } else if (field.number === 9) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity step usage wire type");

      if (primaryUsageBytes === undefined) primaryUsageBytes = readLeaf(reader, field);
    } else if (field.number === 24) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity step model wire type");

      if (field.payloadStart !== undefined && field.payloadLength !== undefined) {
        walkProtoMessage(
          reader,
          field.payloadStart,
          field.payloadStart + field.payloadLength,
          (modelField) => {
            if (modelField.number === 1) {
              if (modelField.wire !== 0)
                throw new Error("Unexpected Antigravity model ID wire type");

              if (modelField.varintValue === undefined)
                throw new Error("Unrepresentable Antigravity model ID");

              if (explicitModelId === 0) explicitModelId = modelField.varintValue;
            } else if (modelField.number === 8) {
              if (modelField.wire !== 2)
                throw new Error("Unexpected Antigravity display name wire type");

              if (displayNameBytes === undefined) displayNameBytes = readLeaf(reader, modelField);
            } else if (modelField.number === 12) {
              if (modelField.wire !== 2) throw new Error("Unexpected Antigravity slug wire type");

              if (slugBytes === undefined) slugBytes = readLeaf(reader, modelField);
            }
          },
        );
      }
    } else if (field.number === 28) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity step retry wire type");

      if (field.payloadStart !== undefined && field.payloadLength !== undefined) {
        let retryUsage: Uint8Array | undefined;

        walkProtoMessage(
          reader,
          field.payloadStart,
          field.payloadStart + field.payloadLength,
          (retryField) => {
            if (retryField.number !== 2) return;

            if (retryField.wire !== 2)
              throw new Error("Unexpected Antigravity retry usage wire type");

            if (retryUsage === undefined) retryUsage = readLeaf(reader, retryField);
          },
        );

        retryUsageBytes.push(retryUsage);
      }
    }
  });

  return {
    idx,
    explicitModelId,
    slugBytes,
    displayNameBytes,
    primaryTimestampBytes,
    fallbackTimestampBytes,
    primaryUsageBytes,
    retryUsageBytes,
  };
}

/**
 * Extracts only workspace URIs, git root URIs, git remote URLs, and the trajectory timestamp
 * from `trajectory_metadata_blob.data`.
 */
export function extractTrajectoryMetadata(
  reader: BlobSliceReader,
  target: MutableAntigravityTrajectory,
): void {
  walkProtoMessage(reader, 0, reader.byteLength, (field) => {
    if (field.number === 1) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity workspace wire type");

      if (field.payloadStart !== undefined && field.payloadLength !== undefined) {
        walkProtoMessage(
          reader,
          field.payloadStart,
          field.payloadStart + field.payloadLength,
          (workspaceField) => {
            if (workspaceField.number === 1) {
              if (workspaceField.wire !== 2)
                throw new Error("Unexpected Antigravity workspace URI wire type");
              target.workspaceUris.push(readLeaf(reader, workspaceField));
            } else if (workspaceField.number === 2) {
              if (workspaceField.wire !== 2)
                throw new Error("Unexpected Antigravity git root URI wire type");
              target.gitRootUris.push(readLeaf(reader, workspaceField));
            } else if (workspaceField.number === 3) {
              if (workspaceField.wire !== 2)
                throw new Error("Unexpected Antigravity repository wire type");

              if (
                workspaceField.payloadStart !== undefined &&
                workspaceField.payloadLength !== undefined
              ) {
                walkProtoMessage(
                  reader,
                  workspaceField.payloadStart,
                  workspaceField.payloadStart + workspaceField.payloadLength,
                  (repoField) => {
                    if (repoField.number !== 2) return;

                    if (repoField.wire !== 2)
                      throw new Error("Unexpected Antigravity remote URL wire type");
                    target.remoteUrls.push(readLeaf(reader, repoField));
                  },
                );
              }
            }
          },
        );
      }
    } else if (field.number === 2) {
      if (field.wire !== 2) throw new Error("Unexpected Antigravity trajectory time wire type");

      if (target.timestampBytes === undefined) target.timestampBytes = readLeaf(reader, field);
    } else if (field.number === 7) {
      if (field.wire !== 2)
        throw new Error("Unexpected Antigravity fallback workspace URI wire type");

      if (target.fallbackWorkspaceUri === undefined)
        target.fallbackWorkspaceUri = readLeaf(reader, field);
    }
  });
}

/**
 * Reads one protobuf varint up to its terminating byte (`< 0x80`) from one 64 KiB chunk in a
 * single SQLite statement, strictly within `maxLength` bytes so excluded payload bytes after the
 * varint never leave SQLite.
 */
export const tempChunkVarintSql = `
  SELECT SUBSTR(
    b,
    ?2,
    CASE
      WHEN SUBSTR(b, ?2, 1) < X'80' THEN 1
      WHEN ?3 >= 2 AND SUBSTR(b, ?2 + 1, 1) < X'80' THEN 2
      WHEN ?3 >= 3 AND SUBSTR(b, ?2 + 2, 1) < X'80' THEN 3
      WHEN ?3 >= 4 AND SUBSTR(b, ?2 + 3, 1) < X'80' THEN 4
      WHEN ?3 >= 5 AND SUBSTR(b, ?2 + 4, 1) < X'80' THEN 5
      WHEN ?3 >= 6 AND SUBSTR(b, ?2 + 5, 1) < X'80' THEN 6
      WHEN ?3 >= 7 AND SUBSTR(b, ?2 + 6, 1) < X'80' THEN 7
      WHEN ?3 >= 8 AND SUBSTR(b, ?2 + 7, 1) < X'80' THEN 8
      WHEN ?3 >= 9 AND SUBSTR(b, ?2 + 8, 1) < X'80' THEN 9
      ELSE ?3
    END
  ) AS chunk
  FROM temp._ag_chunks
  WHERE pos = ?1
`;

/** Reads a bounded byte range within one 64 KiB chunk staged in `temp._ag_chunks`. */
export const tempChunkSliceSql =
  "SELECT SUBSTR(b, ?2, ?3) AS chunk FROM temp._ag_chunks WHERE pos = ?1";

/**
 * Builds the SQL that reads a row's BLOB from `main` once and splits it into 64 KiB chunks in
 * `temp._ag_chunks` via a binary-split recursive CTE (`O(N log N)` work, `O(1)` per-chunk slice).
 */
export function tempStageChunksSql(
  table: "gen_metadata" | "steps" | "trajectory_metadata_blob",
  column: "data" | "metadata",
): string {
  const c = antigravityBlobChunkBytes;
  const half = `((LENGTH(b) + ${c - 1}) / ${c} / 2) * ${c}`;

  return `
    WITH RECURSIVE split(pos, b) AS (
      SELECT 0, ${column} FROM main.${table} WHERE rowid = ?1
      UNION ALL
      SELECT pos, SUBSTR(b, 1, ${half}) FROM split WHERE LENGTH(b) > ${c}
      UNION ALL
      SELECT pos + ${half}, SUBSTR(b, ${half} + 1) FROM split WHERE LENGTH(b) > ${c}
    )
    INSERT INTO temp._ag_chunks (pos, b)
    SELECT pos, b FROM split WHERE LENGTH(b) <= ${c}
  `;
}

/**
 * Builds a `BlobSliceReader` over the 64 KiB blocks staged in `temp._ag_chunks`, seamlessly
 * handling slices and varints that straddle a 64 KiB chunk boundary while never returning a
 * single byte past a varint's terminating `< 0x80` byte.
 */
export function chunkedTempBlobReader(
  byteLength: number,
  readSlice: (chunkPos: number, sqlOffset: number, length: number) => Uint8Array,
  readVarint: (chunkPos: number, sqlOffset: number, maxLength: number) => Uint8Array,
): BlobSliceReader {
  const chunkSize = antigravityBlobChunkBytes;

  return {
    byteLength,
    slice(offset, length) {
      if (length === 0) return new Uint8Array(0);
      const startChunk = Math.floor(offset / chunkSize);
      const endChunk = Math.floor((offset + length - 1) / chunkSize);

      if (startChunk === endChunk) {
        const chunkPos = startChunk * chunkSize;
        const chunk = readSlice(chunkPos, offset - chunkPos + 1, length);

        if (chunk.byteLength !== length) throw new Error("Short SQLite BLOB slice");

        return chunk;
      }

      const out = new Uint8Array(length);
      let cursor = offset;
      let written = 0;

      while (written < length) {
        const chunkPos = Math.floor(cursor / chunkSize) * chunkSize;
        const localOffset = cursor - chunkPos;
        const take = Math.min(length - written, chunkSize - localOffset);
        const part = readSlice(chunkPos, localOffset + 1, take);

        if (part.byteLength !== take) throw new Error("Short SQLite BLOB slice");
        out.set(part, written);
        cursor += take;
        written += take;
      }

      return out;
    },
    readVarintBytes(offset, maxLength) {
      const startChunk = Math.floor(offset / chunkSize);
      const chunkPos = startChunk * chunkSize;
      const localOffset = offset - chunkPos;
      const available = chunkSize - localOffset;

      if (maxLength <= available) return readVarint(chunkPos, localOffset + 1, maxLength);

      const first = readVarint(chunkPos, localOffset + 1, available);
      const lastByte = first[first.byteLength - 1];

      if (first.byteLength < available || (lastByte !== undefined && lastByte < 128)) return first;

      const remaining = maxLength - first.byteLength;
      const second = readVarint(chunkPos + chunkSize, 1, remaining);
      const combined = new Uint8Array(first.byteLength + second.byteLength);
      combined.set(first, 0);
      combined.set(second, first.byteLength);

      return combined;
    },
  };
}

/**
 * Reads allowlisted accounting fields from an Antigravity conversation database inside a single
 * read transaction so concurrent WAL writes cannot split tables or pages. Each row's BLOB is
 * staged once from `main` into 64 KiB blocks inside SQLite's in-memory `TEMP` table
 * (`PRAGMA temp_store = MEMORY`), giving bounded disk I/O and O(1) per-slice reads while
 * returning only allowlisted protobuf slices to JavaScript. Returns `null` when the SQLite file
 * has no recognizable Antigravity table layout; once recognized, any present usage or trajectory
 * table with incompatible columns fails the file rather than silently skipping rows.
 */
export const readAntigravityDatabase = Effect.fn("Antigravity.readDatabase")(function* (
  file: string,
) {
  return yield* Effect.gen(function* () {
    const { DatabaseSync } = yield* Effect.tryPromise({
      try: () => import("node:sqlite"),
      catch: databaseError,
    });

    const db = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new DatabaseSync(file, { readOnly: true, timeout: 5000 }),
        catch: databaseError,
      }),
      (connection) => Effect.sync(() => connection.close()),
    );

    yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          db.exec(
            "PRAGMA temp_store = MEMORY; CREATE TEMP TABLE _ag_chunks (pos INTEGER PRIMARY KEY, b BLOB); BEGIN;",
          );
        },
        catch: databaseError,
      }),
      () =>
        Effect.sync(() => {
          try {
            db.exec("ROLLBACK");
          } catch {
            // Connection already ended its read transaction or closed.
          }
        }),
    );

    const tables = yield* Effect.try({
      try: () => db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table'").all(),
      catch: databaseError,
    }).pipe(
      Effect.flatMap(decodeNames),
      Effect.mapError(databaseError),
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );

    const columns = yield* Effect.try({
      try: () =>
        db
          .prepare(
            "SELECT t.name || '.' || c.name AS name FROM main.sqlite_master t, pragma_table_info(t.name) c WHERE t.type = 'table'",
          )
          .all(),
      catch: databaseError,
    }).pipe(
      Effect.flatMap(decodeNames),
      Effect.mapError(databaseError),
      Effect.map((rows) => new Set(rows.map((row) => row.name))),
    );

    const has = (table: string, ...names: readonly string[]) =>
      names.every((name) => columns.has(`${table}.${name}`));

    const hasGenerations = has("gen_metadata", "idx", "data");
    const hasSteps = has("steps", "idx", "metadata");
    const hasTrajectory = has("trajectory_metadata_blob", "data");

    // Detect an Antigravity conversation database independently of column drift (`gen_metadata`
    // and `trajectory_metadata_blob` are Antigravity-specific), while leaving unrelated SQLite
    // files (such as a generic `steps(id)` table alone) unrecognized (`null`).
    const recognizedAntigravity =
      hasGenerations ||
      hasSteps ||
      tables.has("gen_metadata") ||
      tables.has("trajectory_metadata_blob");

    if (!recognizedAntigravity) return null;

    if (
      (!hasGenerations && !hasSteps) ||
      (tables.has("gen_metadata") && !hasGenerations) ||
      (tables.has("steps") && !hasSteps) ||
      (tables.has("trajectory_metadata_blob") && !hasTrajectory)
    )
      return yield* databaseError();

    const tempStatements = yield* Effect.try({
      try: () => ({
        slice: db.prepare(tempChunkSliceSql),
        varint: db.prepare(tempChunkVarintSql),
        clear: db.prepare("DELETE FROM temp._ag_chunks"),
      }),
      catch: databaseError,
    });

    const stageAndExtract = <A>(
      stageRow: () => void,
      byteLength: number,
      extract: (reader: BlobSliceReader) => A,
    ) =>
      Effect.try({
        try: () => {
          stageRow();

          try {
            const reader = chunkedTempBlobReader(
              byteLength,
              (chunkPos, sqlOffset, length) =>
                decodeBlobRow(tempStatements.slice.get(chunkPos, sqlOffset, length)).chunk,
              (chunkPos, sqlOffset, maxLength) =>
                decodeBlobRow(tempStatements.varint.get(chunkPos, sqlOffset, maxLength)).chunk,
            );

            return extract(reader);
          } finally {
            tempStatements.clear.run();
          }
        },
        catch: databaseError,
      });

    const readMetaTable = Effect.fn("Antigravity.readMetaTable")(function* (
      table: "gen_metadata" | "steps",
      column: "data" | "metadata",
      extract: (idx: number, reader: BlobSliceReader) => RawAntigravityMetadata,
    ) {
      const statements = yield* Effect.try({
        try: () => ({
          firstPage: db.prepare(
            `SELECT rowid AS row_id, idx, LENGTH(${column}) AS byte_length FROM main.${table} ORDER BY rowid LIMIT ?`,
          ),
          nextPage: db.prepare(
            `SELECT rowid AS row_id, idx, LENGTH(${column}) AS byte_length FROM main.${table} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
          ),
          stageStmt: db.prepare(tempStageChunksSql(table, column)),
        }),
        catch: databaseError,
      });

      const entries: RawAntigravityMetadata[] = [];
      let after: number | null = null;

      while (true) {
        const rawRows = yield* Effect.try({
          try: () =>
            after === null
              ? statements.firstPage.all(pageRows)
              : statements.nextPage.all(after, pageRows),
          catch: databaseError,
        });

        const rows = yield* decodeMetaRows(rawRows).pipe(Effect.mapError(databaseError));

        for (const row of rows) {
          if (row.byte_length === null || row.byte_length === 0) {
            if (table === "gen_metadata") return yield* databaseError();
            continue;
          }

          const rowId = row.row_id;

          const parsed = yield* stageAndExtract(
            () => {
              statements.stageStmt.run(rowId);
            },
            row.byte_length,
            (reader) => extract(row.idx, reader),
          );

          entries.push(parsed);
        }

        if (rows.length < pageRows) break;
        const last = rows[rows.length - 1];

        if (last === undefined) break;
        after = last.row_id;
        yield* Effect.yieldNow;
      }

      return entries.toSorted((a, b) => a.idx - b.idx);
    });

    const generations = hasGenerations
      ? yield* readMetaTable("gen_metadata", "data", extractGenerationMetadata)
      : [];

    const trajectory = emptyAntigravityTrajectory();

    if (hasTrajectory) {
      const trajStatements = yield* Effect.try({
        try: () => ({
          listStmt: db.prepare(
            "SELECT rowid AS row_id, LENGTH(data) AS byte_length FROM main.trajectory_metadata_blob ORDER BY rowid",
          ),
          stageStmt: db.prepare(tempStageChunksSql("trajectory_metadata_blob", "data")),
        }),
        catch: databaseError,
      });

      const rawTrajRows = yield* Effect.try({
        try: () => trajStatements.listStmt.all(),
        catch: databaseError,
      });

      const trajRows = yield* decodeTrajectoryRows(rawTrajRows).pipe(
        Effect.mapError(databaseError),
      );

      for (const row of trajRows) {
        if (row.byte_length === null || row.byte_length === 0) continue;
        const rowId = row.row_id;

        yield* stageAndExtract(
          () => {
            trajStatements.stageStmt.run(rowId);
          },
          row.byte_length,
          (reader) => {
            extractTrajectoryMetadata(reader, trajectory);
          },
        );
      }
    }

    const steps = hasSteps ? yield* readMetaTable("steps", "metadata", extractStepMetadata) : [];

    return { generations, steps, trajectory } satisfies RawAntigravityDatabase;
  }).pipe(Effect.scoped);
});
