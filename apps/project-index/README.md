---
name: Project Index
description: >-
  Generates projects/README.md from project frontmatter.
  Scans all project directories, parses YAML frontmatter, and produces
  a status-grouped index table.
category: system
schedule: On demand (triggered by project create/frontmatter change)
runtime: Manual
trigger: Manual
outputs:
  - projects/README.md (generated index)
integrations:
  - GitHub
---

# Project Index


Generates `projects/README.md` from project frontmatter — the single source of truth for project status.

## Usage

```bash
npx tsx apps/project-index/generate.ts
```

## How it works

1. Discovers all `projects/{domain}/{YYYY-MM-DD_name}/README.md` files
2. Parses YAML frontmatter (status, description, next, blocked-on, monitoring-until)
3. Validates required fields
4. Outputs a markdown index grouped by status: In Progress → Up Next → On Hold → Monitoring
