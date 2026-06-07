---
name: implement
description: The "do" verb of the loop — execute a lean SPEC with rigorous self-validation. Use ONLY in a fresh context, after a prior session wrote the SPEC via /project.
argument-hint: "<project-name-or-slug> (or a spec-file path)"
disable-model-invocation: false
allowed-tools: "Bash(git *:*) Bash(npm *:*) Bash(node *:*) Bash(npx *:*) Read Edit Write Task Skill AskUserQuestion"
peers:
  - .claude/skills/project/SKILL.md
  - .claude/skills/close/SKILL.md
  - .claude/templates/spec-lean.md
enforces:
  - "@rule:boundary-inputs"
  - "@rule:mechanisms-not-prose"
  - "@rule:no-deferral"
  - "@rule:simplest-solution-default"
handoffs_from:
  - .claude/skills/project/SKILL.md
handoffs_to:
  - .claude/skills/close/SKILL.md
reads:
  - projects/{domain}/{date}_{slug}/{name}.spec.md
  - apps/{name}/SPEC.md
writes:
  - projects/{domain}/{date}_{slug}/{name}-report.md
steps:
  - id: load
    kind: action
    action: "Resolve and read the lean SPEC (4 sections — Ask / Behavior / Files / Done) from a project slug or a file path."
  - id: execute
    kind: action
    action: "For each file in § 3: Verify Assumptions (read the target + adjacent files, confirm the SPEC's references exist) → Implement (mirror existing patterns) → Validate Immediately (run the project's checks/tests; fix before moving on)."
  - id: validate-all
    kind: action
    action: "Write tests for new code incl. boundary cases per @rule:boundary-inputs. Then the hard end-to-end gate: actually run the thing against § 2 / § 4, not just unit tests."
  - id: mechanism-match
    kind: gate
    gate:
      tool: halt
      on_fail: halt
      condition: "Re-read § 1. Write one line: 'Agreed to X. Diff does X.' If it reads 'Diff does Y', halt and either fix the diff or AskUserQuestion before reporting."
  - id: report
    kind: action
    action: "Write a short {name}-report.md next to the SPEC: tasks, validation results, deviations. Point at /close."
---

# /implement — SPEC-Driven Executor

The "do" verb of the loop. A prior session used `/project` to think and write a lean SPEC; this
session executes it. Validation loops catch mistakes early: run checks after every change, fix issues
immediately, never accumulate broken state.

## Start in a fresh context

A session that wrote the plan is invested in it. It defends the choices it made while thinking instead
of building cleanly to what the SPEC actually says. A fresh session has no such attachment — it reads
the contract and implements it honestly.

So before you run `/implement`: open a new tab (or clear the context), then reload the SPEC from disk.
Nothing enforces this. It is a discipline you follow because it is the whole point of separating the
think and do verbs. Skip it and you lose that benefit.

## Phase — Load the SPEC

The argument is either a project name/slug or a SPEC-file path.

1. If the argument resolves to an existing file path, use it directly.
2. Otherwise treat it as a project slug — find `projects/*/{date}_<slug>/` (any date prefix).
3. Inside the matched folder, find `*.spec.md`:

| Match shape | Behavior |
|---|---|
| 0 SPEC files | HALT: "no SPEC in `<project>` — run `/project <project>` to write one first." |
| 1 SPEC file | Use it. |
| Multiple SPEC files | Pick the most-recent with no sibling `*-report.md` (not yet implemented). Still ambiguous → `AskUserQuestion` listing them. |
| No project matches the slug | HALT: "no project matches `<name>`" + list nearest slugs. |

Then read the SPEC. It follows the lean 4-section template (`.claude/templates/spec-lean.md`):

- **§ 1 — Ask** — the verbatim ask. This is what you check the finished work against; it informs
  Verify Assumptions and the mechanism-match line.
- **§ 2 — Behavior** — the behavior contract, including boundary cases (0/1/empty/max/error per
  `@rule:boundary-inputs`).
- **§ 3 — Files** — files to create/change, patterns to mirror, downstream consumers to update in the
  same pass (nothing deferred, per `@rule:no-deferral`).
- **§ 4 — Done** — the exact commands to run and the output that means success, including the
  end-to-end check.

## Phase — Execute each task

Work through § 3 file by file. For each one:

**Verify Assumptions** (this is the failure-class fix). Before writing any code: read the target file
you're about to create or modify, read its adjacent files (what it imports, what imports it), and
confirm the functions, paths, and patterns the SPEC names actually exist and match. If an assumption
is wrong, adapt before implementing and record what differed in the report's Deviations section.

**Implement.** Read the pattern file § 3 told you to mirror; understand its shape before copying.
Make the change as specified. Then check integration — do imports resolve, do callers and callees
still work, does data flow correctly across the boundary you touched?

**Validate Immediately.** After every task, run the project's own cheap checks before moving on:

    npm run check        # or: npx tsc --noEmit, plus the project's linter

If it fails, read the error, fix at the source, re-run, and only proceed when green. Per
`@rule:simplest-solution-default`, fix the actual cause — don't add the file to an exclude list.

## Phase — Validate all

**Write tests.** Every new function gets at least one test. Each boundary case you enumerated per
`@rule:boundary-inputs` (0, 1, empty, max, error) becomes a test case. Update existing tests if
behavior changed. Test across boundaries — the integration shape, not just an isolated unit.

    npm run check        # type-check
    npm test             # or: node --test

**Then the end-to-end gate (hard).** Green unit tests are the floor, not the finish line. Re-read § 4
and run every done-command as a checklist:

- [ ] Start the thing (CLI, dev server, worker — whatever § 2 / § 4 describes).
- [ ] For EACH check in § 4: run it exactly as written, confirm the output matches what § 4 says
      success looks like, and if it fails — fix, re-run, confirm.

If § 4 has no explicit E2E step, run a basic smoke test of the new behavior. Static checks and unit
tests alone are never sufficient — this gate catches what they miss. Do not report complete until it
passes.

## Phase — Mechanism-match

The E2E gate verifies the diff WORKS. This one verifies it is the RIGHT mechanism — the one the ask
describes, not a shortcut that solves the surface symptom another way.

1. Re-read § 1 (the verbatim ask).
2. Name the agreed mechanism in ONE plain sentence, using the ask's own words where possible.
3. Run `git diff --stat HEAD` (or `git log --oneline <base>..HEAD` for multi-commit work) to see what
   actually shipped.
4. Write ONE verification line:
   - PASS: `Agreed to X. Diff does X.` → proceed to the report.
   - FAIL: `Agreed to X. Diff does Y.` → halt. Surface the divergence. Either fix the diff to actually
     implement X, or `AskUserQuestion` whether the divergence is acceptable. Do not proceed with a
     known mismatch.

Drift patterns to watch for:

- Ask said "use the library" → you called the REST API directly because it was faster.
- Ask said "make it persistent" → you added a one-shot fix instead of a scheduled job.
- Ask said "a shared function" → you built a deployed service (see `@rule:simplest-solution-default`).

## Phase — Report

Write `{spec-name}-report.md` next to the SPEC (its project folder, or `apps/<name>/` for an app SPEC):

    # Implementation Report
    **SPEC**: `{spec-path}`  **Status**: COMPLETE
    ## Summary — {what was implemented}
    ## Tasks Completed — table of # / task / file / status
    ## Validation Results — table of check / result (type-check, lint, tests, E2E § 4, mechanism-match)
    ## Deviations from SPEC — list with rationale, or "None — implementation matched the SPEC."

The SPEC stays in place; the report sits beside it. `/close` commits both. Then print a closing
summary and point the user at `/close` to journal + commit + push.

## Examples

**Fresh-context invocation (golden path).** The user clears context and types `/implement <slug>`.
Load resolves `projects/<domain>/<date>_<slug>/*.spec.md` and reads its four sections. Execute runs
each file with Verify-Assumptions → Implement → Validate-Immediately. Validate-all writes tests, runs
the suite, then exercises the § 4 done-commands against the running surface. Mechanism-match writes
"Agreed to X. Diff does X." Report writes `<slug>-report.md`. Done.

**No SPEC yet.** `/implement <slug>` against a folder with no `*.spec.md` hits the "0 SPEC files" row
and HALTs: "no SPEC in `<project>` — run `/project <project>` to write one first."

**Multi-SPEC ambiguity.** The folder has 3 `*.spec.md` files and no `*-report.md` companions. Load
tries to pick the most-recent without a sibling report; two qualify. `AskUserQuestion` fires with the
SPEC paths; the user selects; Load continues with that file.

## Troubleshooting

| Failure | Symptom | Fix |
|---|---|---|
| SPEC not found | Load HALT: "no SPEC in `<project>`" | Run `/project <project>` first to write a SPEC. |
| Multi-SPEC ambiguity | Load finds >1 `*.spec.md` with no unambiguous pick | `AskUserQuestion` fires with the SPEC paths; pick the one for this session. |
| Type/lint fails | check / tsc --noEmit non-zero | Read the error, fix at the source, re-run. Don't add to an exclude list. |
| Tests fail | test suite red | Fix the implementation or the test; re-run until green. |
| E2E fails | A § 4 step against the running thing doesn't match expected output | Diagnose; if a shared pattern is wrong, fix every instance now per `@rule:no-deferral`; if the approach is wrong, revise the SPEC and re-run. Never declare complete with E2E red. |
| SPEC reference missing | A function or path the SPEC names doesn't exist | Document in Deviations; if the SPEC was based on stale state, revise it and re-run. |
| Mechanism mismatch | "Agreed to X. Diff does Y." | Fix the diff to actually implement X, or `AskUserQuestion` whether the divergence is acceptable. Never proceed with a known mismatch. |
