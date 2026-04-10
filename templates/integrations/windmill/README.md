# Windmill

Self-hosted workflow automation platform for scheduled jobs, webhooks, and multi-step workflows. This is the core
automation engine -- most recurring tasks (data syncs, briefings, reports) run here.

## Requirements

- Windmill instance (self-hosted via Docker or Windmill Cloud)
- API token with workspace access
- Node.js 18+ (for CLI)

## Setup

1. Deploy Windmill or use the cloud instance:
   ```bash
   # Self-hosted (Docker Compose)
   curl https://raw.githubusercontent.com/windmill-labs/windmill/main/docker-compose.yml -o docker-compose.yml
   docker compose up -d
   ```
2. Create a workspace in the Windmill UI
3. Generate an API token: Settings > Tokens > Create Token
4. Store the instance URL and token in your credential vault:
   ```bash
   op item create --category=login --title="Windmill - API Token" \
     --vault="Automation" token="your-token" url="https://your-windmill-instance"
   ```
5. Install the CLI:
   ```bash
   npm install -g windmill-cli
   wmill workspace add <name> <url> --token <token>
   ```

## Key Operations

```bash
wmill sync pull                    # Pull workspace scripts/flows locally
wmill sync push                    # Push local changes to Windmill
wmill flow run <path>              # Trigger a flow manually
wmill script run <path>            # Run a single script
wmill resource list                # List configured resources (API keys, etc.)
```

## Script Types

| Type     | Language                     | Use                                 |
| -------- | ---------------------------- | ----------------------------------- |
| Script   | TypeScript, Python, Go, Bash | Single-step operations              |
| Flow     | YAML + scripts               | Multi-step workflows with branching |
| Schedule | Cron expression              | Time-triggered execution            |
| Webhook  | HTTP endpoint                | Event-triggered execution           |

## Resources and Variables

Windmill stores credentials as **Resources** (typed, e.g., "postgresql", "slack") and configuration as **Variables**.
Reference them in scripts:

```typescript
// TypeScript script example
export async function main(apiKey: wmill.Resource<"api_key">) {
  const response = await fetch("https://api.example.com/data", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  return await response.json();
}
```

## Deployment Workflow

1. Edit scripts locally in your repo (under `apps/{name}/`)
2. Test locally if possible, or use the Windmill web editor for quick iteration
3. Push to Windmill: `wmill sync push`
4. Verify in the Windmill UI: check run history and logs
5. Set a schedule if the script should run on a cron

## API Access

```bash
# Trigger a script via API
curl -X POST https://your-windmill/api/w/workspace/jobs/run/p/f/folder/script \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"arg1": "value1"}'

# Check job status
curl https://your-windmill/api/w/workspace/jobs_u/completed/list \
  -H "Authorization: Bearer $TOKEN"
```

## Use Cases

- Scheduled data syncs (daily briefings, finance pulls, metric updates)
- Webhook handlers for external service events (ticket created, payment received)
- Multi-step workflows (fetch data, transform, deliver via email or dashboard)
- Background jobs that run without user interaction
- Chaining multiple integrations together (e.g., pull Todoist tasks + calendar events, format, send via Gmail)
