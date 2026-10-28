import { homedir, userInfo } from "node:os";

import { Data, Effect, FileSystem, Match, Option, Path, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { configHome, scheduleSettled, settingsDirectory, settleSchedule } from "./settings.ts";

/** The OS scheduler could not be used, or a value cannot be written safely into its job. */
export class ScheduleError extends Schema.TaggedError<ScheduleError>()("ScheduleError", {
  message: Schema.String,
}) {}

/** A daily local time, `HH:MM` on a 24-hour clock. */
export const TimeOfDay = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

/** A daily local time, `HH:MM` on a 24-hour clock. */
export type TimeOfDay = typeof TimeOfDay.Type;

/**
 * `--every` values and their hours between syncs. Each divides a day, so every day syncs at
 * the same times and a scheduler restarting its count at midnight keeps the interval.
 */
export const intervals = [
  ["1h", 1],
  ["2h", 2],
  ["3h", 3],
  ["4h", 4],
  ["6h", 6],
  ["8h", 8],
  ["12h", 12],
  ["24h", 24],
] as const;

/** Hours between scheduled syncs. */
export type Interval = (typeof intervals)[number][1];

/** The interval `schedule install` uses, and that a once-a-day job from before it moves to. */
export const defaultInterval: Interval = 2;

const isTimeOfDay = Schema.is(TimeOfDay);

/** What the scheduler runs, and when. Paths are absolute, and nothing here is a credential. */
export interface ScheduledSync {
  /** One of the times of day a sync runs; the others are `every` hours apart from it. */
  readonly at: TimeOfDay;
  readonly every: Interval;
  /** Directory of the Node that ran `schedule install`, searched before the job's own `PATH`. */
  readonly nodeDirectory: string;
  /**
   * The `XDG_CONFIG_HOME` that `schedule install` ran with. The job exports it, so it reads
   * the settings `login` saved even when the scheduler's environment lacks the variable.
   */
  readonly configHome: Option.Option<string>;
  /** XDG data root used by the optional local billing hint discovery. */
  readonly dataHome: Option.Option<string>;
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

/** The local times, `HH:MM`, at which `job` syncs each day, earliest first. */
export function syncTimes(job: Pick<ScheduledSync, "at" | "every">): ReadonlyArray<TimeOfDay> {
  const hour = Number(job.at.slice(0, 2));
  const minute = job.at.slice(3);

  return Array.from(
    { length: 24 / job.every },
    (_, index) => `${String((hour % job.every) + index * job.every).padStart(2, "0")}:${minute}`,
  );
}

/** When `job` syncs, for a sentence such as "Scheduled a sync ...". */
export const describeTimes = (job: Pick<ScheduledSync, "at" | "every">) =>
  job.every === 24
    ? `daily at ${job.at}`
    : `every ${job.every === 1 ? "hour" : `${job.every} hours`}, at ${syncTimes(job).join(", ")}`;

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
  /** Starts a command in the background, unwaited, which outlives token-ledger. */
  Launch: {
    readonly program: string;
    readonly args: ReadonlyArray<string>;
    readonly shown: string;
  };
}>;

const Action = Data.taggedEnum<Action>();

/**
 * An installed job that syncs once a day at `at`, as every job did before `--every`, and the
 * actions that make it sync every `every` hours from `at` instead. They change only when the
 * job runs, so it keeps its command, flags, and settings.
 */
export interface DailyJob {
  readonly at: TimeOfDay;
  readonly retime: (every: Interval) => ReadonlyArray<Action>;
}

/** A platform's scheduler, as the actions that install, remove, and inspect the scheduled sync. */
export interface Scheduler {
  readonly name: string;
  /** Fails with `ScheduleError` when a job value cannot be quoted for this scheduler. */
  readonly install: (
    job: ScheduledSync,
  ) => Effect.Effect<ReadonlyArray<Action>, ScheduleError, never>;
  readonly uninstall: ReadonlyArray<Action>;
  readonly status: ReadonlyArray<Action>;
  /** The installed job when it syncs once a day; none for no job or another interval. */
  readonly dailyJob: Effect.Effect<
    Option.Option<DailyJob>,
    ScheduleError,
    FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
  >;
}

const unit = "token-ledger-sync";

const label = "com.github.ponbac.token-ledger.sync";

const task = "token-ledger sync";

const packageSpec = "@ponbac/token-ledger@latest";

/** The contents of a scheduler's job file, or none when it has no such file. */
const readJob = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;

    return (yield* fs.exists(file))
      ? Option.some(yield* fs.readFileString(file))
      : Option.none<string>();
  }).pipe(Effect.mapError(() => new ScheduleError({ message: `Cannot read ${file}.` })));

/** A once-a-day time read from a job, when it is one. */
const dailyAt = (hour: string, minute: string) =>
  Option.filter(Option.some(`${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`), isTimeOfDay);

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
  const offending = [
    job.nodeDirectory,
    ...Option.toArray(job.configHome),
    ...Option.toArray(job.dataHome),
    ...job.flags,
  ].find((value) => forbidden.test(value));

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
    ...Option.toArray(job.dataHome).map(
      (directory) => `export XDG_DATA_HOME=${posixWord(directory)}`,
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

const timerUnit = (job: Pick<ScheduledSync, "at" | "every">) => `[Unit]
Description=AI usage sync ${job.every === 24 ? "once a day" : `every ${job.every}h`}

[Timer]
OnCalendar=*-*-* ${syncTimes(job)
  .map((time) => time.slice(0, 2))
  .join(",")}:${job.at.slice(3)}:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
`;

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
          Action.Write({ file: timer, contents: timerUnit(job) }),
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
    // A daily timer names a single hour: `OnCalendar=*-*-* 12:30:00`.
    dailyJob: readJob(timer).pipe(
      Effect.map(
        Option.flatMap((contents) =>
          Option.flatMap(
            Option.fromNullishOr(/^OnCalendar=\*-\*-\* (\d{2}):(\d{2}):00$/m.exec(contents)),
            ([, hour = "", minute = ""]) => dailyAt(hour, minute),
          ),
        ),
      ),
      Effect.map(
        Option.map((at) => ({
          at,
          retime: (every: Interval) => [
            Action.Write({ file: timer, contents: timerUnit({ at, every }) }),
            systemctl("required", ["daemon-reload"]),
            // Restarting only a running timer leaves one the user stopped stopped.
            systemctl("required", ["try-restart", `${unit}.timer`]),
          ],
        })),
      ),
    ),
  };
}

const xmlText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A launchd `StartCalendarInterval` entry with one dict per sync time. */
const calendarInterval = (job: Pick<ScheduledSync, "at" | "every">) =>
  `<key>StartCalendarInterval</key>
  <array>
${syncTimes(job)
  .map((time) => {
    const [hour, minute] = time.split(":").map(Number);

    return `    <dict>
      <key>Hour</key>
      <integer>${hour}</integer>
      <key>Minute</key>
      <integer>${minute}</integer>
    </dict>`;
  })
  .join("\n")}
  </array>`;

// Its value is the dict or array that follows; a dict holds no dict, and an array no array.
const startCalendarInterval =
  /<key>StartCalendarInterval<\/key>\s*(?:<dict>[\s\S]*?<\/dict>|<array>[\s\S]*?<\/array>)/;

const hourAndMinute =
  /<key>Hour<\/key>\s*<integer>(\d{1,2})<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d{1,2})<\/integer>/g;

/**
 * Waits for the process that started it to exit, then reloads the agent `$1` in domain `$2`
 * from plist `$3`. Bootstrapping retries while launchd finishes unloading.
 */
const reloadAgent =
  'while kill -0 "$PPID" 2>/dev/null; do sleep 1; done; launchctl bootout "$1"; for attempt in 1 2 3 4 5; do launchctl bootstrap "$2" "$3" && break; sleep 1; done';

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
        Effect.map((job) => [
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
  ${calendarInterval(job)}
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
        ]),
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
    // A daily agent's interval holds a single Hour and Minute, in a dict or a one-entry array.
    dailyJob: readJob(plist).pipe(
      Effect.map(
        Option.flatMap((contents) =>
          Option.flatMap(Option.fromNullishOr(startCalendarInterval.exec(contents)), ([block]) => {
            const times = [...block.matchAll(hourAndMinute)];
            const [, hour = "", minute = ""] = times[0] ?? [];

            return times.length === 1
              ? Option.map(dailyAt(hour, minute), (at) => ({
                  at,
                  retime: (every: Interval) => [
                    Action.Write({
                      file: plist,
                      contents: contents.replace(startCalendarInterval, () =>
                        calendarInterval({ at, every }),
                      ),
                    }),
                    // launchd reads a plist only when it loads the agent, and unloading the
                    // agent stops its running job, which may be this sync. So the reload
                    // waits for this process to exit, outside the job's process group.
                    Action.Launch({
                      program: "/bin/sh",
                      args: ["-c", reloadAgent, "sh", `${domain}/${label}`, domain, plist],
                      shown: `/bin/sh -c '${reloadAgent}' sh ${domain}/${label} ${domain} ${plist}`,
                    }),
                  ],
                }))
              : Option.none();
          }),
        ),
      ),
    ),
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

// WSH reads an unmarked script using the Windows code page. ASCII escapes preserve Unicode
// paths and also keep line separators out of JScript string literals.
const jscriptString = (value: string) =>
  JSON.stringify(value).replaceAll(
    /[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** PowerShell that sets `$trigger` to start a sync at each of `job`'s times. */
const taskTrigger = (job: Pick<ScheduledSync, "at" | "every">) => [
  `$trigger = New-ScheduledTaskTrigger -Daily -At '${syncTimes(job)[0]}'`,
  // A daily trigger takes its repetition from a one-time trigger's. Repetition also fires at
  // the end of its duration, so it ends at the day's last sync rather than at the next day's
  // first, which the daily trigger starts.
  ...(job.every === 24
    ? []
    : [
        `$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '${syncTimes(job)[0]}' -RepetitionInterval (New-TimeSpan -Hours ${job.every}) -RepetitionDuration (New-TimeSpan -Hours ${24 - job.every})).Repetition`,
      ]),
];

/**
 * Prints the local time a once-a-day task starts at, and nothing for no task or another
 * interval. Its start boundary keeps the time the task was registered with, even where it
 * records an offset that has changed since.
 */
const dailyTaskScript = [
  "$ErrorActionPreference = 'Stop'",
  `$task = Get-ScheduledTask -TaskName ${powershellString(task)} -ErrorAction SilentlyContinue`,
  "if ($task -and @($task.Triggers).Count -eq 1) {",
  "  $trigger = @($task.Triggers)[0]",
  "  if ($trigger.CimClass.CimClassName -eq 'MSFT_TaskDailyTrigger' -and $trigger.DaysInterval -eq 1 -and -not $trigger.Repetition.Interval) {",
  "    $trigger.StartBoundary.Substring(11, 5)",
  "  }",
  "}",
].join("\n");

/** Runs a PowerShell `script`, showing it as written rather than encoded. */
const powershell = (script: string) =>
  Action.Run({
    program: "powershell.exe",
    args: powershellArguments(script),
    shown: `powershell.exe ${powershellOptions.join(" ")} <the script below, as UTF-16LE Base64>\n${script}`,
    outcome: "required",
    hint: "",
    gone: [],
  });

/**
 * A Task Scheduler task for the current user, with its windowless JScript launcher at `file`.
 * It waits for sync and reports its exit code, runs missed syncs at the next opportunity, and
 * allows battery power. Registration uses PowerShell because `schtasks` cannot set those
 * options. Uninstall removes the launcher only after confirming the task is gone.
 */
export function taskScheduler(file: string): Scheduler {
  return {
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
            `$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ${powershellString(`//B //Nologo //E:JScript "${file}"`)}`,
            ...taskTrigger(job),
            "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
            `Register-ScheduledTask -TaskName ${powershellString(task)} -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null`,
          ].join("\n");

          return [
            // A GUI host starts cmd hidden from the outset; hiding PowerShell after it starts
            // can still flash a console. Waiting keeps Task Scheduler tracking the real sync.
            Action.Write({
              file,
              contents: `var shell = WScript.CreateObject("WScript.Shell");\nWScript.Quit(shell.Run(${jscriptString(`cmd.exe /d /v:off /s /c "${command}"`)}, 0, true));\n`,
            }),
            powershell(script),
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
      Action.Remove({ file }),
    ],
    status: [run("reported", "schtasks.exe", ["/Query", "/TN", task, "/V", "/FO", "LIST"])],
    dailyJob: Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const lines = yield* spawner
        .lines(ChildProcess.make("powershell.exe", powershellArguments(dailyTaskScript)))
        .pipe(
          Effect.mapError(
            () => new ScheduleError({ message: "Cannot ask Task Scheduler about the task." }),
          ),
        );

      return Option.map(
        Option.filter(Option.fromUndefinedOr(lines[0]?.trim()), isTimeOfDay),
        (at): DailyJob => ({
          at,
          // Changing only the trigger keeps the task's launcher and settings, and a sync
          // that is running now.
          retime: (every) => [
            powershell(
              [
                "$ErrorActionPreference = 'Stop'",
                ...taskTrigger({ at, every }),
                `Set-ScheduledTask -TaskName ${powershellString(task)} -Trigger $trigger | Out-Null`,
              ].join("\n"),
            ),
          ],
        }),
      );
    }),
  };
}

/** The scheduler for this platform, or a `ScheduleError` where none is supported. */
export const hostScheduler = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = homedir();

  const units = Option.getOrElse(yield* configHome, () => path.join(home, ".config"));

  return yield* Match.value(process.platform).pipe(
    Match.when("linux", () => Effect.succeed(systemdTimer(path.join(units, "systemd", "user")))),
    Match.when("darwin", () => Effect.succeed(launchAgent(home, userInfo().uid))),
    Match.when("win32", () =>
      Effect.map(settingsDirectory, (directory) =>
        taskScheduler(path.join(directory, `${unit}.js`)),
      ),
    ),
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
        Launch: ({ shown }) => `start ${shown}\n`,
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
      // A detached child leads its own process group, and an unreferenced one is neither
      // waited for nor stopped when its scope closes.
      Launch: ({ program, args }) =>
        spawner
          .spawn(
            ChildProcess.make(program, args, {
              detached: true,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(
            Effect.flatMap((handle) => handle.unref),
            Effect.scoped,
            Effect.asVoid,
            Effect.mapError(() => new ScheduleError({ message: `Cannot run ${program}.` })),
          ),
    });
});

/** A once-a-day job that a sync moved to the default interval. */
export interface Retimed {
  readonly scheduler: string;
  readonly at: TimeOfDay;
  readonly every: Interval;
}

/**
 * Moves an installed once-a-day job, the only schedule before `--every`, to the default
 * interval from the same time of day, once per installation. `npx @latest` updates what the
 * job runs, but only this changes when it runs. Afterwards, and after any `schedule install`,
 * `schedule.json` keeps a chosen daily schedule as it is. A platform without a supported
 * scheduler has no job to move.
 */
export const retimeDailySchedule = Effect.fn("Schedule.retimeDailySchedule")(function* (
  directory: string,
) {
  if (yield* scheduleSettled(directory)) return Option.none<Retimed>();

  const scheduler = yield* hostScheduler.pipe(Effect.option);

  const daily = Option.isSome(scheduler)
    ? yield* scheduler.value.dailyJob
    : Option.none<DailyJob>();

  if (Option.isSome(daily)) yield* perform(daily.value.retime(defaultInterval));

  yield* settleSchedule(directory);

  return Option.map(Option.all({ scheduler, daily }), ({ scheduler, daily }): Retimed => ({
    scheduler: scheduler.name,
    at: daily.at,
    every: defaultInterval,
  }));
});
