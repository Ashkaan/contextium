---
project: setup-daily-briefing
status: pending
created: auto
tags: [setup]
---

# Setup: Configure Your Morning Briefing

## Goal

Set up a daily email that summarizes your day before you start working.

## Steps

- [ ] **Calendar integration** — Connect Google Calendar (or your calendar)
- [ ] **Task integration** — Connect Todoist (or your task manager)
- [ ] **Create the workflow** — Build an automation that:
  1. Fetches today's calendar events
  2. Fetches today's tasks
  3. Reads active projects from `projects/README.md`
  4. Computes focus time blocks (gaps between events)
  5. Formats an HTML email
  6. Sends via Gmail or SMTP
- [ ] **Schedule it** — Set for your preferred wake-up time
- [ ] **Document it** — Create `apps/todays-agenda/` with README

## Email Format

Use the template from `preferences/style_guides/email_templates.md`:

- Header with date
- Calendar events section (color-coded by calendar)
- Tasks section (sorted by priority)
- Focus blocks section
- Active projects list
