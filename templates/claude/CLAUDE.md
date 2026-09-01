# CLAUDE.md

The working agreement lives in `.agents/AGENTS.md`, shared with every other AI tool and reachable as
`AGENTS.md` at the repo root. The line below is an import — Claude Code inlines that file here,
resolving the path relative to THIS file's directory — so there is one copy of the methodology and
this file holds only what is true of Claude Code alone. A session started from a subdirectory does not
resolve it.

@../.agents/AGENTS.md

## The Claude Code half

Everything the Loop needs is in `.agents/`, and `.claude/skills`, `.claude/rules`, `.claude/templates`
and `.claude/agents` are symlinks into it — edit either path, it is the same file. What is genuinely
Claude-only lives here as real directories:

| Path | Holds |
|---|---|
| `.claude/hooks/` | in-session guards — destructive-git block, memory-write block, commit gate, session checklist |
| `.claude/output-styles/` | response formats; `decision-only` is the default, `brevity` ships alongside it |
| `.claude/settings.json` | permissions, the selected output style, and the hook wiring |

The reviewer prompts in `.agents/reviewers/` are shared — Claude Code dispatches them as real
subagents through `.claude/agents`, and any other tool runs the same prompt in a clean context. The
PreToolUse guards that stop a bad command before it executes are the one thing no other tool can run. The methodology, the rules and the
git-hook enforcement are identical everywhere.

## Response format

`settings.json` selects the `decision-only` output style. Switch to `brevity` with the `outputStyle`
key if you prefer it. An output style does NOT reach subagents — each runs its own system prompt — so
any brief whose text you will read verbatim has to carry the format itself.
