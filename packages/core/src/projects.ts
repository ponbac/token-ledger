import { Effect, FileSystem, Option, Path } from "effect";

import type { ProjectMapping, UsageRecord } from "./model.ts";

/** Canonicalizes common HTTPS/SSH Git remotes, omitting credentials and transport-specific syntax. */
export function repositoryIdentity(remote: string): string {
  const scp = /^[^/@\s]+@([^/:\s]+):(.+)$/.exec(remote);

  if (scp?.[1] && scp[2]) return `${scp[1].toLowerCase()}/${scp[2].replace(/\.git\/?$/, "")}`;
  const parsed = URL.parse(remote);

  if (parsed !== null)
    return `${parsed.host.toLowerCase()}${parsed.pathname.replace(/\.git\/?$/, "").replace(/\/$/, "")}`;

  return remote.replace(/\.git\/?$/, "").replace(/\/$/, "");
}

/** Creates one report-scoped resolver. Worktrees share their common Git remote or repository root. */
export const projectResolver = Effect.fn("Projects.resolver")(function* (
  mappings: readonly ProjectMapping[],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = new Map<string, { readonly root: string; readonly repository: string | null }>();
  const readOptional = (file: string) => fs.readFileString(file).pipe(Effect.option);

  const discover = Effect.fn("Projects.discover")(function* (cwd: string) {
    const cached = resolved.get(cwd);

    if (cached !== undefined) return cached;
    let current = cwd;
    let root = cwd;
    let repository: string | null = null;

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

        if (url?.[1]) repository = repositoryIdentity(url[1].trim());
        break;
      }

      const parent = path.dirname(current);

      if (parent === current) break;
      current = parent;
    }

    const identity = { root, repository };
    resolved.set(cwd, identity);

    return identity;
  });

  return Effect.fn("Projects.resolve")(function* (
    record: UsageRecord,
    fixedProject: string | undefined,
  ) {
    if (fixedProject !== undefined) return fixedProject;
    const cwd = record.cwd;
    const identity = cwd === null ? null : yield* discover(cwd);

    const remote =
      record.repository === null
        ? (identity?.repository ?? null)
        : repositoryIdentity(record.repository);

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

    if (bestPath !== null) return bestPath.project;

    for (const mapping of mappings) {
      if (
        remote !== null &&
        mapping.repositories.some((entry) => repositoryIdentity(entry) === remote)
      )
        return mapping.project;
    }

    return remote ?? identity?.root ?? "Unassigned";
  });
});
