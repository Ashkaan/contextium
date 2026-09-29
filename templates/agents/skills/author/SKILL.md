---
name: author
description: Scaffolds a conforming AI-layer artifact — skill, hook, agent or output style — that already passes the workbench's format checks, Anthropic's documented frontmatter shape, and the four token/context/determinism principles. Use when authoring or compressing any skill, hook, agent or output style.
allowed-tools: Bash Read Edit Write AskUserQuestion
metadata:
  peers: ".agents/skills/author/references/skill.md .agents/skills/author/references/hook.md .agents/skills/author/references/agent.md .agents/skills/author/references/output-style.md .agents/skills/author/scripts/scaffold.sh .agents/skills/author/scripts/verify.sh .agents/agents/ai-layer-reviewer.md .agents/skills/review/policy-review.sh"
---

# /author — Unified AI-Layer Artifact Scaffolder

One skill, four branches. `/author <type> [name]` scaffolds a conforming
AI-layer artifact that already passes the workbench's format checks, then runs that
check as a backstop. AI judgment is confined to CONTENT (filling a skeleton),
never STRUCTURE (the scaffold is deterministic). Per-branch detail lives in
`references/<type>.md` — loaded on demand (progressive disclosure), not inlined.

`<type>` ∈ {`skill`, `hook`, `agent`, `output-style`}. The flow is uniform
across all four; the type only changes which template, which questions, and
which backstop.

| Type | Branch doc | What scaffold writes | verify backstop |
|---|---|---|---|
| skill | [references/skill.md](references/skill.md) | `.agents/skills/<name>/SKILL.md` | `.agents/checks/check-skills.sh` (the published Agent Skills validator + `AGENTS.md § Skill shape`) |
| hook | [references/hook.md](references/hook.md) | `.agents/hooks/<name>.sh` (or `.agents/checks/`) | `shellcheck` + safe-mode |
| agent | [references/agent.md](references/agent.md) | `.agents/agents/<name>.md` | frontmatter fields (SSOT in agent.md) |
| output-style | [references/output-style.md](references/output-style.md) | `.agents/output-styles/<name>.md` | documented-field check (unknown key, `description`, `keep-coding-instructions`) |

## The four principles (enforced, not advised)

Every artifact `/author` emits must satisfy four principles from the original ask. They are **deterministic `verify.sh` gates**, so a violation fails the check — it is not left to judgment. Sourced from Anthropic docs ([skills](https://code.claude.com/docs/en/skills), [sub-agents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks)).

| Principle | How it's enforced |
|---|---|
| Anthropic best practices | `verify.sh`: skill `description` ≤1,536 + third-person; hook exit-2-for-PreToolUse (emitted by placement); agent 6-field SSOT + scoped `tools` |
| Low token usage | `verify.sh`: `description` within the always-loaded cap AND exactly one sentence (skill, agent, output-style); SKILL.md body ≤500 lines |
| High determinism | `scaffold.sh` emits correct-by-construction (right hook shape + exit code per placement); every type has a non-zero-on-violation backstop; skill branch's determinism inventory pushes data steps to `scripts/` |
| Low context usage | `verify.sh`: SKILL.md body ≤500 lines; `references/` one level deep (leaf docs) |

## parse-type

Read `<type>` from the first argument.

- No type arg → list the four valid types (one line each, from the table above) and prompt which; halt.
- Unknown type (e.g. `/author command`) → reject, list the four valid types; halt. No scaffold is written.
- Valid type, no name → continue to resolve-shape; the name is prompted at scaffold time (an empty name is the "no name" boundary → prompt, not reject).
Then open the matching `references/<type>.md` — it carries the branch's questions and the scaffold→fill→verify→register checklist.

## resolve-shape

Ask the user (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`) for the few decisions that determine STRUCTURE (not content):

- **skill** — skill-vs-agent (session history → skill; fresh context → agent) + gated-step-graph-or-single-body + **a determinism inventory of every step** (data → `scripts/`, judgment → body prose). The skill branch's Step 2.5 turns each DATA step into a script + paired test; prose-describing a deterministic step is the failure that makes skills non-deterministic.
- **hook** — which of the 9 categories + firing surface (PreToolUse/PostToolUse vs pre-commit check).
- **agent** — confirm it's an agent not a skill.
- **output-style** — `keep-coding-instructions` true or false (it defaults to FALSE, which strips Claude Code's software-engineering instructions), and whether the style must bind subagents (it does NOT by default — that needs a `SubagentStart` hook in `.agents/hooks/`).

Halt if the shape cannot be resolved — the artifact is not yet well-scoped.
Model assignment is its own step (`model-assignment`, below), not part of shape.

## activation-fields

Claude Code exposes activation and permission as **frontmatter fields**, and a
field the harness already owns MUST NOT be reimplemented as body prose.
Field list read first-hand from
[code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills).

The table below is the **skill** branch. The other three shapes are not silent
skips — state which line applies and move on:

- **agent** — Claude Code recognizes no activation fields on an agent
  (`name`, `description`, `model`, `tools`, `color` only). Its `description` is
  the whole trigger, `tools:` is its permission surface (already gated at
  `verify`), and `model:` is set by `model-assignment`. Nothing to decide here.
- **output-style** — `keep-coding-instructions` and subagent reach are decided
  at `resolve-shape`; there is no other field.
- **hook** — activation is its matcher in each harness's hook manifest, wired at `register`.

Decide each row. **Where the answer is not obvious from what the artifact does,
ask the user (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`) — do not guess a default and do not skip the field silently.**
Batch the uncertain rows into ONE question set, then record every answer so
`fill` writes it.

| Field | Set it when | Ask when |
|---|---|---|
| trigger text in `description` | always — the description says what the skill does AND when to fire it, trigger phrases included, since a skill file has no separate trigger field (Agent Skills spec). Where the skill fires on words that don't resemble its job ("make this sound less AI" → the voice check), those words go in the description | the trigger set isn't obvious from the job |
| `skillOverrides: "user-invocable-only"` in `~/.claude/settings.json` | only the user should fire it (spend, outbound, deploy). This is harness configuration, not a file field: the file may not carry `disable-model-invocation`, and Codex/Antigravity/Grok each have their own hide (`AGENTS.md § Skill shape`) | **ALWAYS.** This is the one setting that stops a skill firing on its own, so it is never inferred — not from "the user always types it by name anyway," a guess that has mis-planned a migration before. The user names the skill or it stays listed |
| `allowed-tools` | the skill's own commands would otherwise prompt the user every run; one space-separated string | the grant would widen beyond what the skill itself runs |
| `metadata.peers` | always — the references, scripts and dispatched skills/agents the body loads, as one space-separated string | — |

A skill that needs a field the spec does not carry — a path scope, a forked
context, a hidden-from-the-menu flag, a model or effort override — is a
decision to put to the user, because the file cannot carry it and the check
refuses it; say which harness setting would do the job instead.
`argument-hint` is gone with the rest: it was a TUI autocomplete nicety with no
behaviour behind it.

## model-assignment

Only for an artifact that does LLM work — any agent, or a skill/hook that
prompts a model. Skip it otherwise and say so.

The model is read from the policy, never chosen here. Name the artifact's
work-type and
read its assigned chain:

```bash
jq -r '.rows | keys | join(", ")' .agents/skills/review/policy.json   # the work-types
jq -r '.rows["<task-kind>"]' .agents/skills/review/policy.json        # the chain
```

Three outcomes:

| The row's primary vendor | What to do |
|---|---|
| claude | An agent with `model: inherit` already honors it. Nothing more. |
| codex / grok | An agent CANNOT honor it — the `model:` field takes only `inherit` or a Claude id. The dispatching skill MUST route the assigned work through `.agents/skills/review/policy-review.sh <task-kind> <artifact> <brief>`, using the agent only for the repo-context half a one-shot CLI call cannot do. |
| no row fits | Legitimate. Every row describes one-shot prompt-in/answer-out work; multi-turn tool-driven agents (repo exploration) have no row by design. Say which rows you considered and why none applies. MUST NOT invent a row or force a bad fit. |

Record the outcome so `fill` can wire it. Authoring a reviewer agent with
`model: inherit` when its row says Codex, and calling it done, is the
divergence this step exists to prevent.

## scaffold

Run the deterministic emitter:

```bash
bash .agents/skills/author/scripts/scaffold.sh <type> <name> [placement]
```

It validates the type + kebab name, computes the surface path, refuses on collision (never overwrites, never normalizes), and copies the template with `{{name}}` substituted. `placement` is hook-only (`checks` → `.agents/checks/<name>.sh` plus `<name>.test.sh` beside it).

## fill

Fill the scaffold's `TODO` placeholders — the only AI-judgment step. Follow the branch doc's fill checklist (description load-bearing, fields resolved, gates declared, body contract met).

## design-review

Every branch. `verify` proves the artifact is well-FORMED; this gate asks
whether the design is WRONG, which no format check can see. A conforming skill
that never fires, dispatches nothing, or describes a deterministic step in
prose passes every linter and fails in production. For an output style, whose
body is in the system prompt on every turn, the brief also carries every clause
the rewrite dropped from the original, so the reviewer rules on each drop.

**Two reviewers, because they see different things.** The model is assigned by
the review policy table (`.agents/skills/review/policy.json`), not chosen here:

1. **Policy-assigned adversary** — write the attack brief to a temp file
   (the angles table in `.agents/agents/ai-layer-reviewer.md` is the SSOT for
   what to attack), then:

   ```bash
   bash .agents/skills/review/policy-review.sh adversarial-review <artifact-path> <brief-file>
   ```

   The shipped `adversarial-review` row starts with Codex; the script follows
   the chain and never hard-codes a vendor. Exit 3 means the chain reached the
   claude slot — dispatch the agent below and note it. Parse findings by
   line-anchored grep (`^\[must-fix\]`, `^\[should-fix\]`, `^\[nit\]`).

2. **`ai-layer-reviewer` agent** — dispatch with `{type, path, intent}` and
   NOTHING else. Withhold the design rationale on purpose: a reviewer shown the
   "why" rationalizes the flaw.
   This is the repo-context read — the agent can grep for overlapping artifacts
   and read the branch docs, which a one-shot CLI call cannot.

Act on every `must-fix` / `fix-now` before the branch completes; `nit`,
`speculative`, and `out-of-scope` need no action. Zero findings is a valid
result — do not pad. Re-run after
fixes only if a fix changed the design (not for typos); stop the loop when a
round mostly re-opens ground an earlier round already touched, and in no case
past round 4. No user question.

`on_fail: halt` — no clean verdict, no completion. A newly-authored agent is not
dispatchable until the next session (the registry loads at session start); when
that blocks the agent half, the policy-assigned adversary still runs, and a
general-purpose agent carrying the `ai-layer-reviewer` body covers the rest.

## verify

Run the type's conformance backstop; it MUST exit 0 before the branch completes:

```bash
bash .agents/skills/author/scripts/verify.sh <type> <path>
```

On failure, fix at the source and re-run — never override, never exclude.

`verify.sh hook` WARNs (non-blocking) when no hook manifest names a top-level hook (Claude Code `~/.claude/settings.json`, Codex `~/.codex/hooks.json`, Antigravity `.agents/hooks.json`). It says nothing about what fires a check under `.agents/checks/`: nothing dispatches a new check on its own. `/author` writes the check and its test.

## register

Meaningful for exactly one type — **hook** — because hooks are the only artifact that needs explicit wiring to fire:

- **skill** — none; auto-discovered from `.agents/skills/<name>/SKILL.md`.
- **hook** — a PreToolUse/PostToolUse hook is wired per [references/hook.md](references/hook.md) Step 5: a matcher block in each harness's hook manifest; `verify.sh hook` WARNs (non-blocking) while none names it. A check under `.agents/checks/` is not wired here: nothing fires it until something calls it.
- **agent** — none; auto-discovered from `.agents/agents/<name>.md`.
- **output-style** — NOT auto-selected by existing. To make it the default set `outputStyle` in `~/.claude/settings.json`; to carry it into subagents add the agent types to the fail-closed allowlist of a `SubagentStart` hook in `.agents/hooks/`.

## Examples

### Example 1 — `/author skill weekly-digest`

`parse-type` → skill. `resolve-shape` asks skill-vs-agent (session-stateful → skill) + gated-or-simple (no gates → single-body). `scaffold` writes `.agents/skills/weekly-digest/SKILL.md` from the template. `fill` completes the description (what + when) + `metadata.peers` + body. `verify` runs `check-skills.sh` → exit 0. `register` is a no-op (auto-discovered). Done.

### Example 2 — unknown type

`/author command foo` → `parse-type` rejects: "unknown type `command` — valid types: skill, hook, agent, output-style." Halt; nothing written.

## Troubleshooting

| Failure | Cause | Fix |
|---|---|---|
| `scaffold.sh` exits 2 "unknown type" | `<type>` not in the four | Use skill\|hook\|agent\|output-style. |
| `scaffold.sh` exits 1 "invalid name" | name not kebab `^[a-z][a-z0-9-]*$` | Rename to kebab-case; names are rejected, never normalized. |
| `scaffold.sh` exits 1 "exists" | artifact already at the surface path | Pick a new name — never overwrites. |
| `verify.sh` non-zero | conformance backstop failed | Read the stderr, fix at source, re-run. Never exclude. |
| `verify.sh hook` WARNs "not wired" | no hook manifest names a top-level hook | Wire it per references/hook.md Step 5, or accept that it will never fire. |
| A check under `.agents/checks/` never runs | nothing dispatches it yet | Call it from whatever should fire it; run it by hand until then. |
