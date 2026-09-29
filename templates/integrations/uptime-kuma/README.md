---
name: Uptime Kuma
description: Push-based uptime + heartbeat monitoring with status pages and email alerts
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
typed_client:
  - none
access:
  - api
  - ssh
  - browser
uses: none
base_url: https://<kuma-host>
auth: push tokens in the URL for push monitors; a login (with 2FA if enabled) for the Socket.IO API
onepassword_item: none
rate_limit: none documented
cli: Web UI / Push API
---
# Uptime Kuma Integration

**Access order:** api, ssh, browser — the push API plus the Socket.IO API cover heartbeats and monitor and status-page changes; SSH adds the container restart and read-only SQLite lookups; the web UI does it all by hand.

**Instance:** `https://<kuma-host>` (optionally behind a reverse proxy / tunnel)
**Internal:** `<lan-ip>` (port 3001 default)
**Docker network DNS:** `uptime-kuma:3001` (for container-to-container traffic where the kuma container is named `uptime-kuma`; use this as the base URL from a runner on the same docker network — NOT the public hostname).
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
of a "yellow" state), create the monitor with **no notifications attached** (untick them in the
UI, or pass an empty notification list through the Socket.IO API) and treat
`down` as the warning state.
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

**Preferred API path:** for non-trivial monitor changes, use the Socket.IO API — the `uptime-kuma-api` Python lib, or a client of your own (below). It enforces all the invariants direct DB writes can miss (user_id, notification linkage, runtime cache invalidation). Direct SQLite is OK for read-only queries and bulk reversible operations (toggling `active`, renaming) where the gotchas are documented.

**Restart after delete or rename — protocol:** When you call `deleteMonitor` or rename a monitor (via the Socket.IO API or direct DB UPDATE), Kuma 2.x removes the row from the `monitor` table but does **not** invalidate the in-memory beat scheduler. The deleted monitor IDs keep ticking every ~20s, log `Monitor #N 'null': Failing: No heartbeat in the time window`, fail the next `INSERT INTO stat_daily` on a FK constraint, **and fire DOWN email notifications using the cached monitor name** — sometimes for hours after the deletion, until something else triggers a scheduler reload. The fix is mechanical: after any batch of deletions or renames, run `ssh <container-host> 'docker restart uptime-kuma'`. The container reloads from disk in ~25s, the in-memory scheduler rebuilds from the current DB, and the orphans go silent. Diagnostic — to confirm orphan firing: `ssh <container-host> 'docker logs --since 1m uptime-kuma 2>&1 | grep -E "Monitor #[0-9]+ \x27null\x27"'`.

### Monitor CRUD (create / update / delete monitors)

Kuma has no first-class REST API for monitor CRUD. Two paths:

1. **UI:** click through `https://<kuma-host>`. Manual but reliable.
2. **Socket.IO API (preferred for automation):** the `uptime-kuma-api` Python lib, or a `socket.io-client` wrapper of your own. A client you write has to handle three Kuma 2.x quirks:

   - **2FA, if enabled** (`twofa_status=1` on your user). Read the current TOTP from your vault (`op item get <kuma-item-id> --otp`) at login, and retry once on `authInvalidToken` — the code can roll over on the 30s boundary between reading and sending it.
   - **Request-then-broadcast.** The `getMonitorList` ack returns only `{ok:true}`; the monitor data arrives later as a `monitorList` broadcast. Register a one-shot listener for the broadcast before sending the request.
   - **Internal URL.** Connect to `http://<lan-ip>:3001` (lower latency, no proxy in the path). The public `https://<kuma-host>` polling handshake (`/socket.io/?EIO=4&transport=polling`) also returns 200, so it is a viable fallback when the LAN IP is not reachable from the caller.

   Worth exposing: connect, list monitors, add a push monitor (name, interval, push token, notification ids), generate a push token, read a status page config.

Credentials in your secrets vault → `Uptime Kuma - <consumer>`:
- `username`
- `credential` — password
- `one-time password` (OTP field) — otpauth URI; `op item get --otp` returns the current 6-digit code

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

### Smoke / auth check
```bash
curl -fsS -o /dev/null -w "%{http_code}\n" "http://<lan-ip>:3001/" && op item get '<kuma-item-id>' --vault '<your-vault>' --fields label=username --reveal >/dev/null && echo "kuma reachable + vault creds present"
```

### Refresh / re-auth
Kuma logs in per Socket.IO connection, so there is nothing to refresh. To prove the vault credentials still log in (needs `pip install uptime-kuma-api`):
```bash
KUMA_USER="$(op read 'op://<your-vault>/<kuma-item-id>/username')" KUMA_PASS="$(op read 'op://<your-vault>/<kuma-item-id>/credential')" KUMA_OTP="$(op item get '<kuma-item-id>' --vault '<your-vault>' --otp)" \
  python3 -c 'import os; from uptime_kuma_api import UptimeKumaApi; api = UptimeKumaApi("http://<lan-ip>:3001"); api.login(os.environ["KUMA_USER"], os.environ["KUMA_PASS"], os.environ["KUMA_OTP"]); print("login ok,", len(api.get_monitors()), "monitors"); api.disconnect()'
```
Drop `KUMA_OTP` and the third `login` argument if 2FA is off.

### Common queries / actions
- Push a heartbeat (push token from the Kuma UI): `curl -fsS "https://<kuma-host>/api/push/<push_token>?status=up&msg=manual%20smoke"`
- Read the monitor list via SQLite (no auth, no Socket.IO): `ssh <container-host> "sqlite3 -readonly /path/to/uptime-kuma/kuma.db 'SELECT id, name, type, active FROM monitor WHERE active=1 ORDER BY name;'"`
- Add a push monitor: Kuma UI → Add New Monitor → type "Push" → save → copy the push URL (or the Socket.IO API, for automation).
- Restart Kuma after a monitor delete/rename (clears in-memory orphan beats): `ssh <container-host> 'docker restart uptime-kuma'`

### Common failures
- `connect timeout` / `connect_error` against `http://<lan-ip>:3001` → Kuma container down or host unreachable; restart via `ssh <container-host> 'docker restart uptime-kuma'`.
- Login fails with `authInvalidToken` after a retry → the vault OTP field is stale or `op item get --otp` returned empty; re-verify the OTP secret in your vault item.
- `404 Not Found` against the public host → wrong hostname. Verify the URL with `curl -I https://<kuma-host>/` before concluding the service or a push token is broken.
- New monitor probes but doesn't appear in the UI → direct DB INSERT missing `user_id=1`; create it through the UI or Socket.IO API instead, or UPDATE the row to set `user_id=1` and restart Kuma.
- Deleted/renamed monitor still firing `[Down]` emails → in-memory beat scheduler is stale; run `ssh <container-host> 'docker restart uptime-kuma'` after any delete/rename batch (per § "Restart after delete or rename").
