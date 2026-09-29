---
name: Komodo
description: Docker container management and monitoring
hosts:
  - <komodo-host>
aliases:
  - komodo
  - docker management
  - container management
typed_client:
  - none
access:
  - api
  - browser
uses: none
base_url: https://<komodo-host>
auth: x-api-key + x-api-secret headers (both required)
onepassword_item: none
rate_limit: none documented
cli: Web UI / REST API
---
# Komodo Integration

**Access order:** api, browser — the REST API reads, executes and writes everything below (list, deploy, restart), and the web UI adds only API-key rotation.

**Instance:** `https://<komodo-host>`
**Runs on:** your services host (compose at `~/docker/komodo/<host>/compose.yaml`)
**Purpose:** Docker container management and monitoring

## Rules

- **Use Komodo for all Docker operations.** Avoid SSHing into hosts to run raw `docker` CLI commands. Komodo manages containers, restarts, logs, and deployments via its UI and API.
- Compose files live in `~/docker/{service}/` and deploy to your Docker hosts via Komodo.
- Komodo periphery agents connect to Docker via a socket proxy — never expose the Docker socket directly.

## Architecture

- **komodo-core** — Web UI + API at `https://<komodo-host>`
- **komodo-periphery** — Agent on each Docker host, manages containers via socket proxy
- **komodo-mongo** — MongoDB backend for state/config
- **komodo-socket-proxy** — Read/write Docker socket proxy with scoped permissions

## Hosts

| Host | Periphery |
|------|-----------|
| `<services-host>` | `~/docker/komodo/<host>/` |
| `<second-host>` | `~/docker/komodo/<host>/` |

## API Access

```bash
# Credentials in your secrets vault → item "Komodo - <consumer>" (<komodo-item-id>)
KOMODO_KEY=$(op item get "<komodo-item-id>" --vault "<your-vault>" --fields label=api_key --reveal)
KOMODO_SECRET=$(op item get "<komodo-item-id>" --vault "<your-vault>" --fields label=api_secret --reveal)
KOMODO="https://<komodo-host>"

# Auth: both x-api-key AND x-api-secret headers required
AUTH_HEADERS="-H 'x-api-key: $KOMODO_KEY' -H 'x-api-secret: $KOMODO_SECRET'"
```

**Endpoint pattern:** `POST $KOMODO/{action_type}/{operation}` with JSON body.

| Action type | Purpose | Examples |
|-------------|---------|---------|
| `read/` | Query state | `ListStacks`, `GetStack`, `ListStackServices`, `GetSystemStats` |
| `execute/` | Mutate | `DeployStack`, `DestroyStack`, `StartContainer`, `StopContainer` |

### Common Operations

```bash
# List all stacks
curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" \
  -H "Content-Type: application/json" "$KOMODO/read/ListStacks" -d '{}'

# Get stack details (by ID)
curl -fsS ... "$KOMODO/read/GetStack" -d '{"stack": "<stack_id>"}'

# List services and their container state
curl -fsS ... "$KOMODO/read/ListStackServices" -d '{"stack": "<stack_id>"}'

# Deploy a stack (pulls latest from linked git repo)
curl -fsS ... "$KOMODO/execute/DeployStack" -d '{"stack": "<stack_id>"}'

# Check host resource usage
curl -fsS ... "$KOMODO/read/GetSystemStats" -d '{"server": "<server_id>"}'

# View deploy history
curl -fsS ... "$KOMODO/read/ListUpdates" -d '{"query": {"target": {"type": "Stack", "id": "<stack_id>"}}}'
```

Stack IDs and server IDs are workspace-specific; list them with `read/ListStacks` and `read/ListServers`.

## Deploy Flow

Stacks with `files_on_host: false` (most stacks) deploy from a **linked git repo** — not the local filesystem.

### Steps

1. Edit compose in your repo (`integrations/{service}/compose.yaml`)
2. Copy to your docker repo (`~/docker/{service}/compose.yaml`)
3. Commit and push the docker repo
4. Trigger `execute/DeployStack` via the Komodo API
5. Komodo pulls from git and runs `docker compose up -d`

If you script this, have the script do all five steps and then read `read/ListStackServices` to confirm the containers came up, with a `--check` mode that shows the diff and stops before step 3.

**Do not** `scp` the compose file to the host and expect Komodo to pick it up — it reads from git, not the filesystem.

## Common invocations

### Smoke / auth check
```bash
KOMODO_KEY=$(op read 'op://<your-vault>/<komodo-item-id>/api_key') && KOMODO_SECRET=$(op read 'op://<your-vault>/<komodo-item-id>/api_secret') && curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/ListStacks" -d '{}' | jq 'length'
```

### Refresh / re-auth
```bash
# Komodo uses a static API key + secret; rotate via UI → Settings → API Keys → New, then update the vault item fields api_key + api_secret.
op item edit '<komodo-item-id>' --vault '<your-vault>' api_key='NEW_KEY' api_secret='NEW_SECRET'
```

### Common queries / actions
- List all stacks: `curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/ListStacks" -d '{}'`
- Get stack detail: `curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/GetStack" -d '{"stack": "<stack_id>"}'`
- Restart a stack: `curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/execute/RestartStack" -d '{"stack": "<stack_id>"}'`
- Deploy a stack (pulls latest from its linked git repo): `curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/execute/DeployStack" -d '{"stack": "<stack_id>"}'`
- Host stats: `curl -fsS -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/GetSystemStats" -d '{"server": "<server_id>"}'`

### Common failures
- `403 Forbidden` from API → both `x-api-key` AND `x-api-secret` headers are required; missing one returns 403.
- `Stack not found` → check stack ID via `read/ListStacks`; IDs are stable but stack names change.
- `DeployStack` succeeds but containers don't update → compose file change wasn't pushed to git first; Komodo reads from the linked git repo, not the filesystem.
