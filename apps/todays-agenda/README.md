---
name: Today's Agenda
description: >-
  Morning briefing with calendar events, task list, active projects,
  and computed focus time blocks.
category: daily
schedule: Daily (configurable time)
runtime: Your automation platform
trigger: Timer
outputs:
  - Email
integrations:
  - Google Calendar (or any calendar API)
  - Task manager (Todoist or similar)
  - Gmail or SMTP
---

# Today's Agenda

Daily morning briefing combining calendar, tasks, and active projects.

## Pattern: Briefing

A scheduled job aggregates data from multiple sources into a single formatted email.

## Architecture

```
Timer → Fetch calendar events + tasks + active projects → Compute focus blocks → Format HTML email → Send
```

## Data Sources

| Source                                    | What                              | Why                   |
| ----------------------------------------- | --------------------------------- | --------------------- |
| Calendar API                              | Today's events from all calendars | Know your schedule    |
| Task manager                              | Today's tasks and overdue items   | Know your priorities  |
| `projects/README.md`                      | Active projects list              | Know your commitments |
| `knowledge/growth/goals/current-focus.md` | Current strategic focus           | Stay aligned          |

## Features

- **Focus blocks:** Computes free time between events for deep work
- **Color coding:** Different calendar types get different colors
- **Priority sorting:** Tasks sorted by priority/due date

## Implementation

1. Set up calendar API integration (see `integrations/`)
2. Set up task manager integration
3. Create aggregation workflow in your automation platform
4. Configure email delivery for your preferred morning time
