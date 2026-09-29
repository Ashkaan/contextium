---
name: Home Assistant
description: Home automation via SSH and REST API
hosts:
  - home-assistant
aliases:
  - nodered
  - node-red
  - node red
  - thermostat
typed_client:
  - none
access:
  - api
  - ssh
uses: none
base_url: http://home-assistant:8123
auth: bearer token (long-lived access token)
onepassword_item: none
rate_limit: none documented
cli: REST API / SSH
---
# Home Assistant Integration

**Access order:** api, ssh — the REST API serves entity states, service calls and history, while SSH's `ha` CLI covers only supervisor housekeeping (backups, add-ons, core restarts and updates).

A Home Assistant instance, managed via SSH and REST API. Replace the hostname/IP below with your own.

## If you write a client

Nothing here ships one; `curl` and `ssh` cover every call below. If your code talks to HA, this is its shape:

- A session built from a Long-Lived Access Token read from your vault, with an explicit-token override for tests.
- Generic typed GET / POST wrappers that retry 429 and 5xx a few times with backoff.
- `getStates()` (all entities), `getState(entityId)`, and `callService(domain, service, data)`, which returns the states it changed.
- An SSH wrapper that runs the `ha` CLI (`ssh root@home-assistant "ha ..."`) for backups, add-ons and system ops, which the REST API does not cover.

REST auth: a Long-Lived Access Token in your vault (item `Home Assistant - <consumer>`, field `API Token`). SSH auth: key-based via `~/.ssh/config`, user `root`.

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
HA_TOKEN=$(op read "op://<your-vault>/Home Assistant - <consumer>/API Token")

# Check API
curl -fsS -H "Authorization: Bearer $HA_TOKEN" http://home-assistant:8123/api/ | jq

# Get all states
curl -fsS -H "Authorization: Bearer $HA_TOKEN" http://home-assistant:8123/api/states | jq

# Call a service
curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" \
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

Every REST snippet assumes the token is loaded:

```bash
HA_TOKEN="$(op read 'op://<your-vault>/Home Assistant - <consumer>/API Token')"
HA=http://home-assistant:8123
```

### Smoke / auth check
```bash
curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA/api/" | jq -r '.message'   # → "API running."
```

### Refresh / re-auth
Home Assistant uses a Long-Lived Access Token (no refresh flow). To rotate, mint a new LLAT at `http://home-assistant:8123/profile` → "Long-Lived Access Tokens", then:
```bash
op item edit 'Home Assistant - <consumer>' --vault '<your-vault>' 'API Token=NEW_LLAT_VALUE'
```
and rerun the smoke check.

### Common queries / actions
- All entity states (count + sample): `curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA/api/states" | jq '{count: length, sample: [.[:5][] | {entity_id, state}]}'`
- Single entity by id: `curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA/api/states/sensor.example" | jq`
- Filter states by domain (e.g., `sensor.*`): `curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA/api/states" | jq '[.[] | select(.entity_id | startswith("sensor.")) | {entity_id, state}]'`
- Call a service (e.g., toggle a light; returns the changed states): `curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" -H 'Content-Type: application/json' -d '{"entity_id": "light.living_room"}' "$HA/api/services/light/toggle" | jq '[.[] | {entity_id, state}]'`
- History for an entity since a timestamp: `curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA/api/history/period/<ISO-8601-start>?filter_entity_id=sensor.example" | jq '.[0] | length'`
- System info via SSH (no token needed): `ssh root@home-assistant "ha core info"`
- New manual backup via SSH: `ssh root@home-assistant "ha backups new --name manual-$(date +%Y%m%d-%H%M)"`

### Common failures
- `op read` fails → run `op signin` (or check `OP_SERVICE_ACCOUNT_TOKEN`) and confirm `op read 'op://<your-vault>/Home Assistant - <consumer>/API Token'` returns a value.
- HTTP 401 on `/api/...` → LLAT is revoked or wrong; mint a fresh token at `http://home-assistant:8123/profile`, update your vault, rerun.
- HTTP 400 on `/api/services/...` → service domain/name or required `entity_id` is wrong; check the entity with `/api/states/<entity_id>` and confirm the service exists in the HA developer tools.
- `Could not resolve host: home-assistant` / connection refused → host unreachable from this network; verify `ping home-assistant` and that the SSH add-on is running.
- HTTP 429 → REST API throttling; back off and reduce parallel callers, or use the `ha` CLI over SSH for heavy state operations.
