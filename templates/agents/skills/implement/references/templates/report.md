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

## Review coverage

Written before the audit (phase-4.7); the review receipt binds these exact
bytes, so prose elsewhere in this report is free and an edit between the two
markers needs a new review. Paths are repo-relative; a dependency in another
repo adds `"repo": "<absolute worktree path>"`. Each claim names exactly one
of `negativeTest` (the input that makes it fail, the failure expected, and the
recorded runs that show it failing and then passing) or `inapplicable` (why
no such test exists). A dependency with `"required": false` may be left
unchecked; every other item must be checked for the receipt to approve.

<!-- review-coverage:v1 -->
```json
{
  "base": "{BASE_SHA}",
  "scope": "{the --scope passed to validate.ts}",
  "entryPoints": [{ "id": "E1", "path": "{the CLI, skill step or caller that reaches the change}" }],
  "dependencies": [
    { "id": "D1", "path": "{each AGENTS.md at or above a changed path, the root included}", "why": "{the rule the change must honor}" },
    { "id": "D2", "path": "{an unchanged caller}", "why": "{what it assumes}" }
  ],
  "claims": [
    {
      "id": "C1",
      "claim": "{the behavior the change establishes}",
      "negativeTest": {
        "trigger": "{the input that breaks it}",
        "expected": "{the failure the test reports}",
        "evidence": ["{repo-relative log of the red run, then the restored green run}"]
      }
    }
  ]
}
```
<!-- /review-coverage -->

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

**test-failure-observed:** `{the RED excerpt from Phase 4's tests; "none" only when no test file changed; "not-applicable — <why>" for a test or fixture changed without changing what any test expects}`

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
