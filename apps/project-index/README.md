---
name: project-index
description: Generates projects/README.md from project frontmatter
category: system
schedule: on-demand
runtime: npx tsx
trigger: project status change
outputs: projects/README.md
---

# Project Index Generator

Walks `projects/` directories, reads frontmatter from each project's README.md, and generates a status overview table at `projects/README.md`.

## Usage

```bash
npx tsx apps/project-index/generate.ts
```

## How It Works

1. Scans `projects/{domain}/{YYYY-MM-DD_name}/README.md` for YAML frontmatter
2. Groups by status: In Progress, Up Next (planning), On Hold (waiting), Completed
3. Sorts by domain (alphabetical) then created date (newest first)
4. Writes the generated table to `projects/README.md`

## Frontmatter Fields

| Field | Required | Values |
|-------|----------|--------|
| `status` | Yes | `in-progress`, `planning`, `waiting`, `completed` |
| `project` | No | Display name (defaults to directory name without date prefix) |
| `created` | No | Date (defaults to directory date prefix) |
| `description` | No | One-line summary |
| `next` | No | Next steps (shown for in-progress and planning) |
| `blocked-on` | No | Blocker description (shown for waiting) |
