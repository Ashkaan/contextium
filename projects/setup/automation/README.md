---
project: setup-automation
status: pending
created: auto
tags: [setup]
---

# Setup: Build Your First Automation

## Goal

Create a scheduled automation that runs without your involvement.

## Steps

- [ ] **Choose a platform** — Windmill (self-hosted) or n8n (self-hosted or cloud)
- [ ] **Set up the platform** — Deploy and configure access
- [ ] **Pick a first automation** — Start with something simple:
  - Daily weather summary email
  - Task reminder digest
  - RSS feed aggregation
- [ ] **Build it** — Create the workflow:
  1. Trigger (cron schedule or webhook)
  2. Fetch data (API call, RSS, or file read)
  3. Transform (format, filter, summarize)
  4. Deliver (email, webhook, or file write)
- [ ] **Test and deploy** — Verify it runs successfully
- [ ] **Document it** — Create an app README in `apps/{name}/`

## Automation Patterns

| Pattern       | Example           | Flow                                 |
| ------------- | ----------------- | ------------------------------------ |
| Timer + Email | News Digest       | Cron → Fetch → AI Curate → Email     |
| Data Sync     | Health            | Webhook → Transform → Write to repo  |
| System/Event  | Error Remediation | Error → Retry → AI Diagnose → Notify |
| Briefing      | Today's Agenda    | Cron → Aggregate sources → Email     |
