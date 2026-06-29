# Contextium

> Give your AI an operating system.

Contextium is a starting methodology for working with Claude Code. It's a `.claude/` layer (rules,
skills, agents, hooks, and `CLAUDE.md`) plus a set of empty data directories that grow as you work. The
point is not a pile of features. The point is a way of working that holds up over months.

## The idea

Most AI coding sessions start from zero. You re-explain your preferences, the AI makes a plausible
guess, drifts halfway through a long thread, and you start over tomorrow. Contextium fixes that with
three things:

1. **The Loop.** Three verbs with fresh context between thinking and doing.

   | Verb | Skill | What it does |
   |---|---|---|
   | Think | `/project` → `/spec` | Plan, then write a short SPEC of what success looks like. |
   | Do | `/implement` | Execute the SPEC with self-validation, starting from a clean context. |
   | Wrap | `/close` | Journal what happened and why, then commit. |

   The fresh-context boundary between `/project` and `/implement` is deliberate. A session that wrote
   the plan and grew attached to its choices is the wrong session to also judge the implementation. A
   new one catches what the invested one defends.

2. **Rules as mechanisms.** A rule that lives only in a document gets forgotten in the moment it was
   written to cover. The rules that matter here are backed by hooks that actually fire: a commit gate,
   a destructive-git guard, a memory-write guard. Advisory prose is honest about being advisory.

3. **Memory in two layers.** The git log records what changed. The journal records why, one file per
   day, written by `/close`. Reconstructing an old decision needs both, so the system keeps both.

## What's in the box

- Eight skills: the Loop (`/project` → `/spec`, `/implement`, `/close`) plus `/implement-audit`
  (adversarial code review), `/explain` (deep investigation), `/debate`, and `/author` (scaffold a
  conforming rule, skill, hook, or agent).
- Three fresh-context review agents the skills dispatch when they need a second set of eyes.
- Eight always-loaded principle rules, kept short on purpose.
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

The installer lays down the `.claude/` layer (with `CLAUDE.md` inside it), asks for your name, how
autonomous you want the AI to be, and which integration starters to include, and leaves your data
directories alone on re-runs. Then open the project in Claude Code and try `/project`.

See `docs/getting-started.md` for a first walk through the Loop, and `docs/architecture.md` for how the
pieces fit.

## License

MIT. See `LICENSE`.
