#!/usr/bin/env bash
# spec-review.test.sh — peer of spec-review.sh. Run: bash spec-review.test.sh
#
# The reviewer is a stub (the `custom` slot) that saves the prompt it was given
# and answers NO_FINDINGS, so this checks what reaches the reviewer and how the
# answer is read — not any model.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spec-review.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/spec-review-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp" || exit 1
export CONTEXTIUM_REVIEWERS=custom
export CAPTURE="$tmp/prompt.txt"
stub() { export CONTEXTIUM_REVIEWER_CMD="cat > \"\$CAPTURE\"; printf '%s\n' '$1'"; }
stub NO_FINDINGS

mkdir -p specs/001-a
printf '# Feature Specification: a\n\n**Input**: User description: "export faster"\n' >specs/001-a/spec.md
printf '# Implementation Plan: a\n\n### Simplest shape\n\nStream the rows.\n' >specs/001-a/plan.md
printf '# Tasks: a\n\n- [ ] T001 UPDATE src/export.ts\n' >specs/001-a/tasks.md
printf '# Report\n\nspec-status: complete\n' >specs/001-a/report.md

bash "$SUT" specs/001-a/ "export faster" >"$tmp/out" 2>/dev/null; rc=$?
t "folder review exits 0 on NO_FINDINGS" "0" "$rc"
t "clean review prints nothing on stdout" "" "$(cat "$tmp/out")"
t "files go in reading order under headers" "=== spec.md ===
=== plan.md ===
=== tasks.md ===" "$(grep '^=== ' "$CAPTURE")"
t "file bodies reach the reviewer" "yes" "$(grep -q '^- \[ \] T001 UPDATE src/export.ts$' "$CAPTURE" && echo yes)"
t "report.md is not design and is not sent" "no" "$(grep -q 'spec-status: complete' "$CAPTURE" && echo yes || echo no)"
t "the prompt describes the folder shape" "yes" "$(grep -q 'spec-kit folder' "$CAPTURE" && echo yes)"

printf '# Research: a\n' >specs/001-a/research.md
bash "$SUT" specs/001-a "export faster" >/dev/null 2>&1
t "research.md is sent last when present" "=== research.md ===" "$(grep '^=== ' "$CAPTURE" | tail -1)"

mv specs/001-a/tasks.md specs/001-a/tasks.bak
t "a folder without tasks.md is a caller error" "2" "$(bash "$SUT" specs/001-a b >/dev/null 2>&1; echo $?)"
t "the error names tasks.md" "Error: spec folder has no tasks.md: specs/001-a" "$(bash "$SUT" specs/001-a b 2>&1 >/dev/null)"
mv specs/001-a/tasks.bak specs/001-a/tasks.md
rm specs/001-a/research.md
bash "$SUT" specs/001-a "export faster" >/dev/null 2>&1
t "research.md stays optional" "0" "$?"

rm specs/001-a/plan.md
t "a folder without plan.md is a caller error" "2" "$(bash "$SUT" specs/001-a b >/dev/null 2>&1; echo $?)"
t "the error names the missing file" "Error: spec folder has no plan.md: specs/001-a" "$(bash "$SUT" specs/001-a b 2>&1 >/dev/null)"

printf '# SPEC: lean\n\n## 2 — Behavior\n\n- streams rows\n' >lean.spec.md
bash "$SUT" lean.spec.md "export faster" >/dev/null 2>&1
t "a single file is sent without headers" "0" "$(grep -c '^=== ' "$CAPTURE")"
t "a single file gets the four-section shape" "yes" "$(grep -q 'four-section shape' "$CAPTURE" && echo yes)"

t "a missing path is a caller error" "2" "$(bash "$SUT" nothing b >/dev/null 2>&1; echo $?)"

stub '[must-fix] spec.md: no empty-list case — add one — boundary-inputs'
mkdir -p specs/002-b; : >specs/002-b/spec.md; : >specs/002-b/plan.md; : >specs/002-b/tasks.md
t "findings are printed" "[must-fix] spec.md: no empty-list case — add one — boundary-inputs" "$(bash "$SUT" specs/002-b b 2>/dev/null)"

echo "spec-review.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
