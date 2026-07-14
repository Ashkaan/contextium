# Contextium

> Give your AI an operating system.

Contextium is a starting methodology for working with AI coding tools. Pick your tools at install time
and it lays down each one's native config: a full `.claude/` layer for Claude Code, `GEMINI.md` and
commands for Gemini, `AGENTS.md` and skills for Codex, `.cursor/` rules for Cursor, `.github/` files for
Copilot. Underneath it is one methodology, projected into each tool's format from a single source, plus
empty data directories that grow as you work. The point is not a pile of features. The point is a way of
working that holds up over months, in whatever tool you reach for.

## The idea

Most AI coding sessions start from zero. You re-explain your preferences, the AI makes a plausible
guess, drifts halfway through a long thread, and you start over tomorrow. Contextium fixes that with
three things:

1. **The Loop.** Three verbs with fresh context between thinking and doing. Each producer verb runs
   its own review and then wraps itself — you don't type the third verb.

   | Verb | Skill | What it does |
   |---|---|---|
   | Think | `/project` → `/spec` | Plan, then write a short SPEC of what success looks like — spirit-checked and committed automatically. |
   | Do | `/implement` | Execute the SPEC with self-validation from a clean context — code-reviewed and committed automatically. |
   | Wrap | `/close` | Journal what happened and why, then commit. Auto-fired by the two verbs above; still runnable by hand. |

   In Claude Code each verb is a real slash-command skill. In every other tool the same three verbs
   ship as that tool's native commands (Gemini commands, Codex skills, Cursor commands, Copilot
   prompts), so the Loop reads the same everywhere. `/close` runs at the tail of `/spec` and
   `/implement` on a clean finish, so the loop wraps itself and only stops for you when a decision
   genuinely needs your call.

   The fresh-context boundary between `/project` and `/implement` is deliberate. A session that wrote
   the plan and grew attached to its choices is the wrong session to also judge the implementation. A
   new one catches what the invested one defends.

2. **Rules as mechanisms.** A rule that lives only in a document gets forgotten in the moment it was
   written to cover. The rules that matter here are backed by hooks that actually fire: a commit gate,
   a destructive-git guard, a memory-write guard. Advisory prose is honest about being advisory.

3. **Memory in two layers.** The git log records what changed. The journal records why, one file per
   day, written by `/close`. Reconstructing an old decision needs both, so the system keeps both.

## Works in your tool

Contextium is model-agnostic. The installer asks which tools you use and writes each one's native
config. One portable source (the methodology, the principle rules, the Loop commands) is projected into
every tool's format, so the rules read the same no matter what is driving.

| Tool | Instructions file | Loop commands |
|---|---|---|
| Claude Code | `.claude/` + `CLAUDE.md` | `.claude/skills/` (real slash commands) |
| Gemini CLI | `GEMINI.md` | `.gemini/commands/*.toml` |
| Codex | `AGENTS.md` | `.codex/skills/*/SKILL.md` |
| Cursor | `.cursor/rules/contextium.mdc` | `.cursor/commands/*.md` |
| GitHub Copilot | `.github/copilot-instructions.md` | `.github/prompts/*.prompt.md` |

Two things port to every tool: the methodology and rules, and the git-hook enforcement (a verb-led
commit-subject check and a staged-secret scan, wired through `core.hooksPath`). Two things are a Claude
Code bonus that other tools cannot run: the fresh-context review agents and the PreToolUse guards. So
the discipline travels everywhere; the most automation lives in Claude Code.

## What's in the box

- Eight Claude Code skills: the Loop (`/project` → `/spec`, `/implement`, `/close`) plus
  `/implement-audit` (adversarial code review), `/explain` (deep investigation), `/debate`, and
  `/author` (scaffold a conforming rule, skill, hook, or agent). The four Loop verbs also ship as native
  commands for every other supported tool.
- Three fresh-context review agents the Claude skills dispatch when they need a second set of eyes.
- Eight always-loaded principle rules, kept short on purpose, shared verbatim across all tools.
- A handful of wired hooks, a lean 4-section SPEC template, and 14 docs-only integration starters you
  pick from at install time.

## What's not in the box (on purpose)

This ships lean. The heavy enforcement machinery, orchestration platforms, large reconcilers,
multi-model SPEC review, per-session git worktrees, runtime-pinning rules, is described in the docs as
advanced patterns you can grow into. It is not wired in. You start with the methodology and add weight
where your own work demands it.

## Install

```bash
git clone https://github.com/Ashkaan/contextium.git
cd contextium
bash install.sh
```

The installer asks which AI tools you use, your name, how autonomous you want the AI to be, and which
integration starters to include, then lays down each tool's native config and leaves your data
directories alone on re-runs. Default is Claude Code; add others interactively or with
`--tools "claude gemini codex cursor copilot"` (or `--all-tools`). Then open the project in your tool
and run the Think verb (`/project` in Claude Code, the same command in the others).

See `docs/getting-started.md` for a first walk through the Loop, and `docs/architecture.md` for how the
pieces fit.

## License

MIT. See `LICENSE`.
