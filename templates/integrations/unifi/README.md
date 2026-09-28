---
name: UniFi
description: UniFi OS Console controller — version + firmware status reporting
cli: HTTPS with cookie auth
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

## If you write a client

Nothing here ships one; the `curl` calls below cover it. If a scheduled job reports firmware status, this is its shape: one call that logs in, reads sysinfo and the device list, and returns a snapshot.

| Part | Fields |
|---|---|
| sysinfo (`/proxy/network/api/s/default/stat/sysinfo`) | `network_application`, `console_display_version` |
| each device (`/proxy/network/api/s/default/stat/device`) | `name`, `model`, `type`, `version`, `upgrade_to_firmware`, `upgradable`, `state` |

Both responses wrap their rows in `data`.

## Auth

Login via `POST /api/auth/login` with username + password from your secrets vault (item `UniFi - <consumer>`). Session cookie + `X-CSRF-Token` header are captured and reused for the subsequent sysinfo + device-list calls.

## Notes

- **Firmware updates are user-driven.** The check surfaces which APs have firmware available; applying it happens via the controller UI (Devices → select AP → Update). There is no automated firmware-push path.
- If a reverse proxy/tunnel terminates TLS with a real certificate, clients need no TLS override.
- Direct IP access at `https://<lan-ip>` works but the console's certificate is self-signed, so skip verification there (`curl -k`, or `rejectUnauthorized: false` in Node).

## Common invocations

### Smoke / auth check
```bash
UNIFI_USER="$(op read 'op://<your-vault>/UniFi - <consumer>/username')"
UNIFI_PASS="$(op read 'op://<your-vault>/UniFi - <consumer>/password')"
curl -fsSk -c /tmp/uck.jar -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$UNIFI_USER" --arg p "$UNIFI_PASS" '{username: $u, password: $p}')" \
  https://<unifi-host>/api/auth/login -o /dev/null -w 'login http=%{http_code}\n'
curl -fsSk -b /tmp/uck.jar https://<unifi-host>/proxy/network/api/s/default/stat/sysinfo \
  | jq '.data[0] | {network_application, console_display_version}'
```

### Refresh / re-auth
Credentials live in your secrets vault (item `UniFi - <consumer>`). If login returns HTTP 401/403, the password may have rotated — update the vault item via `op item edit 'UniFi - <consumer>' --vault '<your-vault>' 'password[concealed]=NEW_PW'`. Each run logs in fresh, so there is no token to cache or refresh.

### Common queries / actions
- Per-device firmware (after the smoke login): `curl -fsSk -b /tmp/uck.jar https://<unifi-host>/proxy/network/api/s/default/stat/device | jq '[.data[] | {name, model, version, upgradable, upgrade_to_firmware}]'`
- Just the upgradable APs: `curl -fsSk -b /tmp/uck.jar https://<unifi-host>/proxy/network/api/s/default/stat/device | jq '[.data[] | select(.upgradable) | {name, version, upgrade_to_firmware}]'`
- Reachability sniff (HTTP 200 expected): `curl -fsSk --max-time 8 https://<unifi-host>/ -o /dev/null -w 'http=%{http_code}\n'`

### Common failures
- `HTTP 401` on login → password rotated in the controller UI but the vault not updated; rotate the vault item as above.
- `HTTP 502 / 504` → a reverse proxy/tunnel in front of the controller is down; check your proxy/tunnel.
- Connection refused on direct IP → controller rebooted; wait 60–120s for it to come back.
- Response has no `data` array → API surface changed (e.g., UniFi OS major upgrade); rerun the smoke check without the `jq` filter and inspect the raw response.
