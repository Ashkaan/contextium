---
name: Home Assistant
description: Home automation via SSH and REST API
cli: REST API / SSH
typed_client: integrations/home-assistant/home_assistant.ts
hosts:
  - home-assistant
aliases:
  - nodered
  - node-red
  - node red
  - thermostat
---
# Home Assistant Integration

A Home Assistant instance, managed via SSH and REST API. Replace the hostname/IP below with your own.

## TypeScript Client

Canonical typed reference: [`home_assistant.ts`](home_assistant.ts).

```ts
import {
  createHaSession,
  haGetStates,
  haGetState,
  haCallService,
  haExec,
  type HaState,
} from "../../integrations/home-assistant/home_assistant.ts";

const session = await createHaSession();
const states = await haGetStates(session);
await haCallService(session, "light", "turn_on", { entity_id: "light.living_room" });
const { stdout } = await haExec("ha core info");
```

| Function / Type | Purpose |
|---|---|
| `createHaSession(opts?)` | Long-Lived Access Token from your secrets vault; returns session |
| `haGet<T>(session, path)` / `haPost<T>(session, path, body?)` | Generic typed REST wrappers with retry on 429/5xx |
| `haGetStates(session)` | All current entity states |
| `haGetState(session, entityId)` | Single entity by ID |
| `haCallService(session, domain, service, data?)` | Service invocation; returns changed states |
| `haExec(command, timeoutMs?)` | SSH `ha`-CLI wrapper (root@home-assistant); for backups, addons, system ops |
| `HaSession`, `HaState`, `HaCallResult` | Shared types |

REST auth: a Long-Lived Access Token from your secrets vault (item `Home Assistant - <your-vault>`, field `API Token`) — pass `tokenOverride` to supply the token explicitly (e.g. for tests). SSH auth: key-based via `~/.ssh/config`, user `root`.

## System

| Detail | Value |
|--------|-------|
| Hostname | `home-assistant` (set in `~/.ssh/config` + `/etc/hosts` or DNS) |
| IP | `<host-ip>` |
| OS | Home Assistant OS |

## Access

### SSH

```bash
ssh root@home-assistant "command"
```

Key-based auth via the Terminal & SSH add-on (`core_ssh`). User must be `root`.

### REST API

Requires a Long-Lived Access Token (create at `http://home-assistant:8123/profile` → Long-Lived Access Tokens).

```bash
# Retrieve token from your secrets vault
HA_TOKEN=$(op read "op://<your-vault>/Home Assistant - <your-vault>/API Token")

# Check API
curl -s -H "Authorization: Bearer $HA_TOKEN" http://home-assistant:8123/api/ | jq

# Get all states
curl -s -H "Authorization: Bearer $HA_TOKEN" http://home-assistant:8123/api/states | jq

# Call a service
curl -s -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"entity_id": "light.living_room"}' \
  http://home-assistant:8123/api/services/light/turn_on
```

### Web UI

`http://home-assistant:8123`

## Common Operations

```bash
# System info
ssh root@home-assistant "ha core info"
ssh root@home-assistant "ha host info"
ssh root@home-assistant "ha os info"

# Logs
ssh root@home-assistant "ha core logs --lines 50"

# Restart core
ssh root@home-assistant "ha core restart"

# Update core
ssh root@home-assistant "ha core update"

# Add-ons
ssh root@home-assistant "ha addons info"

# Backups
ssh root@home-assistant "ha backups new --name manual-backup"
ssh root@home-assistant "ha backups list"
```

## Troubleshooting

```bash
# Test SSH
ssh -v root@home-assistant "echo connected"

# If SSH times out, verify:
# 1. Terminal & SSH add-on is running
# 2. Ports 22 and 8123 are open in the firewall
# 3. The host IP is reachable from your network

# Check HA logs for errors
ssh root@home-assistant "ha core logs --lines 100"

# Restart if unresponsive
ssh root@home-assistant "ha core restart"
ssh root@home-assistant "ha supervisor restart"
```

## Common invocations

The snippets below fetch the LLAT from your vault via shell `op read` and pass it as `tokenOverride` to `createHaSession`.

### Smoke / auth check
```bash
HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGet } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const r = await haGet(s, "/api/"); console.log(JSON.stringify({ baseUrl: s.baseUrl, message: r?.message ?? null }, null, 2));'
```

### Refresh / re-auth
```bash
# Home Assistant uses a Long-Lived Access Token (no refresh flow). To rotate, mint a new LLAT at http://home-assistant:8123/profile → "Long-Lived Access Tokens" and update your vault.
op item edit 'Home Assistant - <your-vault>' --vault '<your-vault>' 'API Token=NEW_LLAT_VALUE' && HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGet } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const r = await haGet(s, "/api/"); console.log("HA auth ok:", r?.message ?? "(no message)");'
```

### Common queries / actions
- All entity states (count + sample): `HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGetStates } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const states = await haGetStates(s); console.log(JSON.stringify({ count: states.length, sample: states.slice(0, 5).map((e) => ({ entity_id: e.entity_id, state: e.state })) }, null, 2));'`
- Single entity by id (replace `$ENTITY_ID`): `ENTITY_ID="sensor.example" HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGetState } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const e = await haGetState(s, process.env.ENTITY_ID); console.log(JSON.stringify(e, null, 2));'`
- Filter states by domain (e.g., `sensor.*`): `DOMAIN="sensor" HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGetStates } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const all = await haGetStates(s); const filtered = all.filter((e) => e.entity_id.startsWith(process.env.DOMAIN + ".")); console.log(JSON.stringify({ domain: process.env.DOMAIN, count: filtered.length, sample: filtered.slice(0, 10).map((e) => ({ entity_id: e.entity_id, state: e.state })) }, null, 2));'`
- Call a service (e.g., toggle a light): `HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haCallService } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const changed = await haCallService(s, "light", "toggle", { entity_id: "light.living_room" }); console.log(JSON.stringify({ changed: changed.length, states: changed.map((e) => ({ entity_id: e.entity_id, state: e.state })) }, null, 2));'`
- History for an entity (last 24h): `ENTITY_ID="sensor.example" HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token')" node --input-type=module -e 'import { createHaSession, haGet } from "./integrations/home-assistant/home_assistant.ts"; const s = await createHaSession({ tokenOverride: process.env.HA_TOKEN }); const start = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); const rows = await haGet(s, "/api/history/period/" + start + "?filter_entity_id=" + process.env.ENTITY_ID); console.log(JSON.stringify({ start, entity: process.env.ENTITY_ID, points: Array.isArray(rows) ? (rows[0]?.length ?? 0) : 0 }, null, 2));'`
- System info via SSH (no token needed): `ssh root@home-assistant "ha core info"`
- New manual backup via SSH: `ssh root@home-assistant "ha backups new --name manual-$(date +%Y%m%d-%H%M)"`

### Common failures
- `op read for HA token failed: ...` → rerun `op signin` and confirm `op read 'op://<your-vault>/Home Assistant - <your-vault>/API Token'` returns a value.
- `Home Assistant GET /api/... failed: 401 ...` → LLAT is revoked or wrong; mint a fresh token at `http://home-assistant:8123/profile`, update your vault, rerun.
- `Home Assistant POST /api/services/... failed: 400 ...` → service domain/name or required `entity_id` is wrong; verify with `haGetState` first and confirm the service exists in the HA dev tools UI.
- `fetch failed: ENOTFOUND home-assistant` / connection refused → host unreachable from this network; verify `ping home-assistant` and that the SSH add-on is running.
- `... failed: 429 ...` after `MAX_RETRIES=3` → REST API throttling; back off and reduce parallel callers, or fall back to `haExec` (SSH `ha` CLI) for heavy state ops.
