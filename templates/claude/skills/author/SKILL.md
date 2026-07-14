---
name: author
description: Scaffold a conforming AI-layer artifact — a rule, a skill, a hook, or an agent — so a new piece of the layer matches the existing shape instead of drifting. Absorbs the older /propose-rule (now the rule branch). Use when adding any new .claude/ artifact.
argument-hint: "[rule|skill|hook|agent] [name]"
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - Edit
  - Write
  - Grep
  - Glob
  - AskUserQuestion
peers:
  - .claude/rules/write-your-own-rules.md
  - .claude/rules/mechanisms-not-prose.md
enforces:
  - "@rule:write-your-own-rules"
  - "@rule:mechanisms-not-prose"
steps:
  - id: resolve-shape
    kind: gate
    gate:
      tool: AskUserQuestion
      on_fail: halt
  - id: scaffold
    kind: action
    action: Write the conforming skeleton for the chosen type — the structure is mechanical, so it should look like the siblings, not be invented fresh.
  - id: fill
    kind: action
    action: Fill the content placeholders. This is the only judgment step; the structure is already decided.
  - id: verify
    kind: gate
    gate:
      tool: shell
      on_fail: halt
---

# Author — Scaffold a Conforming AI-Layer Artifact

One skill, four branches. `/author <type> [name]` writes a new piece of the
`.claude/` layer in the shape the existing pieces already use, so it conforms
instead of drifting. The structure is mechanical and should be copied from a
sibling; the only real judgment is the content you fill in. `<type>` is one of
`rule`, `skill`, `hook`, `agent`.

This is the operational form of @rule:write-your-own-rules — extended past rules
to every artifact the layer is made of. The rule branch is the old
`/propose-rule` flow, kept intact.

| Type | Lands at | Conforms to |
|---|---|---|
| rule | inline `## <slug>` in a `.claude/rules/{topic}.md` file | the imperative MUST/MUST NOT shape + a backing mechanism |
| skill | `.claude/skills/<name>/SKILL.md` | frontmatter (name, description, disable-model-invocation, enforces) + a step graph if it has gates |
| hook | `.claude/hooks/<name>.sh` | shebang + `set -euo pipefail` + an actionable error + wiring into `settings.json` |
| agent | `.claude/agents/<name>.md` | frontmatter (name, description, model, tools) + input/output contract body |

## Critical

- **Copy the sibling, don't invent.** For any type, open an existing artifact of that type first and mirror its shape. A scaffold that doesn't match its siblings is the drift this skill exists to prevent.
- **Names are kebab-case and never silently renamed.** If a name isn't `^[a-z][a-z0-9-]*$`, reject it and ask — don't normalize it behind the user's back. If the target path already exists, stop and ask; never overwrite.
- **Verify before you call it done.** Each type has a cheap conformance check (below). Run it. A scaffold that doesn't pass its own check is not finished.
- **Don't author for a failure that hasn't happened.** Per @rule:mechanisms-not-prose, a new hook or rule needs a real failure behind it, not a hunch.

## resolve-shape

`AskUserQuestion` for the few decisions that fix the structure (not the content). What to ask depends on the type:

- **rule** — what's the evidence (the failure this rule closes)? where does it live (always-loaded vs path-scoped vs a knowledge file)? No evidence → halt; a rule without a cited failure doesn't ship.
- **skill** — is this actually a skill (needs session history, user-facing) or an agent (benefits from fresh isolated context)? does it have gates (then it needs a step graph) or is it a single-body skill?
- **hook** — what event fires it (a tool call, or commit time)? what does it check? Don't build it for a failure mode you haven't actually hit.
- **agent** — confirm it's an agent, not a skill: agents are dispatched for fresh-context review/investigation and are NOT slash-invocable.

Halt if the shape can't be pinned down — the artifact isn't well-scoped yet.

## scaffold

Write the skeleton for the chosen type by mirroring a sibling. The structure is mechanical:

- **rule** — this branch writes no new file; a rule is an inline `## <slug>` section appended to a chosen `.claude/rules/{topic}.md`. Confirm the slug doesn't collide with an existing `## <slug>` (IDs are effectively immutable — a rename breaks every `@rule:` citation), then draft:
  ```
  ## <stable-id-kebab-case>
  [When X,] MUST <action>[; MUST NOT <anti>]. [YYYY-MM-DD]
  One line on why — the failure or principle behind it.
  Except: <optional exception clause>.
  ```
- **skill** — create `.claude/skills/<name>/SKILL.md` with frontmatter (`name`, `description` stating WHAT + WHEN, `disable-model-invocation`, `enforces:` — may be `[]`) and, if it has gates, a `steps:` graph where each step has an `id`, a `kind` (action|gate), and gates name a `tool` + `on_fail`. Mirror an existing skill.
- **hook** — create `.claude/hooks/<name>.sh` starting `#!/usr/bin/env bash` + `set -euo pipefail`, with every blocking path emitting an error that names the file and the fix. Mirror `commit-gate.sh`.
- **agent** — create `.claude/agents/<name>.md` with frontmatter (`name`, `description`, `model`, `tools` — the agent tool-allowlist field is `tools`, NOT `allowed-tools`, which agents silently ignore) and a body that states the input contract, the MUST/MUST NOT guardrails, and the exact output shape. Mirror an existing agent under `.claude/agents/`.

## fill

Fill the placeholders — the one judgment step. Keep each type's contract in mind: a `description` the model can route on, an `enforces:` list whose every `@rule:` resolves, an actionable hook error, an agent output contract the caller can consume. For the rule branch, "fill" also means the peer-sweep: list the sibling headings in the target file and read each for overlap.

```bash
grep -n '^## ' "${CLAUDE_PROJECT_DIR}/.claude/rules/<file>.md"
```

If the new rule subsumes a sibling, fold them (delete-and-replace, update citations) rather than letting near-twins accumulate, per @rule:write-your-own-rules. Halt if two or more siblings overlap — redesign before continuing.

## verify

Run the cheap conformance check for the type before calling it done:

- **rule** — grep the repo for the new `@rule:<id>` and confirm every `@rule:` you touched still resolves to a real `## <slug>`; the commit gate catches dangling references at commit time.
- **skill** — frontmatter has the required fields, the step graph (if present) is well-formed, and every `enforces:` `@rule:` resolves.
- **hook** — `shellcheck` is clean, `set -euo pipefail` is present, the hook is wired into `.claude/settings.json` (an unwired hook never fires), and a PreToolUse blocker exits **2** to block (exit 1 is non-blocking — the canonical hook bug).
- **agent** — the four frontmatter fields are present and the body has an input + output contract.

If the check fails, fix it at the source and re-run — don't exclude the file to dodge the check.

## register

Only one type needs wiring: a **hook** fires from nothing until it's referenced in `.claude/settings.json` (or a commit-time body). Skills and agents are auto-discovered by their file presence; a rule is live the moment it's in a `.claude/rules/` file. So after `verify`, the hook branch adds the `settings.json` matcher; the other three are done.

## Examples

### Example 1 — `/author rule` after a recurring correction

You corrected the agent on the same thing twice. `resolve-shape` captures the verbatim quote + the journal path as evidence and asks where the rule lives (always-loaded). `scaffold` drafts the `## <slug>` + MUST/MUST NOT body + date + one-line why. `fill` greps the file's headings, finds no overlap, appends cleanly. `verify` confirms the new `@rule:` resolves; the commit gate backs it up.

### Example 2 — `/author skill weekly-digest`

`resolve-shape` confirms it's a skill (user-facing, session-stateful) with no gates. `scaffold` writes `.claude/skills/weekly-digest/SKILL.md` mirroring an existing single-body skill. `fill` completes the description + `enforces: []` + body. `verify` checks the frontmatter. `register` is a no-op — skills are auto-discovered.

### Example 3 — recurring failure is actually an amendment

The same mistake landed in three places, but a rule already covers the general case. `/author rule` runs; the peer-sweep in `fill` finds the existing rule. This is an AMENDMENT, not a new rule — edit the existing rule's body in place with an `[Amended YYYY-MM-DD: ...]` note + the new evidence, rather than adding a near-twin.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| Name rejected | not kebab-case `^[a-z][a-z0-9-]*$` | Rename to kebab-case; the skill rejects rather than silently normalizing. |
| Target path already exists | a skill dir / hook / agent file of that name is present | Pick a new name — never overwrite an existing artifact. |
| `@rule:<id>` collides with a shipped rule | the drafted slug duplicates an existing `## <slug>` | Pick a more specific slug; rule IDs are immutable once shipped. |
| Hook authored but never fires | not wired into `.claude/settings.json` | Add the matcher in `register`; an unwired hook is invisible. |
| Peer-sweep finds 3+ overlapping siblings | the drafted rule competes with several existing ones | Halt and redesign — subsume them or narrow the scope. Never append in this state. |
| You can't name a mechanism for a rule | the rule isn't load-bearing, or you haven't decided how to enforce it | Keep it short and label it advisory honestly, or wire it before shipping, per @rule:mechanisms-not-prose. |
