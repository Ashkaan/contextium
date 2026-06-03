---
name: Komodo
description: Docker container management and monitoring
cli: Web UI / REST API
---
# Komodo Integration

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
# Credentials in your secrets vault → Komodo - <your-vault>
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
curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" \
  -H "Content-Type: application/json" "$KOMODO/read/ListStacks" -d '{}'

# Get stack details (by ID)
curl -s ... "$KOMODO/read/GetStack" -d '{"stack": "<stack_id>"}'

# List services and their container state
curl -s ... "$KOMODO/read/ListStackServices" -d '{"stack": "<stack_id>"}'

# Deploy a stack (pulls latest from linked git repo)
curl -s ... "$KOMODO/execute/DeployStack" -d '{"stack": "<stack_id>"}'

# Check host resource usage
curl -s ... "$KOMODO/read/GetSystemStats" -d '{"server": "<server_id>"}'

# View deploy history
curl -s ... "$KOMODO/read/ListUpdates" -d '{"query": {"target": {"type": "Stack", "id": "<stack_id>"}}}'
```

Stack IDs and server IDs are workspace-specific; list them with `read/ListStacks` and `read/ListServers`.

## Deploy Flow

Stacks with `files_on_host: false` (most stacks) deploy from a **linked git repo** — not the local filesystem.

### Automated (recommended)

```bash
# Deploy a compose change (syncs to docker repo, pushes, triggers Komodo)
integrations/komodo/deploy-stack.sh <service-name>

# Dry-run: show diff without deploying
integrations/komodo/deploy-stack.sh <service-name> --check
```

The script handles the full flow: copy to `~/docker/{service}/`, commit, push, call `execute/DeployStack`, and verify container state.

### Manual steps (for reference)

1. Edit compose in your repo (`integrations/{service}/compose.yaml`)
2. Copy to your docker repo (`~/docker/{service}/compose.yaml`)
3. Commit and push the docker repo
4. Trigger `execute/DeployStack` via the Komodo API
5. Komodo pulls from git and runs `docker compose up -d`

**Do not** `scp` the compose file to the host and expect Komodo to pick it up — it reads from git, not the filesystem.

## Common invocations

### Smoke / auth check
```bash
KOMODO_KEY=$(op read 'op://<your-vault>/<komodo-item-id>/api_key') && KOMODO_SECRET=$(op read 'op://<your-vault>/<komodo-item-id>/api_secret') && curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/ListStacks" -d '{}' | jq 'length'
```

### Refresh / re-auth
```bash
# Komodo uses a static API key + secret; rotate via UI → Settings → API Keys → New, then update the vault item fields api_key + api_secret.
op item edit '<komodo-item-id>' --vault '<your-vault>' api_key='NEW_KEY' api_secret='NEW_SECRET'
```

### Common queries / actions
- List all stacks: `curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/ListStacks" -d '{}'`
- Get stack detail: `curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/GetStack" -d '{"stack": "<stack_id>"}'`
- Restart a stack: `curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/execute/RestartStack" -d '{"stack": "<stack_id>"}'`
- Deploy a stack (pulls latest from git): `bash ./integrations/komodo/deploy-stack.sh <service-name>`
- Dry-run a deploy (diff only): `bash ./integrations/komodo/deploy-stack.sh <service-name> --check`
- Host stats: `curl -s -H "x-api-key: $KOMODO_KEY" -H "x-api-secret: $KOMODO_SECRET" -H "Content-Type: application/json" "https://<komodo-host>/read/GetSystemStats" -d '{"server": "<server_id>"}'`

### Common failures
- `403 Forbidden` from API → both `x-api-key` AND `x-api-secret` headers are required; missing one returns 403.
- `Stack not found` → check stack ID via `read/ListStacks`; IDs are stable but stack names change.
- `DeployStack` succeeds but containers don't update → compose file change wasn't pushed to git first; Komodo reads from the linked git repo, not the filesystem.
