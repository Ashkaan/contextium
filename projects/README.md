# Projects

Multi-session work lives here, one folder per project: `projects/<domain>/<YYYY-MM-DD>_<slug>/`,
holding `README.md` (status frontmatter, Goal, Outcome), `ROADMAP.md` (the rows of outstanding work),
`specs/NNN-name/` (one spec folder per row) and, once there is one, `decisions/`. The layout is
described in `AGENTS.md` § What lives where. Run `/project` for the live, priority-sorted index
(`node .agents/generators/project-index.generate.ts --compact` prints it); nothing here is generated.
Starts empty.
