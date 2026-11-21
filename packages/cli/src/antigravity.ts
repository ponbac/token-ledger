import { Effect, FileSystem, Option, Path, type PlatformError, Predicate, Result } from "effect";

function isNotFound(error: PlatformError.PlatformError): boolean {
  return Predicate.isTagged(error.reason, "NotFound");
}

/**
 * Resolves a shell-style path against `base`, expanding `~`, `~/...`, and `~\...` to `home`.
 * Shared between CLI flags/env vars and Antigravity discovery so tilde expansion has one owner.
 */
export function expandUserPath(path: Path.Path, home: string, value: string, base: string): string {
  return path.resolve(
    base,
    value === "~"
      ? home
      : value.startsWith("~/") || value.startsWith("~\\")
        ? path.join(home, value.slice(2))
        : value,
  );
}

/**
 * Resolves `T3CODE_HOME` by trimming surrounding whitespace and falling back to `<home>/.t3`
 * when unset or blank, delegating tilde expansion and resolution to the shared `expand` callback.
 */
export function resolveT3CodeHome(
  home: string,
  envT3Home: Option.Option<string>,
  join: (...segments: string[]) => string,
  expand: (raw: string) => string,
): string {
  const trimmed = Option.map(envT3Home, (value) => value.trim()).pipe(
    Option.filter((value) => value !== ""),
  );

  return expand(Option.getOrElse(trimmed, () => join(home, ".t3")));
}

/**
 * Discovers Antigravity conversation directories from `ANTIGRAVITY_DATA_DIR` (or the standard
 * `~/.gemini/antigravity*` and `~/.config/antigravity` homes) plus T3 Code's managed ACP
 * profiles under `${T3CODE_HOME:-~/.t3}/{userdata,dev}/providers/antigravity/<hash>/antigravity-acp`.
 *
 * Absent paths (`NotFound`) and non-directory siblings (such as `.DS_Store`) are skipped. Any
 * other access error (such as `EACCES`) is preserved as a returned path so the Ledger reports
 * `failed` coverage rather than silently dropping unreadable history and replacing server data.
 */
export const antigravitySources = Effect.fn("Antigravity.discover")(function* (
  home: string,
  envDataDir: Option.Option<string>,
  envT3Home: Option.Option<string>,
  expand: (raw: string) => string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const t3Home = resolveT3CodeHome(home, envT3Home, (...parts) => path.join(...parts), expand);

  const configured = Option.match(envDataDir, {
    onNone: (): readonly string[] => [],
    onSome: (raw) =>
      raw
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
        .map((entry) => path.resolve(expand(entry))),
  });

  const defaultRoots: string[] = [];
  const preservedErrors: string[] = [];

  if (configured.length === 0) {
    const geminiDir = path.join(home, ".gemini");
    const listedGemini = yield* fs.readDirectory(geminiDir).pipe(Effect.result);

    if (Result.isFailure(listedGemini)) {
      if (!isNotFound(listedGemini.failure)) preservedErrors.push(geminiDir);
    } else {
      for (const child of listedGemini.success.toSorted()) {
        if (!child.startsWith("antigravity")) continue;
        const childPath = path.join(geminiDir, child);
        const stat = yield* fs.stat(childPath).pipe(Effect.result);

        if (Result.isFailure(stat)) {
          if (!isNotFound(stat.failure)) preservedErrors.push(childPath);
          continue;
        }

        if (stat.success.type === "Directory") defaultRoots.push(childPath);
      }
    }

    defaultRoots.push(path.join(home, ".config", "antigravity"));
  }

  for (const state of ["userdata", "dev"] as const) {
    const parent = path.join(t3Home, state, "providers", "antigravity");
    const listed = yield* fs.readDirectory(parent).pipe(Effect.result);

    if (Result.isFailure(listed)) {
      if (!isNotFound(listed.failure)) preservedErrors.push(parent);
      continue;
    }

    for (const child of listed.success.toSorted()) {
      const childPath = path.join(parent, child);
      const stat = yield* fs.stat(childPath).pipe(Effect.result);

      if (Result.isFailure(stat)) {
        if (!isNotFound(stat.failure)) preservedErrors.push(childPath);
        continue;
      }

      if (stat.success.type === "Directory")
        defaultRoots.push(path.join(childPath, "antigravity-acp"));
    }
  }

  const found: string[] = [];

  const inspectRoot = Effect.fn("Antigravity.inspectRoot")(function* (
    root: string,
    allowDirectRoot: boolean,
  ) {
    const conversations = path.join(root, "conversations");
    const nested = yield* fs.stat(conversations).pipe(Effect.result);

    if (Result.isSuccess(nested) && nested.success.type === "Directory") {
      found.push(conversations);

      return;
    }

    if (Result.isFailure(nested) && !isNotFound(nested.failure)) {
      const rootStat = yield* fs.stat(root).pipe(Effect.result);

      if (Result.isSuccess(rootStat) && rootStat.success.type !== "Directory") {
        if (allowDirectRoot) found.push(root);

        return;
      }

      preservedErrors.push(conversations);

      return;
    }

    if (!allowDirectRoot) return;

    const rootStat = yield* fs.stat(root).pipe(Effect.result);

    if (Result.isSuccess(rootStat) || isNotFound(rootStat.failure)) found.push(root);
    else preservedErrors.push(root);
  });

  for (const root of configured) yield* inspectRoot(root, true);

  for (const root of defaultRoots) yield* inspectRoot(root, false);

  const unique: string[] = [];
  const seen = new Set<string>();

  for (const candidate of [...found, ...preservedErrors]) {
    const key = yield* fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate));

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(candidate);
  }

  return unique.length > 0
    ? unique
    : [path.join(home, ".gemini", "antigravity-cli", "conversations")];
});
