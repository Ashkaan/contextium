# Apps

Code you wrote lives here, one folder per app. An "app" is anything repo-authored: an automation, a
scheduled task, a library other apps import, a CLI, or a collection of check scripts. Name the folder
for what the code does, not for an external product (those go in `integrations/`).

The template ships with a small starter set:

| App | What it does |
|---|---|
| `project-index/` | Generates `projects/README.md` from each project's status frontmatter. |
| `app-index/` | Generates this `apps/README.md` from each app's frontmatter. |
| `integration-index/` | Generates `integrations/README.md` from each connector's frontmatter. |
| `quality/` | The repo's quality checks. Ships with the commit gate wired; grow it from there. |
| `shared/` | Small helpers the index generators import (`parse_frontmatter.ts`, `validate_outcome.ts`). |

The three index generators run with `node apps/<name>/generate.ts`. They read frontmatter as the single
source of truth and rewrite the matching index, so you edit the per-item README and let the index
regenerate rather than hand-maintaining a file list.

See `docs/architecture.md` for the apps-vs-integrations boundary.
