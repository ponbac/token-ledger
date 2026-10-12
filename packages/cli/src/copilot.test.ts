import { NodeServices } from "@effect/platform-node";
import { assert, describe as suite, it } from "@effect/vitest";
import { Effect, FileSystem, Option, Path, PlatformError, Result, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  type Enablement,
  type Host,
  StartupEdit,
  type Step,
  copilotSources,
  describe,
  exportsTo,
  perform,
  plan,
  startupEdit,
  summarize,
} from "./copilot.ts";

const both: Enablement = { cli: true, vscode: true, allowRoot: false };

const marker = "# Added by token-ledger copilot enable: Copilot CLI records its usage here.";

const exported = 'export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/usage.jsonl"';

/** A process stand-in that records each command line and answers with `output`, or cannot start. */
function processes(output: (line: string) => string | null) {
  const lines: string[] = [];

  const spawner = ChildProcessSpawner.make((command) => {
    const line = ChildProcess.isStandardCommand(command)
      ? [command.command, ...command.args].join(" ")
      : "pipeline";

    lines.push(line);
    const text = output(line);

    return text === null
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
            stdout: Stream.make(new TextEncoder().encode(text)),
            stderr: Stream.empty,
            all: Stream.empty,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
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

const noPrograms = processes(() => null).spawner;

/** The script a recorded `powershell.exe -EncodedCommand` line carries. */
const script = (line: string) =>
  Buffer.from(line.split(" ").at(-1) ?? "", "base64").toString("utf16le");

/** A fresh home with a VS Code settings folder, and the host that lives there. */
const machine = Effect.fn(function* (platform: NodeJS.Platform, shell: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped();
  const configHome = path.join(home, "config");
  const settings = path.join(configHome, "Code", "User", "settings.json");

  yield* fs.makeDirectory(path.dirname(settings), { recursive: true });

  const host: Host = {
    platform,
    home,
    uid: Option.some(1000),
    copilotHome: path.join(home, ".copilot"),
    shell: Option.some(shell),
    zshDirectory: Option.none(),
    configHome: Option.some(configHome),
    appData: Option.some(configHome),
    exporter: Option.none(),
  };

  return { host, home, settings };
});

/** Plans and carries out the changes, as a confirmed run does. */
const enable = Effect.fn(function* (host: Host, wanted: Enablement = both) {
  const { steps } = yield* plan(host, wanted);

  return yield* perform(steps);
});

const tags = (steps: ReadonlyArray<Step>) => steps.map((step) => `${step.part}:${step._tag}`);

suite("default Copilot sources", () => {
  it.effect("reads the export folder even when the variable names one file in it", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const directory = path.resolve("home", ".copilot", "otel");
      const sources = (file: string) => copilotSources(path, directory, Option.some(file));

      assert.deepStrictEqual(copilotSources(path, directory, Option.none()), [directory]);
      assert.deepStrictEqual(sources(path.join(directory, "usage.jsonl")), [directory]);
      assert.deepStrictEqual(sources(path.join(directory, "cli", "spans.db")), [directory]);
      assert.deepStrictEqual(sources(directory), [directory]);

      // A scan of the folder passes over other extensions, so such a file is named as well.
      assert.deepStrictEqual(sources(path.join(directory, "usage.log")), [
        directory,
        path.join(directory, "usage.log"),
      ]);

      // A file elsewhere is a deliberate choice of that one export, read alone as before.
      for (const elsewhere of [
        path.resolve("exports", "usage.jsonl"),
        path.join(`${directory}-old`, "usage.jsonl"),
        path.join(path.dirname(directory), "usage.jsonl"),
      ])
        assert.deepStrictEqual(sources(elsewhere), [elsewhere], elsewhere);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

suite("shell startup file", () => {
  const target = "/home/me/.copilot/otel/usage.jsonl";

  const edit = (contents: string) =>
    Option.getOrNull(startupEdit(contents, exported, exportsTo(target, "/home/me")));

  it("appends its two lines once, after whatever the file ends with", () => {
    assert.deepStrictEqual(edit(""), StartupEdit.Append({ text: `${marker}\n${exported}\n` }));
    assert.deepStrictEqual(
      edit("alias g=git"),
      StartupEdit.Append({ text: `\n\n${marker}\n${exported}\n` }),
    );
    assert.deepStrictEqual(
      edit("alias g=git\n"),
      StartupEdit.Append({ text: `\n${marker}\n${exported}\n` }),
    );
    assert.deepStrictEqual(edit(`alias g=git\n\n${marker}\n${exported}\n`), null);
  });

  it("accepts the line however a person wrote it by hand", () => {
    for (const line of [
      'export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/usage.jsonl"',
      "export COPILOT_OTEL_FILE_EXPORTER_PATH=${HOME}/.copilot/otel/usage.jsonl",
      "  export COPILOT_OTEL_FILE_EXPORTER_PATH=~/.copilot/otel/usage.jsonl",
      "export COPILOT_OTEL_FILE_EXPORTER_PATH='/home/me/.copilot/otel/usage.jsonl'",
    ])
      assert.deepStrictEqual(edit(`${line}\n`), null, line);
  });

  it("leaves a person's own line alone when it points elsewhere or cannot be read", () => {
    assert.deepStrictEqual(
      edit(
        `# export COPILOT_OTEL_FILE_EXPORTER_PATH=old\nexport COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/logs/copilot.jsonl"\n`,
      ),
      StartupEdit.Conflict({
        line: 2,
        text: 'export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/logs/copilot.jsonl"',
      }),
    );
    assert.deepStrictEqual(
      edit('export COPILOT_OTEL_FILE_EXPORTER_PATH="$(copilot-log-path)"\n'),
      StartupEdit.Conflict({
        line: 1,
        text: 'export COPILOT_OTEL_FILE_EXPORTER_PATH="$(copilot-log-path)"',
      }),
    );
  });

  it("does not take an assignment without export for an exported one", () => {
    // The shell would keep such a variable to itself, and Copilot would never see it.
    assert.deepStrictEqual(
      edit('COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/usage.jsonl"\n'),
      StartupEdit.Conflict({
        line: 1,
        text: 'COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/usage.jsonl"',
      }),
    );
  });

  it("corrects only the line it added itself", () => {
    assert.deepStrictEqual(
      edit(
        `alias g=git\n${marker}\nexport COPILOT_OTEL_FILE_EXPORTER_PATH=/old/usage.jsonl\nalias l=ls\n`,
      ),
      StartupEdit.Replace({ contents: `alias g=git\n${marker}\n${exported}\nalias l=ls\n` }),
    );
  });
});

suite("copilot enable on macOS and Linux", () => {
  it.effect("makes both changes, keeps the rest of settings.json, and changes nothing twice", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home, settings } = yield* machine("linux", "/usr/bin/zsh");
      const startup = path.join(home, ".zshrc");

      // No final newline: the export must not be glued onto the last command.
      yield* fs.writeFileString(startup, "alias g=git");
      yield* fs.writeFileString(
        settings,
        `{
    // appearance
    "workbench.colorTheme": "Dark", /* the good one */
    "github.copilot.chat.otel.exporterType": "otlp-http",
    "editor.rulers": [80, 120,],
}
`,
      );

      const { directory, steps } = yield* plan(host, both);

      assert.include(
        describe(steps),
        `"github.copilot.chat.otel.exporterType": "file" (now "otlp-http")`,
      );
      assert.include(describe(steps), exported);
      assert.isFalse(yield* fs.exists(directory));

      const results = yield* perform(steps);

      assert.deepStrictEqual(tags(results), ["folder:Done", "cli:Done", "vscode:Done"]);
      assert.isTrue(yield* fs.exists(directory));
      assert.strictEqual(
        yield* fs.readFileString(startup),
        `alias g=git\n\n${marker}\n${exported}\n`,
      );

      const outfile = path.join(directory, "vscode-chat.jsonl");

      assert.strictEqual(
        yield* fs.readFileString(settings),
        `{
    // appearance
    "workbench.colorTheme": "Dark", /* the good one */
    "github.copilot.chat.otel.exporterType": "file",
    "editor.rulers": [80, 120,],
    "github.copilot.chat.otel.enabled": true,
    "github.copilot.chat.otel.outfile": "${outfile}",
    "github.copilot.chat.otel.captureContent": false,
}
`,
      );
      assert.include(summarize(results, directory), "open a new terminal");
      assert.include(summarize(results, directory), "Reload Window");

      const before = [yield* fs.readFileString(startup), yield* fs.readFileString(settings)];
      const again = yield* plan(host, both);

      assert.deepStrictEqual(tags(again.steps), ["cli:Kept", "vscode:Kept"]);
      assert.deepStrictEqual(yield* perform(again.steps), again.steps);
      assert.deepStrictEqual(
        [yield* fs.readFileString(startup), yield* fs.readFileString(settings)],
        before,
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("picks the startup file each shell reads in a new terminal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cli = { cli: true, vscode: false, allowRoot: false };

      const linux = yield* machine("linux", "/bin/bash");

      yield* enable(linux.host, cli);
      assert.include(yield* fs.readFileString(path.join(linux.home, ".bashrc")), exported);

      // A login bash on macOS reads only the first profile it finds, never .bashrc.
      const mac = yield* machine("darwin", "/bin/bash");

      yield* fs.writeFileString(path.join(mac.home, ".profile"), "");
      yield* enable(mac.host, cli);
      assert.include(yield* fs.readFileString(path.join(mac.home, ".profile")), exported);
      assert.isFalse(yield* fs.exists(path.join(mac.home, ".bashrc")));

      const zsh = yield* machine("darwin", "/bin/zsh");
      const dotfiles = path.join(zsh.home, "dotfiles");

      yield* enable({ ...zsh.host, zshDirectory: Option.some(dotfiles) }, cli);
      assert.include(yield* fs.readFileString(path.join(dotfiles, ".zshrc")), exported);

      const fish = yield* machine("linux", "/usr/bin/fish");
      const snippet = path.join(fish.home, "config/fish/conf.d/token-ledger-copilot.fish");

      yield* enable(fish.host, cli);
      assert.strictEqual(
        yield* fs.readFileString(snippet),
        `${marker}\nset -gx COPILOT_OTEL_FILE_EXPORTER_PATH "$HOME/.copilot/otel/usage.jsonl"\n`,
      );
      assert.deepStrictEqual(tags((yield* plan(fish.host, cli)).steps), ["cli:Kept"]);

      // What the person adds to that file later is theirs, and survives a correction.
      yield* fs.writeFileString(
        snippet,
        `${marker}\nset -gx COPILOT_OTEL_FILE_EXPORTER_PATH /old/usage.jsonl\nalias ll "ls -la"\n`,
      );
      yield* enable(fish.host, cli);
      assert.strictEqual(
        yield* fs.readFileString(snippet),
        `${marker}\nset -gx COPILOT_OTEL_FILE_EXPORTER_PATH "$HOME/.copilot/otel/usage.jsonl"\nalias ll "ls -la"\n`,
      );

      // Fish reads the other conf.d files and config.fish too, so the person's own line in
      // one of them would win or be overridden; either way it is theirs to change.
      for (const own of ["config/fish/config.fish", "config/fish/conf.d/zzz-local.fish"]) {
        const file = path.join(fish.home, own);

        yield* fs.writeFileString(
          file,
          "set -gx COPILOT_OTEL_FILE_EXPORTER_PATH /logs/copilot.jsonl\n",
        );

        const { steps } = yield* plan(fish.host, cli);

        assert.deepStrictEqual(tags(steps), ["cli:ByHand"], own);
        assert.include(describe(steps), `${file} already sets`);
        yield* fs.remove(file);
      }
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("quotes a folder outside the home directory instead of using $HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home } = yield* machine("linux", "/bin/zsh");
      const copilotHome = path.join(yield* fs.makeTempDirectoryScoped(), "my copilot");

      yield* enable({ ...host, copilotHome }, { cli: true, vscode: false, allowRoot: false });

      assert.include(
        yield* fs.readFileString(path.join(home, ".zshrc")),
        `export COPILOT_OTEL_FILE_EXPORTER_PATH='${path.join(copilotHome, "otel", "usage.jsonl")}'\n`,
      );
      assert.deepStrictEqual(
        tags((yield* plan({ ...host, copilotHome }, { ...both, vscode: false })).steps),
        ["cli:Kept"],
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("finishes what it can and says exactly what is left to add by hand", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home, settings } = yield* machine("linux", "/usr/bin/nu");

      // An unknown shell, and a settings file that cannot be edited safely.
      yield* fs.writeFileString(settings, '{ "a": 1,, }');

      const unknown = yield* plan(host, both);
      const results = yield* perform(unknown.steps);

      assert.deepStrictEqual(tags(results), ["folder:Done", "cli:ByHand", "vscode:ByHand"]);
      assert.include(describe(results), `nu is not a shell this command sets up`);
      assert.include(describe(results), exported);
      assert.include(
        describe(results),
        `right after the opening {\n      "github.copilot.chat.otel.enabled": true,\n      "github.copilot.chat.otel.exporterType": "file",\n      "github.copilot.chat.otel.outfile": "${path.join(unknown.directory, "vscode-chat.jsonl")}",\n      "github.copilot.chat.otel.captureContent": false,`,
      );
      assert.strictEqual(yield* fs.readFileString(settings), '{ "a": 1,, }');

      // A startup file that sets the variable elsewhere is the person's to change.
      const conflicting = yield* machine("linux", "/bin/zsh");

      yield* fs.writeFileString(
        path.join(conflicting.home, ".zshrc"),
        "export COPILOT_OTEL_FILE_EXPORTER_PATH=/logs/copilot.jsonl\n",
      );
      assert.deepStrictEqual(tags(yield* enable(conflicting.host)), [
        "folder:Done",
        "cli:ByHand",
        "vscode:Done",
      ]);
      assert.strictEqual(
        yield* fs.readFileString(path.join(conflicting.home, ".zshrc")),
        "export COPILOT_OTEL_FILE_EXPORTER_PATH=/logs/copilot.jsonl\n",
      );

      // No VS Code at all.
      yield* fs.remove(path.join(home, "config"), { recursive: true });
      assert.deepStrictEqual(tags((yield* plan(host, { ...both, cli: false })).steps), [
        "vscode:ByHand",
      ]);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("does not overwrite a file that changed after the plan was shown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home, settings } = yield* machine("linux", "/bin/zsh");
      const startup = path.join(home, ".zshrc");
      const own = "alias g=git\nexport COPILOT_OTEL_FILE_EXPORTER_PATH=/logs/copilot.jsonl\n";

      yield* fs.writeFileString(settings, "{}");
      yield* fs.writeFileString(startup, "alias g=git\n");

      const { steps } = yield* plan(host, both);

      // While the question waited, an editor saved both files.
      yield* fs.writeFileString(settings, '{ "editor.fontSize": 14 }');
      yield* fs.writeFileString(startup, own);

      const results = yield* perform(steps);

      assert.deepStrictEqual(tags(results), ["folder:Done", "cli:ByHand", "vscode:ByHand"]);
      assert.include(describe(results), "changed while this command was waiting");
      assert.strictEqual(yield* fs.readFileString(settings), '{ "editor.fontSize": 14 }');
      assert.strictEqual(yield* fs.readFileString(startup), own);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("leaves a file whole when its replacement cannot be written", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, settings } = yield* machine("linux", "/bin/zsh");

      const original =
        '{\n  "github.copilot.chat.otel.enabled": false,\n  "editor.fontSize": 14\n}\n';

      yield* fs.writeFileString(settings, original);

      // A full disk: the new text stops part-way, wherever it is being written.
      const full: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (file, contents, options) =>
          fs.writeFileString(file, contents.slice(0, 10), options).pipe(
            Effect.andThen(
              Effect.fail(
                PlatformError.badArgument({
                  module: "FileSystem",
                  method: "writeFileString",
                  description: "fixture: no space left on device",
                }),
              ),
            ),
          ),
      };

      const results = yield* enable(host, { ...both, cli: false }).pipe(
        Effect.provideService(FileSystem.FileSystem, full),
      );

      assert.deepStrictEqual(tags(results), ["folder:Done", "vscode:ByHand"]);
      assert.strictEqual(yield* fs.readFileString(settings), original);
      assert.deepStrictEqual(yield* fs.readDirectory(path.dirname(settings)), ["settings.json"]);

      // The hand-off names the line to change, so pasting cannot leave the old value in force.
      assert.include(describe(results), "change its line if the setting is already there");
      assert.include(describe(results), '"github.copilot.chat.otel.enabled": true,');
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("writes through a link to the file it names, and keeps that file's permissions", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home, settings } = yield* machine("linux", "/bin/zsh");
      const dotfiles = path.join(home, "dotfiles", "settings.json");

      yield* fs.makeDirectory(path.dirname(dotfiles));
      yield* fs.writeFileString(dotfiles, "{}", { mode: 0o600 });
      yield* fs.symlink(dotfiles, settings);

      yield* enable(host, { ...both, cli: false });

      assert.strictEqual(yield* fs.readLink(settings), dotfiles);
      assert.include(yield* fs.readFileString(dotfiles), "github.copilot.chat.otel.outfile");
      assert.strictEqual((yield* fs.stat(dotfiles)).mode & 0o777, 0o600);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("stops when the export folder's path is taken by a file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home } = yield* machine("linux", "/bin/zsh");

      yield* fs.makeDirectory(path.join(home, ".copilot"));
      yield* fs.writeFileString(path.join(home, ".copilot", "otel"), "");

      const refused = yield* plan(host, both).pipe(Effect.result);

      assert.match(Result.isFailure(refused) ? refused.failure.message : "", /is not a folder/);
      assert.isFalse(yield* fs.exists(path.join(home, ".zshrc")));
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("warns when this terminal's variable points outside the folder being set up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home } = yield* machine("linux", "/bin/zsh");

      const elsewhere = {
        ...host,
        exporter: Option.some(path.join(home, "logs", "copilot.jsonl")),
      };

      // Only VS Code is set up, so the variable stays as it is and hides VS Code's export.
      const chat = yield* plan(elsewhere, { ...both, cli: false });

      assert.deepStrictEqual(tags(chat.steps), ["folder:Change", "vscode:Change", "cli:Note"]);
      assert.include(describe(chat.steps), "read only that file");

      // Setting up Copilot CLI too only changes new terminals; this one still reads that file.
      const cli = yield* plan(elsewhere, both);

      assert.deepStrictEqual(tags(cli.steps), [
        "folder:Change",
        "cli:Change",
        "vscode:Change",
        "cli:Note",
      ]);
      assert.include(describe(cli.steps), "Run them from a new terminal");
      assert.isFalse(yield* fs.exists(path.join(home, ".zshrc")));

      // Nor does a startup file that is already right settle what this terminal has.
      yield* enable(host);
      assert.deepStrictEqual(tags((yield* plan(elsewhere, both)).steps), [
        "cli:Kept",
        "vscode:Kept",
        "cli:Note",
      ]);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("gives VS Code Insiders its own file and warns about the affected release", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { host, home } = yield* machine("darwin", "/bin/zsh");
      const support = path.join(home, "Library", "Application Support");

      yield* fs.makeDirectory(path.join(support, "Code", "User"), { recursive: true });
      yield* fs.makeDirectory(path.join(support, "Code - Insiders", "User"), { recursive: true });

      const { lines, spawner } = processes((line) =>
        line.startsWith("/Applications/") ? "1.139.1\nabcdef\narm64\n" : null,
      );

      const results = yield* enable(host, { ...both, cli: false }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      assert.deepStrictEqual(tags(results), [
        "folder:Done",
        "vscode:Done",
        "vscode:Done",
        "vscode:Note",
      ]);
      assert.include(describe(results), "VS Code 1.139.1 is installed");
      assert.include(
        yield* fs.readFileString(path.join(support, "Code", "User", "settings.json")),
        "/.copilot/otel/vscode-chat.jsonl",
      );
      assert.include(
        yield* fs.readFileString(path.join(support, "Code - Insiders", "User", "settings.json")),
        "/.copilot/otel/vscode-insiders-chat.jsonl",
      );
      assert.deepStrictEqual(lines, [
        "code --version",
        "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code --version",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses to run as root unless told that root is the account to set up", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { host, home } = yield* machine("linux", "/bin/bash");
      const root = { ...host, uid: Option.some(0) };

      const refused = yield* plan(root, both).pipe(Effect.result);

      assert.match(Result.isFailure(refused) ? refused.failure.message : "", /without sudo/);
      assert.deepStrictEqual(yield* fs.readDirectory(home), ["config"]);
      assert.deepStrictEqual(tags(yield* enable(root, { ...both, allowRoot: true })), [
        "folder:Done",
        "cli:Done",
        "vscode:Done",
      ]);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noPrograms),
      Effect.provide(NodeServices.layer),
    ),
  );
});

suite("copilot enable on Windows", () => {
  const cli = { cli: true, vscode: false, allowRoot: false };
  const stored = (value: string) => `value=${Buffer.from(value, "utf8").toString("base64")}`;

  it.effect("sets the user environment variable through PowerShell, once", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { host, home } = yield* machine("win32", "");
      const target = path.join(home, ".copilot", "otel", "usage.jsonl");

      const unset = processes(() => stored(""));

      const results = yield* enable(host, cli).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, unset.spawner),
      );

      assert.deepStrictEqual(tags(results), ["folder:Done", "cli:Done"]);
      assert.include(
        script(unset.lines[0] ?? ""),
        "GetEnvironmentVariable('COPILOT_OTEL_FILE_EXPORTER_PATH', 'User')",
      );
      assert.include(
        script(unset.lines[1] ?? ""),
        `[Environment]::SetEnvironmentVariable('COPILOT_OTEL_FILE_EXPORTER_PATH', '${target}', 'User')`,
      );

      // Windows paths compare without regard to case or the direction of slashes.
      const set = processes(() => stored(target.toUpperCase().replaceAll("/", "\\")));

      const again = yield* plan(host, cli).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, set.spawner),
      );

      assert.deepStrictEqual(tags(again.steps), ["cli:Kept"]);
      assert.strictEqual(set.lines.length, 1);

      const elsewhere = yield* plan(host, cli).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          processes(() => stored("D:\\Björn\\copilot.jsonl")).spawner,
        ),
      );

      assert.include(describe(elsewhere.steps), `${target} (now D:\\Björn\\copilot.jsonl)`);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves the variable to the person when PowerShell cannot be used", () =>
    Effect.gen(function* () {
      for (const spawner of [noPrograms, processes(() => "Access denied").spawner]) {
        const { host } = yield* machine("win32", "");

        const results = yield* enable(host, both).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );

        assert.deepStrictEqual(tags(results), ["folder:Done", "cli:ByHand", "vscode:Done"]);
        assert.include(
          describe(results),
          "[Environment]::SetEnvironmentVariable('COPILOT_OTEL_FILE_EXPORTER_PATH'",
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
