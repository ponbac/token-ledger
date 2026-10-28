# Sync payload, versions 1, 2, and 3

The contract between `token-ledger sync` and the toki2 ingest endpoint, and its
[repricing](#repricing) endpoints. The Effect Schemas `SyncPayload` and `RepricePayload` in
[`packages/core/src/sync.ts`](../packages/core/src/sync.ts) are authoritative; this page
explains them. Figures are API-equivalent estimates, not bills.

Version 2 adds an optional `billingProvider` to each bucket. It names a different
subscription provider (`codex`, `claude`, `grok`, or `copilot`); Pi and OpenCode cannot
be payers.
The source `provider` remains unchanged. The bucket key additionally includes
`billingProvider` (absent means native routing), allowing different payers in the
same hour, session, project and model. Coverage and replacement still use the source
provider. Version 1 cannot carry billing overrides. Clients send version 2 only when
at least one uploaded bucket has an override. See [local billing hints](billing-hints.md).

OpenCode is a source that routes requests to other providers' subscriptions: `copilot` for
its `github-copilot` route, and `codex` for an `openai` request whose recorded cost is
exactly zero, which OpenCode's ChatGPT sign-in produces by clearing every OpenAI model's
rates. Other OpenCode routes carry no override. toki2 must accept the `opencode` provider
before a release containing it is published: an older server rejects the whole payload as
invalid, for every provider in it.

Version 3 keeps the priced subtotal of a bucket that mixes priced and unpriced records,
which happens when a priced model's rates lack a token kind a record used, such as cache
writes for OpenAI, Gemini, and xAI models. In versions 1 and 2 `estimatedCostUsd` is
`null` whenever any record is unpriced, which drops the priced records' cost. In version 3
it is the priced records' subtotal, a lower bound while `unpricedRecords` is positive, and
`null` only when every record is unpriced. Version 3 also accepts `billingProvider`.
Clients send the oldest version that carries every bucket: 3 when a bucket is partly
priced, otherwise 2 for an override, otherwise 1. Deploy server support first: an older
server rejects version 3 with `422`, keeping its stored usage.

Any version may carry `snapshotAt`, the UTC instant at which the client began scanning
history, so the payload holds every record written before it. A server keeps the last
applied `snapshotAt` per machine and refuses an older one with `409`, so a slow sync
cannot overwrite a newer one from the same machine. It is optional: servers without
this guard ignore it, and a payload without it is not ordered.

Any version may carry `pricing.basis`, 1 to 128 printable ASCII characters naming what
priced every `estimatedCostUsd` in the payload: the client's pricing method, the version of
its checked-in GitHub Copilot rate card, and a hash of any configured price overrides, such
as `token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers`. It does not change with
the time or contents of a LiteLLM fetch. The client omits it when it priced without vendor
rates, LiteLLM being unavailable, so such an upload never claims the basis of a complete
one; an absent or `null` basis means a legacy client. The server treats it as opaque,
compares it for equality, and stores it on every bucket the upload writes, so it can tell
which stored hours were priced on an older basis, which the client then
[reprices](#repricing). Servers that do not store it ignore it.

Costs are API-equivalent, except that requests GitHub Copilot paid for (`provider`
`copilot` without `billingProvider`, or `billingProvider` `copilot`) are priced at
Copilot's own AI credit rates. Each request is priced before it is summed into a bucket, so
its own context chooses its long-context tier.

## Request

```http
PUT /ai-usage/machines/{machineId}/usage
Authorization: Bearer toki_…
Content-Type: application/json
```

`{machineId}` equals `machine.id` in the body. The API token identifies the developer.

## Body

A synthetic example:

```json
{
  "version": 1,
  "machine": { "id": "5f0c5a1e-3b8e-4d8e-9a57-0d7b1c1f2e3a", "label": "work-laptop" },
  "clientVersion": "0.2.0",
  "timeZone": "Europe/Stockholm",
  "window": { "start": "2026-09-08T22:00:00.000Z", "end": "2026-09-22T22:00:00.000Z" },
  "currency": "USD",
  "costBasis": "api-equivalent",
  "pricing": {
    "status": "fresh",
    "fetchedAt": "2026-09-22T07:00:00.000Z",
    "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json; GitHub Copilot rates 2026-10-24",
    "basis": "token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers"
  },
  "buckets": [
    {
      "hourStart": "2026-09-22T08:00:00.000Z",
      "sessionKey": "9b1f0c6e2d4a8b7c3e5f1a2b4c6d8e0f",
      "project": "github.com/example/app",
      "provider": "claude",
      "model": "example-model",
      "tokens": { "input": 1200, "cacheRead": 48000, "cacheWrite": 3000, "output": 900 },
      "records": 14,
      "estimatedCostUsd": 0.0421,
      "unpricedRecords": 0
    }
  ],
  "coverage": [
    {
      "provider": "claude",
      "status": "ok",
      "files": 31,
      "filesBeforeWindow": 412,
      "unreadable": 0,
      "malformedLines": 0,
      "skippedRecords": 0,
      "duplicates": 2
    }
  ],
  "snapshotAt": "2026-09-22T09:41:07.512Z"
}
```

| Field              | Meaning                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`          | `1` without overrides; `2` supports `billingProvider`. Reject unsupported versions.                                                         |
| `machine.id`       | Random UUID created once per installation.                                                                                                  |
| `machine.label`    | Editable display name, usually the host name.                                                                                               |
| `clientVersion`    | token-ledger version, for diagnostics.                                                                                                      |
| `timeZone`         | The client's IANA zone, for display and debugging only. Every instant is UTC.                                                               |
| `window`           | Half-open `[start, end)` on whole UTC hours: the client's local days, widened outward to whole hours.                                       |
| `pricing`          | Provenance of the rates behind every `estimatedCostUsd`: `status`, `fetchedAt`, a readable `source`, and an optional `basis` (above).       |
| `buckets[]`        | Usage keyed by `(hourStart, sessionKey, project, provider, model, billingProvider)`; each key occurs at most once. Only replaced providers. |
| `hourStart`        | Start of a whole UTC hour inside `window`.                                                                                                  |
| `sessionKey`       | 32 hex characters: a truncated SHA-256 of provider and session. Opaque; stable across syncs from one machine.                               |
| `project`          | Project key; see below.                                                                                                                     |
| `tokens`           | Disjoint counts: `input` excludes cache reads and writes; reasoning is inside `output`.                                                     |
| `records`          | Deduplicated provider requests in the bucket; at least 1.                                                                                   |
| `estimatedCostUsd` | API-equivalent USD of the priced records, or `null` when none was priced (any, before version 3). `null` is unknown, never zero.            |
| `unpricedRecords`  | Records without a known price.                                                                                                              |
| `coverage[]`       | One entry per scanned provider, with file and diagnostic counts; `status` decides replacement (below).                                      |
| `providerHints[]`  | Optional `{ provider, hourStart, plan }` evidence of a billing plan, such as Codex `plan_type`. Declared subscriptions win.                 |
| `snapshotAt`       | Optional UTC instant at which the history scan began; any version. Orders uploads from one machine (see below).                             |

## Plan hints

`providerHints` lists each billing plan a provider reported during an hour of the
window, once, with no session data. They are evidence for toki2 to compare with
declared subscriptions, which remain authoritative; a missing hint proves nothing.

| Provider    | Signal                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | `plan_type` on rate-limit updates, such as `pro`, when signed in with ChatGPT. `null` or absent otherwise, including API-key use.                                                                    |
| Claude Code | None: transcripts do not record whether a subscription or an API key was used. `userType` and `service_tier` are not billing signals.                                                                |
| Copilot     | None observed: Copilot CLI and VS Code Chat exports carry no plan, SKU, or entitlement attribute.                                                                                                    |
| Grok Build  | Not investigated yet.                                                                                                                                                                                |
| Pi          | `openai-codex` when usage ran through Pi's ChatGPT sign-in, a route with no API-key form. Pi records the route, not the plan, and no other route is sent: `anthropic`, for one, also takes API keys. |
| OpenCode    | None: OpenCode records no plan. Its routes become bucket `billingProvider` overrides instead (above).                                                                                                |

## Project keys

- A configured project name, such as `Client A`, from the developer's token-ledger configuration.
- A Git remote normalised to `host/owner/repo`: lower-case host, without credentials or `.git`.
  Copilot can report a repository as `owner/repo` without a host.
- `unattributed`: usage whose only attribution is a local directory or local-path
  remote, or that has no project metadata at all.

Text fields (`machine.label`, `clientVersion`, `timeZone`, `pricing.source`, `project`,
`model`, and `plan`) contain no NUL characters and at most 512 characters (code points).
The client replaces NULs in provider data with U+FFFD and truncates longer values.
Bucket keys, coverage providers, and plan hints are each unique. `unpricedRecords` never
exceeds `records`. `estimatedCostUsd` is `null` exactly when `unpricedRecords > 0` in
versions 1 and 2, and exactly when `unpricedRecords` equals `records` in version 3.
`pricing.fetchedAt` is a UTC instant or `null`.

## Coverage status

| `status`  | Meaning                                                                  | Server      |
| --------- | ------------------------------------------------------------------------ | ----------- |
| `ok`      | Every history file that could hold usage in `window` was read.           | Replace     |
| `partial` | Every such file was read, but some lines or usage records were unusable. | Replace     |
| `failed`  | Some existing history could not be read (`unreadable` > 0).              | Keep stored |
| `missing` | No history was found for the provider.                                   | Keep stored |

A provider absent from `coverage` was not scanned, for example because of
`--provider`, and also keeps its stored data. Missing data is never treated as zero.

Transcripts are append-only, so the client does not open a Codex, Claude Code, Grok, Pi,
or legacy OpenCode message file last modified more than 36 hours before `window.start`.
`files` and the diagnostic counts describe the files opened, and `filesBeforeWindow`
counts the rest. A provider
whose history all predates the window is therefore `ok` with `files` 0, and its stored
buckets in the window are replaced with none. Copilot exports and OpenCode databases are
always opened.
`filesBeforeWindow` is optional: the first version 1 clients omit it, and a server may ignore it.

## Server semantics

1. Reject a machine ID that belongs to another user.
2. Reject a bucket or hint for a provider that is not replaced, or outside `window`.
3. In one transaction, refuse with `409` and change nothing when `snapshotAt` is older
   than the last one applied from the machine; an equal one is accepted.
   Otherwise remember it, and for each **replaced** provider (`ok` or `partial`), delete the
   machine's stored buckets for that provider with `hourStart` in `window`, then insert
   the payload's buckets for it. Other providers' stored buckets are untouched.
   Uploading the same payload twice leaves the same state.
4. Record the machine's label, client version, time zone, coverage, pricing, and
   last sync time, and store `pricing.basis`, or none, on every bucket inserted.
5. Sum buckets across machines. Keep unknown costs visible: an aggregate with any
   `null` cost is a known subtotal plus unpriced usage, not a total. The known
   subtotal sums every non-null bucket cost. A version 1 or 2 bucket mixing priced and
   unpriced records has a `null` cost, so its priced records are missing from that
   subtotal; version 3 includes them.
6. Group days and billing months in `Europe/Stockholm`.

## Responses

| Status                     | Meaning                                                           |
| -------------------------- | ----------------------------------------------------------------- |
| `200 OK`                   | Stored; body `{ "storedBuckets": <number> }`.                     |
| `400 Bad Request`          | The body is not a valid payload.                                  |
| `401 Unauthorized`         | Missing, invalid, or expired API token.                           |
| `403 Forbidden`            | The machine ID belongs to another user.                           |
| `409 Conflict`             | `snapshotAt` is older than the machine's last applied upload.     |
| `422 Unprocessable Entity` | Unsupported `version`; body `{ "supportedVersions": [1, 2, 3] }`. |
| `5xx`                      | A temporary server failure; the client retries later.             |

Use `422` only for an unsupported version, `409` only for a superseded snapshot, and
`5xx` only for failures a retry can fix; validation errors are `400`. The client does
not resend a payload refused with `409`. The newer upload may hold another window or
tools, so it scans the same window again once and sends that newer payload.

A two-week window is typically a few hundred kilobytes, but a long `--since` window
can reach several megabytes; Axum's default 2 MB body limit is too small.

A machine's first upload is the exception to the two-week window. Before scanning, and
again before sending, the client calls `GET /ai-usage/machines` with the same token. When
the answer is a 200 with the server's machine list and that list does not hold
`machine.id`, the client extends the window backwards to the local day of the earliest
usage it finds. The server registers a machine in the transaction that stores its first
upload, so a machine it does not list has nothing a long window could replace. Any other
answer, a redirect and an error included, counts as "listed": the client then sends an
ordinary window. The two requests are not one transaction: uploads from two clients that
share a machine ID and start at the same moment can still replace one another, as they do
on every sync.

Because each sync replaces its window for every replaced provider, a later window must not reach past the provider's
local retention: Claude Code, for example, deletes transcripts after 30 days by
default. Re-syncing a pruned window would replace good server data with less.

## Repricing

A sync replaces only its window, so hours stored before it keep the costs an older pricing
basis gave them when the client's pricing changes: its pricing method, its GitHub Copilot
rate card, or configured overrides. Two endpoints, with the upload's bearer token, give those
hours new costs without replacing any usage.

### Discovery

```http
GET /ai-usage/machines/{machineId}/repricing?basis=<pricing basis>
Authorization: Bearer toki_…
```

```json
{
  "floor": "2026-10-01T00:00:00Z",
  "providers": [
    { "provider": "claude", "from": null, "staleBuckets": 0 },
    { "provider": "copilot", "from": "2026-10-03T14:00:00Z", "staleBuckets": 12 }
  ]
}
```

`floor` is the earliest hour the server reprices. `providers` has one entry per provider with
stored buckets for the caller's machine, ordered by provider: `from` is the earliest stored
`hourStart` at or after `floor` whose bucket's basis differs from `basis` (a bucket stored
without one differs), or `null` when none does, and `staleBuckets` counts those buckets. A
machine the server does not know, or another user's, has no providers. A missing or empty
`basis`, or one longer than 128 characters, is `400`. Instants are RFC 3339 UTC; the client
accepts them with or without fractional seconds, and ignores providers it does not know.

### Reprice-only upload

```http
POST /ai-usage/machines/{machineId}/repricing
Authorization: Bearer toki_…
Content-Type: application/json
```

```json
{
  "version": 1,
  "clientVersion": "0.9.0",
  "pricing": {
    "status": "fresh",
    "fetchedAt": "2026-10-24T10:00:00.000Z",
    "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json; GitHub Copilot rates 2026-10-24",
    "basis": "token-ledger-pricing@1;copilot-rates@2026-10-24;litellm@tiers"
  },
  "buckets": [
    {
      "hourStart": "2026-10-03T14:00:00.000Z",
      "sessionKey": "9b1f0c6e2d4a8b7c3e5f1a2b4c6d8e0f",
      "project": "github.com/example/app",
      "provider": "copilot",
      "model": "example-model",
      "tokens": { "input": 1200, "cacheRead": 48000, "cacheWrite": 0, "output": 900 },
      "records": 14,
      "estimatedCostUsd": 0.0421,
      "unpricedRecords": 0
    }
  ]
}
```

Each bucket is exactly an upload bucket and passes the same validation, with version 3
costs: `estimatedCostUsd` is `null` only when every record is unpriced, and otherwise the
priced subtotal. `pricing.basis` is required. Bucket keys are unique, and a request holds at
most 20,000 buckets; the body limit is the upload's 16 MiB. Any other `version` is `400`.

In one transaction, for each bucket whose `hourStart` is at or after the floor, the server
updates the cost, unpriced record count, and pricing basis of the stored bucket of the same
user and machine with the same key (`billingProvider` compared null-safely), the same four
token counts, and the same record count, after the upload's own normalisation, which stores
Copilot's next edit suggestions at zero cost. It never inserts or deletes a bucket, and does
not touch coverage, plan hints, the snapshot, or sync times. It answers
`200 { "updated": n, "unmatched": n, "beforeFloor": n }`: `updated` counts matched buckets,
also those whose values were equal already; `unmatched` the buckets from the floor on that
matched none; `beforeFloor` those before it. Errors are as for the upload: `400` for an
invalid body, a repeated key, or more than 20,000 buckets, `401`, `413`, `415`, and `5xx`
for failures a retry can fix.

Pruned history cannot wipe stored usage: a bucket the machine no longer has is simply not
sent, and keeps its old basis. A request without the billing hints it once had does not match
either, because the payer is part of the key.

### Client behaviour

After a sync stores its window, and only when its upload carried a `pricing.basis`, the
client asks discovery with that basis. For each provider the sync covered, after
`--provider`, whose `from` (never earlier than `floor`) is before the window's start, it
builds that provider's buckets for `[from, window start)` as an upload builds them: the same
sources, project mappings, billing hints, prices, and keys. Every file that could hold usage
from `from` on is opened: the 36-hour modification-time rule counts from `from`, not from the
window. A provider whose history could not all be read (`failed`) or was not found at all
(`missing`) waits for a later sync; nothing is sent for it.

The buckets go in requests of at most 20,000 buckets and 12 MiB of bucket JSON, one provider
at a time. Unreachable servers, timeouts, `408`, `429`, and `5xx` are retried three times
with backoff, each time with the identical request, so a retry never widens to other
providers; refusals are final for the run. A finished reprice is remembered in
`repricing.json` in the client's settings directory, per server origin and provider, with
its basis, `from`, and the end of the sync's window. When discovery later names the same
`from` for the same basis, and the new window starts no later than that end, the provider is
skipped: everything from `from` up to the window was sent on this basis, so the stale buckets
left are ones the machine can no longer reproduce. A provider that waits is not remembered.
Its report holds counts and outcomes, never tokens, paths, or history contents; the
[README](../README.md#repricing-older-usage) shows it and how a user recovers.

## Privacy

Payloads, reprice-only uploads included, contain no prompts, responses, individual requests,
credentials, source paths, or raw session IDs. Some providers fall back to a transcript path as the
session identity, so session identities are always hashed. `coverage` omits source
paths and diagnostic messages.
