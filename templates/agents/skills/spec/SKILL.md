---
name: spec
description: Writes one spec folder, specs/NNN-name/ with spec.md, plan.md, tasks.md and research.md from spec-kit's templates, for each designed roadmap row; sets each row in ROADMAP.md and re-derives the README's next:, runs /spec-audit on every folder, then auto-invokes /close. Use when /project hands over a design, or when work in progress turns out to need a spec ("/spec <scope hint>").
allowed-tools: "Bash(bash .agents/skills/close/scripts/*:*) Bash(bash .agents/skills/spec-audit/scripts/*:*) Read Edit Write Task Skill AskUserQuestion"
metadata:
  peers: ".agents/skills/project/SKILL.md .agents/skills/spec-audit/SKILL.md .agents/skills/close/references/auto-close-gate.md .agents/skills/spec/references/templates/SOURCE.md .agents/skills/project/references/templates/ROADMAP.md .agents/skills/close/scripts/roadmap.sh"
---

# /spec — write the specs

`/project` does the thinking and hands over a design; `/spec` writes it down,
one spec folder per roadmap row, gets each audited, and auto-closes. Split out
so a spec can be written whenever work needs one, not only at the end of a full
think flow.

## Critical

- **Every spec is audited before it lands.** `/spec-audit` runs on every folder
  written; the user is never the first reviewer.
- **No sign-off halt.** An audited spec is committed by the auto-close and read
  by the user on the branch, or in the fresh `/implement` session. `/spec` halts
  only for a decision the user must make.
- **Fresh context.** The auto-close ends the session; `/implement` runs in a new
  one. `/spec` never rolls into `/implement`.
- **No guesses in a spec.** A credential, path or API the design left
  unresolved is resolved now, by reading, or written as a
  `[NEEDS CLARIFICATION: …]` marker — never "whatever X uses".

## step-1-write-specs

A spec is a folder, `projects/<domain>/<date>_<slug>/specs/NNN-name/`, from
spec-kit's templates (provenance and the byte check:
[references/templates/SOURCE.md](references/templates/SOURCE.md)):

| File | Template | Holds |
|---|---|---|
| `spec.md` | [spec.md](references/templates/spec.md) | `**Input**` — the user's words verbatim; `## Clarifications` — how we read them, and the grill's ledger; user stories, Edge Cases, Requirements, Success Criteria, Acceptance — the behavior contract |
| `plan.md` | [plan.md](references/templates/plan.md) | Simplest shape, Technical Context, Inputs / Outputs and Data sourcing, Constitution Check (the audit line lands here), Patterns to follow, Failure modes, Validation Commands |
| `tasks.md` | [tasks.md](references/templates/tasks.md) | the task lines `/implement` executes, tests included |
| `research.md` | [research.md](references/templates/research.md) | what was looked up, with sources; decisions that outlive the spec link to `decisions/` |

`report.md` is added later, by `/implement`.

For each row handed over:

1. **Number and name.** `NNN` is the highest existing `specs/NNN-*` plus one,
   zero-padded (`001` first); the name is the row's Sub-feature in kebab-case.
2. **Fill the four files.** Replace the template's instructions and examples as
   you answer them — including the example FR lines, whose
   `[NEEDS CLARIFICATION]` text would otherwise read as open questions.
   `N/A — <reason>` is fine for a section the work genuinely lacks, except
   `**Input**`, `## Clarifications` and `### Simplest shape`, which are never
   removed. Keep the `- spec-audit: […]` placeholder in plan.md; step 2
   replaces it. The grill ledger goes under `## Clarifications` →
   `### Session YYYY-MM-DD`, one row per decision; an ad-hoc spec with no grill
   says `N/A — no grill (ad-hoc spec)`.
3. **Leave open items open.** Anything not settled is written in place as
   `[NEEDS CLARIFICATION: <the question>]`.
   `.agents/skills/close/scripts/open-clarifications.sh <spec-folder>` lists
   them, `/implement` refuses to start while one remains, and `/project` routes
   the row back to planning.
4. **Set the row.** With no `ROADMAP.md` yet, create it from
   [the roadmap template](../project/references/templates/ROADMAP.md): fill the
   epic name and intro and REPLACE the three placeholder rows with the real
   ones (a new row's ID is `R` + highest + 1; IDs are never reused). Then, for
   each folder, through the table's one writer:

   ```bash
   bash .agents/skills/close/scripts/roadmap.sh <project-folder> --set <ID> planned --sub-spec specs/NNN-name/
   ```

   and once, after the last:

   ```bash
   bash .agents/skills/close/scripts/roadmap.sh <project-folder> --sync-next
   ```

   `next:` is derived by the README template's rule, never hand-written.

**Where a spec goes:**

| Work | Destination |
|---|---|
| Any build work — a feature, a fix, a refactor, an audit, a rule change | `projects/<domain>/<date>_<slug>/specs/NNN-name/` |
| An app's living contract | `apps/<name>/SPEC.md`, kept beside the code; not a project spec, and `/implement` does not execute it |
| One-off work too small for a spec | none — do it and journal it |

## step-2-spec-audit

For every folder written, invoke `/spec-audit <spec-folder>` and wait for it.
It decides materiality itself, runs the independent reviewer and the
spirit-check, folds accepted findings into the files, and writes its
`spec-audit:` line into the folder's plan.md.

- Findings accepted and folded, spirit MATCH → next folder.
- Spirit DRIFT or AMBIGUOUS, or a reviewer finding still disputed after round 2
  → a decision for the user (`@rule:depth-policy`). Surface it and HALT.
- A reviewer that could not run is a failed audit, not a clean one → report it
  and HALT.

## step-3-auto-close

Follow [`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md):
on clean completion — every folder written and audited, nothing held — invoke
`/close`. It commits the specs with the roadmap and README edits and prints
each ready row's `/implement` command. Before invoking it, print:

```markdown
## Specs written

**Specs**: `<project-folder>/specs/NNN-name/` — row R#, <Sub-feature> (one line per folder)
**Summary**: <2-3 sentences>
**Scope**: <N> files to create, <M> to update, <K> tasks
**Audit**: <the spec-audit: line from each plan.md>
**Open clarifications**: none | <rows whose spec still holds a marker — they go back to /project>
```

The next step is a fresh context (a new tab, or `/clear`), one session per
ready row: `/implement <project-slug>` for the first, or
`/implement <project-slug> <row-id>` for a specific one (e.g. `r2`, matched
case-insensitively). Rows whose dependencies are met can run in parallel.

## Examples

**From /project.** Two designed rows, R1 and R2 (R2 depends on R1). No
`ROADMAP.md` yet, so it is created with those two rows; `specs/001-retry-queue/`
and `specs/002-exhaustion-alert/` are written, each set with `--set`, then
`--sync-next` writes `next: "R1: retry queue"`. Both audits come back round-1,
spirit MATCH. `/close` commits and prints one command — R2 is not ready until
R1 is done.

**Ad hoc.** Mid-session a small change turns out to need a spec. `/spec "cap
export batch size"` adds a row to the project's roadmap, writes its folder with
`## Clarifications` reading `N/A — no grill (ad-hoc spec)`, audits it, closes.

**Drift.** The spirit-check says the user asked for a script and the spec
describes a scheduled service. If the fix is obvious, rewrite down to a script
and re-audit; if it is a real choice, ask the user and HALT — the auto-close
fires after the answer.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `roadmap.sh` exits 1, `placeholder row R1` | rows appended under the template's placeholders | delete the `<name>` rows |
| plan.md still holds `- spec-audit: […]` | step 2 skipped, or its line printed but not written | run `/spec-audit <spec-folder>` |
| `/implement` refuses with `NEEDS CLARIFICATION` | a marker was left in spec.md, plan.md or tasks.md | the gate working — settle it in `/project <slug>`, edit the marker out |
| `next:` is stale | `--sync-next` not run after the last `--set` | run it |
| `/close` ran twice | the auto-close gate's double-fire check was skipped | follow the gate as written before invoking `/close` |
