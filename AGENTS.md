# Token Ledger

Local AI token accounting by project. An Effect v4 core produces structured
reports; an Effect CLI handles configuration, presentation, and process lifecycle.

## Working conventions

- Keep provider formats and token semantics inside provider adapters.
- Decode external data with Effect Schema. No unchecked casts or `any`.
- Use ordinary pure functions for attribution, arithmetic, and aggregation.
- Use Effect for I/O and workflows, typed errors for expected failures, and scoped resources.
- Keep prompts, responses, credentials, and source code out of reports and fixtures.
- Costs are API-equivalent estimates, not subscription bills. Missing data is not zero.
- Use synthetic fixtures; never commit local provider histories or generated personal reports.
- Run `bun run check` (Oxlint, Oxfmt, typecheck, tooling tests, core tests, build).
- Oxlint is the gating linter and Oxfmt is the formatter. All 18 generic and five
  Effect anti-slop rules are errors in production and test code, without exemptions.
  Vendored rules retain their upstream licenses and Spindexer compatibility patches.
- Do not create a UI, daemon, or plugin framework without a concrete need.

## Reference repositories

`.reference/` contains squashed Git subtrees, following the Effect team's
[source-reference workflow](https://effect.website/blog/the-one-weird-git-trick-that-makes-coding-agents-more-effect-ive).

- `.reference/effect`: source pinned to the installed Effect v4 version. Read
  `LLMS.md` first, then relevant source, examples, and tests before writing Effect code.
- `.reference/t3code`: token parsing, deduplication, and pricing reference. Start
  with `apps/server/src/usage/` and `packages/contracts/src/usage.ts`.
- References are read-only. Never import application code from them.
- Prefer reference source over guessing APIs. Exclude references from builds and tests.
- Refresh deliberately with `bun run reference:update effect <release-tag>` or
  `bun run reference:update t3code <commit-or-branch>`. Update Effect packages and
  its reference together; preserve upstream licenses and attribution.

## Scope

Codex, Claude Code, Grok Build histories and Copilot CLI telemetry exports.
VS Code Copilot telemetry is intentionally excluded. A later UI should call the
same core through a local backend; the core must not render terminal output.
