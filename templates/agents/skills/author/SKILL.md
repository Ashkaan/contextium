---
name: author
description: Scaffolds a conforming AI-layer artifact — a rule, skill, hook, agent, or output style — that already passes the format checks, then verifies it. Use when adding any new AI-layer artifact — a shared one under .agents/ or a Claude-only one under .claude/ — so it matches the existing shape instead of drifting. Takes [rule|skill|hook|agent|output-style] [name].
allowed-tools: Bash Read Edit Write AskUserQuestion
metadata:
  peers: ".agents/skills/author/references/rule.md .agents/skills/author/references/skill.md .agents/skills/author/references/hook.md .agents/skills/author/references/agent.md .agents/skills/author/references/output-style.md .agents/skills/author/scripts/scaffold.sh .agents/skills/author/scripts/verify.sh .agents/skills/author/scripts/relocate-evidence.sh .agents/reviewers/rule-efficacy-reviewer.md .agents/reviewers/ai-layer-reviewer.md .agents/scripts/artifact-review.sh .agents/rules/meta/ai-layer-authoring.md"
---

# /author — Unified AI-Layer Artifact Scaffolder

One skill, five branches. `/author <type> [name]` scaffolds a conforming
AI-layer artifact that already passes the repo's format checks, then runs that
check as a backstop. AI judgment is confined to CONTENT (filling a skeleton),
never STRUCTURE (the scaffold is deterministic). Per-branch detail lives in
`references/<type>.md` — loaded on demand (progressive disclosure), not inlined.

`<type>` ∈ {`rule`, `skill`, `hook`, `agent`, `output-style`}. The flow is
uniform across all five; the type only changes which template, which questions,
and which backstop.

| Type | Branch doc | What scaffold writes | verify backstop |
|---|---|---|---|
| rule | [references/rule.md](references/rule.md) | nothing — inline `## <slug>` (prints guidance) | `run-rule-linters.sh` |
| skill | [references/skill.md](references/skill.md) | `.agents/skills/<name>/SKILL.md` | `check-skill-format.sh` |
| hook | [references/hook.md](references/hook.md) | `.claude/hooks/<name>.sh` (or `checks/`) | `shellcheck` + safe-mode |
| agent | [references/agent.md](references/agent.md) | `.agents/reviewers/<name>.md` | frontmatter fields (SSOT in agent.md) |
| output-style | [references/output-style.md](references/output-style.md) | `.claude/output-styles/<name>.md` | documented-field check (unknown key, `description`, `keep-coding-instructions`) |

## The four principles (enforced, not advised)

Every artifact `/author` emits must satisfy four principles. They are **deterministic `verify.sh` gates** (`@rule:mechanisms-not-prose`), so a violation fails the check — it is not left to judgment. Sourced from Anthropic docs ([skills](https://code.claude.com/docs/en/skills), [sub-agents](https://code.claude.com/docs/en/sub-agents), [hooks](https://code.claude.com/docs/en/hooks)).

| Principle | How it's enforced |
|---|---|
| Anthropic best practices | `verify.sh`: skill frontmatter per the [Agent Skills spec](https://agentskills.io/specification) (`check-skill-format.sh`), `description` ≤1,024 + third-person; hook exit-2-for-PreToolUse (emitted by placement); agent 6-field SSOT + scoped `tools` |
| Low token usage | `verify.sh`: `description` within the always-loaded cap; SKILL.md body ≤500 lines |
| High determinism | `scaffold.sh` emits correct-by-construction (right hook shape + exit code per placement); every type has a non-zero-on-violation backstop; skill branch's determinism inventory pushes data steps to `scripts/` |
| Low context usage | `verify.sh`: SKILL.md body ≤500 lines; `references/` one level deep (leaf docs) |

## parse-type

Read `<type>` from the first argument.

- No type arg → list the five valid types (one line each, from the table above) and prompt which; halt.
- Unknown type (e.g. `/author command`) → reject, list the five valid types; halt. No scaffold is written.
- Valid type, no name → continue to resolve-shape; the name is prompted at scaffold time (an empty name is the "no name" boundary → prompt, not reject).
- `rule --compress <path|slug>` → the rule branch's **compress flow** (compact an
  EXISTING rule/file instead of authoring a new one). Skips `scaffold`/evidence-
  citation; runs decompose → relocate-evidence → `efficacy-gate` → in-place
  replace. Detail in [references/rule.md](references/rule.md) § Compress flow.

Then open the matching `references/<type>.md` — it carries the branch's questions, governing-rule citations, and the scaffold→fill→verify→register checklist.

## resolve-shape

Ask the user about the few decisions that determine STRUCTURE (not content). Each branch doc quotes the governing rule inline:

- **rule** — evidence citation (halt if none, `@rule:evidence-required-for-new-rules`) + surface placement (which rule file, and whether it is path-scoped or always loaded — [references/rule.md](references/rule.md) Step 2).
- **skill** — skill-vs-agent (`@rule:tiebreaker-skill-vs-agent`) + which steps are gates (a question, a halt, a check, a dispatch) + **a determinism inventory of every step** (data → `scripts/`, judgment → body prose) per `@rule:deterministic-over-ai` + `@rule:mechanisms-not-prose`. The skill branch's Step 2.5 turns each DATA step into a script + paired test; prose-describing a deterministic step is the failure that makes skills non-deterministic.
- **hook** — which of the 9 allowed categories ([references/hook.md](references/hook.md) Step 1) + firing surface (PreToolUse/PostToolUse vs pre-commit check).
- **agent** — confirm it's an agent not a skill (`@rule:tiebreaker-skill-vs-agent`).
- **output-style** — `keep-coding-instructions` true or false (it defaults to FALSE, which strips Claude Code's software-engineering instructions), and whether the style must bind subagents (it does NOT by default — a subagent runs its own system prompt, so the format has to go into its brief).

Halt if the shape cannot be resolved — the artifact is not yet well-scoped.
Model assignment is its own step (`model-assignment`, below), not part of shape.

## model-assignment

Only for an artifact that does LLM work — any agent, or a skill or hook that
prompts a model. Skip it otherwise and say so.

Two questions, and the second is the one people get wrong:

**Which model runs it?** Default to `model: inherit` — the artifact runs on
whatever the session runs on, which is almost always right and never goes stale.
Pin a model only when the artifact genuinely needs a different one, and write
down why next to the pin, because a model id in a file outlives the reason it
was put there.

**Does it need to be independent of the author?** If the artifact REVIEWS work
that the authoring model produced, an inherit-model reviewer shares the blind spot that
produced it. Route that one through `.agents/scripts/reviewer-chain.sh`,
which uses a different model when one is installed and degrades to a
fresh-context agent — loudly — when none is. Never make an external CLI a hard
requirement: most people have one model CLI, and a skill that refuses to run is
worse than one that runs and labels its own weakness.


## scaffold

Run the deterministic emitter:

```bash
bash .agents/skills/author/scripts/scaffold.sh <type> <name> [placement]
```

It validates the type + kebab name, computes the surface path, refuses on collision (never overwrites, never normalizes), and copies the template with `{{name}}` substituted. The `rule` type writes no file — it validates the slug (collision → halt citing `@rule:rule-stable-id`) and prints insertion guidance. `placement` is hook-only (`checks` → `.githooks/checks/<name>.sh`, where commit-time checks live).

## fill

Fill the scaffold's `TODO` placeholders — the only AI-judgment step. Follow the branch doc's fill checklist (description load-bearing, fields resolved, gates declared, body contract met). For the rule branch, "fill" means emitting the `## <slug>` draft in the rule format + running the peer-sweep (`scripts/grep-rule-peers.sh`).

## efficacy-gate

**Rule and output-style branches** (skill/hook/agent skip this step — their
`verify` backstop is deterministic and sufficient). It matters most for an
output style, whose body is in the system prompt on every turn, so a dropped
clause changes every reply rather than a rare one. This gate proves a rule carries only clauses
whose removal would change behavior — the numberless replacement for any
character cap. Procedure per `references/rule.md`:

1. Decompose the drafted/compressed rule into its clauses; produce
   `dropped_clauses` — every clause in the original absent from the rewrite.
2. Send `{original, compressed, dropped_clauses}` — and NOTHING else — to a
   reviewer. Dispatch the `rule-efficacy-reviewer` agent, which reads only those
   three things. If you have an external model CLI installed, run it through
   that instead for a genuinely independent read:

   ```bash
   bash .agents/scripts/artifact-review.sh <compressed-rule-file> <brief-file>
   ```

   Exit 3 means no external reviewer is installed — use the agent and note it.
   Either way the reviewer is blind to your rationale on purpose: a reviewer
   shown the "why" rationalizes the cut.
3. The agent returns a per-clause verdict. Any `load-bearing` → **halt**:
   restore those clauses into the rewrite and re-dispatch. Convergence = zero
   load-bearing drops. Only then does the edit land.

For a brand-new rule (no compression), `dropped_clauses` is empty and the gate
passes trivially — it exists to protect compression, not to tax authoring.

Never edit rule text on a missing or malformed verdict — no clean verdict, no
edit.

## design-review

**Skill / hook / agent branches** (the rule and output-style branches' adversary
is `efficacy-gate` above — it does not run twice). `verify` proves the artifact is well-FORMED; this
gate asks whether the design is WRONG, which no format check can see. A
conforming skill that never fires, dispatches nothing, or describes a
deterministic step in prose passes every linter and fails in production.

**Two reviewers, because they see different things.**

1. **An independent adversary** — write the attack brief to a temp file (the
   angles table in `.agents/reviewers/ai-layer-reviewer.md` is the one place that
   says what to attack), then:

   ```bash
   bash .agents/scripts/artifact-review.sh <artifact-path> <brief-file>
   ```

   Exit 3 means no external model CLI is installed. Dispatch the
   `ai-layer-reviewer` agent instead and say in your summary that the reviewer
   shared the author's model, so it is a weaker read.

   Parse findings by line-anchored grep (`^\[must-fix\]`, `^\[should-fix\]`, `^\[nit\]`).

2. **`ai-layer-reviewer` agent** — dispatch with `{type, path, intent}` and
   NOTHING else. Withhold the design rationale on purpose: a reviewer shown the
   "why" rationalizes the flaw (same value-test principle as `efficacy-gate`).
   This is the repo-context read — the agent can grep for overlapping artifacts
   and read the branch docs, which a one-shot CLI call cannot.

Act on every `must-fix` / `fix-now` before the branch completes; `nit`,
`speculative`, and `out-of-scope` need no action. Zero findings is a valid
result (`@rule:adversarial-nothing-found-valid`) — do not pad. Re-run after
fixes only if a fix changed the design (not for typos); stop the loop when a
round mostly re-opens ground an earlier round already touched, and in no case
past round 4, per `@rule:adversarial-recursion-cap`. No user question.

Halt on a missing verdict — no clean verdict, no completion. A newly-authored agent is not
dispatchable until the next session (the registry loads at session start); when
that blocks the agent half, the external reviewer (`artifact-review.sh`) still runs, and a
general-purpose agent carrying the `ai-layer-reviewer` body covers the rest.

## verify

Run the type's conformance backstop; it MUST exit 0 before the branch completes:

```bash
bash .agents/skills/author/scripts/verify.sh <type> <path>
```

On failure, fix at the source (`@rule:repo-hygiene-fix-at-source`) and re-run — never override, never exclude.

## register

Meaningful for exactly one type — **hook** — because hooks are the only artifact that needs explicit wiring to fire:

- **rule** — already co-committed by the rule branch (insert in topic order + linters). No settings write.
- **skill** — none; auto-discovered from `.agents/skills/<name>/SKILL.md`.
- **hook** — wire the firing surface per [references/hook.md](references/hook.md) Step 5: a `.claude/settings.json` matcher block (PreToolUse/PostToolUse) OR an invocation line in `.githooks/pre-commit`. `verify.sh hook` WARNs (non-blocking) if still unwired.
- **agent** — none; auto-discovered from `.agents/reviewers/<name>.md`.
- **output-style** — NOT auto-selected by existing. To make it the repo default set `outputStyle` in `.claude/settings.json`; to carry it into subagents, put the format into their briefs — a style does not reach them on its own.

## Examples

### Example 1 — `/author skill weekly-digest`

`parse-type` → skill. `resolve-shape` asks skill-vs-agent (session-stateful → skill) + gates or one body (no gates → one body). `scaffold` writes `.agents/skills/weekly-digest/SKILL.md` from the template. `fill` completes the description, `metadata.peers` and the body. `verify` runs `check-skill-format.sh` → exit 0. `register` is a no-op (auto-discovered). Done.

### Example 2 — `/author rule`

`parse-type` → rule. `resolve-shape` captures the evidence citation (journal path + verbatim quote) and asks for the surface (→ `.agents/rules/feedback.md`). `scaffold rule <slug>` writes nothing — checks the slug doesn't collide (`@rule:rule-stable-id`) and prints guidance. `fill` emits the `## <slug>` draft + runs `grep-rule-peers.sh` for the peer-sweep. `verify rule <file>` runs the rule linters (`run-rule-linters.sh`). `register` is the co-commit. If peer-sweep finds the same intent already ruled, it's an AMENDMENT — edit in place, don't add a second `## <slug>`.

### Example 3 — unknown type

`/author command foo` → `parse-type` rejects: "unknown type `command` — valid types: rule, skill, hook, agent." Halt; nothing written.

## Troubleshooting

| Failure | Cause | Fix |
|---|---|---|
| `scaffold.sh` exits 2 "unknown type" | `<type>` not in the five | Use rule\|skill\|hook\|agent\|output-style. |
| `scaffold.sh` exits 1 "invalid name" | name not kebab `^[a-z][a-z0-9-]*$` | Rename to kebab-case; names are rejected, never normalized. |
| `scaffold.sh` exits 1 "exists" | artifact already at the surface path | Pick a new name — never overwrites. |
| `scaffold.sh rule` exits 1 "collides" | slug duplicates an existing `## <slug>` | Pick a more specific slug; rule IDs are immutable (`@rule:rule-stable-id`). |
| `verify.sh` non-zero | conformance backstop failed | Read the stderr, fix at source (`@rule:repo-hygiene-fix-at-source`), re-run. Never exclude. |
| `verify.sh hook` WARNs "not wired" | hook authored but no matcher/precommit invocation | Wire it per references/hook.md Step 5, or accept that it will never fire. |
