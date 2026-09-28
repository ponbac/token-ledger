import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Schema } from "effect";

import metadata from "../packages/cli/package.json" with { type: "json" };

const root = fileURLToPath(new URL("../", import.meta.url));

const destination = join(root, "dist/npm");

const bundle = join(root, "packages/cli/dist");

const decodeBuild = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      inputs: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

const decodeDependency = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
    }),
  ),
);

// Only files explicitly copied here can enter the published package.
rmSync(destination, { recursive: true, force: true });

mkdirSync(join(destination, "dist"), { recursive: true });

copyFileSync(join(bundle, "main.js"), join(destination, "dist/main.js"));

chmodSync(join(destination, "dist/main.js"), 0o755);

for (const file of ["README.md", "LICENSE"])
  copyFileSync(join(root, file), join(destination, file));

const { name, version, description, license, engines, repository, homepage, bugs, bin, type } =
  metadata;

writeFileSync(
  join(destination, "package.json"),
  JSON.stringify(
    {
      name,
      version,
      description,
      license,
      engines,
      repository,
      homepage,
      bugs,
      bin,
      type,
      files: ["dist/main.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
    },
    null,
    2,
  ) + "\n",
);

// Preserve the licenses of the dependencies actually included by the bundler.
/** @type {Set<string>} */
const dependencies = new Set();

for (const input of Object.keys(
  decodeBuild(readFileSync(join(bundle, "meta.json"), "utf8")).inputs,
)) {
  if (!input.replaceAll("\\", "/").includes("node_modules/")) continue;
  let directory = dirname(resolve(root, input));

  while (!existsSync(join(directory, "package.json"))) {
    const parent = dirname(directory);

    if (parent === directory) throw new Error("Bundled dependency has no package metadata.");
    directory = parent;
  }

  dependencies.add(directory);
}

const notices = [];

for (const directory of [...dependencies].toSorted((a, b) => a.localeCompare(b))) {
  const dependency = decodeDependency(readFileSync(join(directory, "package.json"), "utf8"));

  const licenses = readdirSync(directory).filter((file) =>
    /^(licen[cs]e|notice|copying)/i.test(file),
  );

  if (licenses.length === 0)
    throw new Error(`Missing license for bundled dependency ${dependency.name}.`);
  notices.push(
    `${dependency.name}@${dependency.version}\n\n${licenses
      .toSorted((a, b) => a.localeCompare(b))
      .map((file) => readFileSync(join(directory, file), "utf8"))
      .join("\n")}\n`,
  );
}

writeFileSync(join(destination, "THIRD_PARTY_NOTICES.txt"), notices.join("\n---\n\n"));
