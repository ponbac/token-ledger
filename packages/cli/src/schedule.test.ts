import { runInNewContext } from "node:vm";

import { NodeServices } from "@effect/platform-node";
import { assert, describe as suite, it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Predicate,
  Result,
  Schedule,
  Schema,
  Sink,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type Action,
  type DailyJob,
  type ScheduledSync,
  describe,
  launchAgent,
  perform,
  powershellArguments,
  retimeDailySchedule,
  systemdTimer,
  taskScheduler,
} from "./schedule.ts";

// A path with every character the POSIX schedulers quote: space, `'`, `"`, `$`, `%`, `\`, `&`, `<`.
const awkward = `/tmp/my cfg/it's $HOME %h "x" \\ & <b>.json`;

const job: ScheduledSync = {
  at: "07:05",
  every: 6,
  nodeDirectory: "/opt/node 24/bin",
  configHome: Option.some("/home/me/my config"),
  dataHome: Option.none(),
  flags: ["--config", awkward, "--time-zone", "Europe/Stockholm"],
};

/**
 * A scheduler stand-in that records each command line, exits as `exit` decides, and prints
 * `output`.
 */
function scheduler(exit: (line: string) => number | null, output = "") {
  const lines: string[] = [];

  const spawner = ChildProcessSpawner.make((command) => {
    const line = ChildProcess.isStandardCommand(command)
      ? [command.command, ...command.args].join(" ")
      : "pipeline";

    lines.push(line);
    const code = exit(line);

    return code === null
      ? Effect.fail(
          PlatformError.badArgument({
            module: "ChildProcess",
            method: "spawn",
            description: "fixture: no such program",
          }),
        )
      : Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            stdin: Sink.drain,
            stdout: output === "" ? Stream.empty : Stream.make(new TextEncoder().encode(output)),
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
            unref: Effect.succeed(Effect.void),
          }),
        );
  });

  return { lines, spawner };
}

/** The daily job a scheduler reports, failing the test when it reports none. */
const daily = (job: Option.Option<DailyJob>) =>
  Option.match(job, {
    onNone: () => assert.fail("expected a once-a-day job"),
    onSome: (job) => job,
  });

/** The script a `powershell.exe -EncodedCommand` command line runs. */
const encoded = (line: string) =>
  Buffer.from(line.split(" ").at(-1) ?? "", "base64").toString("utf16le");

/** The script a PowerShell action runs. */
const script = (action: Action) =>
  encoded(Predicate.isTagged(action, "Run") ? action.args.join(" ") : "");

// A timer as `schedule install` wrote it before `--every`.
const dailyTimer = `[Unit]
Description=Daily AI usage sync

[Timer]
OnCalendar=*-*-* 12:30:00
Persistent=true
RandomizedDelaySec=10m

[Install]
WantedBy=timers.target
`;

suite("systemd user timer", () => {
  it.effect("preserves the XDG data root without making optional hints a required source", () =>
    Effect.gen(function* () {
      const actions = yield* systemdTimer("/tmp/units").install({
        ...job,
        dataHome: Option.some("/home/me/my data"),
      });

      const plan = describe(actions);
      assert.include(plan, "export XDG_DATA_HOME='/home/me/my data'");
      assert.notInclude(plan, "--billing-hints-dir");
    }),
  );

  it.effect("installs units that carry awkward paths through systemd and the shell", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(yield* fs.makeTempDirectoryScoped(), "systemd", "user");
      const { lines, spawner } = scheduler(() => 0);

      yield* perform(yield* systemdTimer(directory).install(job)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      // systemd 261 ran these bytes and passed the flags through exactly as given.
      assert.include(
        yield* fs.readFileString(path.join(directory, "token-ledger-sync.service")),
        `ExecStart=/bin/sh -lc "cd /; export XDG_CONFIG_HOME='/home/me/my config'; export PATH='/opt/node 24/bin':\\"$$PATH\\"; exec npx --yes @ponbac/token-ledger@latest sync --config '/tmp/my cfg/it'\\\\''s $$HOME %%h \\"x\\" \\\\ & <b>.json' --time-zone Europe/Stockholm"\n`,
      );
      assert.include(
        yield* fs.readFileString(path.join(directory, "token-ledger-sync.timer")),
        "OnCalendar=*-*-* 01,07,13,19:05:00\nPersistent=true\n",
      );
      assert.deepStrictEqual(lines, [
        "systemctl --user daemon-reload",
        "systemctl --user daemon-reload",
        "systemctl --user enable token-ledger-sync.timer",
        "systemctl --user restart token-ledger-sync.timer",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("replaces an installed schedule when installed again with another interval", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const timer = path.join(directory, "token-ledger-sync.timer");
      const { lines, spawner } = scheduler(() => 0);

      for (const every of [6, 24, 1] as const)
        yield* perform(yield* systemdTimer(directory).install({ ...job, every })).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      assert.include(
        yield* fs.readFileString(timer),
        `OnCalendar=*-*-* ${Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")).join(",")}:05:00\n`,
      );
      assert.deepStrictEqual((yield* fs.readDirectory(directory)).toSorted(), [
        "token-ledger-sync.service",
        "token-ledger-sync.timer",
      ]);
      // A running timer keeps its old schedule until restarted, so each install restarts it.
      assert.strictEqual(lines.filter((line) => line.includes("restart")).length, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("schedules a daily sync at the given time", () =>
    Effect.gen(function* () {
      const plan = describe(yield* systemdTimer("/tmp/units").install({ ...job, every: 24 }));

      assert.include(plan, "OnCalendar=*-*-* 07:05:00\n");
    }),
  );

  it.effect("writes nothing when no user session answers, and says what to do instead", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      for (const exit of [() => 1, () => null]) {
        const { lines, spawner } = scheduler(exit);

        const outcome = yield* perform(yield* systemdTimer(directory).install(job)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.result,
        );

        assert.isTrue(Result.isFailure(outcome));
        assert.match(Result.isFailure(outcome) ? outcome.failure.message : "", /cron entry/);
        assert.deepStrictEqual(lines, ["systemctl --user daemon-reload"]);
        assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uninstalls the units even when the timer was never enabled", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const timer = systemdTimer(directory);

      yield* perform(yield* timer.install(job)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scheduler(() => 0).spawner),
      );

      // systemd knows no such unit: disabling fails, and is-active answers 4.
      const { lines, spawner } = scheduler((line) => (line.includes("is-active") ? 4 : 1));

      yield* perform(timer.uninstall).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      assert.deepStrictEqual(yield* fs.readDirectory(directory), []);
      assert.deepStrictEqual(lines, [
        "systemctl --user disable --now token-ledger-sync.timer",
        "systemctl --user clean --what=state token-ledger-sync.timer",
        "systemctl --user daemon-reload",
        "systemctl --user is-active --quiet token-ledger-sync.timer",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails an uninstall that cannot confirm the timer is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      // The timer is still active (0), or the user bus cannot be reached (1).
      for (const answer of [0, 1]) {
        const { spawner } = scheduler((line) => (line.includes("is-active") ? answer : 1));

        const outcome = yield* perform(systemdTimer(directory).uninstall).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.result,
        );

        assert.match(
          Result.isFailure(outcome) ? outcome.failure.message : "",
          /Cannot confirm/,
          `is-active exit ${answer}`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves a timer from before --every to every 2 hours, leaving its service alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped();
      const service = path.join(directory, "token-ledger-sync.service");
      const timer = path.join(directory, "token-ledger-sync.timer");
      const { lines, spawner } = scheduler(() => 0);

      yield* fs.writeFileString(service, "[Service]\nExecStart=/bin/true\n");
      yield* fs.writeFileString(timer, dailyTimer);

      const job = daily(yield* systemdTimer(directory).dailyJob);
      assert.strictEqual(job.at, "12:30");

      yield* perform(job.retime(2)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      assert.include(
        yield* fs.readFileString(timer),
        "OnCalendar=*-*-* 00,02,04,06,08,10,12,14,16,18,20,22:30:00\n",
      );
      assert.strictEqual(yield* fs.readFileString(service), "[Service]\nExecStart=/bin/true\n");
      // A timer the user stopped stays stopped.
      assert.deepStrictEqual(lines, [
        "systemctl --user daemon-reload",
        "systemctl --user try-restart token-ledger-sync.timer",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("finds a once-a-day job only in a timer that runs once a day", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const timer = systemdTimer(directory);
      const { spawner } = scheduler(() => 0);

      const install = (every: 6 | 24) =>
        Effect.flatMap(timer.install({ ...job, every }), perform).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

      assert.isTrue(Option.isNone(yield* timer.dailyJob));

      yield* install(6);
      assert.isTrue(Option.isNone(yield* timer.dailyJob));

      // An --every 24h timer looks like one from before --every; schedule.json tells them apart.
      yield* install(24);
      assert.strictEqual(daily(yield* timer.dailyJob).at, "07:05");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

suite("launchd agent", () => {
  it.effect("replaces a loaded agent, creating LaunchAgents on a fresh account", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();

      const plist = path.join(
        home,
        "Library/LaunchAgents/com.github.ponbac.token-ledger.sync.plist",
      );

      // Unloading fails on a first install, where no agent is loaded yet.
      const { lines, spawner } = scheduler((line) => (line.includes("bootout") ? 3 : 0));

      yield* perform(yield* launchAgent(home, 501).install(job)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const contents = yield* fs.readFileString(plist);

      assert.include(
        contents,
        `<string>cd /; export XDG_CONFIG_HOME='/home/me/my config'; export PATH='/opt/node 24/bin':"$PATH"; exec npx --yes @ponbac/token-ledger@latest sync --config '/tmp/my cfg/it'\\''s $HOME %h "x" \\ &amp; &lt;b&gt;.json' --time-zone Europe/Stockholm</string>`,
      );
      assert.deepStrictEqual(
        Array.from(
          contents.matchAll(
            /<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g,
          ),
          ([, hour, minute]) => `${hour}:${minute}`,
        ),
        ["1:5", "7:5", "13:5", "19:5"],
      );
      assert.deepStrictEqual(
        lines.map((line) => line.replaceAll("\\", "/")),
        [
          "launchctl bootout gui/501/com.github.ponbac.token-ledger.sync",
          `launchctl bootstrap gui/501 ${plist.replaceAll("\\", "/")}`,
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a loaded agent running when its replacement cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const { lines, spawner } = scheduler(() => 0);

      // A file where the directory belongs makes the plist unwritable.
      yield* fs.writeFileString(path.join(home, "Library"), "");

      const outcome = yield* perform(yield* launchAgent(home, 501).install(job)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
      );

      assert.isTrue(Result.isFailure(outcome));
      assert.deepStrictEqual(lines, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves an agent from before --every to every 2 hours, as install would write it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();

      const plist = path.join(
        home,
        "Library",
        "LaunchAgents",
        "com.github.ponbac.token-ledger.sync.plist",
      );

      const agent = launchAgent(home, 501);
      const { lines, spawner } = scheduler(() => 0);

      yield* perform(yield* agent.install({ ...job, at: "12:30", every: 2 })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const installed = yield* fs.readFileString(plist);

      // Before --every, the interval was a single dict.
      yield* fs.writeFileString(
        plist,
        installed.replace(
          /<key>StartCalendarInterval<\/key>\n {2}<array>[\s\S]*?<\/array>/,
          "<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>12</integer>\n    <key>Minute</key>\n    <integer>30</integer>\n  </dict>",
        ),
      );
      assert.notStrictEqual(yield* fs.readFileString(plist), installed);

      const retime = daily(yield* agent.dailyJob);
      assert.strictEqual(retime.at, "12:30");

      lines.length = 0;
      yield* perform(retime.retime(2)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      assert.strictEqual(yield* fs.readFileString(plist), installed);
      assert.lengthOf(lines, 1);
      assert.match(
        lines[0] ?? "",
        /^\/bin\/sh -c .* sh gui\/501\/com\.github\.ponbac\.token-ledger\.sync gui\/501 .*\.plist$/,
      );
      assert.isTrue(Option.isNone(yield* agent.dailyJob));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform === "win32")(
    "reloads the agent only once the process that started the reload has exited",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped();
        const receipt = path.join(directory, "receipt");
        const launchctl = path.join(directory, "launchctl");

        yield* fs.writeFileString(launchctl, `#!/bin/sh\necho "$*" >> '${receipt}'\n`);
        yield* fs.chmod(launchctl, 0o755);

        const home = yield* fs.makeTempDirectoryScoped();

        const plist = path.join(
          home,
          "Library",
          "LaunchAgents",
          "com.github.ponbac.token-ledger.sync.plist",
        );

        yield* fs.makeDirectory(path.dirname(plist), { recursive: true });
        yield* fs.writeFileString(
          plist,
          "<key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>12</integer>\n    <key>Minute</key>\n    <integer>30</integer>\n  </dict>\n",
        );

        // Stands in for the sync: performs the reload a retime launches, outlives launchd's first
        // check that it is still running, then exits.
        const sync = [
          'import { NodeServices } from "@effect/platform-node";',
          'import { Effect, Option } from "effect";',
          'import { launchAgent, perform } from "./schedule.ts";',
          "await Effect.runPromise(",
          '  launchAgent(process.env["TEST_HOME"] ?? "", 501).dailyJob.pipe(',
          "    Effect.map(Option.getOrThrow),",
          '    Effect.flatMap((job) => perform(job.retime(2).filter((action) => action._tag === "Launch"))),',
          '    Effect.andThen(Effect.sleep("1500 millis")),',
          "    Effect.provide(NodeServices.layer),",
          "  ),",
          ");",
        ].join("\n");

        assert.strictEqual(
          yield* spawner.exitCode(
            ChildProcess.make("bun", ["-e", sync], {
              cwd: import.meta.dirname,
              env: { PATH: `${directory}:${process.env["PATH"] ?? ""}`, TEST_HOME: home },
              extendEnv: true,
              stdin: "ignore",
            }),
          ),
          ChildProcessSpawner.ExitCode(0),
        );

        assert.isFalse(yield* fs.exists(receipt));

        const reloaded = `bootout gui/501/com.github.ponbac.token-ledger.sync\nbootstrap gui/501 ${plist}\n`;

        const received = yield* fs.readFileString(receipt).pipe(
          Effect.filterOrFail((text) => text === reloaded),
          Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }),
          Effect.catch(() => fs.readFileString(receipt)),
        );

        assert.strictEqual(received, reloaded);
      }).pipe(Effect.provide(NodeServices.layer)),
    10_000,
  );
});

suite("Task Scheduler task", () => {
  it.effect(
    "registers a hidden launcher that waits, forwards paths, and returns the sync exit code",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const file = path.join(yield* fs.makeTempDirectoryScoped(), "token-ledger-sync.js");
        const { lines, spawner } = scheduler(() => 0);

        const actions = yield* taskScheduler(file).install({
          at: "07:05",
          every: 6,
          nodeDirectory: "C:\\Program Files\\nodejs",
          configHome: Option.some("D:\\my config"),
          dataHome: Option.none(),
          flags: ["--config", "C:\\Users\\O'Neil & Malmö 🌍\\token-ledger.json"],
        });

        yield* perform(actions).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        const [program, ...args] = (lines[0] ?? "").split(" ");
        const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");

        assert.strictEqual(program, "powershell.exe");
        assert.include(describe(actions), script);
        assert.include(script, "-Execute 'wscript.exe'");
        assert.include(
          script,
          `-Argument '//B //Nologo //E:JScript "${file.replaceAll("'", "''")}"'`,
        );
        assert.include(script, "-Daily -At '01:05'");
        assert.include(
          script,
          "$trigger.Repetition = (New-ScheduledTaskTrigger -Once -At '01:05' -RepetitionInterval (New-TimeSpan -Hours 6) -RepetitionDuration (New-TimeSpan -Hours 18)).Repetition",
        );
        assert.include(
          script,
          "-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries",
        );

        const launcher = yield* fs.readFileString(file);

        // WSH's default code page must not change Unicode paths in this generated file.
        assert.isTrue(Array.from(launcher).every((character) => character.charCodeAt(0) < 128));

        for (const exit of [0, 7]) {
          const commands: string[] = [];
          const codes: number[] = [];

          runInNewContext(launcher, {
            WScript: {
              CreateObject: (name: string) => {
                assert.strictEqual(name, "WScript.Shell");

                return {
                  Run: (command: string, style: number, wait: boolean) => {
                    commands.push(command);
                    assert.strictEqual(style, 0, "the child window must be hidden");
                    assert.isTrue(wait, "the task must wait for sync to finish");

                    return exit;
                  },
                };
              },
              Quit: (code: number) => codes.push(code),
            },
          });

          assert.deepStrictEqual(commands, [
            `cmd.exe /d /v:off /s /c "set "XDG_CONFIG_HOME=D:\\my config" && set "PATH=C:\\Program Files\\nodejs;%PATH%" && npx --yes @ponbac/token-ledger@latest sync --config "C:\\Users\\O'Neil & Malmö 🌍\\token-ledger.json""`,
          ]);
          assert.deepStrictEqual(codes, [exit]);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses paths cmd.exe would expand or cannot quote", () =>
    Effect.gen(function* () {
      for (const file of ["C:\\100%\\token-ledger.json", 'C:\\a"b\\token-ledger.json']) {
        const outcome = yield* taskScheduler("C:\\config\\token-ledger-sync.js")
          .install({
            at: "12:30",
            every: 2,
            nodeDirectory: "C:\\nodejs",
            configHome: Option.none(),
            dataHome: Option.none(),
            flags: ["--config", file],
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(outcome), file);
      }
    }),
  );

  it.effect("registers a daily task without repetition", () =>
    Effect.gen(function* () {
      const plan = describe(
        yield* taskScheduler("C:\\config\\token-ledger-sync.js").install({
          ...job,
          every: 24,
          nodeDirectory: "C:\\nodejs",
          configHome: Option.none(),
          flags: [],
        }),
      );

      assert.include(plan, "-Daily -At '07:05'");
      assert.notInclude(plan, "Repetition");
    }),
  );

  it.effect("keeps the launcher while the task exists, and removes it once the task is gone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(yield* fs.makeTempDirectoryScoped(), "token-ledger-sync.js");
      const task = taskScheduler(file);

      yield* fs.writeFileString(file, "launcher");

      for (const queryExit of [0, 1]) {
        const { spawner } = scheduler((line) => (line.includes("/Query") ? queryExit : 1));

        const outcome = yield* perform(task.uninstall).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.result,
        );

        assert.strictEqual(Result.isFailure(outcome), queryExit === 0);
        assert.strictEqual(yield* fs.exists(file), queryExit === 0);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(process.platform !== "win32")(
    "builds a trigger that Task Scheduler repeats through the day",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const recorded = scheduler(() => 0);

        yield* perform(
          yield* taskScheduler("C:\\config\\token-ledger-sync.js").install({
            ...job,
            nodeDirectory: "C:\\nodejs",
            configHome: Option.none(),
            flags: [],
          }),
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recorded.spawner));

        const script = Buffer.from(
          (recorded.lines[0] ?? "").split(" ").at(-1) ?? "",
          "base64",
        ).toString("utf16le");

        // Builds the trigger the way install does, without registering a task.
        const trigger = [
          ...script.split("\n").filter((line) => line.startsWith("$trigger")),
          '"$($trigger.StartBoundary) $($trigger.Repetition.Interval) $($trigger.Repetition.Duration)"',
        ].join("\n");

        const output = yield* spawner.string(
          ChildProcess.make("powershell.exe", powershellArguments(trigger), { stdin: "ignore" }),
        );

        assert.match(output.trim(), /T01:05:00\S* PT6H PT18H$/);
      }).pipe(Effect.provide(NodeServices.layer)),
    // A cold PowerShell takes seconds to load the ScheduledTasks module on CI runners.
    30_000,
  );

  it.live.skipIf(process.platform !== "win32")(
    "runs the generated launcher with Windows Script Host, forwarding arguments and exit codes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const directory = yield* fs.makeTempDirectoryScoped();
        const file = path.join(directory, "token-ledger-sync.js");
        const fixture = path.join(directory, "fixture.mjs");
        const receipt = path.join(directory, "receipt.json");
        const configHome = path.join(directory, "my config");
        const flags = ["--config", path.join(directory, "O'Neil & Malmö 🌍", "config.json")];

        yield* fs.writeFileString(
          path.join(directory, "npx.cmd"),
          `@"${process.execPath}" "${fixture}" %*\r\n@exit /b %errorlevel%\r\n`,
        );

        for (const exit of [0, 7]) {
          yield* fs.writeFileString(
            fixture,
            `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(receipt)}, JSON.stringify({ args: process.argv.slice(2), configHome: process.env.XDG_CONFIG_HOME }));\nprocess.exit(${exit});\n`,
          );

          yield* perform(
            yield* taskScheduler(file).install({
              at: "07:05",
              every: 2,
              nodeDirectory: directory,
              configHome: Option.some(configHome),
              dataHome: Option.none(),
              flags,
            }),
          ).pipe(
            Effect.provideService(
              ChildProcessSpawner.ChildProcessSpawner,
              scheduler(() => 0).spawner,
            ),
          );

          const code = yield* spawner.exitCode(
            ChildProcess.make("wscript.exe", ["//B", "//Nologo", "//E:JScript", file], {
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          );

          assert.strictEqual(code, exit);

          const result = yield* fs
            .readFileString(receipt)
            .pipe(
              Effect.flatMap(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(
                    Schema.Struct({ args: Schema.Array(Schema.String), configHome: Schema.String }),
                  ),
                ),
              ),
            );

          assert.deepStrictEqual(result, {
            args: ["--yes", "@ponbac/token-ledger@latest", "sync", ...flags],
            configHome,
          });
        }
      }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("reads a once-a-day task's time and changes only its trigger", () =>
    Effect.gen(function* () {
      const tasks = taskScheduler("C:\\config\\token-ledger-sync.js");
      const asked = scheduler(() => 0, "12:30\r\n");

      const job = daily(
        yield* tasks.dailyJob.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, asked.spawner),
        ),
      );

      assert.strictEqual(job.at, "12:30");
      assert.include(
        encoded(asked.lines[0] ?? ""),
        "Get-ScheduledTask -TaskName 'token-ledger sync'",
      );

      // The CI-only test below checks the trigger the task scheduler actually ends up with.
      const [retime, ...more] = job.retime(2);
      assert.lengthOf(more, 0);
      assert.include(
        retime === undefined ? "" : script(retime),
        "Set-ScheduledTask -TaskName 'token-ledger sync' -Trigger $trigger",
      );

      // A failed query is not an absent task, so the next sync asks again.
      const failed = yield* tasks.dailyJob.pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scheduler(() => 1).spawner),
        Effect.result,
      );

      assert.isTrue(Result.isFailure(failed));

      for (const output of ["", "PT2H\r\n"]) {
        const none = yield* tasks.dailyJob.pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            scheduler(() => 0, output).spawner,
          ),
        );

        assert.isTrue(Option.isNone(none));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  // Registers the real task, so it runs only on CI runners.
  it.live.skipIf(process.platform !== "win32" || process.env["CI"] === undefined)(
    "moves a registered once-a-day task to every 2 hours, keeping its action",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

        const powershell = (script: string) =>
          spawner.string(
            ChildProcess.make("powershell.exe", powershellArguments(script), { stdin: "ignore" }),
          );

        const tasks = taskScheduler("C:\\unused\\token-ledger-sync.js");

        yield* Effect.ignore(
          powershell("Unregister-ScheduledTask -TaskName 'token-ledger sync' -Confirm:$false"),
        );

        assert.isTrue(Option.isNone(yield* tasks.dailyJob));

        // As schedule install registered it before --every.
        yield* Effect.acquireRelease(
          powershell(
            [
              "$ErrorActionPreference = 'Stop'",
              "$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0'",
              "$trigger = New-ScheduledTaskTrigger -Daily -At '12:30'",
              "Register-ScheduledTask -TaskName 'token-ledger sync' -Action $action -Trigger $trigger -Force | Out-Null",
            ].join("\n"),
          ),
          () =>
            Effect.ignore(
              powershell("Unregister-ScheduledTask -TaskName 'token-ledger sync' -Confirm:$false"),
            ),
        );

        const job = daily(yield* tasks.dailyJob);

        assert.strictEqual(job.at, "12:30");

        yield* perform(job.retime(2));

        const registered = yield* powershell(
          `$task = Get-ScheduledTask -TaskName 'token-ledger sync'\n"$($task.Actions[0].Arguments) $($task.Triggers[0].StartBoundary) $($task.Triggers[0].Repetition.Interval)"`,
        );

        assert.match(registered.trim(), /^\/c exit 0 \S*T00:30:00\S* PT2H$/);
        assert.isTrue(Option.isNone(yield* tasks.dailyJob));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    60_000,
  );
});

suite("retiming a once-a-day schedule", () => {
  it.effect.skipIf(process.platform !== "linux")(
    "moves it once, and never after schedule.json records the schedule as chosen",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* fs.makeTempDirectoryScoped();
        const timer = path.join(config, "systemd", "user", "token-ledger-sync.timer");
        const settings = path.join(config, "token-ledger");
        let session = false;
        const { lines, spawner } = scheduler(() => (session ? 0 : 1));

        yield* fs.makeDirectory(path.dirname(timer), { recursive: true });
        yield* fs.writeFileString(timer, dailyTimer);

        const retime = retimeDailySchedule(settings).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { XDG_CONFIG_HOME: config } }),
          ),
        );

        // Without a user session, the timer is put back and nothing is recorded.
        assert.isTrue(Result.isFailure(yield* Effect.result(retime)));
        assert.strictEqual(yield* fs.readFileString(timer), dailyTimer);
        assert.isFalse(yield* fs.exists(path.join(settings, "schedule.json")));

        session = true;
        lines.length = 0;

        assert.deepStrictEqual(
          yield* retime,
          Option.some({ scheduler: "systemd user timer", at: "12:30", every: 2 }),
        );
        assert.lengthOf(lines, 2);

        // A daily schedule chosen afterwards, as with schedule install --every 24h, stays.
        yield* fs.writeFileString(timer, dailyTimer);

        assert.isTrue(Option.isNone(yield* retime));
        assert.lengthOf(lines, 2);
        assert.strictEqual(yield* fs.readFileString(timer), dailyTimer);
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
