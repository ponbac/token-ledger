import { Data, Effect, FileSystem, Match, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type Membership, type Property, setProperties } from "./jsonc.ts";
import { posixWord, powershellArguments, powershellString } from "./schedule.ts";

/** Copilot's export cannot be enabled at all; partial failures are `ByHand` steps instead. */
export class CopilotError extends Schema.TaggedError<CopilotError>()("CopilotError", {
  message: Schema.String,
}) {}

/** The variable whose file path switches on Copilot CLI's export. */
const variable = "COPILOT_OTEL_FILE_EXPORTER_PATH";

const marker = "# Added by token-ledger copilot enable: Copilot CLI records its usage here.";

/** VS Code 1.139.1 writes spans as empty lines, so its export names no repository. */
const affectedVersion = "1.139.1";

/** VS Code builds configured when present, each with its own file so they never share one. */
const builds = [
  { name: "VS Code", folder: "Code", file: "vscode-chat.jsonl" },
  { name: "VS Code Insiders", folder: "Code - Insiders", file: "vscode-insiders-chat.jsonl" },
] as const;

/** Whether `file` is `directory` or lies below it. */
function within(path: Path.Path, directory: string, file: string) {
  const relative = path.relative(directory, file);

  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * The default Copilot sources. The export directory is read whole, so a file Copilot CLI is
 * told to write inside it never hides a VS Code export beside it. That file is named as well
 * when a directory scan, which takes only `.jsonl` and `.db` files, would pass over it. A file
 * outside the directory is a deliberate choice of that one export, and is read alone.
 */
export function copilotSources(
  path: Path.Path,
  directory: string,
  exporter: Option.Option<string>,
): ReadonlyArray<string> {
  if (Option.isNone(exporter)) return [directory];

  if (!within(path, directory, exporter.value)) return [exporter.value];

  return /\.(?:jsonl|db)$/.test(exporter.value) || path.relative(directory, exporter.value) === ""
    ? [directory]
    : [directory, exporter.value];
}

/** The machine and account `copilot enable` changes. Every path is absolute. */
export interface Host {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  /** The POSIX user ID; absent on Windows. */
  readonly uid: Option.Option<number>;
  /** `COPILOT_HOME`, or `~/.copilot`. */
  readonly copilotHome: string;
  /** The login shell, from `SHELL`. */
  readonly shell: Option.Option<string>;
  /** `ZDOTDIR`, where zsh looks for `.zshrc` instead of the home directory. */
  readonly zshDirectory: Option.Option<string>;
  /** `XDG_CONFIG_HOME`. */
  readonly configHome: Option.Option<string>;
  /** `%APPDATA%`. */
  readonly appData: Option.Option<string>;
  /** The file `COPILOT_OTEL_FILE_EXPORTER_PATH` names in this process's environment. */
  readonly exporter: Option.Option<string>;
}

/** Which exports to switch on. */
export interface Enablement {
  readonly cli: boolean;
  readonly vscode: boolean;
  /** Proceed as root, for a container where root is the account that runs Copilot. */
  readonly allowRoot: boolean;
}

/** What a step belongs to: the shared export folder, Copilot CLI, or VS Code Copilot Chat. */
type Part = "folder" | "cli" | "vscode";

type Action = Data.TaggedEnum<{
  MakeDirectory: { readonly directory: string };
  /** Replaces `file`, provided it still reads as `original`; `None` means it must not exist. */
  Write: {
    readonly file: string;
    readonly contents: string;
    readonly original: Option.Option<string>;
  };
  Run: { readonly program: string; readonly args: ReadonlyArray<string> };
}>;

const Action = Data.taggedEnum<Action>();

/**
 * One line of the plan or of its result. A `Change` is carried out once confirmed and becomes
 * `Done`, or `ByHand` when it fails; `byHand` is what the person then adds themselves. `Kept`
 * is already as wanted. `ByHand` is a part this command cannot do, with the reason and the
 * exact text to add. `Note` is a warning that changes nothing.
 */
export type Step = Data.TaggedEnum<{
  Kept: { readonly part: Part; readonly summary: string };
  Change: {
    readonly part: Part;
    readonly summary: string;
    readonly detail: ReadonlyArray<string>;
    readonly action: Action;
    readonly byHand: string;
  };
  Done: { readonly part: Part; readonly summary: string };
  ByHand: { readonly part: Part; readonly reason: string; readonly instructions: string };
  Note: { readonly part: Part; readonly text: string };
}>;

export const Step = Data.taggedEnum<Step>();

const indented = (text: string, width: number) => text.replaceAll(/^(?=.)/gm, " ".repeat(width));

/**
 * The value a shell assignment gives, for the plain forms a person writes by hand: a bare
 * word, or one quoted string, with `$HOME`, `${HOME}`, and a leading `~/` expanded. `None`
 * for anything that would need a shell to evaluate.
 */
function assignedValue(assigned: string, home: string): Option.Option<string> {
  const text = assigned.trim();
  const single = /^'([^']*)'$/.exec(text);

  if (single !== null) return Option.fromUndefinedOr(single[1]);

  const double = /^"([^"\\`]*)"$/.exec(text)?.[1];
  // Only an unquoted `~/` is the home directory.
  const bare = /^([^\s"'`\\;&|<>()#]+)$/.exec(text)?.[1]?.replace(/^~(?=\/)/, () => home);
  const expanding = double ?? bare;

  if (expanding === undefined) return Option.none();

  const expanded = expanding.replaceAll(/\$HOME\b|\$\{HOME\}/g, () => home);

  return expanded.includes("$") ? Option.none() : Option.some(expanded);
}

/** A change a shell startup file needs so that new shells export the variable. */
export type StartupEdit = Data.TaggedEnum<{
  Append: { readonly text: string };
  /** A line this command wrote earlier points elsewhere; `contents` corrects it. */
  Replace: { readonly contents: string };
  /** The person's own line sets the variable to something else, and is left alone. */
  Conflict: { readonly line: number; readonly text: string };
}>;

export const StartupEdit = Data.taggedEnum<StartupEdit>();

/**
 * Whether a bash or zsh line exports the variable as the file `target`. An assignment without
 * `export` does not count: the variable would never reach Copilot.
 */
export const exportsTo = (target: string, home: string) => (line: string) =>
  Option.contains(
    Option.flatMap(
      Option.fromUndefinedOr(new RegExp(`^\\s*export\\s+${variable}=(.*)$`).exec(line)?.[1]),
      (assigned) => assignedValue(assigned, home),
    ),
    target,
  );

/**
 * Compares a startup file with the `wanted` line; `None` when the file already does the job.
 * Only the last line that mentions the variable counts, as it does in a shell, and `satisfies`
 * says whether that line exports the variable as wanted.
 */
export function startupEdit(
  contents: string,
  wanted: string,
  satisfies: (line: string) => boolean,
): Option.Option<StartupEdit> {
  const lines = contents.split("\n");

  const index = lines.findLastIndex((line) => !/^\s*#/.test(line) && line.includes(variable));

  const current = lines[index];

  if (current === undefined) {
    const lead = contents === "" ? "" : contents.endsWith("\n") ? "\n" : "\n\n";

    return Option.some(StartupEdit.Append({ text: `${lead}${marker}\n${wanted}\n` }));
  }

  if (current === wanted || satisfies(current)) return Option.none();

  return Option.some(
    lines[index - 1] === marker
      ? StartupEdit.Replace({ contents: lines.with(index, wanted).join("\n") })
      : StartupEdit.Conflict({ line: index + 1, text: current.trim() }),
  );
}

/** `file` as a shell word, through `$HOME` when that needs no further quoting. */
function homeWord(path: Path.Path, host: Host, file: string, quoted: (value: string) => string) {
  const relative = path.relative(host.home, file);

  return /^(?!\.\.)[\w@+=:,./-]+$/.test(relative) && !path.isAbsolute(relative)
    ? `"$HOME/${relative}"`
    : quoted(file);
}

const fishWord = (value: string) =>
  /^[\w@+=:,./-]+$/.test(value)
    ? value
    : `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;

/** A file's text, or `None` when it does not exist; any other failure is an error. */
const readOptional = Effect.fn("Copilot.readOptional")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;

  return yield* fs.readFileString(file).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<string>())),
  );
});

/** The startup file bash reads in a new terminal: a login shell on macOS, `.bashrc` elsewhere. */
const bashStartup = Effect.fn("Copilot.bashStartup")(function* (host: Host) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (host.platform !== "darwin") return path.join(host.home, ".bashrc");

  // A login bash reads only the first of these that exists.
  for (const name of [".bash_profile", ".bash_login", ".profile"]) {
    const file = path.join(host.home, name);

    if (yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
  }

  return path.join(host.home, ".bash_profile");
});

/** A shell's startup file, the line that exports the variable there, and how to recognise it. */
interface Startup {
  readonly file: string;
  readonly line: string;
  readonly satisfies: (line: string) => boolean;
  /** Other files the shell reads at startup, where the person may set the variable themselves. */
  readonly others: ReadonlyArray<string>;
}

/** Steps that make new bash, zsh, or fish terminals export the variable as `target`. */
const startupSteps = Effect.fn("Copilot.startupSteps")(function* (host: Host, target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const shell = Option.match(host.shell, {
    onNone: () => "",
    onSome: (file) => path.basename(file),
  });

  const exported = `export ${variable}=${homeWord(path, host, target, posixWord)}`;

  const posix = (file: string): Startup => ({
    file,
    line: exported,
    satisfies: exportsTo(target, host.home),
    others: [],
  });

  const startup = yield* Match.value(shell).pipe(
    Match.when("zsh", () =>
      Effect.succeed(
        Option.some(
          posix(
            path.join(
              Option.getOrElse(host.zshDirectory, () => host.home),
              ".zshrc",
            ),
          ),
        ),
      ),
    ),
    Match.when("bash", () => Effect.map(bashStartup(host), (file) => Option.some(posix(file)))),
    Match.when("fish", () => {
      const directory = path.join(
        Option.getOrElse(host.configHome, () => path.join(host.home, ".config")),
        "fish",
      );

      const line = `set -gx ${variable} ${homeWord(path, host, target, fishWord)}`;

      const snippets = path.join(directory, "conf.d");
      const file = path.join(snippets, "token-ledger-copilot.fish");

      // A file of its own in conf.d. Fish reads those in name order and then config.fish, so
      // the person's own line in any of them either overrides this one or is overridden by it.
      return fs.readDirectory(snippets).pipe(
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
        Effect.map((names) =>
          Option.some<Startup>({
            file,
            line,
            satisfies: (text) => text.trim() === line,
            others: [
              ...names
                .toSorted((a, b) => a.localeCompare(b))
                .flatMap((name) =>
                  name.endsWith(".fish") && path.join(snippets, name) !== file
                    ? [path.join(snippets, name)]
                    : [],
                ),
              path.join(directory, "config.fish"),
            ],
          }),
        ),
      );
    }),
    Match.orElse(() => Effect.succeed(Option.none<Startup>())),
  );

  if (Option.isNone(startup))
    return [
      Step.ByHand({
        part: "cli",
        reason:
          shell === ""
            ? "SHELL is not set, so there is no startup file to choose."
            : `${shell} is not a shell this command sets up; it knows bash, zsh, and fish.`,
        instructions: `Add the equivalent of this line to your shell's startup file:\n${indented(exported, 4)}`,
      }),
    ];

  const { file, line, satisfies, others } = startup.value;
  const byHand = `Add this line to ${file}:\n${indented(line, 4)}`;

  const conflict = (where: string, found: string) =>
    Step.ByHand({
      part: "cli",
      reason: `${where}, and was left alone:\n${indented(found, 4)}`,
      instructions: `To record Copilot CLI usage where token-ledger reads it, change that line to:\n${indented(line, 4)}`,
    });

  const read = yield* Effect.all([
    readOptional(file),
    Effect.forEach(others, (other) =>
      Effect.map(readOptional(other), (text) => ({
        other,
        found: Option.getOrElse(text, () => "")
          .split("\n")
          .find((entry) => !/^\s*#/.test(entry) && entry.includes(variable)),
      })),
    ),
  ]).pipe(Effect.option);

  if (Option.isNone(read))
    return [Step.ByHand({ part: "cli", reason: `Cannot read ${file}.`, instructions: byHand })];

  const [original, mentions] = read.value;

  for (const { other, found } of mentions)
    if (found !== undefined) return [conflict(`${other} already sets ${variable}`, found.trim())];

  const existing = Option.getOrElse(original, () => "");

  return [
    Option.match(startupEdit(existing, line, satisfies), {
      onNone: () => Step.Kept({ part: "cli", summary: `${file} already exports ${variable}.` }),
      onSome: StartupEdit.$match({
        Append: ({ text }) =>
          Step.Change({
            part: "cli",
            summary: `${Option.isSome(original) ? "add to the end of" : "create"} ${file}`,
            detail: [marker, line],
            action: Action.Write({ file, contents: `${existing}${text}`, original }),
            byHand,
          }),
        Replace: ({ contents }) =>
          Step.Change({
            part: "cli",
            summary: `correct the line this command added to ${file}`,
            detail: [line],
            action: Action.Write({ file, contents, original }),
            byHand,
          }),
        Conflict: ({ line: number, text }) =>
          conflict(`${file} already sets ${variable} on line ${number}`, text),
      }),
    }),
  ];
});

/** Steps that set the Windows user environment variable, which every new terminal inherits. */
const userVariableSteps = Effect.fn("Copilot.userVariableSteps")(function* (target: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const assignment = `[Environment]::SetEnvironmentVariable(${powershellString(variable)}, ${powershellString(target)}, 'User')`;
  const byHand = `Run this in PowerShell:\n${indented(assignment, 4)}`;

  // Base64 keeps a non-ASCII path intact whatever code page PowerShell writes its output in.
  const current = yield* spawner
    .string(
      ChildProcess.make(
        "powershell.exe",
        powershellArguments(
          `[Console]::Out.Write('value=' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string][Environment]::GetEnvironmentVariable(${powershellString(variable)}, 'User'))))`,
        ),
        { stdin: "ignore", stderr: "ignore" },
      ),
    )
    .pipe(
      Effect.map((output) => /^value=([A-Za-z0-9+/=]*)\s*$/.exec(output)?.[1]),
      Effect.map(Option.fromUndefinedOr),
      Effect.orElseSucceed(() => Option.none<string>()),
      Effect.map(Option.map((encoded) => Buffer.from(encoded, "base64").toString("utf8"))),
    );

  if (Option.isNone(current))
    return [
      Step.ByHand({
        part: "cli",
        reason: `Cannot read the user environment variable ${variable} through PowerShell.`,
        instructions: byHand,
      }),
    ];

  const comparable = (file: string) => file.replaceAll("/", "\\").toLowerCase();

  return [
    comparable(current.value) === comparable(target)
      ? Step.Kept({
          part: "cli",
          summary: `The user environment variable ${variable} is already set.`,
        })
      : Step.Change({
          part: "cli",
          summary: `set the user environment variable ${variable}`,
          detail: [current.value === "" ? target : `${target} (now ${current.value})`],
          action: Action.Run({
            program: "powershell.exe",
            args: powershellArguments(
              [
                "$ErrorActionPreference = 'Stop'",
                "$ProgressPreference = 'SilentlyContinue'",
                assignment,
              ].join("\n"),
            ),
          }),
          byHand,
        }),
  ];
});

/** The version a `code` command reports, when one is installed where it can be found. */
const installedVersion = Effect.fn("Copilot.installedVersion")(function* (host: Host) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const commands =
    host.platform === "win32"
      ? [ChildProcess.make("cmd.exe", ["/d", "/s", "/c", "code --version"])]
      : [
          "code",
          ...(host.platform === "darwin"
            ? ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"]
            : []),
        ].map((program) => ChildProcess.make(program, ["--version"]));

  for (const command of commands) {
    const version = yield* spawner.lines(command).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.map(Option.flatMap((lines) => Option.fromUndefinedOr(lines[0]))),
      Effect.map(Option.filter((line) => /^\d+\.\d+\.\d+$/.test(line))),
      Effect.orElseSucceed(() => Option.none<string>()),
    );

    if (Option.isSome(version)) return version;
  }

  return Option.none<string>();
});

/** Steps that set the export settings in each installed VS Code build's user settings. */
const settingsSteps = Effect.fn("Copilot.settingsSteps")(function* (host: Host, directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  // Where each platform's VS Code keeps its user data; only Linux follows XDG_CONFIG_HOME.
  const root = Match.value(host.platform).pipe(
    Match.when("win32", () =>
      Option.getOrElse(host.appData, () => path.join(host.home, "AppData", "Roaming")),
    ),
    Match.when("darwin", () => path.join(host.home, "Library", "Application Support")),
    Match.orElse(() => Option.getOrElse(host.configHome, () => path.join(host.home, ".config"))),
  );

  // VS Code takes forward slashes on every platform, and JSON needs no escapes for them.
  const properties = (file: string): ReadonlyArray<Property> => [
    ["github.copilot.chat.otel.enabled", true],
    ["github.copilot.chat.otel.exporterType", "file"],
    ["github.copilot.chat.otel.outfile", path.join(directory, file).replaceAll("\\", "/")],
    ["github.copilot.chat.otel.captureContent", false],
  ];

  // The path belongs to this machine. Settings Sync would copy it to the person's other
  // machines, where it names nothing, so VS Code is told to leave that one setting out.
  const unsynced: ReadonlyArray<Membership> = [
    ["settingsSync.ignoredSettings", "github.copilot.chat.otel.outfile"],
  ];

  const unsyncing = unsynced.map(
    ([key, item]) =>
      `add ${JSON.stringify(item)} to the ${JSON.stringify(key)} list, so that Settings Sync does not copy this machine's path to your other machines`,
  );

  // Every line ends with a comma, which is valid whether or not other settings follow.
  const byHand = (lines: ReadonlyArray<string>, lists: ReadonlyArray<string>) =>
    [
      ...(lines.length === 0
        ? []
        : [
            `In VS Code, run "Preferences: Open User Settings (JSON)" from the Command Palette. Give each of these settings the value shown: change its line if the setting is already there, and paste the others on a new line right after the opening {\n${indented(
              lines.map((line) => `${line},`).join("\n"),
              4,
            )}`,
          ]),
      ...lists.map((list) => `In the same file, ${list}.`),
    ].join("\n");

  const every = (file: string) =>
    byHand(
      properties(file).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`),
      unsyncing,
    );

  const steps: Step[] = [];

  for (const build of builds) {
    const user = path.join(root, build.folder, "User");
    const file = path.join(user, "settings.json");

    if (!(yield* fs.exists(user).pipe(Effect.orElseSucceed(() => false)))) continue;

    const original = yield* readOptional(file).pipe(Effect.option);

    if (Option.isNone(original)) {
      steps.push(
        Step.ByHand({
          part: "vscode",
          reason: `Cannot read ${file}.`,
          instructions: every(build.file),
        }),
      );
      continue;
    }

    steps.push(
      Option.match(
        setProperties(
          Option.getOrElse(original.value, () => ""),
          properties(build.file),
          unsynced,
        ),
        {
          onNone: () =>
            Step.ByHand({
              part: "vscode",
              reason: `${file} has a syntax error, repeats one of these settings, or holds one in a form this command does not expect, so it was left alone.`,
              instructions: `Repair it first: VS Code marks what is wrong, and a repeated setting should be there once. Then run this command again, or finish by hand.\n${every(build.file)}`,
            }),
          onSome: ({ text, changes, included }) =>
            changes.length === 0 && included.length === 0
              ? Step.Kept({ part: "vscode", summary: `${file} already has the export settings.` })
              : Step.Change({
                  part: "vscode",
                  summary: `${Option.isSome(original.value) ? "edit" : "create"} ${file}`,
                  detail: [
                    ...changes.map(
                      ({ key, value, previous }) =>
                        `${JSON.stringify(key)}: ${value}${Option.match(previous, {
                          onNone: () => "",
                          onSome: (was) => ` (now ${was})`,
                        })}`,
                    ),
                    ...(included.length === 0 ? [] : unsyncing),
                  ],
                  action: Action.Write({ file, contents: text, original: original.value }),
                  byHand: byHand(
                    changes.map(({ key, value }) => `${JSON.stringify(key)}: ${value}`),
                    included.length === 0 ? [] : unsyncing,
                  ),
                }),
        },
      ),
    );
  }

  if (steps.length === 0)
    return [
      Step.ByHand({
        part: "vscode",
        reason: `No VS Code settings folder at ${path.join(root, builds[0].folder, "User")}.`,
        instructions: every(builds[0].file),
      }),
    ];

  if (Option.contains(yield* installedVersion(host), affectedVersion))
    steps.push(
      Step.Note({
        part: "vscode",
        text: `VS Code ${affectedVersion} is installed. Its file export leaves out the repository, so Chat usage is counted but stays Unassigned. Update VS Code, or see "Workaround for VS Code's file exporter bug" in the token-ledger README.`,
      }),
    );

  return steps;
});

/**
 * Works out what enabling Copilot's export takes on `host`, reading but changing nothing, and
 * names the export `directory` the steps fill.
 * Fails with `CopilotError` as root: the folder and files would belong to root, and neither
 * Copilot nor VS Code could then write them.
 */
export const plan = Effect.fn("Copilot.plan")(function* (host: Host, wanted: Enablement) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (Option.contains(host.uid, 0) && !wanted.allowRoot)
    return yield* new CopilotError({
      message:
        "Run this as yourself, without sudo. As root, the export folder, your shell startup file, and VS Code's settings would end up owned by root, and Copilot and VS Code could no longer write them. Nothing here needs admin rights. If root really is the account that runs Copilot, as in some containers, add --allow-root.",
    });

  const directory = path.join(host.copilotHome, "otel");
  const target = path.join(directory, "usage.jsonl");

  const existing = yield* fs.stat(directory).pipe(
    Effect.map((info) => Option.some(info.type)),
    Effect.orElseSucceed(() => Option.none<FileSystem.File.Type>()),
  );

  if (Option.isSome(existing) && existing.value !== "Directory")
    return yield* new CopilotError({
      message: `${directory} exists but is not a folder, so Copilot cannot write its export there. Move it away, then run this again.`,
    });

  const steps = [
    ...(Option.isSome(existing)
      ? []
      : [
          Step.Change({
            part: "folder",
            summary: `create the folder ${directory}`,
            detail: [],
            action: Action.MakeDirectory({ directory }),
            byHand: "",
          }),
        ]),
    ...(wanted.cli
      ? yield* host.platform === "win32" ? userVariableSteps(target) : startupSteps(host, target)
      : []),
    ...(wanted.vscode ? yield* settingsSteps(host, directory) : []),
  ];

  // A variable pointing elsewhere is read alone, which hides everything in the folder. A
  // startup file only changes new terminals, so this one keeps reading that file either way.
  const elsewhere = Option.filter(host.exporter, (file) => !within(path, directory, file));

  const settled = steps.some(
    (step) => step.part === "cli" && (Step.$is("Change")(step) || Step.$is("Kept")(step)),
  );

  return {
    directory,
    steps: Option.match(elsewhere, {
      onNone: () => steps,
      onSome: (file) => [
        ...steps,
        Step.Note({
          part: "cli",
          text: `This terminal has ${variable} set to ${file}, outside ${directory}. While it is, reports and syncs that see the variable read only that file and skip the exports in ${directory}, VS Code's among them. ${
            settled
              ? `Run them from a new terminal; if it still has that value, something else sets it, and should name ${target} instead.`
              : `Point it at ${target} to have both read.`
          }`,
        }),
      ],
    }),
  };
});

/** One rendered entry for each step of the kind `tag`. */
const entries = <Tag extends Step["_tag"]>(
  steps: ReadonlyArray<Step>,
  tag: Tag,
  render: (step: Extract<Step, { readonly _tag: Tag }>) => string,
) => steps.flatMap((step) => (Step.$is(tag)(step) ? [indented(render(step), 2)] : []));

const leftByHand = (steps: ReadonlyArray<Step>) =>
  entries(steps, "ByHand", ({ reason, instructions }) => `${reason}\n${instructions}`);

const notes = (steps: ReadonlyArray<Step>) => entries(steps, "Note", ({ text }) => text);

/** Titled lists with a blank line between them, and between entries of more than one line. */
const sections = (parts: ReadonlyArray<readonly [title: string, entries: ReadonlyArray<string>]>) =>
  parts
    .flatMap(([title, lines]) =>
      lines.length === 0
        ? []
        : [`${title}\n\n${lines.join(lines.some((line) => line.includes("\n")) ? "\n\n" : "\n")}`],
    )
    .join("\n\n");

/** The text shown before asking: each change with its exact lines, and what stays or is left over. */
export const describe = (steps: ReadonlyArray<Step>) =>
  sections([
    [
      "Copilot records no usage until its local export is switched on. This will:",
      entries(steps, "Change", ({ summary, detail }) =>
        [summary, ...detail.map((line) => indented(line, 4))].join("\n"),
      ),
    ],
    ["Already in place:", entries(steps, "Kept", ({ summary }) => summary)],
    ["Left for you to do by hand:", leftByHand(steps)],
    ["Note:", notes(steps)],
  ]);

/**
 * Replaces `file` with `contents` in one step: the text is complete under another name before
 * it takes this one, so a write that fails part-way leaves the original as it was. A symbolic
 * link stays a link, with the file it names replaced, and the file keeps its permissions. A
 * link whose file does not exist is a `CopilotError`: writing there would replace the link.
 */
const replaceFile = Effect.fn("Copilot.replaceFile")(function* (file: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  yield* Effect.gen(function* () {
    const target = yield* fs.realPath(file).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        // A link to a file that is not there yet would be replaced by the file itself.
        Effect.matchEffect(fs.readLink(file), {
          onFailure: () => Effect.succeed(file),
          onSuccess: (destination) =>
            Effect.fail(
              new CopilotError({
                message: `${file} is a link to ${destination}, which does not exist, so it was left alone.`,
              }),
            ),
        }),
      ),
    );

    const mode = yield* fs.stat(target).pipe(
      Effect.map((info) => Option.some(info.mode & 0o7777)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none<number>())),
    );

    yield* fs.makeDirectory(path.dirname(target), { recursive: true });

    const temporary = path.join(
      yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(target),
        prefix: ".token-ledger-",
      }),
      path.basename(target),
    );

    yield* fs.writeFileString(temporary, contents);

    if (Option.isSome(mode)) yield* fs.chmod(temporary, mode.value);

    yield* fs.rename(temporary, target);
  }).pipe(Effect.scoped);
});

/**
 * Carries out each `Change`, turning it into `Done`, or into `ByHand` when it fails, so one
 * unwritable file does not stop the rest. Only the export folder is required: without it
 * nothing else works, and failing to create it is a `CopilotError`.
 */
export const perform = Effect.fn("Copilot.perform")(function* (steps: ReadonlyArray<Step>) {
  const fs = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const results: Step[] = [];

  for (const step of steps) {
    if (!Step.$is("Change")(step)) {
      results.push(step);
      continue;
    }

    const { part, summary, byHand } = step;
    const done = Step.Done({ part, summary });

    const failed = (reason: string) => Step.ByHand({ part, reason, instructions: byHand });

    results.push(
      yield* Action.$match(step.action, {
        MakeDirectory: ({ directory }) =>
          fs.makeDirectory(directory, { recursive: true }).pipe(
            Effect.as(done),
            Effect.mapError(() => new CopilotError({ message: `Cannot create ${directory}.` })),
          ),
        Write: ({ file, contents, original }) =>
          Effect.gen(function* () {
            // The plan was made before the question; an editor may have saved the file since.
            if (Option.getOrNull(yield* readOptional(file)) !== Option.getOrNull(original))
              return failed(`${file} changed while this command was waiting. Run it again.`);

            yield* replaceFile(file, contents);

            return done;
          }).pipe(
            Effect.catchTag("CopilotError", ({ message }) => Effect.succeed(failed(message))),
            Effect.orElseSucceed(() => failed(`Cannot write ${file}.`)),
          ),
        Run: ({ program, args }) =>
          spawner
            .exitCode(
              ChildProcess.make(program, args, {
                stdin: "ignore",
                stdout: "ignore",
                stderr: "inherit",
              }),
            )
            .pipe(
              Effect.map((code) =>
                code === 0 ? done : failed(`${program} could not ${summary}.`),
              ),
              Effect.orElseSucceed(() => failed(`Cannot run ${program}.`)),
            ),
      }),
    );
  }

  return results;
});

/** The text shown once the changes are made: what happened, what is left, and what to do next. */
export function summarize(steps: ReadonlyArray<Step>, directory: string) {
  const changed = (part: Part) =>
    steps.some((step) => Step.$is("Done")(step) && step.part === part);

  const next = [
    ...(changed("cli") ? ["Copilot CLI: open a new terminal before you start copilot."] : []),
    ...(changed("vscode")
      ? [
          'VS Code: run "Developer: Reload Window" in each open window, or restart VS Code, then start a new chat.',
        ]
      : []),
  ];

  return sections([
    ["Done:", entries(steps, "Done", ({ summary }) => summary)],
    ["Left for you to do by hand:", leftByHand(steps)],
    ["Note:", notes(steps)],
    [
      "Next:",
      next.length === 0
        ? []
        : [
            ...next,
            `Usage is recorded in ${directory} from then on; earlier sessions cannot be recovered.`,
            "Check it with: token-ledger report --provider copilot",
          ].map((line) => indented(line, 2)),
    ],
  ]);
}
