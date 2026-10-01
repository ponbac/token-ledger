export interface ReferenceRepo {
  readonly id: string;
  readonly prefix: string;
  readonly repository: string;
  readonly latestRef: string;
  readonly pinnedRef?: string;
  readonly versionSourcePath: string;
  readonly packageVersionPath: ReadonlyArray<string>;
  readonly versionTagPrefix: string;
}

export const referenceRepos: ReadonlyArray<ReferenceRepo> = [
  {
    id: "effect",
    prefix: ".repos/effect",
    repository: "https://github.com/Effect-TS/effect.git",
    latestRef: "main",
    pinnedRef: "effect@4.0.0",
    versionSourcePath: "pnpm-workspace.yaml",
    packageVersionPath: ["catalog", "effect"],
    versionTagPrefix: "effect@",
  },
  {
    id: "alchemy-effect",
    prefix: ".repos/alchemy-effect",
    repository: "https://github.com/alchemy-run/alchemy-effect.git",
    latestRef: "main",
    versionSourcePath: "infra/relay/package.json",
    packageVersionPath: ["dependencies", "alchemy"],
    versionTagPrefix: "v",
  },
];
