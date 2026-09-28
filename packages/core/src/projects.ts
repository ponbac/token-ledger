import { Effect, FileSystem, Option, Path } from "effect";

import type { ProjectMapping, UsageRecord } from "./model.ts";

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
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = new Map<string, { readonly root: string; readonly remote: string | null }>();
  const readOptional = (file: string) => fs.readFileString(file).pipe(Effect.option);

  const discover = Effect.fn("Projects.discover")(function* (cwd: string) {
    const cached = resolved.get(cwd);

    if (cached !== undefined) return cached;
    let current = cwd;
    let root = cwd;
    let remote: string | null = null;

    while (true) {
      const git = path.join(current, ".git");
      const stat = yield* fs.stat(git).pipe(Effect.option);

      if (Option.isSome(stat)) {
        root = current;
        let gitDirectory = git;

        if (stat.value.type === "File") {
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

        if (url?.[1]) remote = url[1].trim();
        break;
      }

      const parent = path.dirname(current);

      if (parent === current) break;
      current = parent;
    }

    const identity = { root, remote };
    resolved.set(cwd, identity);

    return identity;
  });

  return Effect.fn("Projects.resolve")(function* (
    record: UsageRecord,
    fixedProject: string | undefined,
  ): Effect.fn.Return<Attribution> {
    if (fixedProject !== undefined) return { project: fixedProject, shareable: true };
    const cwd = record.cwd;
    const identity = cwd === null ? null : yield* discover(cwd);

    const rawRemote = record.repository?.value ?? identity?.remote ?? null;
    const remote = rawRemote === null ? null : repositoryIdentity(rawRemote);

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

    for (const mapping of mappings) {
      if (
        remote !== null &&
        mapping.repositories.some((entry) => repositoryIdentity(entry) === remote)
      )
        return { project: mapping.project, shareable: true };
    }

    if (rawRemote !== null && remote !== null)
      return {
        project: remote,
        shareable:
          remote !== "" && (record.repository?._tag === "Identity" || isNetworkRemote(rawRemote)),
      };

    return { project: identity?.root ?? "Unassigned", shareable: false };
  });
});
