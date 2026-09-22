import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const repositories = {
  effect: "https://github.com/Effect-TS/effect.git",
  t3code: "https://github.com/pingdotgg/t3code.git",
};
const [name, revision, ...extra] = process.argv.slice(2);
if (!Object.hasOwn(repositories, name ?? "") || !revision || extra.length) {
  console.error("Usage: bun run reference:update <effect|t3code> <tag-or-commit-or-branch>");
  process.exit(1);
}
const run = (args, capture = false) => execFileSync("git", args, {
  cwd: root, stdio: capture ? "pipe" : "inherit", encoding: "utf8",
});
if (run(["status", "--porcelain"], true).trim()) {
  console.error("Commit your changes before updating reference subtrees.");
  process.exit(1);
}
const prefix = `.reference/${name}`;
run(["fetch", "--depth=1", repositories[name], revision]);
run(["subtree", existsSync(`${root}/${prefix}`) ? "merge" : "add", `--prefix=${prefix}`, "FETCH_HEAD", "--squash"]);
