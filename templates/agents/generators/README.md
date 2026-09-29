# Index generators

Programs that build an index from the frontmatter of the things it indexes. Nothing schedules
them: `/project` runs the project index to render the live table, and you run the other two when you
add an app or a connector. They live in `.agents/` rather than in `apps/` because they are layer
programs, and `apps/` is yours.

| Script | Reads | Writes |
|---|---|---|
| `project-index.generate.ts` | `projects/<domain>/<date>_<slug>/README.md` frontmatter | stdout (default), or `--out <file>`, refused while a project README cannot be read; `--compact` is the slim view `/project` pastes |
| `app-index.generate.ts` | `apps/*/README.md` frontmatter | `apps/README.md` (`--out -` for stdout) |
| `integration-index.generate.ts` | `integrations/*/README.md` frontmatter | stdout (default), or `--out <file>` — not `integrations/README.md`, which holds the manifest schema |

```bash
node .agents/generators/project-index.generate.ts --compact
node .agents/generators/app-index.generate.ts
```

The project index is never committed: it is rendered live, so there is no second copy of the
projects' frontmatter to drift. Its `next:` column is itself derived, from each project's
`ROADMAP.md`, by `/close`. The app index rewrites `apps/README.md` in place, so hand-editing that
file only means the edit gets overwritten. The integration index prints: `integrations/README.md`
is hand-maintained, because it holds the manifest schema every integration README is checked against.

`parse_frontmatter.ts`, `table_cell.ts` (every Markdown table cell rendered from frontmatter goes
through it), `validate_outcome.ts` and `repo_root.ts` are the shared helpers. The project
index finds the workbench with `git rev-parse --show-toplevel` from its own folder; the other two use
`repo_root.ts`, which reads the same answer off their location. An empty `projects/` or `apps/` is
valid — the header still renders, with no rows.

The suites run in the Contextium repo and are not installed:

```bash
node --test templates/agents/generators/project-index.generate.test.ts templates/agents/generators/generators.test.ts
```
