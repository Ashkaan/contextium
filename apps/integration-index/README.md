---
name: Integration Index
description: >-
  Generates integrations/README.md from integration frontmatter.
  Scans all integrations/*/README.md for YAML metadata and builds the index table.
category: system
schedule: On demand (triggered by integration README add/modify/delete)
runtime: Manual
trigger: Manual
outputs:
  - integrations/README.md
integrations: []
---

# Integration Index


Generates `integrations/README.md` from integration frontmatter.

## Usage

```bash
npx tsx apps/integration-index/generate.ts
```

Normally runs automatically via `apps/quality/git-precommit.sh` Phase A on any commit that adds/modifies/deletes `integrations/*/README.md`.

## How It Works

1. Scans `integrations/*/README.md` for YAML frontmatter
2. Parses `name`, `description`, `cli` fields
3. Sorts alphabetically
4. Generates markdown table
5. Writes `integrations/README.md`
