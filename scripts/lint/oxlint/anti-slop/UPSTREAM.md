# Vendored anti-slop rules

Source: [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop),
commit [`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`](https://github.com/dmmulroy/anti-slop/commit/c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b).
This is nine commits after v0.1.2; the upstream package version still says 0.1.2.
Copied upstream `src/` excluding test files, plus the MIT `LICENSE`.
The generic plugin enables all eighteen rules. Its nested ESLint Stylistic
vendor directory retains its own license and provenance.
The Effect plugin is copied from the same revision and all five rules are
registered as errors. Only manual tagged construction is exempt in test files
and test-helper directories. Token Ledger adopts these same policies.

## Local patches

`rules/no-module-mocking.ts` preserves local Bun `mock.module`, Jest `setMock`,
namespace, extracted-method, alias, and shadowing coverage. It uses upstream's
new shared scope resolver. These existing local extensions were missing from
the previous provenance record; preserve their regression fixtures.

`shared/dictionary-types.ts` retains `unsafeMembers[0] ?? null` for the repo's
`noUncheckedIndexedAccess` setting.

`shared/type-alias-resolution.ts` retains an iterative, per-environment cache that resolves
non-generic alias chains ending in keyword types such as `string`, `object`,
or `unknown`. Generic,
cyclic, and composite alias forms use upstream's resolver unchanged; cached
results never cross file environments or generic substitutions.

Unpatched v0.1.2 exceeds the existing 30-second process timeout on the
3,000-alias regression fixture. The patch runs that fixture in approximately
0.35 seconds, including Oxlint startup. It replaces the previous custom
implementations of `no-object-parameters` and `no-unknown-type-aliases`.

Keep the alias, shadowing, and long-chain regression fixtures when updating.
Remove this patch once upstream handles the long-chain fixture within the
existing timeout. Preserve the adjacent license on future updates.

Token Ledger checks rule registration, representative rejections, test exemptions,
and local patch regressions in `../../anti-slop.test.mjs`. Spacing-only adoption changes add
blank lines throughout the configured lint scopes; fixture source strings
also follow this policy. All other generic source matches the pinned upstream.

Imported from Spindexer on 2026-09-22, retaining the local patches described above.
Verified against upstream `main` on 2026-09-22: the pinned commit is still the
remote head (zero newer commits). Updates must check upstream before copying a
local vendor snapshot.
