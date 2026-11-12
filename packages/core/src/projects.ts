import { Effect, FileSystem, Option, Path, Predicate, Result } from "effect";

import {
  type ProjectMapping,
  type ReportRequest,
  RepositoryReference,
  type UsageRecord,
} from "./model.ts";
import { type RepositoryHistoryError, repositoryHistory } from "./repository-history.ts";

const scpRemote = /^(?:[^/@\s]+@)?(\[[^\]\s]+\]|[^/:\\\s]+):((?!\/\/).+)$/;

/** Canonicalizes common HTTPS/SSH Git remotes, omitting credentials and transport-specific syntax. */
export function repositoryIdentity(remote: string): string {
  const scp = isNetworkRemote(remote) ? scpRemote.exec(remote) : null;

  if (scp?.[1] && scp[2]) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git\/?$/, "")}`;
  const parsed = URL.parse(remote);

  if (parsed !== null)
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;

  return remote.replace(/\.git\/?$/, "").replace(/\/$/, "");
}

/** A record's project, and whether the name may leave the machine. */
export interface Attribution {
  readonly project: string;
  /** False for local directories, local-path remotes, and the `Unassigned` placeholder. */
  readonly shareable: boolean;
}

// Only explicit network transports are shareable; unadorned Git paths are local.
function isNetworkRemote(remote: string): boolean {
  const value = remote.trim();

  if (/^(?:file:|[/\\~.]|[a-z]:|[a-z][a-z0-9+.-]*::)/i.test(value)) return false;
  const parsed = URL.parse(value);

  return parsed !== null && parsed.host !== ""
    ? ["http:", "https:", "ssh:", "git:", "ftp:", "ftps:"].includes(parsed.protocol)
    : scpRemote.test(value);
}

/** Creates one report-scoped resolver. Worktrees share their common Git remote or repository root. */
export const projectResolver = Effect.fn("Projects.resolver")(function* (
  mappings: readonly ProjectMapping[],
  historyConfig?: ReportRequest["repositoryHistory"],
  onWarning?: (message: string) => Effect.Effect<void>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const history = yield* repositoryHistory(historyConfig, onWarning);

  const resolved = new Map<
    string,
    { readonly root: string; readonly repository: RepositoryReference | null }
  >();

  const readOptional = (file: string) => fs.readFileString(file).pipe(Effect.option);

  const discover = Effect.fn("Projects.discover")(function* (cwd: string) {
    const cached = resolved.get(cwd);

    if (cached !== undefined) return cached;
    let current = cwd;
    let root = cwd;
    let repository: RepositoryReference | null = null;

    while (true) {
      const git = path.join(current, ".git");
      const stat = yield* fs.stat(git).pipe(Effect.result);

      if (Result.isSuccess(stat)) {
        root = current;
        let gitDirectory = git;

        if (stat.success.type === "File") {
          const pointer = yield* readOptional(git);
          const match = /^gitdir:\s*(.+)\s*$/m.exec(Option.getOrElse(pointer, () => ""));

          if (match?.[1]) gitDirectory = path.resolve(current, match[1].trim());
        }

        const common = yield* readOptional(path.join(gitDirectory, "commondir"));

        if (Option.isSome(common)) {
          gitDirectory = path.resolve(gitDirectory, common.value.trim());
          root = path.dirname(gitDirectory);
        }

        const config = yield* readOptional(path.join(gitDirectory, "config"));
        const origin = /\[remote "origin"\]([^[]*)/.exec(Option.getOrElse(config, () => ""));
        const url = /^\s*url\s*=\s*(.+)$/m.exec(origin?.[1] ?? "");

        if (url?.[1]) {
          const remote = url[1].trim();
          repository = RepositoryReference.Remote({ value: remote });
        }

        // Keep the worktree root, before commondir changed root to the main checkout.
        // A readable config also proves when an old network origin is no longer present.
        if (Option.isSome(config))
          history.remember(
            current,
            url?.[1] && isNetworkRemote(url[1].trim()) ? repositoryIdentity(url[1].trim()) : null,
          );

        break;
      }

      // A live directory without Git metadata may have been reused for unrelated work.
      // History is a fallback only for a directory that has actually disappeared.
      if (historyConfig !== undefined && Predicate.isTagged(stat.failure.reason, "NotFound")) {
        const exists = yield* fs.exists(current).pipe(Effect.option);

        if (Option.isSome(exists)) {
          const previous = yield* history.read(current);

          if (previous !== null && !exists.value) {
            root = current;
            repository =
              previous.repository === null
                ? null
                : RepositoryReference.Identity({ value: previous.repository });
            break;
          }

          if (previous !== null && previous.repository !== null) history.remember(current, null);
        }
      }

      const parent = path.dirname(current);

      if (parent === current) break;
      current = parent;
    }

    const identity = { root, repository };
    resolved.set(cwd, identity);

    return identity;
  });

  const resolve = Effect.fn("Projects.resolve")(function* (
    record: UsageRecord,
    fixedProject: string | undefined,
  ): Effect.fn.Return<Attribution, RepositoryHistoryError> {
    if (fixedProject !== undefined) return { project: fixedProject, shareable: true };
    const cwd = record.cwd;

    let bestPath: { readonly project: string; readonly length: number } | null = null;

    for (const mapping of mappings) {
      for (const prefix of mapping.paths) {
        const normalized = path.resolve(prefix);

        if (
          cwd !== null &&
          (cwd === normalized || cwd.startsWith(`${normalized}${path.sep}`)) &&
          normalized.length > (bestPath?.length ?? -1)
        ) {
          bestPath = { project: mapping.project, length: normalized.length };
        }
      }
    }

    if (bestPath !== null) return { project: bestPath.project, shareable: true };

    const identity = record.repository !== null || cwd === null ? null : yield* discover(cwd);
    const reference = record.repository ?? identity?.repository ?? null;

    const remote =
      reference === null
        ? null
        : Predicate.isTagged(reference, "Identity")
          ? reference.value
          : repositoryIdentity(reference.value);

    for (const mapping of mappings) {
      if (
        remote !== null &&
        mapping.repositories.some((entry) => repositoryIdentity(entry) === remote)
      )
        return { project: mapping.project, shareable: true };
    }

    if (reference !== null && remote !== null)
      return {
        project: remote,
        shareable:
          remote !== "" &&
          (Predicate.isTagged(reference, "Identity") || isNetworkRemote(reference.value)),
      };

    return { project: identity?.root ?? "Unassigned", shareable: false };
  });

  return { resolve, flush: history.flush };
});
