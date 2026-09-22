# Token Ledger

Local token consumption and estimated API cost, grouped by project across coding agents.

An Effect v4 core reads provider histories and produces structured reports. An Effect
CLI handles discovery, configuration, and terminal/CSV/JSON output. You do not need
T3 Code, provider API keys, or a company dashboard to use it.

**Dollar figures are API-equivalent estimates, not subscription expenses.** Reports
keep input, cache-read, cache-write, and output tokens separate. Unknown model or
cache prices stay unknown; the known subtotal remains available.

## Quick start

Install [Bun](https://bun.sh), then:

```sh
git clone https://github.com/ponbac/token-ledger.git
cd token-ledger
bun install --frozen-lockfile
bun run dev report --provider codex
```

The default window is the current calendar month through today, in UTC. Read every
supported source by omitting `--provider`. Terminal reports sort projects by descending
API estimate (known subtotal when pricing is incomplete), with color and emoji accents
on color-capable terminals. Set `NO_COLOR=1` for plain output.

```sh
bun run dev report --since 2026-09-01 --until 2026-09-30
bun run dev report --provider codex --json > report.json
bun run dev report --provider codex --format csv > report.csv
bun run dev report --provider codex --source ~/history/session.jsonl --project "Client A"
```

`--json` is a shortcut for `--format json` and takes precedence over `--format`.
JSON stdout contains only the structured report, including coverage and pricing
metadata; diagnostics go to stderr. Unknown costs are `null`, not zero.

Build a standalone Node executable (Node 24 or newer):

```sh
bun run build
node packages/cli/dist/main.js report --provider codex
```

This repository is not yet published to npm. Run `--help` on the executable or any
subcommand for options. Effect CLI also provides completion scripts and `--wizard`.

### Windows

The CLI is intended to run on Windows with Bun, or with Node.js 24+ for the built
executable, but Windows compatibility has not yet been verified. With Git and Bun
installed, run these commands in PowerShell:

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

| Provider    | Default input                                          | Coverage                                                                     |
| ----------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Codex       | `~/.codex/sessions` and `archived_sessions`            | Rollout token events, model switches, session and working-directory metadata |
| Claude Code | `~/.claude/projects`                                   | Assistant usage records; repeated message blocks counted once                |
| Grok Build  | `~/.grok/sessions/**/updates.jsonl`                    | Saved completed turns and their model breakdowns                             |
| Copilot CLI | `~/.copilot/otel` or `COPILOT_OTEL_FILE_EXPORTER_PATH` | JSONL `chat` spans from the CLI's file exporter                              |

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
sessions. Only request spans are counted, so parent summaries and metric exports
cannot add the same usage twice. Both documented dotted and older underscored
cache-token attributes are accepted. See the [Copilot CLI reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference#opentelemetry-monitoring).

VS Code Copilot telemetry, autocomplete, other IDEs, and Copilot session-state
history import are outside this initial release. Copilot imports are covered by
synthetic fixtures matching the CLI export format, not a live billed session test.

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

Grok logs currently lack project metadata in the usage parser. Copilot exports may
also omit repository attributes. Use a fixed source project for those histories:

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
grouped by project/day/provider/model. CSV exports those rows with empty estimated
cost cells when any usage is unpriced. Neither format includes prompts or responses;
JSON coverage does contain configured source paths. CSV escapes spreadsheet formula
prefixes in identifiers. Coverage diagnostics also go to stderr, leaving stdout
usable for piping.

Exit codes: `0` for a generated report, `1` for invalid input or a fatal error, and
`2` with `--strict` when a source is missing/partial/failed or tokens are unpriced.
Ordinary mode still produces a partial report when some providers are unavailable.
Keep developer identity alongside exported reports when combining them across a team.

## Accuracy and limitations

- Reports reflect saved, readable local history, not an authoritative provider invoice.
- Scans stream files rather than loading transcripts into memory. This initial version
  rescans histories on each run; deduplication state grows with observed usage records.
- Copied files, overlapping source paths, and stable provider record IDs are deduplicated.
  Missing stable IDs are called out where the provider cannot support that guarantee.
- Codex fork histories use T3 Code's timing heuristic to exclude the leading copied
  burst. The report explicitly marks affected coverage as partial.
- A truncated or malformed JSONL line is skipped and counted. No prompts are printed
  in diagnostics. An active session can change during a scan; this is not a transactional snapshot.
- Default project inference uses the current local Git metadata when the transcript
  lacks a remote. Explicit mappings make attribution more stable across machines.
- A session that works across projects still needs an explicit allocation policy;
  tokens cannot identify which client benefited from an individual generated line.

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
- Effect and platform packages are pinned to `4.0.0-rc.117`.
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
bun run reference:update effect 'effect@4.0.0-rc.117'
bun run reference:update t3code main
```

Update Effect dependencies together with their reference. Git subtree commit
messages record the imported revisions. The initial T3 reference is upstream
`aff9318bf46beaf05cc7155b428d3f0b8711efd2`.

## License

MIT. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the licenses retained
inside each vendored reference and rule set.
