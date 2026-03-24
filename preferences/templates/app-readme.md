# App README Template

Every app must have a README with this structure:

```markdown
---
name: App Name
description: >-
  One-paragraph description of what the app does.
category: personal | daily | system | home
schedule: Daily 6:15 AM PT | On demand | Staleness check (configurable)
runtime: Your automation platform
trigger: Timer | Webhook | Event | Manual
outputs:
  - Email
  - Dashboard update
integrations:
  - Google Calendar
  - Gmail or SMTP
---

# App Name

Brief description.

## Pattern: Pattern Name

What architectural pattern this app follows (e.g., Briefing, Data Sync, Timer + Email).

## Architecture

How data flows through the app (optional diagram or description).

## Data

Where this app's data lives (typically in `/knowledge/`).

## Protocol

How to use this app — step-by-step instructions grouped by use case.

## Implementation

Steps to set up and configure the app with your automation platform.
```

## Notes

- The frontmatter block is required: `name`, `description`, `category`, `schedule`, `runtime`, `trigger`, `outputs`,
  `integrations`.
- The `## Pattern:` section names the architectural pattern (Briefing, Data Sync, Timer + Email, etc.).
- Use `## Architecture` for data-flow descriptions or diagrams.
- Use `## Protocol` for operational instructions grouped by sub-task.
- Use `## Implementation` for setup/configuration steps.
- Sections like `## Data`, `## Configuration`, `## Features` are optional and vary by app.
