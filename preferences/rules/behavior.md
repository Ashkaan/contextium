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

**Don't:** create standalone docs (use journal), write to agent memory files (use the repo).

### Delegation Logging

When delegating non-trivial work (not quick lookups), include a one-line summary in the journal:
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

### Fresh context for complex builds

When building a new automation or app with 3+ iteration rounds, delegate implementation phases to sub-agents with fresh context:

**When to delegate:**
- You've already done 2+ rounds of significant edits to the same script
- The script exceeds ~200 lines and you're still adding features
- You're wiring multiple integrations (API + storage + UI + automation)

**How:**
- Pass the sub-agent: file path, current implementation, specific task ("add these 3 flags with these signatures"), and verification criteria
- Keep planning/design in main context (needs user interaction)
- Commit between phases so sub-agents work on clean state

**Skip when:** single-pass builds, bug fixes, config changes, or anything under ~100 lines.

### Other rules

- **Grep before Read** — find specific lines instead of reading entire files
- **Offset/limit for large files** — files >200 lines: read only the relevant section
- **Don't re-read** — never re-read a file already loaded this session
- **Focused agent prompts** — "What function handles X?" not "Read file Y and summarize"
- **Compact Bash output** — pipe through grep/head/tail when output exceeds ~50 lines

## Depth Policy

**Decisions** (architecture, strategy, tool selection, purchases):

- Present alternatives with trade-offs
- Flag risks and dependencies
- If skipping deep analysis, state why (e.g., "single viable approach, no meaningful alternatives")

**Execution** (writing code, routine changes, data entry):

- Stay concise, execute directly

## Tracking Completions

When the user reports completing a tracked item (journal Next, project README next-steps, action items), update the docs in the same turn — don't just acknowledge conversationally. Dangling items confuse future sessions into thinking work is still pending.

## Proactive Value

After completing a milestone or research task, include a brief "Also consider:" with 1-3 adjacent insights the user didn't ask for. Examples:
- Cross-project connections ("This also applies to [other project]")
- Timing opportunities ("Good time to do X since you're already in this area")
- Risk flags ("This decision affects [dependency] — worth checking")

Keep it to 2-3 lines. Useful, not noisy. Skip if nothing useful to add.
