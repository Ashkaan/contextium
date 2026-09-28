---
name: implement
description: The "do" verb of the loop — build one roadmap row's spec folder (spec.md, plan.md, tasks.md) with validation after every task, an end-to-end walk, a mechanism check, and one independent code review, then write report.md and close. Use in a fresh session after /project and /spec wrote the spec, as `/implement <project-slug>` or `/implement <project-slug> <row-id>`.
allowed-tools: "Bash Read Edit Write Task Skill AskUserQuestion"
metadata:
  peers: ".agents/skills/project/scripts/find-project.sh .agents/skills/project/scripts/detect-stage.sh .agents/skills/close/scripts/roadmap.sh .agents/skills/close/scripts/open-clarifications.sh .agents/skills/implement/scripts/peer-sweep.sh .agents/skills/implement/references/templates/report.md .agents/skills/implement-audit/SKILL.md .agents/skills/close/SKILL.md .agents/skills/close/references/auto-close-gate.md"
---

# /implement — build a spec

A prior session thought and wrote the spec; this one builds it. Validate after
every change, fix before moving on, and never accumulate broken state.

**Start in a fresh session.** A session that wrote the plan defends its own
choices instead of building to what the spec says. Open a new tab or clear the
context, then run `/implement`. Nothing enforces this; it is the reason the
think and do verbs are separate.

## 1 — Resolve the spec

Which spec runs is a script result, never a glob of the folder:

```bash
bash .agents/skills/project/scripts/find-project.sh <slug>                  # PATH:projects/<domain>/<date>_<slug>
bash .agents/skills/project/scripts/detect-stage.sh <project-folder>        # stage:, active-spec:, next-row:
bash .agents/skills/close/scripts/roadmap.sh <project-folder>               # ID, Status, ready, Sub-spec, Sub-feature
```

| Invocation | Spec to run |
|---|---|
| `/implement <slug>` | `active-spec:` from `detect-stage.sh`; `next-row:` names its row — the first ready row (in-progress before planned) whose spec is still owed work and has no open clarification |
| `/implement <slug> <id>` | Row `<id>`, matched case-insensitively, only if `roadmap.sh <project-folder> --check <id>` exits 0 (it prints the Sub-spec). Exit 1 → HALT with its lines: each unmet dependency by name, a `blocked:` / `done` status, no spec yet, or a spec already complete |
| stage is `ready-to-close` | HALT: "`<slug>` row `<next-row>` has a complete report but is not `done` — run `/close`" |
| any other stage but `ready-to-implement` | HALT: "`<slug>` is at stage `<stage>` — run `/project <slug>`" |
| `roadmap-error:` | HALT with the message; the table needs fixing first |
| `NOT_FOUND` | HALT: "no project matches `<slug>`" plus the nearest slugs it printed |

A project without `ROADMAP.md` (loose `*.spec.md` files, the older layout)
resolves the same way: `active-spec:` names the loose spec still owed work.

**Refuse on an open clarification.** A marker is a decision nobody made, and
building past it is the misalignment `/project`'s grill exists to prevent:

```bash
bash .agents/skills/close/scripts/open-clarifications.sh <project-folder>/specs/NNN-name   # exit 1 → HALT
```

Exit 1 prints each `NEEDS CLARIFICATION` as `file:line: text`. HALT with those
lines and `run /project <slug>`. Exit 2 means a spec file could not be read —
HALT with that, too. Once it passes, and only when the project has a
`ROADMAP.md`, mark the row:

```bash
bash .agents/skills/close/scripts/roadmap.sh <project-folder> --set <ID> in-progress
```

A loose-spec project has no row to mark; skip this.

`in-progress` is the only Status this skill writes. `/close` sets `done` from
the report.

## 2 — Read the spec by section name

A spec is a folder, `specs/NNN-name/`. Read `spec.md`, `plan.md` and `tasks.md`
whole, then use these sections by name:

| Used below as | In the spec folder | In a loose `*.spec.md` |
|---|---|---|
| the verbatim ask | spec.md `**Input**` | § 1 Ask |
| the settled decisions | spec.md `## Clarifications` | § 1 Ask |
| the behavior contract | spec.md `## User Scenarios & Testing`, `## Requirements` | § 2 Behavior |
| the boundary cases | spec.md `### Edge Cases` | § 2 Behavior |
| the acceptance checks | spec.md `### Acceptance` | § 4 Done |
| the simplest shape | plan.md `### Simplest shape` | § 3 Files |
| the inputs and data sourcing | plan.md `## Technical Context`, `### Data sourcing` | § 2 Behavior |
| the patterns to mirror | plan.md `### Patterns to follow` | § 3 Files |
| the validation commands | plan.md `## Validation Commands` | § 4 Done |
| the tasks | tasks.md task lines (`- [ ] T001 …`) | § 3 Files |
| the E2E walk | tasks.md's test tasks, then spec.md `### Acceptance` | § 4 Done |

`research.md` holds the reasoning behind the plan's choices; read it when a
task's intent is unclear. An app's own `SPEC.md` is context, never the build
spec.

## 3 — Execute tasks.md

Work through tasks.md in order; tasks marked `[P]` may run in any order within
their phase. For each task:

**Verify assumptions first.** Read the file you are about to change and its
neighbours (what it imports, what imports it). Confirm the functions, paths and
patterns the plan names exist and match. If one is wrong, adapt, and record the
difference for the report's Deviations.

**Sweep for peers before editing a shared pattern** — a helper everything
calls, a config key read in several places, a convention repeated across
sibling files:

```bash
bash .agents/skills/implement/scripts/peer-sweep.sh --pattern '<extended-regex>' --scope '<pathspec>'
```

Sweep the mechanism, not the file; siblings live in directories you did not
touch. Read the whole output and fix every match this session
(`@rule:class-fix-is-atomic`). `MATCHES: 0` is valid evidence. Record the
command and its `MATCHES:` line for the report's `class-sweep:` line.

**Implement**, mirroring the file plan.md `### Patterns to follow` names, in the shape `### Simplest shape` settled. Then check the
integration: imports resolve, callers and callees still work, data crosses the
boundary you touched correctly.

**Validate immediately.** Run the plan's cheap checks (type-check, lint) after
the task. Red → read the error, fix the cause, re-run. Never add a file to an
exclude list to go green. Tick the task (`- [x]`) in tasks.md when it passes.

## 4 — Validate everything

**Tests.** Every new function gets a test; each boundary case (0, 1, empty,
max, error — `@rule:boundary-inputs`) becomes a case. See each new test fail
first — break the code or the fixture on purpose, confirm the message names
what the test claims, restore — and keep that red excerpt for the report's
`test-failure-observed:` line. A test that never failed proves nothing
(`@rule:red-before-green`).

**The validation commands.** Run every command in plan.md
`## Validation Commands`, exactly as written. All must pass.

**The E2E walk (hard gate).** Green unit tests are the floor. Run the thing —
the CLI, the server, the job — and execute every test task in tasks.md, then
each spec.md `### Acceptance` check, as a checklist: run it as written, compare
to what the spec says success looks like, fix and re-run on a mismatch. No test tasks → a smoke test of the new behavior.
Do not report complete with a step red, and re-walk it whenever a later fix
changes the code.

## 5 — Mechanism-match (hard gate)

The E2E walk proves the diff works; this proves it is the mechanism that was
agreed, not a shortcut that solves the symptom another way.

1. Re-read the verbatim ask and `## Clarifications`.
2. Name the agreed mechanism in one sentence, in the ask's own words.
3. `git diff --stat <base>` (plus untracked files) to see what actually changed.
4. Write one line:
   - `Agreed to X. Diff does X.` → continue.
   - `Agreed to X. Diff does Y.` → HALT. Fix the diff, or ask the user whether
     the divergence is acceptable (a numbered list, recommendation first; in
     Claude Code, `AskUserQuestion`). Never continue past a known mismatch.

Typical drift: the ask said "use the library" and the diff calls the API
directly; the ask said "a shared function" and the diff adds a service.

## 6 — Code review

Dispatch `/implement-audit --from-implement specs/NNN-name` on this session's
diff — the argument tells it `/implement` owns the close, since `report.md` does
not exist yet. It runs the project's
automated checks, puts the judgment half on a reviewer that did not write the
code, and fixes every ready finding in its own loop. Continue only on a clean
pass. A reviewer that could not run is a failed review, not a clean one: HALT
and report it. Its `implement-audit:` line goes into the report.

## 7 — Report

Write `specs/NNN-name/report.md` from
[references/templates/report.md](references/templates/report.md) (for a loose
spec: `<name>-report.md` beside it, with `spec: <name>`). `spec-status:` is
`complete` only when nothing in the spec is still owed; anything less is
`partial`. `spec-state.sh` reads that line, and it is how `/close` knows whether
to flip the row to `done`. Fill in the three record lines verbatim:
`implement-audit:`, `class-sweep:`, `test-failure-observed:`. Leave ROADMAP.md
alone; the row is `/close`'s to finish.

## 8 — Auto-close

Print a short summary — the spec and row, what changed, the validation results,
any deviation — then hand the session to `/close` per
[../close/references/auto-close-gate.md](../close/references/auto-close-gate.md),
with caller `implement`. A mechanism-match FAIL, a failed review or an open
question halts instead.

## Examples

**Golden path.** In a fresh session: `/implement checkout-flow`.
`detect-stage.sh` says `ready-to-implement`, `next-row: R2`,
`active-spec: projects/web/2026-01-10_checkout-flow/specs/002-retry/spec.md`.
No open clarifications; R2 goes `in-progress`. Tasks T001–T006 run with a check
after each; the tests go red then green; the validation commands pass; the E2E
walk retries a declined test card once. "Agreed to retry once with the
fallback processor. Diff does that." `/implement-audit` converges in two rounds.
`report.md` says `spec-status: complete`; `/close` flips R2 to `done` and prints
`/implement checkout-flow r3` in its own block.

**Parallel rows.** A close printed `/implement sync-engine r4` and
`/implement sync-engine r5`; both rows' dependencies are `done`. Each runs in
its own session and each close flips its own row.

**Unsettled spec.** `/implement sync-engine r3` finds
`spec.md:41: - FR-004 [NEEDS CLARIFICATION: keep or drop deleted rows?]`.
HALT with that line and `run /project sync-engine`.

## Troubleshooting

| Failure | Fix |
|---|---|
| Stage is `needs-planning` | The row has no spec, or its spec has open clarifications. Run `/project <slug>`. |
| The bare slug picked the wrong row | Name it: `/implement <slug> <id>`. |
| A check or test fails | Fix the cause and re-run; never exclude the file. |
| A path or function the plan names does not exist | Record it under Deviations; if the plan was written against stale code, stop and revise the spec with `/project`. |
| E2E step fails | Diagnose; if a shared pattern is wrong, fix every instance now; if the approach is wrong, revise the spec. Never report complete with E2E red. |
| Mechanism mismatch | Fix the diff, or ask the user. Never proceed past it. |
