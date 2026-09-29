---
name: spec
description: Writes one spec folder, specs/NNN-name/{spec,plan,tasks,research}.md, per designed roadmap row from spec-kit's templates, fills the row in ROADMAP.md, auto-dispatches spec-audit (reviewer consensus + spirit-check), folds findings, then auto-invokes /close. Use when /project hands over a design, or when work-in-progress turns out to need a SPEC in the moment. The SPEC-writing half of the loop's Think verb — broken out so a SPEC can be produced anytime one is needed, not only inside a full /project think flow.
allowed-tools: "Bash(.agents/skills/close/scripts/*:*) Bash(.agents/skills/spec-audit/scripts/*:*) Read Edit Write Skill Task"
metadata:
  peers: ".agents/skills/project/SKILL.md .agents/skills/spec-audit/SKILL.md .agents/skills/close/references/auto-close-gate.md .agents/skills/spec/references/templates/SOURCE.md .agents/skills/project/references/templates/ROADMAP.md .agents/skills/close/scripts/roadmap.sh"
---

# /spec — write the SPEC

`/spec` is the **SPEC-writing half of the Think verb**. `/project` does the thinking — goal-alignment, context-load, explore, design, row split, categorize — then hands the design to `/spec`, which writes one spec folder per designed roadmap row, gets each machine-audited, and auto-closes. Breaking it out means a SPEC can be produced ANY time one is needed: inside a full `/project` think flow, OR ad-hoc when work-in-progress turns out to need one in the moment.

## Critical

- **The SPEC is machine-audited BEFORE it lands, never user-first.** `step-2-spec-audit` dispatches `/spec-audit` (reviewer consensus + spirit-check) on every SPEC. The user is NEVER the first reviewer. Folded findings + surfaced escalations/DRIFT ride into the close summary.
- **No user sign-off halt (option A).** The old "present SPEC, HALT for user review" gate is gone. A machine-audited SPEC is committed + pushed by the auto-close and reviewed by the user on the trunk / in the fresh `/implement` tab. The loop only halts for a genuine decision or deferral.
- **Auto-close is the tail.** `step-3-auto-close` invokes `/close` itself on clean completion per the shared SSOT (`close/references/auto-close-gate.md`). The user does not type `/close`.
- **Fresh-context boundary preserved.** `/spec`'s auto-close ENDS the session. The next `/implement` runs in a fresh tab — `/spec` does NOT roll into `/implement`.
- **Credentials in the SPEC must resolve to a named secret-store item + field.** "From the key or whatever app Y uses" is a `AGENTS.md § Standards → Read before asserting` violation — resolve the item's name + field (and its id, where the store has one) during the design (in `/project`'s explore step) and cite it explicitly. `/spec` writes what the design resolved; it does not paper over a gap.

## step-1-write-spec — write the spec folders

A spec is a FOLDER, `projects/{domain}/{date}_{slug}/specs/NNN-name/`, laid out
by spec-kit (the templates and their provenance are
[references/templates/SOURCE.md](references/templates/SOURCE.md)):

| File | From | Holds |
|---|---|---|
| `spec.md` | [templates/spec.md](references/templates/spec.md) | `**Input**` — the user's words VERBATIM; `## Clarifications` — how we read them and the grill's ledger; User Scenarios, Edge Cases, Requirements, Success Criteria — the behavior contract |
| `plan.md` | [templates/plan.md](references/templates/plan.md) | Simplest shape, Technical Context, Inputs / Outputs + Data sourcing, Patterns to follow, Failure modes, Validation Commands |
| `tasks.md` | [templates/tasks.md](references/templates/tasks.md) | the task lines `/implement` executes, test tasks included — they are the E2E walk |
| `research.md` | [templates/research.md](references/templates/research.md) | what was looked up, with sources |

`report.md` is written into the same folder later, by `/implement`.

**One folder per designed row.** `/project` splits a design into roadmap rows
with `Depends on`, and hands over every row it designed this session; each gets
its own folder now, so rows whose dependencies are met can run in parallel at
once. A row that was not designed keeps Sub-spec `—` and sends the next session
to planning.

1. **Number and name.** `NNN` is the highest existing `specs/NNN-*` plus one,
   zero-padded to three (`001` first); the name is the row's Sub-feature in
   kebab-case — spec-kit's own convention.
2. **Fill the four files from the templates.** Delete the template's
   instructions where they are answered; `N/A — brief reason` is valid for a
   section the work genuinely lacks, except `**Input**`, `## Clarifications` and
   `### Simplest shape`, which are never removed. The grill ledger goes under
   `## Clarifications` → `### Session YYYY-MM-DD`, one row per decision,
   including the ones adopted without asking. An ad-hoc spec with no grill says
   `N/A — no grill (ad-hoc spec)` there.
3. **Leave open items open.** Anything not settled is written in place as
   `[NEEDS CLARIFICATION: <the question>]`. That is not a failure of the spec:
   `.agents/skills/close/scripts/open-clarifications.sh` finds it, `/implement` refuses to
   start while one remains, and the project routes back to `/project` to settle
   it.
4. **The roadmap row.** With no `ROADMAP.md` in the project, create it from
   [`project/references/templates/ROADMAP.md`](../project/references/templates/ROADMAP.md):
   fill the epic name and intro, and REPLACE the template's three placeholder
   rows (`<name>`, `<one line>`) with the real rows — never append beneath them,
   because `roadmap.sh` refuses a table that still holds a placeholder. A new
   row's ID is `R` + (the highest numeric ID + 1), from `R1`; an existing ID is
   never reused or renumbered, since specs and commits cite it. Then record the
   folder in the row, through the one writer of that table:

   ```bash
   bash .agents/skills/close/scripts/roadmap.sh <project-folder> --set <ID> planned --sub-spec specs/NNN-name/
   bash .agents/skills/close/scripts/roadmap.sh <project-folder> --sync-next
   ```

   The second line re-derives the README's `next:` from the table, per the
   README template's derivation rule — `next:` is never hand-written.

**Location by work shape:**

| Work shape | Destination |
|---|---|
| Build work of any kind — a new app, a feature on an existing app, audits, standard/hook edits, refactors | `projects/{domain}/{date}_{slug}/specs/NNN-name/` |
| An app's living contract | `apps/{name}/SPEC.md`, seeded once code exists by mirroring an existing app's `SPEC.md`; it is not a project spec, and `/implement` never executes it |
| Genuinely one-off, too small for a spec | Skip — do the work directly and journal it |

**Legacy projects.** A project with loose `*.spec.md` files and no
`ROADMAP.md` gets its next spec in the new layout all the same — a folder plus a
`ROADMAP.md` created from the template. The two layouts may sit side by side;
every reader (`spec-state.sh`,
`detect-stage.sh`, `project-remaining-work.sh`, `next-implement-command.sh`)
reads both.

## step-2-spec-audit — dispatch /spec-audit

UNCONDITIONAL — fires on every spec `/spec` writes. Dispatch `/spec-audit <spec-folder>` synchronously, once per folder. The skill runs reviewer consensus (correctness) + the spirit-check agent (drift between the user's verbatim ask in spec.md's `**Input**`, the interpretation in `## Clarifications`, the behavior contract in User Scenarios and Requirements, and plan.md's Simplest shape) in one pass, and writes the `spec-audit:` line into the folder's plan.md Constitution Check.

**Handling findings:**

- **review round-1 consensus**: all findings accepted by the authoring agent and folded (edit the spec's files); proceed.
- **review round-2 with pushbacks**: the reviewer conceded (`[concede]`) or held (`[disagree]`); disagreements that hold are an escalation.
- **Spirit-check MATCH**: no drift; proceed.
- **Spirit-check DRIFT / AMBIGUOUS, or a held reviewer escalation**: surface to the user. This is a hard stop — `step-3-auto-close` does NOT fire while it is outstanding (per the auto-close gate's precondition (i)).

**Skip-clause** (handled inside `/spec-audit` via `check-materiality.sh`, which diffs the whole folder): trivial wording iteration of an already-audited spec skips the machine review and writes a `spec-audit: skipped — non-material` line there.

The line is a record in plan.md, never a gate on a commit; the close's journal entry quotes it.

## step-3-auto-close — auto-invoke /close

Per the shared SSOT [close/references/auto-close-gate.md](../close/references/auto-close-gate.md). On clean completion — every folder written + audited, no escalation / DRIFT / hard stop / deferral outstanding, and `land.sh --gate` is `not-fired` — dispatch `/close` via the Skill tool. `/close` commits + pushes the specs and the ROADMAP/README edits, prints each ready row's command in its own block, and folds the `## SPEC Created` summary (below) into the close output.

**HALT instead of closing** iff a hard stop (a held reviewer escalation or spirit DRIFT the user must adjudicate) or a deferral question to the user is outstanding. After the user answers, the verb resumes and then auto-closes (the gate prevents a double-fire).

The `## SPEC Created` summary `/close` surfaces (no sign-off halt):

```markdown
## SPEC Created

**Spec**: `<project-folder>/specs/NNN-name/` — row {ID}, {Sub-feature}
(one line per folder written)
**Summary**: {2-3 sentence overview}
**Scope**: {N} files to CREATE, {M} to UPDATE, {K} total tasks
**Key Patterns**: {pattern with file:line}, {pattern with file:line}

**Machine review (step-2 via /spec-audit):**
- Machine review: {round-1 consensus | round-2 consensus (N pushbacks accepted by the reviewer, M escalated) | skipped — non-material}
- Spirit-check: {MATCH | DRIFT — <details> | AMBIGUOUS — <details>}

**Open clarifications**: {none | the rows whose spec still carries a `[NEEDS CLARIFICATION]` marker — they go back to /project, not /implement}

**Next Step**: review the specs on the trunk, then in a fresh context (a new tab, or `/clear`), one session per row:
```

Each row's command goes in its OWN fenced block, so each has its own copy
button — they are separate sessions and may run in parallel:

````markdown
```
/implement <project-slug> r4
```

```
/implement <project-slug> r5
```
````

The row ID is lowercased because `/implement`'s argument must pass the slug
regex `^[a-z][a-z0-9-]{0,63}$` (`.agents/skills/implement/scripts/setup-worktree.sh`); it is
matched to the row case-insensitively. These are the same lines
`next-implement-command.sh` prints and `land.sh` renders at the close.

## Examples

### Example 1 — dispatched by /project (the golden path)

`/project <slug>` runs the think flow through design + row split + categorize, then its `think-step-4-dispatch-spec` invokes `/spec` with two designed rows, R1 and R2 (R2 depends on R1). `step-1` creates `ROADMAP.md` from the template with those two rows, writes `specs/001-foundation/` and `specs/002-sync/`, and runs `roadmap.sh --set` for each, then `--sync-next`. `step-2` dispatches `/spec-audit specs/001-foundation/` and `/spec-audit specs/002-sync/` → round-1 consensus, spirit MATCH, `spec-audit:` line written into each plan.md. `step-3` sees no decision/deferral + `not-fired` → dispatches `/close`, which commits + pushes and prints one block, `/implement <slug> r1` — R2 is not ready until R1 is done. Session ends; the user opens a fresh tab for `/implement`.

### Example 2 — ad-hoc mid-session SPEC

Working together, it turns out a small change needs a spec. `/spec "<scope hint>"` reads the design context already in session (lighter than a full think flow), adds a row to the project's `ROADMAP.md` (creating it from the template if absent), writes that row's `specs/NNN-name/` folder with `## Clarifications` reading `N/A — no grill (ad-hoc spec)`, audits it, auto-closes. No `/project` think flow required.

### Example 3 — spirit DRIFT halts auto-close

`step-2` returns spirit-check DRIFT (the interpretation in spec.md's Clarifications diverged from the ask in its `**Input**`). `/spec` surfaces the DRIFT to the user as a decision. `step-3-auto-close`'s precondition (i) is unmet → it does NOT fire. The user adjudicates; `/spec` folds the resolution; on resume the gate fires and auto-closes.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Auto-close fired while a DRIFT was unresolved | `step-2` surfaced DRIFT but `step-3` proceeded | Precondition (i) was violated — an outstanding decision means HALT; re-open the decision with the user before any close |
| `/close` ran twice | the gate was not consulted before dispatch | `step-3` MUST run `land.sh --gate` BEFORE dispatching `/close`, and proceed only on `not-fired` |
| plan.md still holds the `- spec-audit: [...]` placeholder | `step-2` was skipped, or printed the line without writing it | Run `/spec-audit <spec-folder>`; it replaces the whole list item with the line |
| Spec written as a loose `*.spec.md` | The legacy layout was followed | Move it into `specs/NNN-name/` split across the four templates, and point its row's Sub-spec at the folder with `roadmap.sh --set` |
| `roadmap.sh` exits 1 `placeholder row R1` | ROADMAP.md was created from the template and the placeholder rows were appended to, not replaced | Delete the `<name>` rows; the real rows take their place |
| `/implement` refuses with `NEEDS CLARIFICATION` | A marker was left in spec.md, plan.md or tasks.md | That is the gate working: settle the question in `/project <slug>`, then edit the marker out |
