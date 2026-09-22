import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

const repositories = new Map([
  ["effect", "https://github.com/Effect-TS/effect.git"],
  ["t3code", "https://github.com/pingdotgg/t3code.git"],
]);

const [name, revision, ...extra] = process.argv.slice(2);

const repository = repositories.get(name ?? "");

if (!repository || !revision || extra.length) {
  console.error("Usage: bun run reference:update <effect|t3code> <tag-or-commit-or-branch>");
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

run(["fetch", "--depth=1", repository, revision]);

run([
  "subtree",
  existsSync(`${root}/${prefix}`) ? "merge" : "add",
  `--prefix=${prefix}`,
  "FETCH_HEAD",
  "--squash",
]);
