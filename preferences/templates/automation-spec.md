---
name: {Name}
description: >-
  {1-3 sentence summary for the dashboard card.}
category: {personal | home | daily | content | system}
schedule: {Human-readable, e.g. "Daily 6:15 AM PT", "Every 60s", "On demand"}
runtime: {Windmill | n8n | systemd | cron | Manual | TypeScript}
trigger: {Timer | Webhook | Manual | Event | Timer + Webhook}
outputs:
  - {What it produces, e.g. "Email", "KV data", "Auto-remediation"}
integrations:
  - {External services, e.g. "Gmail", "Docker", "Autotask"}
---

# {Name}
{One-line description.}

**Automation Path:** `{platform-specific path}`

## What Success Looks Like
- {Concrete assertion 1 — e.g., "email sent with ≥3 news topics"}
- {Concrete assertion 2}

## Outcome Validation
Each assertion above should be enforced in code before returning. Validate all expected outputs before marking the job successful — a "successful" run with missing data is worse than a failure.

```typescript
// Example: validate all outputs before returning
if (!result.email || result.topics.length < 3) {
  throw new Error(`Validation failed: expected ≥3 topics, got ${result.topics.length}`);
}
```

## Architecture
{Data flow: sources → processing → outputs}

## Error Handling
{What can fail, what's retried, what escalates}

## Credentials
{Vault items or environment variables used}

## Testing
{How to trigger manually + verify}
