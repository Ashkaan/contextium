# AI Assistant Guide

## Session Start

Classify: **New Project** (multi-session -> project + tracker + journal) | **Existing** (prior work -> update + journal) | **One-Off** (quick -> journal only). Default: journal-only.

## Context Router

Do NOT preload files — lazy load only when needed.

| Trigger | Load |
|---------|------|
| Every session | `preferences/user/preferences.md`, `integrations/README.md` |
| Non-trivial task | `knowledge/growth/goals/current-focus.md` |
| Project work | `projects/README.md` |
| Writing emails | `preferences/style_guides/email_templates.md` |
| Creating project | `preferences/templates/project_template.md` |
| Drafting journal entry | `preferences/templates/journal_template.md` |
| Creating/editing app README | `preferences/templates/app-readme.md` |
| Any integration/API call | `integrations/{name}/README.md` |
| Credential handling | `integrations/1password/README.md` |
| Personal context | `knowledge/people/{your-name}/bio.md` |
| Person mentioned | `knowledge/people/{name}/` |
| Prior work referenced | `journal/` (latest) |

## Rules

-> `preferences/rules/README.md` (index with enforcement status)

## Repo Structure

| Directory | Purpose |
|-----------|---------|
| `/apps/{name}/` | Self-contained apps: protocol (README) + automation scripts |
| `/apps/shared/` | Shared utilities (notifications, email, etc.) |
| `/knowledge/{domain}/` | Data organized by domain |
| `/knowledge/people/{name}/` | People & entities |
| `/projects/{domain}/` | Self-contained projects: `YYYY-MM-DD_brief-description/` |
| `/journal/` | Daily session logs: `YYYY-MM-DD.md` |
| `/preferences/` | User preferences, rules, templates, style guides |
| `/integrations/` | External service connectors (auth, APIs, docs) |
