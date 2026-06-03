---
name: 1Password
description: Secrets vault for API keys, client credentials, and passwords
cli: "`op` CLI"
aliases:
  - 1p
  - secrets vault
  - credential vault
  - op cli
  - op_helper
  - getCred
---
# 1Password Integration

Static credentials (API keys, client secrets, passwords) are stored in a dedicated 1Password vault (referred to below as `<your-vault>`). OAuth tokens (access/refresh) are stored in each integration's vault item too, kept fresh by a refresher job. Pick one vault name and use it consistently.

## Service Account

```
OP_SERVICE_ACCOUNT_TOKEN=<stored in your vault as "1Password Service Account Token">
```

Set it where every shell that runs your automations will see it. For zsh, `~/.zshenv` is the safe choice — it's sourced for non-interactive, non-login shells too (which is what SSH-invoked commands and cron use). `~/.zshrc` only covers interactive shells.

## Prerequisites

- `op` CLI installed: `sudo apt install 1password-cli` (Ubuntu) or `brew install 1password-cli` (macOS)
- `OP_SERVICE_ACCOUNT_TOKEN` set in `~/.zshenv` (all contexts) and `~/.zshrc` (interactive)

## Conventions for new credentials

### Title format

`{Service or Resource}{ ({Type})} - {Consumer}`

**Consumers:** name them for who reads the credential (e.g. `Runner`, `Workstation`, `Shared`). Use `Shared` when multiple consumers read it (most common).

Examples:
- `Some Service OAuth - Shared`
- `API Token - Workstation`

### Category (1P item type)

Pick by intent, not by the literal field count:

| Category | When to use | Example |
|----------|-------------|---------|
| `Login` | The credential authenticates a human at a website (web UI / admin panel). Has a website URL field; autofill is a real use case. | A SaaS admin panel |
| `API Credential` | A single secret consumed only by code. No human identity, no interactive login. | A single API token |
| `Secure Note` | Multi-field credential with no website (OAuth client_id+secret+refresh_token, multi-token APIs, SSH keypairs). | OAuth items, SSH keys |

**Never use the `SSH Key` category** — the 1P CLI cannot edit or read SSH-Key-category items (`SSH Key item editing in the CLI is not yet supported`). Use `Secure Note` with `private_key` (concealed) + `public_key` (text) custom fields instead.

### Decision tree

```
Does a human log in to this with username + password at a website?
├── YES → Login
└── NO  → Is this a single secret consumed only by code?
          ├── YES → API Credential
          └── NO  → Secure Note (multi-field, no web login)
```

### Description field

Keep it as a one-liner ("what it is + who refreshes it + who reads it"). No tags, no custom metadata fields.

The classification is cosmetic at the code level: `getCred(CREDS.x, "field")` works the same regardless of category. The category drives 1P UI rendering, autofill, and `op` CLI editability.

## Vault Items

The 1Password vault is the source of truth. Query it directly rather than maintaining a static list:

```bash
op item list --vault "<your-vault>"
```

The typed map at [`credentials.ts`](credentials.ts) declares which UUIDs are referenced by repo code, but the vault itself is canonical.

## Helper Module

`integrations/1password/op_helper.ts` exposes two APIs.

### UUID-based (preferred)

References the typed map at [`credentials.ts`](credentials.ts). Stable across renames; field names type-checked at compile time.

```typescript
import { CREDS, getCred, getCredAll } from "../integrations/1password/op_helper.ts";

// Single field — type-safe field name
const clientId = await getCred(CREDS.someService, "clientId");

// All declared fields — typed return shape
const creds = await getCredAll(CREDS.someService);
```

### Execution paths — Connect (optional) → `op` CLI (fallback)

If you run a 1Password Connect server on your network, reads can go through it first and fall back to the `op` CLI. Connect gives you a dedicated rate-limit budget and per-item caching — useful when many workers read credentials at once.

Reads (`getCred`, `getCredAll`, `getRawField`) follow this order on every call:

1. **1P Connect server (primary, if configured).** If `OP_CONNECT_HOST` + `OP_CONNECT_TOKEN` env vars are set, fetch the full item from the local Connect server. One HTTP call returns all fields; per-item cache keys mean any subsequent field on the same item is a cache hit.
2. **Retry transient failures.** On HTTP 5xx, 429, or a fetch-level network error, the helper retries up to `OP_CONNECT_MAX_ATTEMPTS` times (default 3) with exponential backoff. 4xx errors propagate immediately.
3. **Fall back to `op` CLI.** After retries are exhausted on transient errors, the helper runs `op read op://<vault>/<id>/<field>` for that single call. Subsequent calls retry Connect from scratch.
4. **No Connect env vars set?** Skip steps 1-3, use `op` CLI directly. This is the simplest setup and works fine without Connect.

### Title-based (legacy)

Couples code to 1P titles — a rename breaks callers. Kept for backward compatibility; prefer UUID-based.

```typescript
import { getItem, getField } from "../integrations/1password/op_helper.ts";

const creds = await getItem("Some Service - <your-vault>");
const apiKey = await getField("Todoist API - <your-vault>", "api_key");
```

### Adding a new credential

1. Create the item in 1P following the naming convention above.
2. Get the UUID: `op item list --vault "<your-vault>" --format json | jq '.[] | select(.title=="<title>") | .id'`
3. Add an entry to [`credentials.ts`](credentials.ts) with `id` (UUID), `title`, `fields` map (code-side names → 1P field labels), `rotates: true` if it's an OAuth token, and a one-line description.
4. Use it: `await getCred(CREDS.newCred, "fieldName")`

## CLI Quick Reference

```bash
# Read a field (--reveal required for service accounts to get actual values)
op read "op://<your-vault>/<item-id>/api_key"

# Get a single field value (always use --reveal with service accounts)
op item get "<item-id>" --vault "<your-vault>" --reveal --fields label=api_key

# Get all fields as JSON
op item get "<item-id>" --vault "<your-vault>" --reveal --format json

# Use as env var inline
SOME_API_TOKEN=$(op item get "<item-id>" --vault "<your-vault>" --reveal --fields label=credential) some-command

# Edit a field
op item edit "<item-id>" "api_key=new_value" --vault "<your-vault>"

# List all items
op item list --vault "<your-vault>"
```

> **Important:** Service accounts require `--reveal` to return actual field values. Without it, `op item get --fields` returns a reference placeholder instead of the real value. This is a 1Password security feature — service accounts conceal secrets by default.

## Connect Server (optional)

A local 1Password Connect server proxies + caches credential reads with its own rate-limit budget. If many workers read credentials and you hit upstream rate limits, deploying Connect resolves it.

**Architecture:**
- `1password-connect-api` container exposes a `/v1/*` REST API on your LAN
- `1password-connect-sync` container syncs vault state from upstream 1Password
- Both containers share `1password-credentials.json` (encryption key) + a `data/` directory

**Auth:** Bearer access token (`OP_CONNECT_TOKEN`), distinct from `OP_SERVICE_ACCOUNT_TOKEN`. Store it in your vault and have workers source it via their environment.

**Bootstrap (one-time human step — requires 1P admin web access):**

```bash
# 1. On a machine with `op` CLI signed in as the human admin (NOT the service account):
op connect server create "<connect-name>" --vaults "<your-vault>"
# → writes 1password-credentials.json to cwd

# 2. Mint an access token for the server, scoped read-only on the vault:
op connect token create "<connect-name>" --server "<connect-name>" --vault "<your-vault>"
# → prints the JWT to stdout (capture this — only shown once)

# 3. Deploy the two containers on your services host, mounting the credentials
#    file and the data directory. Save the access token + the Connect host URL
#    to your vault for runtime lookup.

# 4. Verify health:
curl -s http://<connect-host>:8080/heartbeat   # → ok
```

**Verification after Connect is live:**

```typescript
import { CONNECT_AVAILABLE } from "../integrations/1password/op_helper.ts";
console.log("Connect:", CONNECT_AVAILABLE);  // true if env vars set
```

```bash
curl -s -H "Authorization: Bearer $OP_CONNECT_TOKEN" \
  "$OP_CONNECT_HOST/v1/vaults" | jq '.[].name'
# → "<your-vault>"
```

**Rotation:** generate a new access token via `op connect token create`, update the vault item, push to every worker's environment, restart workers. The old token becomes invalid as soon as the new one is minted.

## Notes

- **SSH keys:** Store SSH keys as `Secure Note` with `private_key[concealed]` and `public_key[text]` fields. The `SSH Key` category's `private_key` field doesn't accept assignment syntax via `op item create`.
- **Reserved field names:** `fingerprint` and `private key` (with space) are reserved and can't be used as custom field names. Use alternatives like `key_fingerprint`.

## Troubleshooting

| Error | Fix |
|-------|-----|
| `op: command not found` | Install: `sudo apt install 1password-cli` |
| `not signed in` | Set `OP_SERVICE_ACCOUNT_TOKEN` in environment |
| `No accounts configured for use with 1Password CLI` | Token not in shell env. Check `~/.zshenv` exists and exports `OP_SERVICE_ACCOUNT_TOKEN`. Run `zsh -c 'op whoami'` to test non-interactive access. |
| `item not found` | Check item name matches exactly (case-sensitive) |
| Field value is a reference placeholder | Add `--reveal` flag. Service accounts conceal values by default. |
| `Unable to authenticate request [code: 10001]` | Token value may be a placeholder — re-fetch with `--reveal`. |
| Timeout | Check network connectivity to 1Password servers |

## Common invocations

### Smoke / auth check
```bash
op whoami && op read 'op://<your-vault>/1Password Service Account Token/credential' >/dev/null && echo '1Password CLI auth OK'
```

### Common queries / actions
- List item UUIDs + titles in the vault: `op item list --vault '<your-vault>' --format json | jq -r '.[] | [.id,.title] | @tsv'`
- Inspect field labels before writing/reading: `op item get '<item-title>' --vault '<your-vault>' --format json | jq -r '.fields[].label'`
- Read by UUID when title has unsupported characters: `op read 'op://<your-vault>/<item-id>/credential'`
- Preview an edit without writing: `op item edit '<item-title>' --vault '<your-vault>' --dry-run 'api_key[concealed]=dry-run-check'`

### Common failures
- `op: command not found` → install CLI (`sudo apt install 1password-cli` on Ubuntu, `brew install 1password-cli` on macOS).
- `No accounts configured for use with 1Password CLI` or `not signed in` → ensure `OP_SERVICE_ACCOUNT_TOKEN` is exported in `~/.zshenv`; verify with `zsh -lc 'source ~/.zshenv; op whoami'`.
- `Unable to authenticate request [code: 10001]` → token is invalid/stale; rotate in 1Password and update `OP_SERVICE_ACCOUNT_TOKEN`.
- Service account ignored while Connect vars are set → unset `OP_CONNECT_HOST` and `OP_CONNECT_TOKEN`, then retry `op whoami`.
- `invalid secret reference ... invalid character` (for titles with `(`, `)`, `@`, etc.) → use the item UUID in the secret reference path.
- `item does not have a field ...` → confirm labels with `op item get '<item-title>' --vault '<your-vault>' --format json | jq -r '.fields[].label'`.
