import { homedir, userInfo } from "node:os";

import { Data, Effect, FileSystem, Match, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { configHome } from "./settings.ts";

/** The OS scheduler could not be used, or a value cannot be written safely into its job. */
export class ScheduleError extends Schema.TaggedError<ScheduleError>()("ScheduleError", {
  message: Schema.String,
}) {}

/** A daily local time, `HH:MM` on a 24-hour clock. */
export const TimeOfDay = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

/** A daily local time, `HH:MM` on a 24-hour clock. */
export type TimeOfDay = typeof TimeOfDay.Type;

/** What the scheduler runs each day. Paths are absolute, and nothing here is a credential. */
export interface ScheduledSync {
  readonly at: TimeOfDay;
  /** Directory of the Node that ran `schedule install`, searched before the job's own `PATH`. */
  readonly nodeDirectory: string;
  /**
   * The `XDG_CONFIG_HOME` that `schedule install` ran with. The job exports it, so it reads
   * the settings `login` saved even when the scheduler's environment lacks the variable.
   */
  readonly configHome: Option.Option<string>;
  /** Flags forwarded to `sync`. */
  readonly flags: ReadonlyArray<string>;
}

/**
 * How a command's result is treated. A `required` command must exit 0. A `reported` command
 * shows its output and any exit code is accepted. A `silent` command is attempted with its
 * output and outcome discarded. An `absent` command asks whether the job still exists: its
 * output is discarded, and it must exit with one of `gone`, or with any non-zero code when
 * `gone` is empty.
 */
type Outcome = "required" | "reported" | "silent" | "absent";

/** One step of changing or inspecting the scheduler. */
export type Action = Data.TaggedEnum<{
  Write: { readonly file: string; readonly contents: string };
  Remove: { readonly file: string };
  Run: {
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly shown: string;
    readonly outcome: Outcome;
    readonly hint: string;
    /** Exit codes by which an `absent` command confirms the job is gone. */
    readonly gone: ReadonlyArray<number>;
  };
}>;

const Action = Data.taggedEnum<Action>();

/** A platform's scheduler, as the actions that install, remove, and inspect the daily sync. */
export interface Scheduler {
  readonly name: string;
  /** Fails with `ScheduleError` when a job value cannot be quoted for this scheduler. */
  readonly install: (
    job: ScheduledSync,
  ) => Effect.Effect<ReadonlyArray<Action>, ScheduleError, never>;
  readonly uninstall: ReadonlyArray<Action>;
  readonly status: ReadonlyArray<Action>;
}

const unit = "token-ledger-sync";

const label = "com.github.ponbac.token-ledger.sync";

const task = "token-ledger sync";

const packageSpec = "@ponbac/token-ledger@latest";

function run(outcome: Outcome, program: string, args: ReadonlyArray<string>, hint = "") {
  return Action.Run({
    program,
    args,
    shown: [program, ...args].join(" "),
    outcome,
    hint,
    gone: [],
  });
}

/** Rejects job values that a scheduler's quoting cannot carry. */
function quotable(
  job: ScheduledSync,
  forbidden: RegExp,
  described: string,
): Effect.Effect<ScheduledSync, ScheduleError, never> {
  const offending = [job.nodeDirectory, ...Option.toArray(job.configHome), ...job.flags].find(
    (value) => forbidden.test(value),
  );

  return offending === undefined
    ? Effect.succeed(job)
    : Effect.fail(
        new ScheduleError({
          message: `Cannot schedule with ${JSON.stringify(offending)}: it contains ${described}.`,
        }),
      );
}

/** Quotes `value` as one word of a POSIX shell command, leaving plain words bare. */
export const posixWord = (value: string) =>
  /^[\w@+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The shell line a POSIX job runs in a login shell. The pinned Node directory comes first, so
 * the job does not depend on the profile; if that Node is later removed, the profile's `PATH`
 * still finds `npx`.
 */
const posixScript = (job: ScheduledSync) =>
  [
    // systemd starts user services in the home directory, where sync would pick up a
    // stray `token-ledger.json`; only `--config` selects a configuration for the job.
    "cd /",
    ...Option.toArray(job.configHome).map(
      (directory) => `export XDG_CONFIG_HOME=${posixWord(directory)}`,
    ),
    `export PATH=${posixWord(job.nodeDirectory)}:"$PATH"`,
    `exec npx --yes ${packageSpec} ${["sync", ...job.flags].map(posixWord).join(" ")}`,
  ].join("; ");

const posixJob = (job: ScheduledSync) => quotable(job, /\p{Cc}/u, "a control character");

// systemd expands `%` specifiers and `$` variables, and reads C-style escapes inside quotes.
const systemdQuoted = (value: string) =>
  `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%")
    .replaceAll("$", () => "$$")}"`;

/**
 * A systemd user timer whose units live in `directory`. `Persistent=true` runs a missed sync
 * when the user's timers next start, after a short delay that lets the network come up.
 */
export function systemdTimer(directory: string): Scheduler {
  const service = `${directory}/${unit}.service`;
  const timer = `${directory}/${unit}.timer`;

  const systemctl = (outcome: Outcome, args: ReadonlyArray<string>, hint = "") =>
    run(outcome, "systemctl", ["--user", ...args], hint);

  return {
    name: "systemd user timer",
    install: (job) =>
      posixJob(job).pipe(
        Effect.map((job) => [
          systemctl(
            "required",
            ["daemon-reload"],
            "A systemd user session is required; without one, add the cron entry from the README.",
          ),
          Action.Write({
            file: service,
            contents: `[Unit]
Description=Upload AI usage to toki2

[Service]
Type=oneshot
ExecStart=/bin/sh -lc ${systemdQuoted(posixScript(job))}
`,
          }),
          Action.Write({
            file: timer,
            contents: `[Unit]
Description=Daily AI usage sync

[Timer]
OnCalendar=*-*-* ${job.at}:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
`,
          }),
          systemctl("required", ["daemon-reload"]),
          systemctl("required", ["enable", `${unit}.timer`]),
          // A timer that is already running keeps its old schedule until restarted.
          systemctl("required", ["restart", `${unit}.timer`]),
        ]),
      ),
    uninstall: [
      systemctl("reported", ["disable", "--now", `${unit}.timer`]),
      // Persistent=true keeps a timestamp on disk that outlives the unit files.
      systemctl("reported", ["clean", "--what=state", `${unit}.timer`]),
      Action.Remove({ file: service }),
      Action.Remove({ file: timer }),
      systemctl("reported", ["daemon-reload"]),
      // is-active exits 3 for an inactive unit and 4 for an unknown one; 1 is a failed query.
      Action.Run({
        ...systemctl(
          "absent",
          ["is-active", "--quiet", `${unit}.timer`],
          "Cannot confirm that the timer is gone; systemd's reason is shown above.",
        ),
        gone: [3, 4],
      }),
    ],
    status: [systemctl("reported", ["status", "--no-pager", `${unit}.timer`, `${unit}.service`])],
  };
}

const xmlText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * A launchd agent for the user `uid` whose home is `home`. It also syncs when the agent loads
 * at login, and launchd runs an interval missed during sleep on wake. Output goes to
 * `~/Library/Logs/token-ledger-sync.log`.
 */
export function launchAgent(home: string, uid: number): Scheduler {
  const plist = `${home}/Library/LaunchAgents/${label}.plist`;
  const log = `${home}/Library/Logs/${unit}.log`;
  const domain = `gui/${uid}`;

  return {
    name: "launchd agent",
    install: (job) =>
      posixJob(job).pipe(
        Effect.map((job) => {
          const [hour, minute] = job.at.split(":").map(Number);

          return [
            // Written first: a plist that cannot be written leaves the loaded agent running.
            Action.Write({
              file: plist,
              contents: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlText(posixScript(job))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlText(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlText(log)}</string>
</dict>
</plist>
`,
            }),
            // Replacing a loaded agent requires unloading it; a first install has none.
            run("silent", "launchctl", ["bootout", `${domain}/${label}`]),
            run("required", "launchctl", ["bootstrap", domain, plist]),
          ];
        }),
      ),
    uninstall: [
      run("reported", "launchctl", ["bootout", `${domain}/${label}`]),
      Action.Remove({ file: plist }),
      run(
        "absent",
        "launchctl",
        ["print", `${domain}/${label}`],
        "The agent is still loaded; launchd's reason is shown above.",
      ),
    ],
    status: [run("reported", "launchctl", ["print", `${domain}/${label}`])],
  };
}

const cmdWord = (value: string) => (/^[\w@+=:,./\\-]+$/.test(value) ? value : `"${value}"`);

/** Quotes `value` as a PowerShell string literal that expands nothing. */
export const powershellString = (value: string) => `'${value.replaceAll("'", "''")}'`;

const powershellOptions = ["-NoProfile", "-NonInteractive", "-EncodedCommand"];

/** Arguments that make `powershell.exe` run `script` unchanged by any shell's quoting. */
export const powershellArguments = (script: string) => [
  ...powershellOptions,
  Buffer.from(script, "utf16le").toString("base64"),
];

/**
 * A Task Scheduler task for the current user. It runs a missed sync at the next opportunity
 * and is neither blocked nor stopped by battery power. Registration goes through PowerShell,
 * because `schtasks` cannot set those options.
 */
export const taskScheduler: Scheduler = {
  name: "Task Scheduler task",
  install: (job) =>
    // cmd.exe expands `%` even inside quotes and has no escape for a quote within them;
    // `/v:off` keeps `!` literal where delayed expansion is enabled machine-wide.
    quotable(job, /[\p{Cc}"%]/u, 'a control character, `"`, or `%`').pipe(
      Effect.map((job) => {
        const command = [
          ...Option.toArray(job.configHome).map(
            (directory) => `set "XDG_CONFIG_HOME=${directory}"`,
          ),
          `set "PATH=${job.nodeDirectory};%PATH%"`,
          `npx --yes ${packageSpec} ${["sync", ...job.flags].map(cmdWord).join(" ")}`,
        ].join(" && ");

        const script = [
          "$ErrorActionPreference = 'Stop'",
          "$ProgressPreference = 'SilentlyContinue'",
          `$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ${powershellString(`/d /v:off /s /c "${command}"`)}`,
          `$trigger = New-ScheduledTaskTrigger -Daily -At '${job.at}'`,
          "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
          `Register-ScheduledTask -TaskName ${powershellString(task)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
        ].join("\n");

        return [
          Action.Run({
            program: "powershell.exe",
            args: powershellArguments(script),
            shown: `powershell.exe ${powershellOptions.join(" ")} <the script below, as UTF-16LE Base64>\n${script}`,
            outcome: "required",
            hint: "",
            gone: [],
          }),
        ];
      }),
    ),
  uninstall: [
    run("reported", "schtasks.exe", ["/Delete", "/TN", task, "/F"]),
    run(
      "absent",
      "schtasks.exe",
      ["/Query", "/TN", task],
      "The task is still registered; Task Scheduler's reason is shown above.",
    ),
  ],
  status: [run("reported", "schtasks.exe", ["/Query", "/TN", task, "/V", "/FO", "LIST"])],
};

/** The scheduler for this platform, or a `ScheduleError` where none is supported. */
export const hostScheduler = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = homedir();

  const units = Option.getOrElse(yield* configHome, () => path.join(home, ".config"));

  return yield* Match.value(process.platform).pipe(
    Match.when("linux", () => Effect.succeed(systemdTimer(path.join(units, "systemd", "user")))),
    Match.when("darwin", () => Effect.succeed(launchAgent(home, userInfo().uid))),
    Match.when("win32", () => Effect.succeed(taskScheduler)),
    Match.orElse((platform) =>
      Effect.fail(
        new ScheduleError({
          message: `No scheduler is supported on ${platform}; schedule token-ledger sync yourself.`,
        }),
      ),
    ),
  );
});

/** The text `--dry-run` prints: each file with its contents and each command as it would run. */
export const describe = (actions: ReadonlyArray<Action>) =>
  actions
    .map(
      Action.$match({
        Write: ({ file, contents }) => `write ${file}\n${contents.replaceAll(/^(?=.)/gm, "    ")}`,
        Remove: ({ file }) => `remove ${file}\n`,
        Run: ({ shown }) => `run ${shown}\n`,
      }),
    )
    .join("\n");

/**
 * Carries out actions in order, creating parent directories for written files. Stops with a
 * `ScheduleError` at the first file that cannot be changed, `required` or `reported` command
 * that cannot be started, `required` command that exits non-zero, or `absent` command that
 * does not confirm the job is gone.
 */
export const perform = Effect.fn("Schedule.perform")(function* (actions: ReadonlyArray<Action>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  for (const action of actions)
    yield* Action.$match(action, {
      Write: ({ file, contents }) =>
        fs.makeDirectory(path.dirname(file), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(file, contents)),
          Effect.mapError(() => new ScheduleError({ message: `Cannot write ${file}.` })),
        ),
      Remove: ({ file }) =>
        fs
          .remove(file, { force: true })
          .pipe(Effect.mapError(() => new ScheduleError({ message: `Cannot remove ${file}.` }))),
      Run: ({ program, args, outcome, hint, gone }) => {
        const output = outcome === "silent" || outcome === "absent" ? "ignore" : "inherit";

        const exit = spawner
          .exitCode(
            ChildProcess.make(program, args, { stdin: "ignore", stdout: output, stderr: output }),
          )
          .pipe(
            Effect.mapError(
              () => new ScheduleError({ message: `Cannot run ${program}. ${hint}`.trim() }),
            ),
          );

        return Match.value(outcome).pipe(
          Match.when("required", () =>
            Effect.filterOrFail(
              exit,
              (code) => code === 0,
              (code) =>
                new ScheduleError({
                  message:
                    `${[program, ...args.slice(0, 2)].join(" ")} failed with exit code ${code}. ${hint}`.trim(),
                }),
            ),
          ),
          Match.when("reported", () => exit),
          Match.when("silent", () => Effect.ignore(exit)),
          // A scheduler that cannot be started holds no job.
          Match.when("absent", () =>
            exit.pipe(
              Effect.map((code) => (gone.length === 0 ? code !== 0 : gone.includes(code))),
              Effect.orElseSucceed(() => true),
              Effect.filterOrFail(
                (confirmed) => confirmed,
                () => new ScheduleError({ message: hint }),
              ),
            ),
          ),
          Match.exhaustive,
        );
      },
    });
});
