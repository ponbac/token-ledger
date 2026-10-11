import { NodeServices } from "@effect/platform-node";
import { assert, describe as suite, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type ScheduledSync,
  describe,
  launchAgent,
  perform,
  systemdTimer,
  taskScheduler,
} from "./schedule.ts";

// A path with every character the POSIX schedulers quote: space, `'`, `"`, `$`, `%`, `\`, `&`, `<`.
const awkward = `/tmp/my cfg/it's $HOME %h "x" \\ & <b>.json`;

const job: ScheduledSync = {
  at: "07:05",
  nodeDirectory: "/opt/node 24/bin",
  configHome: Option.some("/home/me/my config"),
  flags: ["--config", awkward, "--time-zone", "Europe/Stockholm"],
};

/** A scheduler stand-in that records each command line and exits as `exit` decides. */
function scheduler(exit: (line: string) => number | null) {
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
            stdout: Stream.empty,
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

suite("systemd user timer", () => {
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
        `ExecStart=/bin/sh -lc "export XDG_CONFIG_HOME='/home/me/my config'; export PATH='/opt/node 24/bin':\\"$$PATH\\"; exec npx --yes @ponbac/token-ledger@latest sync --config '/tmp/my cfg/it'\\\\''s $$HOME %%h \\"x\\" \\\\ & <b>.json' --time-zone Europe/Stockholm"\n`,
      );
      assert.include(
        yield* fs.readFileString(path.join(directory, "token-ledger-sync.timer")),
        "OnCalendar=*-*-* 07:05:00\nPersistent=true\n",
      );
      assert.deepStrictEqual(lines, [
        "systemctl --user daemon-reload",
        "systemctl --user daemon-reload",
        "systemctl --user enable token-ledger-sync.timer",
        "systemctl --user restart token-ledger-sync.timer",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
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

      const { lines, spawner } = scheduler(() => 1);

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

  it.effect("fails an uninstall that leaves the timer running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      // systemd refuses to stop the timer, which therefore still reports itself active.
      const { spawner } = scheduler((line) => (line.includes("is-active") ? 0 : 1));

      const outcome = yield* perform(systemdTimer(directory).uninstall).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.result,
      );

      assert.match(Result.isFailure(outcome) ? outcome.failure.message : "", /still active/);
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
        `<string>export XDG_CONFIG_HOME='/home/me/my config'; export PATH='/opt/node 24/bin':"$PATH"; exec npx --yes @ponbac/token-ledger@latest sync --config '/tmp/my cfg/it'\\''s $HOME %h "x" \\ &amp; &lt;b&gt;.json' --time-zone Europe/Stockholm</string>`,
      );
      assert.match(contents, /<key>Hour<\/key>\s*<integer>7<\/integer>/);
      assert.match(contents, /<key>Minute<\/key>\s*<integer>5<\/integer>/);
      assert.deepStrictEqual(lines, [
        "launchctl bootout gui/501/com.github.ponbac.token-ledger.sync",
        `launchctl bootstrap gui/501 ${plist}`,
      ]);
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
});

suite("Task Scheduler task", () => {
  it.effect("registers the script it shows, quoting paths for cmd.exe and PowerShell", () =>
    Effect.gen(function* () {
      const { lines, spawner } = scheduler(() => 0);

      const actions = yield* taskScheduler.install({
        at: "07:05",
        nodeDirectory: "C:\\Program Files\\nodejs",
        configHome: Option.some("D:\\my config"),
        flags: ["--config", "C:\\Users\\O'Neil & Co\\token-ledger.json"],
      });

      yield* perform(actions).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const [program, ...args] = (lines[0] ?? "").split(" ");
      const script = Buffer.from(args.at(-1) ?? "", "base64").toString("utf16le");

      assert.strictEqual(program, "powershell.exe");
      assert.include(describe(actions), script);
      assert.include(
        script,
        `-Argument '/d /v:off /s /c "set "XDG_CONFIG_HOME=D:\\my config" && set "PATH=C:\\Program Files\\nodejs;%PATH%" && npx --yes @ponbac/token-ledger@latest sync --config "C:\\Users\\O''Neil & Co\\token-ledger.json""'`,
      );
      assert.include(script, "-Daily -At '07:05'");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses paths cmd.exe would expand or cannot quote", () =>
    Effect.gen(function* () {
      for (const file of ["C:\\100%\\token-ledger.json", 'C:\\a"b\\token-ledger.json']) {
        const outcome = yield* taskScheduler
          .install({
            at: "12:30",
            nodeDirectory: "C:\\nodejs",
            configHome: Option.none(),
            flags: ["--config", file],
          })
          .pipe(Effect.result);

        assert.isTrue(Result.isFailure(outcome), file);
      }
    }),
  );
});
