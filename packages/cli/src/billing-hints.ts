import { posix, win32 } from "node:path";

import { Config, Effect, Match, Option, Path } from "effect";

/** Preserve an absolute XDG data root when installing a scheduled sync. */
export const dataHome = Effect.gen(function* () {
  const path = yield* Path.Path;

  return yield* Config.String("XDG_DATA_HOME").pipe(
    Config.option,
    Effect.map(Option.filter((directory) => path.isAbsolute(directory))),
  );
});

/** The proxy's conventional per-user directory, independent of roaming CLI settings. */
export function billingHintsDirectory(
  platform: NodeJS.Platform,
  home: string,
  localAppData: Option.Option<string>,
  xdgDataHome: Option.Option<string>,
): string {
  const path = platform === "win32" ? win32 : posix;

  const root = Match.value(platform).pipe(
    Match.when("win32", () =>
      Option.getOrElse(
        Option.filter(localAppData, (directory) => path.isAbsolute(directory)),
        () => path.join(home, "AppData", "Local"),
      ),
    ),
    Match.when("darwin", () => path.join(home, "Library", "Application Support")),
    Match.orElse(() => Option.getOrElse(xdgDataHome, () => path.join(home, ".local", "share"))),
  );

  return path.join(root, "token-ledger", "billing-hints");
}
