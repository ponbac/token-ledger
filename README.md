# Token Ledger

Local token consumption and estimated API cost, grouped by project across coding agents.

An Effect v4 core reads provider histories and produces structured reports. An Effect
CLI handles discovery, configuration, and terminal/CSV/JSON output. You do not need
T3 Code, provider API keys, or a company dashboard to use it.

**Dollar figures are API-equivalent estimates, not subscription expenses.** Reports
keep input, cache-read, cache-write, and output tokens separate. Unknown model or
cache prices stay unknown; the known subtotal remains available.

## Quick start

Requires **Node.js 24 or newer**. Run without cloning or building:

```sh
npx @ponbac/token-ledger@latest report --provider copilot
pnpx @ponbac/token-ledger@latest report --provider copilot
bunx @ponbac/token-ledger@latest report --provider copilot
```

These are equivalent alternatives; choose the package manager you already use.
The npm package contains a bundled CLI with no runtime dependencies or install
scripts. `bunx` uses the Node shebang, so Node 24+ is still required.

The default window is the current calendar month through today, in UTC. Read every
supported source by omitting `--provider`. Configure Copilot collection before
starting sessions as described below; installing the CLI does not enable telemetry.

```sh
npx @ponbac/token-ledger@latest report --since 2026-09-01 --until 2026-09-30 --format csv > usage.csv
npx @ponbac/token-ledger@latest report --provider codex --json > report.json
npx @ponbac/token-ledger@latest config-example > token-ledger.json
```

`--json` is a shortcut for `--format json` and takes precedence over `--format`.
JSON stdout contains only the structured report, including coverage and pricing
metadata; diagnostics go to stderr. Unknown costs are `null`, not zero.
Terminal reports sort projects by descending API estimate, with color when supported.
The `Cost %` column shows each project’s share of the total API estimate. With
incomplete pricing, `Known cost %` shows shares of the priced subtotal; unknown
costs are excluded. A zero subtotal shows `—`. Percentages use unrounded costs
and are displayed to one decimal place, so rounded project shares may not sum
exactly to 100%.
Set `NO_COLOR=1` for plain output. Run `--help` for options.

### Run from source

Install [Bun](https://bun.sh), then:

```sh
git clone https://github.com/ponbac/token-ledger.git
cd token-ledger
bun install --frozen-lockfile
bun run dev report --provider codex
```

Examples below use `bun run dev`; replace that prefix with
`npx @ponbac/token-ledger@latest`, `pnpx @ponbac/token-ledger@latest`, or `bunx @ponbac/token-ledger@latest`
when using the published package.

Build a standalone Node executable and the npm package directory:

```sh
bun run build
node packages/cli/dist/main.js report --provider codex
```

### Windows

The packaged CLI is tested in CI on Windows, macOS, and Linux using Node.js 24.
Those checks cover package installation and reports from synthetic histories; live
provider discovery has been verified on Linux. To run from source on Windows with
Git and Bun installed, use PowerShell:

```powershell
git clone https://github.com/ponbac/token-ledger.git
cd token-ledger
bun install --frozen-lockfile
bun run dev report
```

To build with Bun and run with Node.js:

```powershell
bun run build
node packages/cli/dist/main.js report
```

## Collection coverage

| Provider                   | Default input                                          | Coverage                                                                     |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Codex                      | `~/.codex/sessions` and `archived_sessions`            | Rollout token events, model switches, session and working-directory metadata |
| Claude Code                | `~/.claude/projects`                                   | Assistant usage records; repeated message blocks counted once                |
| Grok Build                 | `~/.grok/sessions/**/updates.jsonl`                    | Saved completed turns and their model breakdowns                             |
| Copilot CLI / VS Code Chat | `~/.copilot/otel` or `COPILOT_OTEL_FILE_EXPORTER_PATH` | JSONL request spans, VS Code inference events, and SQLite span exports       |

`CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, and `COPILOT_HOME` override the usual
homes. Configuration supports additional accounts, machines' exported histories,
and arbitrary source directories. Histories are opened read-only, including work
performed outside T3 Code.

Copilot CLI requires enabling its own file export **before** a session starts:

```sh
mkdir -p ~/.copilot/otel
export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/otel/usage.jsonl"
copilot
```

On Windows, use PowerShell:

```powershell
New-Item -ItemType Directory -Force "$HOME\.copilot\otel"
$env:COPILOT_OTEL_FILE_EXPORTER_PATH = "$HOME\.copilot\otel\usage.jsonl"
copilot
```

Setting the file path automatically enables telemetry export to that local file;
no separate toggle or telemetry server is needed. Prompt and response content
capture is off by default.

The commands above set the variable for the current shell. To persist it for future
Windows terminals, also run:

```powershell
[Environment]::SetEnvironmentVariable(
  "COPILOT_OTEL_FILE_EXPORTER_PATH",
  "$HOME\.copilot\otel\usage.jsonl",
  "User"
)
```

On Bash or Zsh, add the `export` line to your shell startup file to persist it.

Then run `bun run dev report --provider copilot`. This does not backfill earlier
sessions. Only inference requests are counted, so parent summaries and metric exports
cannot add the same usage twice. Both documented dotted and older underscored
cache-token attributes are accepted. See the [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring).

### VS Code Copilot Chat

In your active VS Code profile's user settings, enable local file export:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "file",
  "github.copilot.chat.otel.outfile": "/absolute/path/to/.copilot/otel/vscode-chat.jsonl",
  "github.copilot.chat.otel.captureContent": false
}
```

Replace the output path with an absolute path on your machine, create its parent
directory, reload VS Code, and start a new chat. On Windows, use a path such as
`C:/Users/you/.copilot/otel/vscode-chat.jsonl`. See the
[VS Code monitoring documentation](https://code.visualstudio.com/docs/agents/guides/monitoring-agents).

Read that export, or combine CLI and Chat files from the same directory:

```sh
bun run dev report --provider copilot --source ~/.copilot/otel/vscode-chat.jsonl
bun run dev report --provider copilot --source ~/.copilot/otel
```

Both use the `copilot` provider. Default discovery reads `~/.copilot/otel`, unless
`COPILOT_OTEL_FILE_EXPORTER_PATH` selects a specific file; `--source` overrides it.
VS Code inference events require a response ID, timestamp, and input/output token
counts. Missing or invalid fields are reported as skipped usage. Response IDs
deduplicate copied events and matching request spans. Agent turn summaries,
notifications, and metrics are ignored. Background inference calls, such as title
generation, are included when exported as inference events.

### Automatic project attribution

One shared export directory can contain usage from multiple projects. Token Ledger
reads Copilot CLI spans and the corrected VS Code JSONL span format, follows parent
spans to `github.copilot.git.repository` (or `copilot_chat.repo.remote_url`), and
matches inference events by trace/span context or response ID. Parent spans can
arrive later or in another file within the same source directory. Matching request
spans supply cache-token details that inference logs may omit; the request is
counted once. Agent summaries are never counted as additional requests.

This uses the repository remote, not a local directory. Configure repository
mappings below to choose project names. Requests without usable repository linkage,
including some background calls and folders without a remote, remain `Unassigned`.
Multi-root workspaces follow the repository Copilot attaches to each agent span;
tokens are not split between folders. A fixed `--project` overrides attribution for
an export belonging to one project.

### Workaround for VS Code's file exporter bug

VS Code 1.139.1 can write spans as empty `{}` lines, losing the metadata needed for
attribution while inference logs still contain token counts. Microsoft's
[fix](https://github.com/microsoft/vscode/pull/337373) is marked released in Insiders
and targets 1.140 in the [tracking issue](https://github.com/microsoft/vscode/issues/319993).
Token Ledger supports the corrected format, but cannot reconstruct spans already
lost from an export.

On affected builds, enable the **built-in SQLite span exporter** alongside the file
settings above:

```json
{
  "github.copilot.chat.otel.dbSpanExporter.enabled": true,
  "github.copilot.chat.otel.captureContent": false
}
```

Reload the VS Code window, use Copilot Chat, then run **Chat: Export Agent Traces DB**
from the command palette. Save it as `~/.copilot/otel/agent-traces.db` alongside the
JSONL files, and report the whole directory:

```sh
bun run dev report --provider copilot --source ~/.copilot/otel
```

Token Ledger opens `.db` files read-only and selects only accounting attributes.
The exported database is a snapshot; export again to include subsequent sessions.
For ongoing collection you can instead read VS Code's live `agent-traces.db` with
`--source`, or symlink it into the shared export directory on systems that support
symlinks. For example, with the usual Linux stable storage path:

```sh
ln -s "$HOME/.config/Code/User/globalStorage/github.copilot-chat/agent-traces.db" \
  "$HOME/.copilot/otel/vscode-spans.db"
```

Its location is under the active VS Code profile's extension global
storage (`github.copilot-chat`); custom profiles, remote hosts, and Insiders use
different storage roots. Resolve a symlink to the live database rather than copying
an open database without its WAL; the built-in export command flushes and checkpoints
before copying.

Keep related JSONL and database files in **one source directory** to correlate and
deduplicate them before project attribution. Separately configured sources use
first-source-wins deduplication. Export paths and custom OTel resource attributes
are application-scoped VS Code settings; a fixed project value is unsuitable for
simultaneous usage across projects.

Unknown model prices remain unknown. Autocomplete, other IDEs, and Copilot
session-state history import are outside this release. Copilot imports are covered
by synthetic fixtures and live CLI, VS Code JSONL, and SQLite export checks; database coverage
starts when its exporter is enabled.

## Project attribution

Create an optional configuration:

```sh
bun run dev config-example > token-ledger.json
```

The default filename is `./token-ledger.json`; select another with `--config`.

```json
{
  "projects": [
    {
      "project": "Client A",
      "paths": ["~/work/client-a"],
      "repositories": [
        "https://github.com/example/client-a-app.git",
        "git@github.com:example/client-a-api.git"
      ]
    }
  ]
}
```

Attribution order:

1. `--project` or the source's fixed `project`.
2. The most specific matching directory prefix.
3. A matching repository mapping.
4. The Git remote, Git root, or recorded working directory.
5. `Unassigned` when there is no usable metadata.

SSH and HTTPS remotes share a canonical identity. Local worktrees resolve through
their common Git directory. Relative config paths resolve from the config file;
`~/` resolves from the current developer's home. Directory mappings respect path
boundaries, so `/work/app` never matches `/work/application`.

Grok logs currently lack project metadata in the usage parser. Copilot CLI can put
repository metadata on a parent agent span rather than the counted request span;
Token Ledger associates the two. If an export has no repository metadata, use a
fixed source project:

```json
{
  "sources": [
    { "provider": "codex", "path": "~/.codex/sessions" },
    { "provider": "copilot", "path": "~/exports/client-a.jsonl", "project": "Client A" }
  ]
}
```

An explicit `sources` array replaces default discovery. Source order matters for
overlapping files: the first configured source owns their project attribution.

## Prices and exports

The CLI fetches the public LiteLLM model-rate table and caches the decoded snapshot
for 24 hours under `$XDG_CACHE_HOME/token-ledger` (default `~/.cache/token-ledger`).
Only this public pricing request uses the network; histories are processed locally.
`--offline` uses cached prices and config overrides. A failed refresh falls back to
cached prices, with the snapshot timestamp retained in JSON.

Override exact model IDs in USD per million tokens:

```json
{
  "prices": {
    "my-model": { "input": 2, "output": 10, "cacheRead": 0.2, "cacheWrite": null }
  }
}
```

`null` means unknown, while `0` explicitly means free. Rates are base-tier estimates
applied to the whole selected history; historical price changes, service tiers,
tool charges, taxes, negotiated discounts, and subscription allocations are not
modeled. Provider-reported credit or dollar figures do not override this estimate.

JSON is a versioned report with pricing provenance, applied unit rates, coverage diagnostics, and rows
grouped by project/day/provider/model. CSV instead matches the terminal summary:
one row per project, sorted by known API cost, plus a Total row. It includes token
totals, API estimates rounded to two decimals, and cost percentages. Incomplete
costs display `+ unknown`, and percentages use only the known subtotal. Neither
format includes prompts or responses;
JSON coverage does contain configured source paths. CSV escapes spreadsheet formula
prefixes in identifiers. Coverage diagnostics also go to stderr, leaving stdout
usable for piping.

Exit codes: `0` for a generated report, `1` for invalid input or a fatal error, and
`2` with `--strict` when a source is missing/partial/failed or tokens are unpriced.
Ordinary mode still produces a partial report when some providers are unavailable.
Keep developer identity alongside exported reports when combining them across a team.

## Accuracy and limitations

- Reports reflect saved, readable local history, not an authoritative provider invoice.
- JSONL files are streamed, while Copilot buffers accounting records and span links
  per source for attribution; SQLite imports read the selected accounting rows. Each
  run rescans its sources, and memory grows with observed usage records.
- Copied files, overlapping source paths, and stable provider record IDs are deduplicated.
  Missing stable IDs are called out where the provider cannot support that guarantee.
- Codex fork histories use T3 Code's timing heuristic to exclude the leading copied
  burst. The report explicitly marks affected coverage as partial.
- A truncated or malformed JSONL line is skipped and counted. No prompts are printed
  in diagnostics. An active session can change during a scan; this is not a transactional snapshot.
- Coverage diagnostics describe all scanned files, including events outside the selected
  date window. Codex updates with no usage payload are ignored, not counted as lost usage.
- Default project inference uses the current local Git metadata when the transcript
  lacks a remote. Explicit mappings make attribution more stable across machines.
- A session that works across projects still needs an explicit allocation policy;
  tokens cannot identify which client benefited from an individual generated line.

## Publishing

The workspace packages stay private. `bun run build` creates the publishable
package in `dist/npm`, copying only the bundled executable, manifest, README,
project license, and bundled dependency license notices. The CLI version comes
from `packages/cli/package.json`.

For manual publication:

1. Log in with `npm login` using an account with publish access to `@ponbac/token-ledger`.
2. Run `bun run check`. The CLI test packs the package, installs it offline outside
   the repository with lifecycle scripts disabled, and exercises the installed CLI.
3. Run `bun run pack` to create `dist/ponbac-token-ledger-0.1.2.tgz` (filename follows version).
4. Inspect `npm publish ./dist/npm --dry-run`.
5. Publish with `npm publish ./dist/npm --access public`; complete npm's authentication
   prompt if requested.

For subsequent releases, update the CLI manifest version, commit it, and rerun the
checks. The manual **Publish npm package** GitHub Actions workflow also runs checks
before publishing from `main`. Configure an
[npm trusted publisher](https://docs.npmjs.com/trusted-publishers/) for GitHub owner
`ponbac`, repository `token-ledger`, workflow `publish.yml`, with direct publishing
allowed, before using it. This uses GitHub OIDC rather than a stored npm token.
An already published version cannot be reused.

## Development

```sh
bun run check
bun run fmt
bun run lint:fix
```

- `packages/core`: Effect schemas, provider adapters, project attribution, pricing,
  and the `Ledger` module. `Ledger.layer` receives filesystem/path dependencies;
  `Ledger.report` returns data and typed failures, with no terminal rendering.
- `packages/cli`: Effect CLI and process wiring. A later UI can run the same core
  through a local backend.
- Effect and platform packages are pinned to stable `4.0.0`.
- Oxlint `1.80.0` with type-aware checks, Oxfmt `0.66.0`, and all 18 generic plus
  five Effect anti-slop policies gate CI, including test code, without exemptions.
  TypeScript owns duplicate declaration checking for schema/type pairs.
- Vendored anti-slop rules are pinned to upstream `c44ef22`; `main` was verified at
  that revision on 2026-09-22. Provenance, local patches, and licenses live beside
  the rules. The separate experimental Effect TSGo bridge is not installed.

### Source references

`.reference/effect` and `.reference/t3code` are real squashed Git subtrees following
the [Effect team's recommendation](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive).
A normal clone includes them. They are read-only reference material, excluded from
application checks and editor indexing, and marked vendored for GitHub statistics.

```sh
# Start with a clean working tree. Change the version deliberately when upgrading.
bun run reference:update effect 'effect@4.0.0'
bun run reference:update t3code main
# Refresh only the Effect-source overlay within the T3 Code reference:
bun run reference:update effect-t3code 'effect@4.0.0'
```

Refresh the Effect reference after upgrading dependencies, in a separate PR stacked
above the dependency upgrade. The Effect reference is pinned to `effect@4.0.0`
(`67ba4e46a11ccda0b6761578bfd22c04ae00167d`) from
[`Effect-TS/effect`](https://github.com/Effect-TS/effect). Git subtree commit
messages record the imported revisions. The initial T3 reference is upstream
`aff9318bf46beaf05cc7155b428d3f0b8711efd2`.

The nested `.reference/t3code/.repos/effect-smol` snapshot has a deliberate overlay
of the same stable Effect source. Other T3 Code reference files keep their imported
revision. Its nested subtree history was omitted by the outer squash, so the updater
replaces that snapshot and records its upstream URL, release tag, and commit in Git
commit trailers. Refreshing either outer reference reapplies this Effect overlay;
refreshing T3 Code uses the root manifest's installed Effect version.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the licenses retained
inside each vendored reference and rule set.
