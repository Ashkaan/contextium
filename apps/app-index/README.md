---
name: App Index
description: >-
  Generates apps/README.md from app frontmatter. Scans all app directories,
  parses YAML frontmatter, and produces a category-grouped index table.
category: system
schedule: On demand (triggered by app create/change)
runtime: Manual
trigger: Manual
outputs:
  - apps/README.md (generated index)
integrations: []
---

# App Index


Generates `apps/README.md` from app frontmatter — the same pattern as `project-index/generate.ts`.

## Usage

```bash
npx tsx apps/app-index/generate.ts
```

## How it works

1. Scans `apps/*/README.md` (one level deep, skips `shared/` and `app-index/`)
2. Parses YAML frontmatter for `name`, `description`, `category`, `schedule`, `runtime`
3. Groups apps by `category`, sorts alphabetically within each group
4. Writes `apps/README.md` with category-sectioned tables
