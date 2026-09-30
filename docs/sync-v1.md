# Sync payload, version 1

The contract between `token-ledger sync` and the toki2 ingest endpoint. The Effect
Schema `SyncPayload` in [`packages/core/src/sync.ts`](../packages/core/src/sync.ts) is
authoritative; this page explains it. Figures are API-equivalent estimates, not bills.

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
    "source": "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
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
      "unreadable": 0,
      "malformedLines": 0,
      "skippedRecords": 0,
      "duplicates": 2
    }
  ]
}
```

| Field              | Meaning                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `version`          | Always `1`. Reject other versions.                                                                                          |
| `machine.id`       | Random UUID created once per installation.                                                                                  |
| `machine.label`    | Editable display name, usually the host name.                                                                               |
| `clientVersion`    | token-ledger version, for diagnostics.                                                                                      |
| `timeZone`         | The client's IANA zone, for display and debugging only. Every instant is UTC.                                               |
| `window`           | Half-open `[start, end)` on whole UTC hours: the client's local days, widened outward to whole hours.                       |
| `pricing`          | Provenance of the rates behind every `estimatedCostUsd`.                                                                    |
| `buckets[]`        | Usage keyed by `(hourStart, sessionKey, project, provider, model)`; each key occurs at most once. Only replaced providers.  |
| `hourStart`        | Start of a whole UTC hour inside `window`.                                                                                  |
| `sessionKey`       | 32 hex characters: a truncated SHA-256 of provider and session. Opaque; stable across syncs from one machine.               |
| `project`          | Project key; see below.                                                                                                     |
| `tokens`           | Disjoint counts: `input` excludes cache reads and writes; reasoning is inside `output`.                                     |
| `records`          | Deduplicated provider requests in the bucket; at least 1.                                                                   |
| `estimatedCostUsd` | API-equivalent USD, or `null` when any record in the bucket could not be priced. `null` is unknown, never zero.             |
| `unpricedRecords`  | Records without a known price.                                                                                              |
| `coverage[]`       | One entry per scanned provider, with file and diagnostic counts; `status` decides replacement (below).                      |
| `providerHints[]`  | Optional `{ provider, hourStart, plan }` evidence of a billing plan, such as Codex `plan_type`. Declared subscriptions win. |

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
exceeds `records`, and `estimatedCostUsd` is `null` exactly when `unpricedRecords > 0`.
`pricing.fetchedAt` is a UTC instant or `null`.

## Coverage status

| `status`  | Meaning                                                                   | Server      |
| --------- | ------------------------------------------------------------------------- | ----------- |
| `ok`      | Every existing history file was read.                                     | Replace     |
| `partial` | Every file was read, but some lines or records were unusable or excluded. | Replace     |
| `failed`  | Some existing history could not be read (`unreadable` > 0).               | Keep stored |
| `missing` | No history was found for the provider.                                    | Keep stored |

A provider absent from `coverage` was not scanned, for example because of
`--provider`, and also keeps its stored data. Missing data is never treated as zero.

## Server semantics

1. Reject a machine ID that belongs to another user.
2. Reject a bucket or hint for a provider that is not replaced, or outside `window`.
3. In one transaction, for each **replaced** provider (`ok` or `partial`), delete the
   machine's stored buckets for that provider with `hourStart` in `window`, then insert
   the payload's buckets for it. Other providers' stored buckets are untouched.
   Uploading the same payload twice leaves the same state.
4. Record the machine's label, client version, time zone, coverage, pricing, and
   last sync time.
5. Sum buckets across machines. Keep unknown costs visible: an aggregate with any
   `null` cost is a known subtotal plus unpriced usage, not a total. The known
   subtotal sums fully priced buckets only. A bucket mixing priced and unpriced
   records has a `null` cost, so v1 also omits its priced records from that subtotal.
6. Group days and billing months in `Europe/Stockholm`.

## Responses

| Status                     | Meaning                                                     |
| -------------------------- | ----------------------------------------------------------- |
| `200 OK`                   | Stored; body `{ "storedBuckets": <number> }`.               |
| `400 Bad Request`          | The body is not a valid payload.                            |
| `401 Unauthorized`         | Missing, invalid, or expired API token.                     |
| `403 Forbidden`            | The machine ID belongs to another user.                     |
| `422 Unprocessable Entity` | Unsupported `version`; body `{ "supportedVersions": [1] }`. |
| `5xx`                      | A temporary server failure; the client retries later.       |

Use `422` only for an unsupported version, and `5xx` only for failures a retry can
fix; validation errors are `400`.

A two-week window is typically a few hundred kilobytes, but a long `--since` window
can reach several megabytes; Axum's default 2 MB body limit is too small.

Because each sync replaces its window for every replaced provider, a window must not reach past the provider's
local retention: Claude Code, for example, deletes transcripts after 30 days by
default. Re-syncing a pruned window would replace good server data with less.

## Privacy

Payloads contain no prompts, responses, individual requests, credentials, source
paths, or raw session IDs. Some providers fall back to a transcript path as the
session identity, so session identities are always hashed. `coverage` omits source
paths and diagnostic messages.
