# Local proxy billing hints

A ChatGPT OAuth proxy used by VS Code Copilot can append one JSON object per line to
`chatgpt-proxy.jsonl` in the per-user directory below. Token Ledger discovers `*.jsonl`
files directly inside that directory during `sync`, including a first history upload.
`report` reads no billing hints, so it prices every Copilot request, routed or not, as
Copilot-paid, with Copilot's rate card.

| OS      | Default directory                                                                                   |
| ------- | --------------------------------------------------------------------------------------------------- |
| Windows | `%LOCALAPPDATA%\token-ledger\billing-hints` (fallback `~\AppData\Local\token-ledger\billing-hints`) |
| macOS   | `~/Library/Application Support/token-ledger/billing-hints`                                          |
| Linux   | `$XDG_DATA_HOME/token-ledger/billing-hints` (fallback `~/.local/share/token-ledger/billing-hints`)  |

The proxy writes:

```json
{ "requestId": "incoming-X-Request-Id", "billingProvider": "codex", "authMode": "chatgpt" }
```

`requestId` must be the **incoming Copilot `X-Request-Id` header**, exported as
`gen_ai.response.id` in Copilot telemetry. The upstream ChatGPT response body ID is
different and will not match. Only the `codex` / `chatgpt` pair is supported.
Use this pair only for a request actually routed through ChatGPT OAuth, never an API key.
Append complete UTF-8 lines followed by a newline. Repeated identical hints are harmless.
Do not log prompts, responses, tokens, cookies, authorization headers, or credentials here.

A hint may also name the request's Git repository:

```json
{
  "requestId": "incoming-X-Request-Id",
  "billingProvider": "codex",
  "authMode": "chatgpt",
  "repository": "https://dev.azure.com/org/project/_git/repo"
}
```

`repository` is the remote URL of the repository the sending VS Code workspace works in.
Requests to some custom endpoints produce no agent span, so Copilot's telemetry never
names their repository and they would otherwise be `unattributed`. Token Ledger uses the
hinted remote only when Copilot names none, and treats it like any other Git remote:
only network remotes are uploaded, without credentials. Omit the field when the
repository is not certain. Rows naming different repositories for one request leave it
without one. Like the payer, a hinted repository applies to `sync` only.

Hints only annotate matching Copilot token records. An unmatched hint creates no usage;
an unhinted request keeps ordinary Copilot billing. No model-name inference is performed.
The source provider and session identity remain Copilot. Only `billingProvider` is
uploaded with the hourly usage bucket; request IDs, auth mode and hint paths stay local.
Toki uses the developer's declared Codex/ChatGPT subscription covering that day and
shares its fee across Codex, routed Copilot, and applicable Pi usage. Without that
subscription, routed requests bill at their API-equivalent estimate, even if the
developer has a Copilot subscription. Toki warns about the missing payer subscription.

To override discovery, put `"billingHintsDirectory": "./proxy-hints"` in
`token-ledger.json`. Relative paths resolve against the configuration file's directory.
Pass that config to both `sync --config` and `schedule install --config`.
Scheduled POSIX jobs preserve `XDG_DATA_HOME` from installation; Windows jobs use the
user's `LOCALAPPDATA`.

A missing default directory means no hints. A missing configured directory, unreadable
file, malformed row, unsupported pair, or incomplete final append marks only Copilot
coverage as failed. Its stored usage is kept while other providers still sync. A complete
final JSON row without a newline is accepted. When telemetry is written before its hint,
the next sync repairs the billing route by replacing the same window once the hint is complete.

Sync prints hint failures to stderr, including the file basename and line number for
an invalid row. If a proxy crash leaves a truncated row that later appends turn into
an invalid middle row, repair or remove that row before retrying. The same applies
to unsupported provider/auth pairs. Preserve valid rows; removing a valid hint changes
its request back to native Copilot billing. After repair, run
`token-ledger sync --provider copilot --since YYYY-MM-DD` from the first missed day,
with the same config when applicable. A later scheduled run only revisits its usual
14-day window, so older missed days need this explicit backfill.

Retain hint files for the whole window being synced: normally 14 days, and all retained
history for a first upload or a manual backfill. Deleting the default directory or old
hint rows makes those requests look like ordinary Copilot if their telemetry is synced
again. Token Ledger keeps no separate routing cache.

Deploy Toki's support for **sync payload version 2 before releasing/updating Token Ledger**.
Payloads with routed buckets use version 2; payloads without overrides retain version 1.
An older server rejects version 2 explicitly and keeps its stored usage.
