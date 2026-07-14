---
name: UniFi
description: UniFi OS Console controller — version + firmware status reporting
cli: HTTPS with cookie auth
typed_client: integrations/unifi/unifi.ts
hosts:
  - <unifi-host>
  - <lan-ip>
aliases:
  - unifi
  - cloudkey
  - uck
---

# UniFi Integration

UniFi runs on a dedicated UniFi OS appliance (e.g. CloudKey / Dream Machine) at `<lan-ip>`, optionally fronted by a reverse proxy or tunnel. It hosts the UniFi Network Application (controller) and manages your access points.

A typical use is surfacing available firmware updates per AP plus the controller and console versions.

## TypeScript Client

Canonical typed reference: [`unifi.ts`](unifi.ts).

```ts
import { getUnifiSnapshot, type UnifiSnapshot, type UnifiDevice } from "../../integrations/unifi/unifi.ts";

const snap = await getUnifiSnapshot();
console.log(snap.sysinfo.network_application);
for (const d of snap.devices) {
  if (d.upgradable) console.log(`${d.name}: ${d.version} → ${d.upgrade_to_firmware}`);
}
```

### Export surface

| Function / Type | Purpose |
|---|---|
| `getUnifiSnapshot()` | One-shot login + sysinfo + device-list query; returns parsed `UnifiSnapshot` |
| `UnifiSnapshot` | `{ sysinfo: UnifiSysInfo, devices: UnifiDevice[] }` |
| `UnifiSysInfo` | `{ network_application, console_display_version }` |
| `UnifiDevice` | `{ name, model, type, version, upgrade_to_firmware, upgradable, state }` |

## Auth

Login via `POST /api/auth/login` with username + password from your secrets vault (item `UniFi - <your-vault>`). Session cookie + `X-CSRF-Token` header are captured and reused for the subsequent sysinfo + device-list calls.

## Notes

- **Firmware updates are user-driven.** The check surfaces which APs have firmware available; applying it happens via the controller UI (Devices → select AP → Update). There is no automated firmware-push path.
- If a reverse proxy/tunnel terminates TLS with a real certificate, `fetch()` doesn't need a custom agent.
- Direct IP access at `https://<lan-ip>` works but requires `rejectUnauthorized: false` (self-signed cert).

## Common invocations

### Smoke / auth check
```bash
node --input-type=module -e "import { getUnifiSnapshot } from './integrations/unifi/unifi.ts'; const s = await getUnifiSnapshot(); console.log('network_application=' + s.sysinfo.network_application + ' console=' + s.sysinfo.console_display_version + ' devices=' + s.devices.length);"
```

### Refresh / re-auth
Credentials live in your secrets vault (item `UniFi - <your-vault>`). If login returns HTTP 401/403, the password may have rotated — update the vault item via `op item edit 'UniFi - <your-vault>' --vault '<your-vault>' 'password[concealed]=NEW_PW'`. The session cookie auto-refreshes on every call (no token caching).

### Common queries / actions
- Full snapshot (versions + per-device firmware): `node ./integrations/unifi/unifi.ts`
- Check just firmware-upgradable APs: `node --input-type=module -e "import { getUnifiSnapshot } from './integrations/unifi/unifi.ts'; const s = await getUnifiSnapshot(); console.log(JSON.stringify(s.devices.filter(d => d.upgradable), null, 2));"`
- Reachability sniff (HTTP 200 expected): `curl -sk --max-time 8 https://<unifi-host>/ -o /dev/null -w 'http=%{http_code}\n'`

### Common failures
- `HTTP 401` on login → password rotated in the controller UI but the vault not updated; rotate the vault item as above.
- `HTTP 502 / 504` → a reverse proxy/tunnel in front of the controller is down; check your proxy/tunnel.
- `fetch failed: connect ECONNREFUSED` on direct IP → controller rebooted; wait 60–120s for it to come back.
- `body.data === undefined` → API surface changed (e.g., UniFi OS major upgrade); inspect the raw response with `curl -sk --cookie-jar /tmp/uck.jar -H "Content-Type: application/json" -d '{"username":"...","password":"..."}' https://<unifi-host>/api/auth/login` then `curl -sk -b /tmp/uck.jar https://<unifi-host>/proxy/network/api/s/default/stat/sysinfo`.
