# Canonical Project README Scaffold

Reference for [`/project`](../SKILL.md) create-mode. Loaded by Claude when scaffolding a new project
README, not held in always-loaded context.

## Template

```markdown
---
project: project-name-slug
status: active|blocked|monitor|completed
priority: high|medium|low   # required on active/blocked/monitor
created: YYYY-MM-DD
tags: [category, technology, type]
description: One-line summary for the project index
next: Current next steps (use blocked-on when status is blocked; monitoring-until when status is monitor)
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

Only `README.md` in the project root. Use subfolders as the work needs them: `docs/` for markdown docs,
`scripts/` for executables, `configs/` for configuration, the SPEC files (`*.spec.md`) alongside the
README.

## Domains

A domain is any short kebab folder directly under `projects/` — pick one that groups the work
(e.g. `ai`, `finance`, `home`, `health`, `business`, `infra`). The set is yours to grow; a new domain
just means a new folder. When unsure which domain a project belongs to, ask the user first.

## Naming convention

`/projects/{domain}/YYYY-MM-DD_brief-description/`.

## Priority classifier

- **high** = serves an explicit current goal you're actively pushing on
- **medium** = meta-infrastructure (rules, hooks, skills, frameworks, support-apps that make the rest
  of the repo work)
- **low** = neither
