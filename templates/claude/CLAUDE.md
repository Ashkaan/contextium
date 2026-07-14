# CLAUDE.md

This file is the working surface for Claude Code in this repo. It is the first thing a fresh session
reads. Keep it short; the detail lives in `.claude/rules/` and `.claude/skills/`.

Maintained for: **{{NAME}}**. Autonomy preference: **{{AUTONOMY}}**.

## How to work here

Three verbs, with fresh context between thinking and doing. Each producer verb runs its own review and
then auto-invokes `/close` on a clean finish — so "wrap" is not a verb you type; the loop wraps itself.

| Verb | Skill | What it does | Auto-runs |
|---|---|---|---|
| Think | `/project` → `/spec` | Render the project index, or start/route a project; `/project` plans and hands SPEC-writing to `/spec`. | spirit-check, then `/close` (commits the SPEC) |
| Do | `/implement` | Execute a SPEC with self-validation. Starts fresh on purpose. | `/implement-audit`, then `/close` |
| Wrap | `/close` | Journal the session, then commit + push. | — (auto-fired by the producer verbs) |

`/close` still runs standalone for ad-hoc sessions that didn't go through a producer verb. The loop
HALTS for you only when a `@rule:depth-policy` decision or a deferral needs your call; otherwise it
carries a clean run all the way to the commit. See
[`skills/close/references/auto-close-gate.md`](skills/close/references/auto-close-gate.md).

Supporting skills: `/implement-audit` (adversarial code review — the loop's single reviewer),
`/explain` (deep investigation), `/debate` (argue a decision from both sides), `/author` (scaffold a
rule, skill, hook, or agent the right way).

## Working preferences

- Be concise, direct, practical. Technical depth is welcome; padding is not.
- Use tables for structured data instead of bullet lists of similar rows.
- Push back with a better approach when you have one. Do not agree by default.
- Default to doing the work over planning it. Do not expand a small task into a large plan.
- Land the full scope in the session. Do not defer in-scope work to "later" (see @rule:no-deferral).
- When autonomy is `ask`: diagnose freely, but ask before changing shared host infrastructure
  (networking, daemon configs, systemd units, root credentials) on any machine other than this repo.

## The layer

| Path | What's there |
|---|---|
| `.claude/rules/` | Always-loaded principles. Start here to understand how this repo wants you to behave. |
| `.claude/skills/` | The Loop verbs and supporting skills. |
| `.claude/agents/` | Fresh-context sub-reviewers the skills dispatch. |
| `.claude/hooks/` | Mechanisms that actually fire (commit gate, destructive-git guard, memory-write guard). |
| `apps/` | Code you wrote: automations, scripts, libraries. Starts empty; nothing of the template's lives here. |
| `integrations/` | External connectors you wrap. Starters live in `templates/integrations/`. |
| `knowledge/` | Your domain data: people, goals, business context. |
| `projects/` | Multi-session work, one folder per initiative, with status frontmatter. |
| `journal/` | Daily session logs, the WHY layer of memory. Written by `/close`. |

## Memory

Two layers. The git log records WHAT changed (commit subjects). The journal records WHY, one file per
day under `journal/`, written at the end of a session by `/close`. Reconstructing a past decision needs
both.

## Growing this

The rules here are a starting set, not the whole story. When a correction recurs and you want it
enforced, write it down as a rule with a backing mechanism. See @rule:write-your-own-rules.
