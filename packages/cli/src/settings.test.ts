import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, FileSystem, Path, Result, Schema } from "effect";

import { ServerUrl, loadMachine } from "./settings.ts";

it.effect("keeps one machine identity, honors edited labels, and never replaces a bad file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.makeTempDirectoryScoped(), "token-ledger");
    const file = path.join(directory, "machine.json");

    const created = yield* loadMachine(directory);
    assert.deepStrictEqual(yield* loadMachine(directory), created);

    yield* fs.writeFileString(file, JSON.stringify({ ...created, label: "renamed" }));
    assert.deepStrictEqual(yield* loadMachine(directory), { ...created, label: "renamed" });

    yield* fs.writeFileString(file, "{");
    assert.isTrue(Result.isFailure(yield* loadMachine(directory).pipe(Effect.result)));
    assert.strictEqual(yield* fs.readFileString(file), "{");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("concurrent first runs publish complete identities and adopt the winner", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(yield* fs.makeTempDirectoryScoped(), "token-ledger");
    const opened = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();

    const delayed: FileSystem.FileSystem = {
      ...fs,
      writeFileString: (file, contents, options) =>
        Effect.gen(function* () {
          const handle = yield* fs.open(file, options);
          yield* Deferred.succeed(opened, undefined);
          yield* Deferred.await(resume);
          yield* handle.writeAll(new TextEncoder().encode(contents));
        }).pipe(Effect.scoped),
    };

    const first = yield* loadMachine(directory).pipe(
      Effect.provideService(FileSystem.FileSystem, delayed),
      Effect.result,
      Effect.forkChild,
    );

    yield* Deferred.await(opened);
    const second = yield* loadMachine(directory).pipe(Effect.result);
    yield* Deferred.succeed(resume, undefined);
    const original = yield* Fiber.join(first);

    assert.isTrue(Result.isSuccess(second));
    assert.deepStrictEqual(original, second);
    assert.deepStrictEqual(yield* fs.readDirectory(directory), ["machine.json"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("only accepts servers that keep the token off plain HTTP networks", () => {
  const decode = Schema.decodeUnknownResult(ServerUrl);

  for (const url of ["https://toki.example/api", "http://localhost:3000", "http://127.0.0.1:8080"])
    assert.isTrue(Result.isSuccess(decode(url)), url);

  for (const url of ["http://toki.example", "ftp://toki.example", "not a url"])
    assert.isTrue(Result.isFailure(decode(url)), url);
});
