---
name: propose-rule
description: Structured flow for proposing a new rule in .claude/rules/. Use when authoring a rule after a recurring correction, after a repeated failure, or when a missing enforcement keeps biting.
argument-hint: "[one-line description of the failure class the rule would close]"
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
  - id: cite-evidence
    kind: action
    action: Collect the originating failure — journal entry path, commit SHA, or direct user-correction quote — with an absolute date. No evidence, no rule.
  - id: pick-surface
    kind: gate
    gate:
      tool: AskUserQuestion
      on_fail: halt
  - id: draft-imperative
    kind: action
    action: Emit a `## rule-id` heading + imperative `[When X,] MUST <action>[; MUST NOT <anti>]. [YYYY-MM-DD]` body + one line on why, with an optional Except clause.
  - id: peer-sweep
    kind: gate
    gate:
      tool: shell
      on_fail: halt
  - id: wire-and-commit
    kind: action
    action: Insert the rule into the chosen file, name its backing mechanism if load-bearing, and verify nothing dangles before the commit.
---

# Propose Rule — Structured Rule Authoring

Use this skill when a correction or failure class warrants a standing rule — a constraint applied to future sessions. The ritual is deliberate: the gates enforce evidence and a peer-sweep, so the rule set does not accumulate drift or speculative entries. This skill is the operational form of @rule:write-your-own-rules.

## Critical

- **Evidence is required THIS session.** A rule without a cited failure (journal path, commit SHA, user-correction quote) does not ship. No "I think this would be useful" — speculative rules become noise per @rule:write-your-own-rules.
- **Peer-sweep is mandatory.** Read every sibling `## <slug>` in the target file and check for overlap. ≥2 overlapping siblings means redesign (subsume or narrow), not append.
- **Rule IDs are effectively immutable once shipped.** `@rule:<id>` references resolve by grep across the repo; renaming a shipped rule breaks every citation. Pick the slug carefully.
- **Back it with a mechanism if it's load-bearing.** Per @rule:mechanisms-not-prose, a rule you actually want enforced needs a hook, a check, or a named skill step. If you can't wire it, keep it short and be honest that it's advisory.

## cite-evidence

Write a one-sentence evidence citation naming the originating failure. Accept any of:

- Journal entry path: `journal/YYYY-MM-DD.md`
- Commit SHA with its subject line
- Direct user correction: quote the user's message + the session it happened in
- A repeated failure you can point at: the two or three places the same mistake landed

Reject intuition, "this seems useful", and hypothetical future failures. A rule without a cited failure does not ship — that is the line between a real rule and compliance theater.

## pick-surface

Invoke `AskUserQuestion` to decide where the rule lives:

- Always-loaded behavior the AI should follow everywhere → `.claude/rules/{topic}.md` with no `paths:` frontmatter.
- A convention that only matters when editing one kind of file → `.claude/rules/{topic}.md` with `paths:` frontmatter, so it path-scopes and doesn't load on every prompt.
- A persistent fact about a person or your domain → that domain's file under `knowledge/`.
- A multi-step named operation rather than a constraint → a skill under `.claude/skills/{name}/SKILL.md`, not a rule.

Halt if the surface can't be picked — the rule isn't well-scoped yet.

## draft-imperative

Emit the rule in the repo's standard shape:

```
## <stable-id-kebab-case>
[When X,] MUST <action>[; MUST NOT <anti>]. [YYYY-MM-DD]
One line on why — the failure or principle behind it.
Except: <optional exception clause>.
```

Pick the id carefully — it's effectively immutable because `@rule:<id>` references resolve by grep across the repo. Prefer a concrete noun over a verb (`rule-evidence-required`, not `check-rule-evidence`).

## peer-sweep

Before inserting, list the sibling `## <slug>` sections in the chosen file and read each for overlap. There is no peer-sweep script — do it inline with a grep:

```bash
grep -n '^## ' "${CLAUDE_PROJECT_DIR}/.claude/rules/<file>.md"
```

Reviewing each sibling for overlap is the judgment work. If the new rule subsumes a sibling, delete the sibling outright — remove its `## <slug>` section and update any `@rule:<slug>` references across the repo to point at the new rule. Per the lean-set discipline in @rule:write-your-own-rules, fold duplicates rather than letting near-twins accumulate.

Halt if ≥2 siblings overlap; redesign before continuing.

## wire-and-commit

1. Insert the rule in topic order within the chosen file.
2. If the rule is load-bearing, name its backing mechanism in the body — the hook, check, or skill step that makes it fire — per @rule:mechanisms-not-prose. The commit gate at `.claude/hooks/commit-gate.sh` is the model: the reasoning lives in the rule, the enforcement in the hook, and they reference each other.
3. Update any skill `enforces:` lists that should now cite the new rule.
4. Verify nothing dangles before committing: grep the repo for the new `@rule:<id>` and confirm every `@rule:` you touched still resolves to a real `## <slug>`:

```bash
grep -rn '@rule:<id>' "${CLAUDE_PROJECT_DIR}"   # confirm the citation resolves
```

5. Commit with a verb-first subject (`add rule: <short>`) and the evidence citation in the body. Fix any commit-gate failure at the source; do not exclude the file to dodge the check.

## Examples

### Example 1 — Rule after a user correction

The user pushed back twice in one session on the same thing. You run `/propose-rule`. `cite-evidence` captures the verbatim quote + the journal path. `pick-surface` resolves to an always-loaded `.claude/rules/{topic}.md`. `draft-imperative` writes a `## <slug>` heading + MUST/MUST NOT body + the date + a one-line why. `peer-sweep` greps the file's headings, finds no overlap, so the rule appends cleanly. `wire-and-commit` confirms the new `@rule:` resolves and commits with the quote in the body.

### Example 2 — Recurring failure is actually an amendment

The same mistake landed in three places over a week — but a rule already covers the general case. `/propose-rule` runs; `cite-evidence` cites the three spots. `peer-sweep` finds the existing rule that should have caught it. This is an AMENDMENT, not a new rule — so the flow exits the new-rule path and you edit the existing rule's body in place, tightening it with an `[Amended YYYY-MM-DD: ...]` note and the new evidence, rather than adding a near-twin.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| Chosen surface file doesn't exist | `pick-surface` resolved to a new path-scoped `.claude/rules/<topic>.md` | Create the file with a one-line header comment + the rule body. The first commit lands both the file and the rule. |
| `@rule:<id>` collides with a shipped rule | The drafted slug duplicates an existing `## <slug>` | Rename the new rule to a more specific slug. IDs are immutable once shipped — never edit the existing rule's slug to make room. |
| Peer-sweep finds 3+ overlapping siblings | The drafted rule competes with several existing ones — class-level redesign needed | Halt and redesign: either subsume the siblings (delete-and-replace) or narrow the new rule's scope. Never append in this state. |
| A `@rule:` reference doesn't resolve after the edit | A new `@rule:` points at a slug not yet on disk, or a deleted sibling is still cited | Fix the dangling reference at the source and re-grep. Don't ship a commit with a broken citation. |
| You can't name a mechanism for the rule | The rule isn't actually load-bearing, or you haven't decided how to enforce it | Either keep it short and label it advisory honestly, or wire it before shipping. Don't claim enforcement the rule doesn't have, per @rule:mechanisms-not-prose. |
