import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, PlatformError } from "effect";

import { antigravitySources, expandUserPath } from "./antigravity.ts";

function denyAccess(fs: FileSystem.FileSystem, denied: readonly string[]): FileSystem.FileSystem {
  const isDenied = (target: string) =>
    denied.some((prefix) => target === prefix || target.startsWith(`${prefix}/`));

  const permissionDenied = (method: string, target: string) =>
    Effect.fail(
      PlatformError.badArgument({
        module: "FileSystem",
        method,
        description: `fixture: permission denied (${target})`,
      }),
    );

  return FileSystem.make({
    ...fs,
    stat: (target) => (isDenied(target) ? permissionDenied("stat", target) : fs.stat(target)),
    readDirectory: (target, options) =>
      isDenied(target)
        ? permissionDenied("readDirectory", target)
        : fs.readDirectory(target, options),
  });
}

describe("Antigravity source discovery", () => {
  it.effect(
    "discovers ~/.gemini/antigravity* and T3 ACP profiles, skips non-directory siblings, and preserves unreadable directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "ag-discover-" });
        const home = path.join(root, "home");
        const t3Home = path.join(home, ".t3");

        const expand = (raw: string) => expandUserPath(path, home, raw, root);

        // Empty machine falls back to a single missing default path.
        const none = yield* antigravitySources(home, Option.none(), Option.none(), expand);
        assert.deepStrictEqual(none, [
          path.join(home, ".gemini", "antigravity-cli", "conversations"),
        ]);

        // Create standalone CLI + preview + dot-suffixed backup homes + T3 ACP profile + sibling regular file.
        const standaloneConversations = path.join(
          home,
          ".gemini",
          "antigravity-cli",
          "conversations",
        );

        const previewConversations = path.join(
          home,
          ".gemini",
          "antigravity-preview",
          "conversations",
        );

        const dotBackupConversations = path.join(
          home,
          ".gemini",
          "antigravity.backup",
          "conversations",
        );

        const profileConversations = path.join(
          t3Home,
          "userdata",
          "providers",
          "antigravity",
          "abc123",
          "antigravity-acp",
          "conversations",
        );

        yield* fs.makeDirectory(standaloneConversations, { recursive: true });
        yield* fs.makeDirectory(previewConversations, { recursive: true });
        yield* fs.makeDirectory(dotBackupConversations, { recursive: true });
        yield* fs.makeDirectory(profileConversations, { recursive: true });
        yield* fs.writeFileString(
          path.join(t3Home, "userdata", "providers", "antigravity", ".DS_Store"),
          "junk",
        );

        // Default homes without a `conversations/` store (e.g. skills-only `~/.gemini/antigravity`
        // with a dangling symlink, or `~/.config/antigravity` with credentials) are skipped.
        const skillsOnly = path.join(home, ".gemini", "antigravity", "global_skills");
        yield* fs.makeDirectory(skillsOnly, { recursive: true });
        yield* fs.symlink(path.join(root, "missing-target"), path.join(skillsOnly, "broken"));
        const configOnly = path.join(home, ".config", "antigravity");
        yield* fs.makeDirectory(configOnly, { recursive: true });
        yield* fs.writeFileString(path.join(configOnly, "credential-user-scope"), "token");

        // Padded and blank T3CODE_HOME values match T3 Code's trim + ~/.t3 fallback semantics.
        const discovered = yield* antigravitySources(
          home,
          Option.none(),
          Option.some(`  ${t3Home}  `),
          expand,
        );

        assert.deepStrictEqual(discovered, [
          standaloneConversations,
          previewConversations,
          dotBackupConversations,
          profileConversations,
        ]);

        const blankT3Home = yield* antigravitySources(
          home,
          Option.none(),
          Option.some("   "),
          expand,
        );

        assert.deepStrictEqual(blankT3Home, discovered);

        // `T3CODE_HOME="~"` and `T3CODE_HOME="~\\custom-t3"` use the single shared `expandUserPath`.
        const tildeRootProfile = path.join(
          home,
          "userdata",
          "providers",
          "antigravity",
          "tilde1",
          "antigravity-acp",
          "conversations",
        );

        const tildeSubProfile = path.join(
          home,
          "custom-t3",
          "userdata",
          "providers",
          "antigravity",
          "tilde2",
          "antigravity-acp",
          "conversations",
        );

        yield* fs.makeDirectory(tildeRootProfile, { recursive: true });
        yield* fs.makeDirectory(tildeSubProfile, { recursive: true });

        const tildeOnly = yield* antigravitySources(home, Option.none(), Option.some("~"), expand);

        assert.include(tildeOnly, tildeRootProfile);
        assert.notInclude(tildeOnly, profileConversations);

        const tildeBackslash = yield* antigravitySources(
          home,
          Option.none(),
          Option.some("~\\custom-t3"),
          expand,
        );

        assert.include(tildeBackslash, tildeSubProfile);
        assert.notInclude(tildeBackslash, profileConversations);

        // Inaccessible homes and T3 profile directories are preserved (never silently dropped).
        const lockedHome = path.join(home, ".gemini", "antigravity-ide");
        yield* fs.makeDirectory(lockedHome, { recursive: true });
        const lockedParent = path.join(t3Home, "dev", "providers", "antigravity");
        yield* fs.makeDirectory(lockedParent, { recursive: true });

        const withLocked = yield* antigravitySources(
          home,
          Option.none(),
          Option.some(t3Home),
          expand,
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, denyAccess(fs, [lockedHome, lockedParent])),
        );

        assert.include(withLocked, standaloneConversations);
        assert.include(withLocked, previewConversations);
        assert.include(withLocked, dotBackupConversations);
        assert.include(withLocked, profileConversations);
        assert.include(withLocked, lockedHome);
        assert.include(withLocked, lockedParent);

        // An unreadable `~/.gemini` parent is also preserved rather than dropped.
        const geminiParent = path.join(home, ".gemini");

        const withLockedGemini = yield* antigravitySources(
          home,
          Option.none(),
          Option.some(t3Home),
          expand,
        ).pipe(Effect.provideService(FileSystem.FileSystem, denyAccess(fs, [geminiParent])));

        assert.include(withLockedGemini, geminiParent);
        assert.include(withLockedGemini, profileConversations);

        // ANTIGRAVITY_DATA_DIR overrides standalone defaults while still scanning T3 profiles.
        const customRoot = path.join(root, "custom-ag");
        yield* fs.makeDirectory(customRoot, { recursive: true });

        const overridden = yield* antigravitySources(
          home,
          Option.some(customRoot),
          Option.some(t3Home),
          expand,
        );

        assert.deepStrictEqual(overridden, [customRoot, profileConversations]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
