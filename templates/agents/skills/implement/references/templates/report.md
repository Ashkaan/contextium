---
spec: {NNN-name}
spec-status: complete
---

# Implementation Report

**SPEC**: `specs/{NNN-name}/` (spec.md, plan.md, tasks.md)
**Branch**: `{branch-name}`
**Status**: COMPLETE

## Summary
{Brief description of what was implemented}

## Tasks Completed

| # | Task | File | Status |
|---|---|---|---|
| 1 | {description} | `apps/<slug>/foo.ts` | ✅ |
| 2 | {description} | `apps/<slug>/worker.ts` | ✅ |

## Validation Results

| Layer | Result |
|---|---|
| 1. Syntactic | ✅ |
| 2. Tests | ✅ ({N} passed) |
| 3. Quality | ✅ ({N} checks) |
| 4. implement-audit | ✅ ({N} findings, all addressed; {rounds} round(s)) |
| 5. E2E | ✅ ({N} test tasks from tasks.md; re-run {N} time(s) on NEED_E2E=1) |
| 6. Mechanism-match | ✅ ({agreed-mechanism-one-liner}) |
| 7. QA | ✅ ({N} targets, impeccable ran) — or `skipped-not-web` |

**implement-audit:** `{the line phase-4.7 printed — copy verbatim; this is its record}`

**class-sweep:** `{<regex> -- <pathspec>, verified by find-peers.ts --verify-sweep exiting 0 — or "none" when the change was not a class fix}`

**test-failure-observed:** `{the RED excerpt from Phase 4's tests, or "none"}`

## Files Changed

| File | Action | Lines |
|---|---|---|
| `apps/<slug>/foo.ts` | CREATE | +{N} |
| `apps/<slug>/worker.ts` | UPDATE | +{N}/-{M} |

## Deviations from Plan

{List any deviations with rationale, or "None — implementation matched the spec."}

## Tests Written

| Test File | Test Cases |
|---|---|
| `apps/<slug>/tests/foo.test.ts` | {boundary-cases-covered list} |
