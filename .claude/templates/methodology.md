# Working agreement

This is the portable core of the Contextium methodology. It is tool-agnostic: it reads the same
whether your agent is Claude Code, Cursor, Codex, Gemini, Copilot, Windsurf, Cline, or Aider. The
generated per-tool instruction files (AGENTS.md and friends) are projections of this file plus the
principles below, so they never drift from one source.

Claude Code users get an extra layer on top: the Loop verbs are real slash-command skills
(`/project`, `/implement`, `/close`), backed by fresh-context review agents. Every other tool runs the
same Loop as a procedure you invoke in plain language. The methodology is the same; only the ergonomics
differ.

## How to work: the Loop

Three moves, with a deliberate context break between thinking and doing.

| Move | In Claude Code | In any other tool |
|---|---|---|
| **Think** | `/project` | Plan the work. Write a short SPEC (Ask / Behavior / Files / Done). Get sign-off before building. |
| **Do** | `/implement` | Start a fresh chat. Load the SPEC. Implement task by task, validating after each change. Run it end to end. |
| **Wrap** | `/close` | Write a journal entry (Action / Changes / Decisions / Issues / Lessons / Next). Commit. |

The break between Think and Do matters. A chat that wrote the plan and grew attached to its choices is
the wrong one to also judge the implementation. Open a new conversation for the Do step and reload the
SPEC. A fresh context implements what was actually agreed instead of defending what it already wrote.

### The SPEC stays lean

Four sections: what was asked, what success looks like (including the 0 / 1 / empty / max / error
edges), the files to touch, and the exact commands that prove it works. A heavy project grows its own
sections when a real gap bites. Do not pad it with boilerplate that degrades to "N/A".

## Memory: two layers

- **Git log** records WHAT changed. Keep commit subjects verb-led so the log reads as memory.
- **Journal** (`journal/YYYY-MM-DD.md`) records WHY, one file per day, written when you wrap. Use the
  labeled markers (Action / Changes / Decisions / Issues / Lessons / Next) so a future session can skim
  it.

Reconstructing a past decision needs both: the log says when and what, the journal says why and what
you learned.

## Enforcement travels with the repo

The rules that matter are backed by mechanisms, not by hoping the model remembers. Two of them are
wired as git hooks, so they fire no matter which tool drove the change:

- **commit-msg** checks the subject is verb-led and reasonable length, and blocks AI co-author trailers.
- **pre-commit** scans the staged diff for obvious secrets (private keys, cloud credentials).

Run the installer's hook step (or `git config core.hooksPath .githooks`) to turn them on. One guard,
the destructive-git command block, is Claude-Code-specific because git has no hook for it; other tools
should lean on the same caution in prose.

## Working style

- Be concise, direct, practical. Push back with a better approach when you have one.
- Default to doing the work over planning it. Match the weight of the solution to the problem: an
  inline script beats a service that does the same thing.
- Land the full scope in the session. Do not defer in-scope work to "later".
- When the task is a real decision (architecture, a vendor, anything hard to reverse), present the
  options and wait. When it is execution, just do it.
- Ask before changing shared host infrastructure (networking, daemons, system services, root creds) on
  any machine that is not this repo.

The principles below expand on all of this. They are the same rules a Claude Code session loads from
`.claude/rules/`.
