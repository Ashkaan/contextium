---
name: Uptime Kuma
description: Push-based uptime + heartbeat monitoring with status pages and email alerts
cli: Web UI / Push API
hosts:
  - <kuma-host>
  - <lan-ip>
aliases:
  - kuma
  - uptime kuma
  - uptime-kuma
  - heartbeat monitor
  - heartbeat monitoring
  - status page
  - uptime monitoring
  - push monitor
---
# Uptime Kuma Integration

**Instance:** `https://<kuma-host>` (optionally behind a reverse proxy / tunnel)
**Internal:** `<lan-ip>` (port 3001 default)
**Docker network DNS:** `uptime-kuma:3001` (for container-to-container traffic where the kuma container is named `uptime-kuma`; this is what `KUMA_BASE_URL` should be set to inside a runner on the same docker network — NOT the public hostname).
**Image:** `louislam/uptime-kuma:2`
**Data:** SQLite DB at `kuma.db` under the container's data volume.

## Purpose

Monitors endpoints (services, devices, websites). Push monitors track scheduled processes (backups, automations); active probes (HTTP/TCP/ping) track always-on services.

## Access patterns

### Push API (heartbeats from scheduled processes)

Each push monitor has a unique URL. On success, the script curls:

```bash
curl -fsS "https://<kuma-host>/api/push/<MONITOR_ID>?status=up&msg=summary&ping=duration_ms" >/dev/null
```

Parameters:
- `status` — `up` (green) or `down` (red, active failure signal). Kuma push has no native "yellow"/warning status — see below for the visual-only pattern.
- `msg` — URL-encoded text shown on the status page (use for component counts, sizes, failure reasons)
- `ping` — optional response-time milliseconds

Missing pings within the monitor's interval window auto-trigger Kuma's email notification.

#### Visual-only ("yellow") signal pattern

Kuma's push API only accepts `up` and `down`. To get a warning signal that
flags the dashboard without firing an email alert (the practical equivalent
of a "yellow" state), create the monitor with **`notifications=[]`** via
[`addPushMonitor`](kuma_client.ts) and treat `down` as the warning state.
Scripts push `up` on clean runs, `down` on data-quality issues; the
dashboard shows red but no email goes out.

Use this for "did the data sync match expectations?" monitors where you
want visibility on drift without paging anyone. Reserve email notifications
for true execution failures (script crash, missed heartbeat).

**Caveat:** `down` pushes count against the monitor's recorded uptime%
(persisted in `stat_daily`). If a visual-only-signal monitor is ever placed
on a public status page, every `down` for a data-quality issue will degrade
the displayed uptime number alongside genuine outages. Either keep these
monitors off public status pages, or accept that "yellow signal" reduces
visible availability as part of the trade-off.

### Stack management (start, stop, redeploy, logs)

If you manage the container via Komodo, see [`integrations/komodo/README.md`](../komodo/README.md) for the API pattern. Otherwise restart it via your usual Docker tooling.

### Direct DB access (read monitor list)

Kuma stores its config in SQLite at the container's data volume (`.../uptime-kuma/kuma.db`). Read it over SSH on the container host. Use `-readonly` because Kuma actively writes to the DB (look for `kuma.db-shm` and `kuma.db-wal` sidecar files):

```bash
ssh <container-host> "sqlite3 -readonly /path/to/uptime-kuma/kuma.db 'SELECT id, name, type, hostname, port FROM monitor WHERE active=1;'"
```

This is the cleanest way to enumerate existing monitors without admin UI access.

**Schema gotcha:** the `monitor` table has ~100 columns, but each monitor type only reads a few. For `type=port` (TCP), only `hostname` + `port` matter — `url` is inert leftover data and is NOT shown in the Kuma UI for TCP monitors. For `type=http` and `type=keyword`, `url` IS the probe target. For `type=push`, `push_token` is the URL slug (`/api/push/<push_token>`). Don't infer "config drift" from stale values in fields a monitor type doesn't use.

**Direct-DB write gotcha:** if you INSERT into `monitor` without setting `user_id`, Kuma will **probe the monitor and write heartbeats**, but the UI **will not display it** — the dashboard filters by `user_id`. Always set `user_id = 1` (or whichever your user id is from `SELECT id, username FROM user`). Also link to notifications via `INSERT INTO monitor_notification (monitor_id, notification_id)` — Kuma does not auto-link new monitors to default notifications. Restart the container after writes (`docker restart uptime-kuma`) so it reloads from disk.

**Preferred API path:** for non-trivial monitor changes, use the `uptime-kuma-api` Python lib (Socket.IO) or the TypeScript client below. It enforces all the invariants direct DB writes can miss (user_id, notification linkage, runtime cache invalidation). Direct SQLite is OK for read-only queries and bulk reversible operations (toggling `active`, renaming) where the gotchas are documented.

**Restart after delete or rename — protocol:** When you call `deleteMonitor` or rename a monitor (via the Socket.IO API or direct DB UPDATE), Kuma 2.x removes the row from the `monitor` table but does **not** invalidate the in-memory beat scheduler. The deleted monitor IDs keep ticking every ~20s, log `Monitor #N 'null': Failing: No heartbeat in the time window`, fail the next `INSERT INTO stat_daily` on a FK constraint, **and fire DOWN email notifications using the cached monitor name** — sometimes for hours after the deletion, until something else triggers a scheduler reload. The fix is mechanical: after any batch of deletions or renames, run `ssh <container-host> 'docker restart uptime-kuma'`. The container reloads from disk in ~25s, the in-memory scheduler rebuilds from the current DB, and the orphans go silent. Diagnostic — to confirm orphan firing: `ssh <container-host> 'docker logs --since 1m uptime-kuma 2>&1 | grep -E "Monitor #[0-9]+ \x27null\x27"'`.

### Monitor CRUD (create / update / delete monitors)

Kuma has no first-class REST API for monitor CRUD. Two paths:

1. **UI:** click through `https://<kuma-host>`. Manual but reliable.
2. **TypeScript client (preferred for automation):** [`kuma_client.ts`](kuma_client.ts) — `socket.io-client` wrapper. Handles three Kuma 2.x quirks:

   - **2FA, if enabled** (`twofa_status=1` on your user). `connect()` reads the current TOTP from your secrets vault via `op --otp` and retries once on `authInvalidToken` (TOTP race on the 30s window boundary).
   - **Request-then-broadcast pattern.** `getMonitorList` ack returns `{ok:true}`; the actual monitor data fires later as a `monitorList` broadcast event. `getMonitors()` registers a one-shot listener for the broadcast before triggering the request.
   - **Internal URL default.** `kuma_client.ts` uses `http://<lan-ip>:3001` for Socket.IO (lower latency, no proxy in the path). The public `https://<kuma-host>` polling handshake (`/socket.io/?EIO=4&transport=polling`) returns 200, so the public URL is a viable fallback if the LAN IP isn't reachable from the caller.

```ts
import { connect, getMonitors, addPushMonitor, generatePushToken }
  from "../../integrations/uptime-kuma/kuma_client.ts";

const client = await connect();
try {
  const monitors = await getMonitors(client);
  console.log(`${monitors.length} monitors`);

  const token = generatePushToken();
  await addPushMonitor(client, {
    name: "backup-example",
    intervalSeconds: 691200, // 8d
    pushToken: token,
    notificationIds: [1],
  });
} finally {
  client.disconnect();
}
```

Credentials in your secrets vault → `Uptime Kuma - <your-vault>`:
- `username`
- `credential` — password
- `one-time password` (OTP field) — otpauth URI; `op --otp` returns the current 6-digit code

No SSH or DB lookup needed at auth time.

The API path is **strongly preferred over direct SQLite writes** for monitor CRUD — it sets `user_id`, links default notifications, and invalidates Kuma's runtime cache. Direct DB writes can leave monitors invisible in the UI (see "Direct-DB write gotcha"). Direct SQL is fine for read-only queries and bulk reversible UPDATEs (renames, toggling `active`).

### Status page CRUD (Kuma 2.x quirks)

The Python lib's `save_status_page()` and `get_status_page()` both call a 2.x-broken HTTP endpoint and crash with `KeyError: 'incident'`. Workarounds:

- **Read:** call `api._call("getStatusPage", "<slug>")` — returns `{config: {...}}` only (no group list, fetch separately if needed).
- **Write:** call `api.sio.call("saveStatusPage", (slug, config, imgDataUrl, publicGroupList), timeout=30)`. Three things to know:
  1. **Args are positional, not a list.** Pass them as a Python tuple — `socketio.call` unpacks tuples into multiple positional args; lists are sent as a single arg and Kuma's handler errors with `"No slug?"`.
  2. **`imgDataUrl` cannot be `None`.** Kuma calls `.startsWith("data:")` on it. Pass the existing `config["icon"]` value (e.g., `"/icon.svg"`) when you don't want to change the logo.
  3. **Preserve the full `config` dict.** Kuma validates fields like `analyticsType` against an enum; if you build a partial config from scratch, you get `{ok: False, msg: "Invalid analytics type"}`. Best practice: fetch the existing config, mutate only what you need, send back the whole thing.

## UI patch: default push-example language = TypeScript

Kuma 2.x hard-codes the push-monitor code-example dropdown default to `javascript-fetch` in its compiled JS bundle. That value is not stored per-monitor anywhere — it's pure Vue component state baked into `/app/dist/assets/index-*.js`. To make the dropdown default to TypeScript:

```bash
ssh <container-host> 'docker exec uptime-kuma bash -c "
  cd /app/dist/assets
  JS=\$(ls index-*.js | head -1)
  sed -i -e \"s#currentExample:\\\"javascript-fetch\\\"#currentExample:\\\"typescript-fetch\\\"#g\" \$JS
  rm -f \$JS.br \$JS.gz
  gzip -9 -k \$JS
"'
docker restart uptime-kuma  # or via your Docker management tool
```

**Must re-apply after any Kuma container rebuild** (image upgrade). The `index-*.js` filename changes per-release, so the sed targets whatever the current name is via `ls index-*.js`. The `.br` brotli variant must be removed because the brotli CLI isn't inside the container to regenerate it; Kuma falls back to `.gz` for clients that accept either.

## Notifications

Native SMTP, configured in the Kuma UI. Kuma is a notification service whose native function is email; routing it through a separate mail bridge would add a layer with no audit benefit.

## Status pages

Public status pages can be configured in the Kuma UI for grouped views (e.g. service availability, backups, automations).

## Common tasks

| Task | How |
|------|-----|
| List existing monitors | SQLite query above |
| Create a new push monitor | Kuma UI → Add New Monitor → type "Push" → save → copy the URL |
| Get push URL for a monitor | Kuma UI → click monitor → Settings → "Push URL" |
| Restart Kuma | `docker restart uptime-kuma` (or your Docker tool) |
| View logs | `docker logs uptime-kuma` |

## Common invocations

> **Prerequisite:** `kuma_client.ts` imports `socket.io-client`. Since it's library code (no owning app), install the dep once into a shared off-repo location and run snippets from that directory so Node's ESM resolver can find it:
>
> ```bash
> mkdir -p ~/.local/lib/kuma-client && cd ~/.local/lib/kuma-client
> npm install --no-save socket.io-client@^4
> cp <repo>/integrations/uptime-kuma/kuma_client.ts .
> ```
>
> Then run the `node --input-type=module -e ...` snippets below from `~/.local/lib/kuma-client/` using the local `./kuma_client.ts` copy.

### Smoke / auth check
```bash
curl -fsS -o /dev/null -w "%{http_code}\n" "http://<lan-ip>:3001/" && op item get '<kuma-item-id>' --vault '<your-vault>' --fields label=username --reveal >/dev/null && echo "kuma reachable + vault creds present"
```

### Refresh / re-auth
```bash
node --input-type=module -e "import { connect } from './kuma_client.ts'; const c = await connect(); console.log('login ok'); c.disconnect();"
```

### Common queries / actions
- Push a heartbeat (use the monitor's push token from Kuma UI): `node --input-type=module -e "import { kumaPush } from './uptime-kuma.ts'; const ok = await kumaPush(process.env.TOKEN, { status: 'up', msg: 'manual smoke' }); console.log(JSON.stringify({ ok }));"` # set TOKEN=<push_token> first
- List all monitors (Socket.IO): `node --input-type=module -e "import { connect, getMonitors } from './kuma_client.ts'; const c = await connect(); try { const ms = await getMonitors(c); console.log(JSON.stringify({ count: ms.length, types: [...new Set(ms.map(m => m.type))] })); } finally { c.disconnect(); }"`
- Read monitor list via SQLite (no auth, no Socket.IO): `ssh <container-host> "sqlite3 -readonly /path/to/uptime-kuma/kuma.db 'SELECT id, name, type, active FROM monitor WHERE active=1 ORDER BY name;'"`
- Add a push monitor with generated token: `node --input-type=module -e "import { connect, addPushMonitor, generatePushToken } from './kuma_client.ts'; const c = await connect(); try { const token = generatePushToken(); const r = await addPushMonitor(c, { name: process.env.NAME, intervalSeconds: 86400, pushToken: token, notificationIds: [1] }); console.log(JSON.stringify({ monitorID: r.monitorID, token })); } finally { c.disconnect(); }"` # set NAME=<monitor_name>
- Restart Kuma after monitor delete/rename (clears in-memory orphan beats): `ssh <container-host> 'docker restart uptime-kuma'`
- Read status page config (read-only): `node --input-type=module -e "import { connect, getStatusPageConfig } from './kuma_client.ts'; const c = await connect(); try { const cfg = await getStatusPageConfig(c, process.env.SLUG); console.log(JSON.stringify({ id: cfg.id, slug: cfg.slug, title: cfg.title })); } finally { c.disconnect(); }"` # set SLUG=<page_slug>

### Common failures
- `connect timeout` / `connect_error` against `http://<lan-ip>:3001` → Kuma container down or host unreachable; restart via `ssh <container-host> 'docker restart uptime-kuma'`.
- `login failed: {"msg":"authInvalidToken"}` after retry → vault OTP field is stale or `op --otp` returned empty; re-verify the OTP secret in your vault item.
- `404 Not Found` against the public host → wrong hostname. Verify the URL with `curl -I https://<kuma-host>/` before claiming the service or a push token is broken.
- New monitor probes but doesn't appear in UI → direct DB INSERT missing `user_id=1`; use `addPushMonitor()` (Socket.IO) instead, or UPDATE the row to set `user_id=1` and restart Kuma.
- Deleted/renamed monitor still firing `[Down]` emails → in-memory beat scheduler stale; run `ssh <container-host> 'docker restart uptime-kuma'` after any delete/rename batch (per § "Restart after delete or rename").
