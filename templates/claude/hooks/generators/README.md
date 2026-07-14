# Index generators

Three scripts that rewrite an index file from the frontmatter of the things it indexes. They are
AI-layer machinery, not apps: nothing schedules them. `/project` runs the project-index generator to
render the live index; the other two you run yourself when you add an app or a connector. They live
here so `apps/` stays yours.

| Script | Reads | Writes |
|---|---|---|
| `project-index.generate.ts` | `projects/{domain}/{date_name}/README.md` frontmatter | `projects/README.md` |
| `app-index.generate.ts` | `apps/*/README.md` frontmatter | `apps/README.md` |
| `integration-index.generate.ts` | `integrations/*/README.md` frontmatter | `integrations/README.md` |

Run one directly:

```bash
node .claude/hooks/generators/app-index.generate.ts
```

`--out <path>` redirects the output; `--out -` writes to stdout instead of the index file, which is
how `/project` renders the live project table without touching disk.

The contract is one-way: frontmatter is the source of truth, the index is derived. Edit the per-item
README and regenerate. Hand-editing an index file only means your edit gets overwritten.

`parse_frontmatter.ts` and `validate_outcome.ts` are the shared helpers all three import. An empty
`apps/` is valid — the generator still writes the header, it just has no rows.
