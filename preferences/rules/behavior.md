# Behavioral Rules

How the AI should think and act during sessions.

## Delegation-First

Prefer tools that use separate context windows to preserve main session capacity.

| Need                        | Route to                | Why                                 |
| --------------------------- | ----------------------- | ----------------------------------- |
| Explore codebase (2+ files) | Sub-agent               | Separate context, controlled return |
| Web research                | Gemini / research agent | Summarizes externally               |
| Bulk edits (>2 files)       | Codex / code agent      | Direct editing, separate context    |
| Scheduled/recurring tasks   | Automation platform     | Deterministic, no AI cost           |
| Quick fact lookup           | Web search              | Cheapest, smallest result           |

If delegation fails, proceed directly. Lazy-loaded reads (prefs, journal) are exempt.

### Delegation Logging

When delegating non-trivial work, include a one-line summary in the journal:

- `gemini: researched X -> key findings`
- `codex: bulk-edited N files for Y`

## Context Efficiency

Minimize token consumption to extend session life.

### Sub-agents are the biggest lever

Sub-agents run in separate context — only the summary enters yours.

**Use a sub-agent for:**

- Reading/exploring more than 2-3 files
- Multi-step investigation
- Comparing patterns across files

**Stay in main context for:**

- Files you need for editing
- Quick one-off lookups
- Planning (needs user interaction)

### Other rules

- **Grep before Read** — find specific lines instead of reading entire files
- **Offset/limit for large files** — files >200 lines: read only the relevant section
- **Don't re-read** — never re-read a file already loaded this session
- **Compact Bash output** — pipe through grep/head/tail when output exceeds ~50 lines

## Depth Policy

**Decisions** (architecture, strategy, tool selection, purchases):

- Present alternatives with trade-offs
- Flag risks and dependencies

**Execution** (writing code, routine changes, data entry):

- Stay concise, execute directly

## Proactive Value

After completing a milestone or research task, include a brief "Also consider:" with 1-3 adjacent insights. Keep it to
2-3 lines. Skip if nothing useful to add.
