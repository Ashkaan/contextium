---
name: Cloudflare
description: DNS, Pages, Workers KV, and domain management
hosts:
  - api.cloudflare.com
aliases:
  - cf pages
  - cf workers
  - cf kv
  - cloudflare tunnel
  - cloudflare access
  - wrangler
  - cf access
typed_client:
  - none
access:
  - api
  - cli
uses: none
base_url: https://api.cloudflare.com/client/v4
auth: bearer token (API token)
onepassword_item: none
rate_limit: 1200 requests/5 min per user
cli: "`wrangler` CLI / REST API"
---
# Cloudflare Integration

**Access order:** api, cli — the REST API reaches everything `wrangler` does plus what it does not (Access apps, analytics), and runs where `wrangler` is not installed.

## If you write a client

Nothing here ships one; the REST calls under [Common invocations](#common-invocations) cover reads. If your code touches Workers KV, this is a shape that has held up:

- **Read / list / delete in one module; writes in a separate one**, so every write path is one narrow grep away.
- Read is a single-key GET that returns null on 404. List follows the `cursor` until it is empty and accepts `prefix` + `limit`. Delete treats 404 as success, so it is idempotent.
- Token resolution: take an explicit token argument first, else read it from your vault.
- A registry of your namespace ids by friendly name, so call sites never paste raw ids.
- A per-request timeout (15s is plenty for KV).

## Account

- **Email:** `<your-cloudflare-email>`
- **Account ID:** `<your-account-id>`
- **Domains:** `<your-domains>`

## API Tokens

| Token | Vault Item | Permissions |
|-------|-----------|-------------|
| Pages + KV | `Cloudflare API Token - <consumer>` | Account Settings Read, Cloudflare Pages Edit, User Details Read, Workers KV Storage Edit |

## Wrangler CLI

Authenticated via the Pages + KV token above.

```bash
export CLOUDFLARE_API_TOKEN=$(op item get "<cf-pages-item-id>" --vault "<your-vault>" --fields label=credential --reveal)
wrangler whoami
```

## Cloudflare Pages

Connect Pages projects to a Git repo so they auto-deploy on push to `main`.
**Rule:** Always connect Pages projects to the GitHub repo first. Never use `wrangler pages deploy` as the primary deployment method — it creates a disconnected project that must be deleted and recreated. Use the dashboard or API to set up GitHub integration before the first deploy.

| Project | Domain | Framework |
|---------|--------|-----------|
| `<project-name>` | `<your-domain>` | Astro / Slidev / etc. |

### Event-Driven KV Sync Pattern

A common edge-app pattern: data moves on change (git push, webhook, scheduled job), not on a timer. A build step or job writes JSON to CF KV; SSR pages always read fresh values from KV; connected browsers receive SSE deltas within a few seconds. Document the wire format in a `data-pipeline.md` alongside your app.

### Starting a New Edge App

Clone the closest live app — `cp -r ~/code/<app> ~/code/<new-app> && rm -rf ~/code/<new-app>/{node_modules,.git} && (cd ~/code/<new-app> && git init)` — then strip the app-specific `lib/` + `pages/` and rename in `package.json` + `wrangler.toml`.

## Cloudflare Workers

Workers can serve APIs, MCP servers, or edge logic on a custom domain.

Deploy reality worth knowing: a token with `Workers Scripts:Edit` lets `wrangler deploy` upload the script, but binding a custom domain may need a different permission. If your token lacks zone Workers-Routes/DNS edit, bind the domain via `PUT /accounts/{id}/workers/domains` (account-level) instead of wrangler's zone-route path, or declare it in `wrangler.jsonc` `routes: [{ pattern, custom_domain: true }]`. The cleaner steady state is CF Workers Builds (git-push → `npm ci && npx wrangler deploy`, using CF's own deploy creds, which handle the route).

For a Worker that needs secrets, set them via `wrangler secret put` (or a `scripts/set-secrets.sh` helper). If you front a Worker with a shared secret, prefer a constant-time Bearer-header check; if you also support a `/<secret>/mcp` path fallback, turn observability OFF so the secret-bearing URL isn't logged.

## Cloudflare Tunnels

Remotely managed tunnels (token-based, configured in the Zero Trust dashboard) expose internal services without opening inbound ports.

| Tunnel | Host | Routes |
|--------|------|--------|
| `<tunnel-name>` | `<docker-host>` (`<lan-ip>`) | Internal services |

A tunnel public hostname (Zero Trust → Networks → Tunnels → Public Hostnames) maps a hostname to an internal `http://<lan-ip>:<port>`. Pair it with an Access policy (bypass or identity-based) as needed.

A common pattern for inbound webhooks: route ONE public hostname (e.g. `webhooks.<your-domain>`) through a tunnel ingress + Access bypass to a thin reverse-proxy on your runner that path-routes to each app's local listener. New receivers add a route to the proxy, no Cloudflare dashboard change needed.

## Cloudflare Access (Zero Trust)

- **Team domain:** `<your-team>.cloudflareaccess.com`
- **Plan:** Zero Trust Free (50 seats)
- **Identity provider:** Google (OAuth + PKCE), or any IdP you configure
  - Authorized redirect: `https://<your-team>.cloudflareaccess.com/cdn-cgi/access/callback`

### Protected Applications

| Application | Domain | Policy | IdP |
|-------------|--------|--------|-----|
| `<app-name>` | `<your-domain>` | Allow `<your-email>` (or `@<your-domain>`) | Google |

### Adding a new protected app

1. Zero Trust → Access controls → Applications → Add application → Self-hosted
2. Set domain, session duration
3. Add policy: Action=Allow, Include=Emails `<your-email>`
4. Select your identity provider, enable Instant Auth
5. Save

### Service token bypass for headless probes

Headless callers (probes, scripts, anything without an interactive browser
session) authenticate via a CF Access service token sent as
`CF-Access-Client-Id` + `CF-Access-Client-Secret` headers. **Three load-
bearing details that cost time when missed:**

1. **Service tokens require their own `decision: non_identity` policy.** They
   are silently ignored when added to a `decision: allow` (identity-based)
   policy's `include` array — the redirect's JWT decodes to
   `service_token_status: false` regardless. Pattern: keep the existing
   identity policy untouched, add a separate policy with `decision:
   non_identity` and one `include: [{service_token: {token_id}}]` rule. Both
   policies attach to the same app.
2. **The Pages API token needs TWO permission groups for end-to-end
   automation:** `Access: Service Tokens: Edit` (creates tokens) AND
   `Access: Apps and Policies: Edit` (modifies the policies that authorize
   them). Either alone is insufficient.
3. **Reusable policies use the account-level endpoint, not the app-level
   one.** `PUT /accounts/{id}/access/apps/{app_id}/policies/{policy_id}`
   returns `cannot update reusable policies through this endpoint`; use
   `PUT /accounts/{id}/access/policies/{policy_id}` instead. To attach a
   newly-created policy to an app, `PUT /access/apps/{app_id}` with the
   full app body (`name`, `domain`, `type`, `session_duration`, `policies`)
   — partial bodies error with `app type is missing or invalid`.

**Recipe (end-to-end via API):**

```bash
CF_TOKEN=$(op item get "<cf-pages-item-id>" --vault "<your-vault>" --fields label=credential --reveal)
ACCOUNT_ID="<your-account-id>"

# 1. Create the service token
curl -fsS -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<probe-name>","duration":"forever"}' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/service_tokens"
# → returns id, client_id, client_secret. Save to your vault as
#   "Cloudflare Access - <Probe Name>" (client_id, client_secret, token_id concealed).

# 2. Create a non_identity policy referencing the token
curl -fsS -X POST -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name":"Service - <probe-name>",
    "decision":"non_identity",
    "include":[{"service_token":{"token_id":"<TOKEN_ID>"}}]
  }' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/policies"
# → returns the new policy id

# 3. Attach the new policy alongside the existing identity policy
APP_ID="<app-id>"
APP=$(curl -fsS -H "Authorization: Bearer $CF_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$APP_ID")
# Then PUT with full body and the merged policies array
curl -fsS -X PUT -H "Authorization: Bearer $CF_TOKEN" -H "Content-Type: application/json" \
  -d '{
    "name":"<existing-name>",
    "domain":"<existing-domain>",
    "type":"self_hosted",
    "session_duration":"<existing-duration>",
    "policies":["<existing-policy-id>","<new-policy-id>"]
  }' \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/access/apps/$APP_ID"

# 4. Test (allow ~5-10s for propagation)
curl -sI \
  -H "CF-Access-Client-Id: <client_id>" \
  -H "CF-Access-Client-Secret: <client_secret>" \
  "https://<domain>/"
# Expect HTTP 200. HTTP 302 to login means policy didn't take.
```

**Diagnostic — service-token auth failing despite policy-attach success:**
decode the `meta` JWT in the redirect's `Location` header (everything after
`?meta=`, before `&redirect_url=`). If `service_token_status: false`, the
token is being ignored — almost always means the policy is `decision:
allow` instead of `decision: non_identity` (per detail #1 above).

## Common invocations

### Smoke / auth check
```bash
CF_API_TOKEN="$(op read 'op://<your-vault>/<cf-pages-item-id>/credential')" && curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq -r '.result | "token_id=\(.id) status=\(.status)"'
```

### Refresh / re-auth
```bash
export CF_API_TOKEN="$(op read 'op://<your-vault>/<cf-pages-item-id>/credential')" && curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" https://api.cloudflare.com/client/v4/user/tokens/verify | jq -e '.result.status=="active"' >/dev/null && echo "CF_API_TOKEN refreshed and active"
```

### Common queries / actions
- List KV keys with a prefix: `CF_API_TOKEN="$(op read 'op://<your-vault>/<cf-pages-item-id>/credential')" && curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/<your-account-id>/storage/kv/namespaces/<namespace-id>/keys?prefix=<prefix>&limit=1000" | jq -r '.result[].name'`
- Read a KV value: `CF_API_TOKEN="$(op read 'op://<your-vault>/<cf-pages-item-id>/credential')" && curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/<your-account-id>/storage/kv/namespaces/<namespace-id>/values/<key>"`
- List Pages projects in the account: `CF_API_TOKEN="$(op read 'op://<your-vault>/<cf-pages-item-id>/credential')" && curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" "https://api.cloudflare.com/client/v4/accounts/<your-account-id>/pages/projects" | jq -r '.result[].name'`
- Probe a CF Access service-token bypass: `curl -sSI -H "CF-Access-Client-Id: $(op read 'op://<your-vault>/<cf-access-item-id>/client_id')" -H "CF-Access-Client-Secret: $(op read 'op://<your-vault>/<cf-access-item-id>/client_secret')" https://<your-domain>/ | sed -n '1p'`

### Common failures
- `invalid secret reference ... invalid character in secret reference: '('` from `op read` → use vault item IDs in secret refs instead of titles containing parentheses.
- `Authentication error [code: 10000]` from Wrangler/API → token is wrong or missing scope; reload the token from your vault and re-run Smoke. If still failing, rotate the Cloudflare API token and update the vault item.
- CF Access probe returns `HTTP/2 302` instead of `200` → service token is not authorized; attach a separate `decision: non_identity` policy for the token on the Access app.
- `jq` parse errors on KV value reads → key is missing or the stored value is not JSON; inspect HTTP status first (`curl -sS -o /dev/null -w '%{http_code}\n' ...`) and verify namespace/key spelling.
