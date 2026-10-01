import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import manifest from "../package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

const effectRepository = "https://github.com/Effect-TS/effect.git";

const nestedEffectPrefix = ".reference/t3code/.repos/effect";

const legacyNestedEffectPrefix = ".reference/t3code/.repos/effect-smol";

const nestedEffectReferenceFiles = [
  ".reference/t3code/AGENTS.md",
  ".reference/t3code/scripts/lib/reference-repos.ts",
  ".reference/t3code/scripts/sync-reference-repos.test.ts",
  ".reference/t3code/apps/server/src/pullRequest/pullRequestViewedFiles.ts",
];

const repositories = new Map([
  ["effect", effectRepository],
  ["effect-t3code", effectRepository],
  ["t3code", "https://github.com/pingdotgg/t3code.git"],
]);

const [name, revision, ...extra] = process.argv.slice(2);

const repository = repositories.get(name ?? "");

if (!repository || !revision || extra.length) {
  console.error(
    "Usage: bun run reference:update <effect|effect-t3code|t3code> <tag-or-commit-or-branch>",
  );
  process.exit(1);
}

/** @param {string[]} args @param {boolean} [capture] */
const run = (args, capture = false) =>
  execFileSync("git", args, {
    cwd: root,
    stdio: capture ? "pipe" : "inherit",
    encoding: "utf8",
  });

if (run(["status", "--porcelain"], true).trim()) {
  console.error("Commit your changes before updating reference subtrees.");
  process.exit(1);
}

const prefix = `.reference/${name}`;

/** Refreshes the nested Effect snapshot and its canonical paths, recording provenance. */
const refreshNestedEffect = (/** @type {string} */ effectRevision) => {
  run(["fetch", "--depth=1", effectRepository, effectRevision]);

  const upstreamCommit = run(["rev-parse", "FETCH_HEAD"], true).trim();
  const upstreamTree = run(["rev-parse", "FETCH_HEAD^{tree}"], true).trim();

  if (existsSync(`${root}/${legacyNestedEffectPrefix}`)) {
    run(["rm", "-r", "--quiet", legacyNestedEffectPrefix]);
  }

  const matchesUpstream =
    existsSync(`${root}/${nestedEffectPrefix}`) &&
    run(["rev-parse", `HEAD:${nestedEffectPrefix}`], true).trim() === upstreamTree;

  if (!matchesUpstream && existsSync(`${root}/${nestedEffectPrefix}`)) {
    run(["rm", "-r", "--quiet", nestedEffectPrefix]);
  }

  if (!matchesUpstream) {
    run(["read-tree", `--prefix=${nestedEffectPrefix}/`, "-u", upstreamCommit]);
  }

  for (const referenceFile of nestedEffectReferenceFiles) {
    const referencePath = `${root}/${referenceFile}`;

    if (!existsSync(referencePath)) continue;

    const original = readFileSync(referencePath, "utf8");
    const canonical = original.replaceAll("effect-smol", "effect");

    if (canonical === original) continue;

    writeFileSync(referencePath, canonical);
    run(["add", referenceFile]);
  }

  if (!run(["diff", "--cached", "--name-only"], true).trim()) return;

  run([
    "commit",
    "--quiet",
    "-m",
    `chore(references): refresh nested Effect source to ${effectRevision}`,
    "-m",
    `Deliberate Effect-source overlay and canonical reference paths inside the T3 Code subtree; unrelated files retain their imported revision.\n\nReference-prefix: ${nestedEffectPrefix}\nReference-upstream: ${effectRepository}\nReference-revision: ${effectRevision}\nReference-commit: ${upstreamCommit}`,
  ]);
};

if (name === "effect-t3code") {
  refreshNestedEffect(revision);
} else {
  run(["fetch", "--depth=1", repository, revision]);

  run([
    "subtree",
    existsSync(`${root}/${prefix}`) ? "merge" : "add",
    `--prefix=${prefix}`,
    "FETCH_HEAD",
    "--squash",
  ]);

  refreshNestedEffect(name === "effect" ? revision : `effect@${manifest.devDependencies.effect}`);
}
