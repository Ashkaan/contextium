---
spec: {NNN-name}
spec-status: complete
---

<!--
  /implement writes this file as specs/{NNN-name}/report.md, inside the spec
  folder it implemented. spec-status is `complete` only when nothing in the
  spec is still owed; anything less (a slice done, code done but not shipped,
  tasks half-run) is `partial`. spec-state.sh reads this line, and /close flips
  the roadmap row to `done` only on `complete`. Delete this comment.
-->

# Implementation Report

**Spec**: `specs/{NNN-name}/` (spec.md, plan.md, tasks.md) — roadmap row {ID}
**Branch**: `{branch-name}`
**Status**: {COMPLETE | PARTIAL — what is still owed}

## Summary

{What was implemented, in two or three sentences.}

## Tasks Completed

| Task | What | File | Status |
|---|---|---|---|
| T001 | {description} | `{path}` | done |

## Validation Results

| Check | Result |
|---|---|
| Validation Commands (plan.md) | {each command: pass / fail} |
| Tests | {N passed, M new} |
| E2E walk (tasks.md test tasks) | {N steps, all matched the spec} |
| Mechanism-match | {Agreed to X. Diff does X.} |
| implement-audit | {rounds, findings, verdict} |

**implement-audit:** `{the line /implement-audit printed, verbatim}`

**class-sweep:** `{the peer-sweep.sh command and its MATCHES line, or "none" when the change was not a shared pattern}`

**test-failure-observed:** `{the red excerpt a new test printed before it passed, or "none"}`

## Files Changed

| File | Action | Lines |
|---|---|---|
| `{path}` | CREATE / UPDATE / DELETE | +{N}/-{M} |

## Deviations from Plan

{Each deviation and why, or "None — implementation matched the spec."}

## Tests Written

| Test file | Cases |
|---|---|
| `{path}` | {the boundary cases covered: 0 / 1 / empty / max / error} |
