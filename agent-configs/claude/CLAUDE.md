# AI Assistant Guide

## Session Start

Classify: **New Project** (multi-session -> project + tracker + journal) | **Existing** (prior work -> update + journal)
| **One-Off** (quick -> journal only). Default: journal-only.

## Context Router

Do NOT preload files — lazy load only when needed, **except** items marked "Every session" which MUST be loaded before doing any work. Re-evaluate triggers when task scope changes mid-session — if a new trigger matches, load it then.

| Trigger                                        | Load                                                                                                                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Every session                                  | `preferences/user/preferences.md`, `preferences/rules/behavior.md`, `preferences/rules/governance.md`, `integrations/README.md`  |
| Before delegating bulk/multi-file work         | `integrations/README.md` → pick the right tool before spawning subagents                                                          |
| Non-trivial task                               | `knowledge/growth/goals/current-focus.md`                                                                                         |
| Project work                                   | `projects/README.md`                                                                                                              |
| Writing emails                                 | `preferences/style_guides/email_templates.md`                                                                                     |
| Writing / reviewing TypeScript or shell        | `preferences/style_guides/code-conventions.md` (if exists)                                                                        |
| Screenshots / visual verification              | `integrations/browse/README.md`                                                                                                   |
| Monitoring alert / outage / failing schedule   | `preferences/rules/incident-response.md`                                                                                          |
| Creating project                               | `preferences/templates/project_template.md`                                                                                       |
| Changing project status                        | Run `npx tsx apps/project-index/generate.ts` after updating frontmatter                                                           |
| Drafting journal entry                         | `preferences/templates/journal_template.md`                                                                                       |
| Creating/editing app README                    | `preferences/templates/app-readme.md`                                                                                             |
| Creating/updating a people card                | `knowledge/people/README.md`                                                                                                      |
| Any integration/API call                       | `integrations/{name}/README.md`                                                                                                   |
| Credential handling                            | `integrations/1password/README.md`                                                                                                |
| Personal context                               | `knowledge/people/{your-name}/bio.md`                                                                                             |
| Person mentioned                               | `knowledge/people/{name}/`                                                                                                        |
| Prior work referenced                          | `journal/` (latest)                                                                                                               |

## Session End — MANDATORY

Before your final response in every session, no matter how short:

1. Create/update `/journal/YYYY-MM-DD.md` (load template if needed)
2. Commit specific files — never `git add -A`
3. Push

No exceptions. A 2-minute discussion still gets a journal heading. See `preferences/rules/governance.md` § Session End for full format rules.

## New Apps — MANDATORY

After creating a new directory in `apps/`:

1. Create `apps/{name}/README.md` with frontmatter (name, description, category, schedule, runtime, trigger, outputs)
2. Add an entry to `apps/README.md` (alphabetical order)

An app without a README has no protocol. An app without a registry entry is invisible to future sessions.

## Automation Scripts — MANDATORY

After editing any automation script that is deployed to an external platform (Windmill, n8n, etc.):

1. Deploy the updated script to the platform
2. Verify deployment succeeded

Editing without deploying has no effect — the platform runs its own copy. Skip this if no automation platform is configured.

## Rules

-> `preferences/rules/README.md` (index with enforcement status)

## Repo Structure

| Directory                   | Purpose                                                     |
| --------------------------- | ----------------------------------------------------------- |
| `/apps/{name}/`             | Self-contained apps: protocol (README) + automation scripts |
| `/apps/shared/`             | Shared utilities (notifications, email, etc.)               |
| `/knowledge/{domain}/`      | Data organized by domain                                    |
| `/knowledge/people/{name}/` | People & entities                                           |
| `/projects/{domain}/`       | Self-contained projects: `YYYY-MM-DD_brief-description/`    |
| `/journal/`                 | Daily session logs: `YYYY-MM-DD.md`                         |
| `/preferences/`             | User preferences, rules, templates, style guides            |
| `/integrations/`            | External service connectors (auth, APIs, docs)              |
