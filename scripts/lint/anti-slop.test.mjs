import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import config from "../../.oxlintrc.json" with { type: "json" };

const root = fileURLToPath(new URL("../../", import.meta.url));

const binary = join(root, "node_modules/.bin/oxlint");

/** Run real Oxlint plugins against disposable synthetic source, without executing that source.
 * @param {string} source
 * @param {string} [name]
 * @param {boolean} [aliasOnly]
 */
function lint(source, name = "fixture.ts", aliasOnly = false) {
  const directory = mkdtempSync(join(tmpdir(), "token-ledger-lint-"));

  try {
    const configuration = join(directory, "oxlint.json");
    const file = join(directory, name);

    writeFileSync(
      configuration,
      JSON.stringify({
        ...config,
        categories: aliasOnly ? { correctness: "off" } : config.categories,
        rules: aliasOnly
          ? {
              "anti-slop/no-object-parameters": "error",
              "anti-slop/no-unknown-returns": "error",
              "anti-slop/no-unknown-type-aliases": "error",
            }
          : config.rules,
        options: { ...config.options, typeAware: false },
        jsPlugins: config.jsPlugins.map((path) => join(root, path)),
      }),
    );
    writeFileSync(file, source);

    const result = spawnSync(
      binary,
      ["--config", configuration, "--no-ignore", "--format", "unix", file],
      {
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    assert.equal(result.error, undefined);

    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

await test("enables all 18 generic and five Effect rules", () => {
  const rules = Object.entries(config.rules);
  const generic = rules.filter(([key]) => key.startsWith("anti-slop/"));
  const effect = rules.filter(([key]) => key.startsWith("anti-slop-effect/"));

  assert.equal(generic.length, 18);
  assert.equal(effect.length, 5);

  for (const [, severity] of [...generic, ...effect]) assert.equal(severity, "error");

  for (const override of config.overrides) {
    for (const [rule, severity] of Object.entries(override.rules)) {
      if (rule.startsWith("anti-slop/") || rule.startsWith("anti-slop-effect/"))
        assert.equal(severity, "error", `${rule} must remain enabled in overrides`);
    }
  }
});

await test("generic rules reject lost type evidence and module mocking", () => {
  const result = lint(`
import { mock } from "bun:test";

export type Hidden = unknown;

export function accept(value: object) {
  return value;
}

mock.module("./dependency", () => ({}));
`);

  assert.equal(result.status, 1);
  assert.match(result.output, /anti-slop\(no-unknown-type-aliases\)/);
  assert.match(result.output, /anti-slop\(no-object-parameters\)/);
  assert.match(result.output, /anti-slop\(no-module-mocking\)/);
});

await test("all five Effect rules reject their production targets", () => {
  const cases = [
    [
      "no-service-constructor-imports",
      'import { makeCache } from "./cache";\n\nexport { makeCache };',
    ],
    ["no-manual-tagged-construction", 'export const value = { _tag: "Ready" };'],
    ["no-manual-tag-comparison", 'export const value = span._tag === "Ready";'],
    [
      "no-manual-effect-error-tag",
      'Effect.catch((error) => error._tag === "Missing" ? recover(error) : Effect.fail(error));',
    ],
    ["prefer-effect-match", 'export const value = kind === "a" ? 1 : kind === "b" ? 2 : 3;'],
  ];

  for (const [rule, source] of cases) {
    assert.ok(rule && source);

    const result = lint(source);

    assert.equal(result.status, 1);
    assert.ok(result.output.includes(`anti-slop-effect(${rule})`), result.output);
  }
});

await test("manual tagged construction is rejected in production and test code", () => {
  const source = 'export const value = { _tag: "Ready" };\n';

  assert.equal(lint(source).status, 1);

  for (const name of ["fixture.test.ts", "fixture.spec.ts"]) {
    const result = lint(source, name);
    assert.equal(result.status, 1);
    assert.match(result.output, /anti-slop-effect\(no-manual-tagged-construction\)/);
  }
});

await test("long alias chains remain fast and generic shadowing remains valid", () => {
  const chain = Array.from(
    { length: 3000 },
    (_, i) => `type Alias${i} = ${i === 2999 ? "string" : `Alias${i + 1}`};`,
  ).join("\n");

  const result = lint(
    `${chain}\n\nexport function read(value: Alias0): Alias0 {\n  return value;\n}\n`,
    "fixture.ts",
    true,
  );

  assert.equal(result.status, 0, result.output);
  assert.equal(
    lint(
      "export type Input = object;\n\nexport function read<Input>(value: Input) {\n  return value;\n}\n",
    ).status,
    0,
  );
});
