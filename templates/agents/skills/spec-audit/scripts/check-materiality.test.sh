#!/usr/bin/env bash
# check-materiality.test.sh — peer of check-materiality.sh. Run: bash check-materiality.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-materiality.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/check-materiality-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
cd "$tmp" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false
# In-place edit that works with GNU and BSD sed alike.
ed_() { sed -i.bak "$1" "$2" && rm -f "$2.bak"; }

mkdir -p specs/001-a
cat >specs/001-a/spec.md <<'EOF'
# Feature Specification: a

**Input**: User description: "make it go"

## Clarifications

### Session 2026-01-10

- Q: which store? → A: the orders table

## User Scenarios & Testing *(mandatory)*

### Edge Cases

- What happens when the list is empty? Nothing is written.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST write one row per run.

## Assumptions

- The store exists.
EOF
cat >specs/001-a/plan.md <<'EOF'
# Implementation Plan: a

## Summary

Write a row.

### Simplest shape

One script.

## Technical Context

### Data sourcing

| What | Where | Transports | Chosen |
|---|---|---|---|
| orders | the orders table | SQL | SQL |
EOF
printf '# Tasks: a\n\n- [ ] T001 Write the script\n' >specs/001-a/tasks.md
git add -A && git commit -qm init
run() { bash "$SUT" "$@"; }
reset() { git checkout -q -- specs; git clean -qfd specs; }

t "unchanged folder" "non-material:no-change" "$(run specs/001-a)"

ed_ 's/→ A: the orders table/→ A: the orders table, the one store/' specs/001-a/spec.md
t "a changed decision-ledger row under Clarifications is material" "material:numbered-section-changed" "$(run specs/001-a)"
reset

ed_ 's/Nothing is written\./Nothing is written, and it says so./' specs/001-a/spec.md
t "an edit under Edge Cases is material" "material:numbered-section-changed" "$(run specs/001-a/)"
reset

ed_ 's/one row per run/two rows per run/' specs/001-a/spec.md
t "an edit under Requirements is material" "material:numbered-section-changed" "$(run specs/001-a)"
reset

ed_ 's/^One script\./One script and a test./' specs/001-a/plan.md
t "an edit under Simplest shape is material" "material:numbered-section-changed" "$(run specs/001-a)"
reset

ed_ 's/| orders | the orders table | SQL | SQL |/| orders | the orders API | SQL, API | API |/' specs/001-a/plan.md
t "an edit under Data sourcing is material" "material:numbered-section-changed" "$(run specs/001-a)"
reset

ed_ 's/make it go/make it go now/' specs/001-a/spec.md
t "an edit to the Input line is material" "material:input-changed" "$(run specs/001-a)"
reset

ed_ 's/^- The store exists\./- The store already exists./' specs/001-a/spec.md
t "an edit under Assumptions is non-material" "non-material:minor-text-edit-2-lines" "$(run specs/001-a)"
reset

ed_ '/^- The store exists\./d' specs/001-a/spec.md
t "a deleted line is placed under its old heading" "non-material:minor-text-edit-1-lines" "$(run specs/001-a)"
reset

ed_ 's/^- What happens when the list is empty/- What happens when the list is full/' specs/001-a/spec.md
ed_ 's/^### Edge Cases$/### Corner cases/' specs/001-a/spec.md; git commit -qam rename; git tag renamed
ed_ 's/Nothing is written\./Nothing is written, ever./' specs/001-a/spec.md
t "an edit under an unlisted sub-heading of a material section is material" "material:numbered-section-changed" "$(run specs/001-a renamed)"
git checkout -q -- specs; git reset -q --hard HEAD~1; git tag -d renamed >/dev/null

git rm -q specs/001-a/tasks.md
t "a deleted file is material" "material:file-removed" "$(run specs/001-a)"
git reset -q HEAD -- specs; git checkout -q -- specs

rm -r specs/001-a
t "a deleted spec folder is material" "material:file-removed" "$(run specs/001-a)"
git checkout -q -- specs

printf -- '- [ ] T002 Test it\n' >>specs/001-a/tasks.md
t "a new task line is material" "material:task-lines-changed" "$(run specs/001-a)"
reset

printf '\n## Notes\n\nx\n' >>specs/001-a/plan.md
t "a new heading is material" "material:section-changed" "$(run specs/001-a)"
reset

echo '# Research: a' >specs/001-a/research.md
t "an untracked file in the folder is new" "material:new-file" "$(run specs/001-a)"
reset

mkdir -p specs/002-b && echo '# spec' >specs/002-b/spec.md
t "a new folder is new-file" "material:new-file" "$(run specs/002-b)"
reset

# The legacy file path is untouched
echo '# x' >legacy.spec.md
t "a new legacy file is still new-file" "material:new-file" "$(run legacy.spec.md)"

# ── A single file (the older lean spec) ──
cat >lean.spec.md <<'EOF'
# SPEC: lean

## 1 — Ask

"make the export faster"

## 2 — Behavior

- Export streams rows instead of buffering them.

## 3 — Files

- src/export.ts — UPDATE

## 4 — Done

npm test   # expected: pass
EOF
git add lean.spec.md && git commit -qm lean
t "unchanged file" "non-material:no-change" "$(run lean.spec.md)"
ed_ 's/"make the export faster"/"make the export fastr"/' lean.spec.md
t "a typo in the Ask is non-material" "non-material:minor-text-edit-2-lines" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
ed_ 's/streams rows/streams rows in batches of 500/' lean.spec.md
t "a Behavior edit is material" "material:behavior-section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
ed_ 's/npm test   # expected: pass/npm test \&\& npm run e2e/' lean.spec.md
t "a Done edit is material" "material:done-section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
printf '\n## 5 — Notes\n' >>lean.spec.md
t "a new heading in a file is material" "material:section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
{ printf 'a\n- b\n- c\n- d\n- e\n- f\n'; cat lean.spec.md; } >x.tmp && mv x.tmp lean.spec.md
t "added bullets outside the contract count as substantive lines" "material:substantive-changes-6-lines" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
t "a missing file is not an error" "non-material:spec-file-missing" "$(run nothing.spec.md)"
t "exit is 0 for a missing file" "0" "$(bash "$SUT" nothing.spec.md >/dev/null; echo $?)"

echo "check-materiality.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
