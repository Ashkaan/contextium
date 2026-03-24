# n8n

Workflow automation platform for multi-step workflows, webhooks, and scheduled jobs.

## Requirements

- n8n instance (self-hosted or cloud)
- API key or user credentials

## Setup

1. Deploy n8n (Docker recommended) or sign up for n8n Cloud
2. Go to Settings > API > Create API Key
3. Store the API key and instance URL in your vault
4. Test: `curl -H "X-N8N-API-KEY: $KEY" https://your-n8n/api/v1/workflows`

## Key Endpoints

| Resource    | Endpoint              | Use                       |
| ----------- | --------------------- | ------------------------- |
| Workflows   | `/api/v1/workflows`   | List and manage workflows |
| Executions  | `/api/v1/executions`  | View run history          |
| Credentials | `/api/v1/credentials` | Manage stored credentials |

## When to Use n8n vs. Windmill

- **n8n**: Visual workflow builder, 400+ pre-built integrations, good for non-code workflows
- **Windmill**: Code-first, better for complex logic, script-based automation

## Use Cases

- Complex multi-step workflows with branching logic
- Webhook handlers for external service events
- Scheduled data processing and reporting
- Connecting services with pre-built integration nodes
