# Canonical Project README Scaffold

Reference for [`/project`](../SKILL.md) create-mode. Anthropic progressive-disclosure tier 3 — loaded by Claude when scaffolding a new project README. Absorbed from the deleted `.claude/skills/project/references/readme-template.md` (2026-04-20).

## Template

```markdown
---
project: project-name-slug
status: active|blocked|monitor|completed
priority: high|medium|low   # required on active/blocked/monitor
created: YYYY-MM-DD
tags: [category, technology, type]
description: One-line summary for the project index
next: One short human-facing sentence — the single immediate next action (shown verbatim in the agenda email + index; the full backlog + context live in the body sections below, which is where AI reads). Use blocked-on when status is blocked; monitoring-until when status is monitor.
---

# Project: [Descriptive Name]

## Goal

[1-3 sentences: what and why]

## Status

- [ ] Planning
- [ ] In Progress
- [ ] Testing
- [ ] Completed

## Current Progress

- [Concrete deliverables and accomplishments]

## Next Steps

- [ ] [Actionable items]

## Outcome

[Written when project completes: what was achieved, key learnings]
```

## Optional sections

Add as needed: `Research Findings`, `Technical Details`, `Notes`.

## Folder structure

Only `README.md` in the project root; use `docs/` for longer documents, `scripts/` for executables, `configs/` for configuration, `backups/` for backups.

## Valid domains

whatever domains your work actually falls into — e.g. `ai`, `infra`, `finance`, `product`, `personal`. Pick a small set and keep it stable; a new domain is a decision to make deliberately, not per-project.

## Naming convention

`/projects/{domain}/YYYY-MM-DD_brief-description/`.

## Priority classifier

- **high** = serves an explicit Q2 goal bullet in `knowledge/growth/goals/goals.md`
- **medium** = meta-infrastructure (rules, hooks, skills, telemetry, frameworks, support-apps that make the rest of the repo work)
- **low** = neither
