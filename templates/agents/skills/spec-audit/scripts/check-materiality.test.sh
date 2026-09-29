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

# ── A single file (an app SPEC or an older loose *.spec.md) ──
# Each changed line is walked back to its `##` section, so a one-line edit
# under Behavior or Done is material; the Ask (the user's quoted words) is not.
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
t "a one-line Behavior edit in a single file is material" "material:numbered-section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
ed_ 's/npm test   # expected: pass/npm test \&\& npm run e2e/' lean.spec.md
t "a one-line Done edit in a single file is material" "material:numbered-section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
printf '\n## 5 — Notes\n' >>lean.spec.md
t "a new heading in a file is material" "material:section-changed" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
{ printf 'a\n- b\n- c\n- d\n- e\n- f\n'; cat lean.spec.md; } >x.tmp && mv x.tmp lean.spec.md
t "added bullets outside the contract count as substantive lines" "material:substantive-changes-6-lines" "$(run lean.spec.md)"
git checkout -q -- lean.spec.md
t "a missing file is not an error" "non-material:spec-file-missing" "$(run nothing.spec.md)"
t "exit is 0 for a missing file" "0" "$(bash "$SUT" nothing.spec.md >/dev/null; echo $?)"

# The heading forms legacy SPECs actually use, in either case: `## § 10 — AI
# eval plan`, `## 9. AI Eval Plan`, `## 7. Data-reliability checklist`.
cat >evals.spec.md <<'EOF'
# SPEC: evals

## § 9 — Failure modes

- the scorer times out

## § 10 — AI eval plan

- fixture: 20 labelled rows; pass bar 18

## 7. Data-reliability checklist

- stale beats wrong
EOF
git add evals.spec.md && git commit -qm evals
ed_ 's/pass bar 18/pass bar 19/' evals.spec.md
t "a one-line edit under '§ 10 — AI eval plan' is material" "material:numbered-section-changed" "$(run evals.spec.md)"
git checkout -q -- evals.spec.md
ed_ 's/stale beats wrong/stale beats wrong, always/' evals.spec.md
t "a one-line edit under '7. Data-reliability checklist' is material" "material:numbered-section-changed" "$(run evals.spec.md)"
git checkout -q -- evals.spec.md

# ── A git read that FAILS is not "no change" ─────────────────────────────
# FAKE_GIT_FAIL makes one git subcommand error. Read as empty, a failed diff is
# "no-change" and a failed ls-tree is "new-file" or "nothing removed" — each a
# verdict about a spec nobody compared. It is reported, and treated as material
# so the audit runs.
fakegit="$tmp/fakegit"; mkdir -p "$fakegit"
realgit="$(command -v git)"
cat >"$fakegit/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated \$a failure" >&2; exit 128; fi
done
exec "$realgit" "\$@"
EOF
chmod +x "$fakegit/git"
for sub in ls-tree diff; do
  rc=0; out="$(PATH="$fakegit:$PATH" FAKE_GIT_FAIL=$sub bash "$SUT" specs/001-a 2>/dev/null)" || rc=$?
  t "folder: a failed git $sub is reported material, exit 1" "material:git-read-failed|1" "$out|$rc"
done
rc=0; out="$(PATH="$fakegit:$PATH" FAKE_GIT_FAIL=diff bash "$SUT" lean.spec.md 2>/dev/null)" || rc=$?
t "file: a failed git diff is reported material, exit 1" "material:git-read-failed|1" "$out|$rc"
err_out="$(PATH="$fakegit:$PATH" FAKE_GIT_FAIL=diff bash "$SUT" lean.spec.md 2>&1 >/dev/null)"
t "…and says which read failed" "yes" "$(grep -q 'git diff failed' <<<"$err_out" && echo yes)"

# A failed read of the OLD version is not "the file was absent": `git show`
# failing on a path the ref has is a git error, answered material. Absent at
# the ref stays the new-file answer.
grep -v 'npm test' lean.spec.md >x.tmp && mv x.tmp lean.spec.md
t "baseline: deleting the acceptance command is material" "material:numbered-section-changed" "$(run lean.spec.md)"
rc=0; out="$(PATH="$fakegit:$PATH" FAKE_GIT_FAIL=show bash "$SUT" lean.spec.md 2>/dev/null)" || rc=$?
t "file: a failed git show of the old version is reported, exit 1" "material:git-read-failed|1" "$out|$rc"
git checkout -q -- lean.spec.md
ed_ 's/Nothing is written\./Nothing is written, and it says so./' specs/001-a/spec.md
rc=0; out="$(PATH="$fakegit:$PATH" FAKE_GIT_FAIL=show bash "$SUT" specs/001-a 2>/dev/null)" || rc=$?
t "folder: a failed git show of a changed file is reported, exit 1" "material:git-read-failed|1" "$out|$rc"
git checkout -q -- specs
fresh="$(mktemp -d "${TMPDIR:-/tmp}/cm-unborn.XXXXXX")"
( cd "$fresh" && git init -q && printf '# SPEC\n' >new.spec.md && bash "$SUT" new.spec.md >"$fresh/out" 2>/dev/null ); rc=$?
t "a repo with no commits yet: a spec is new, not a read failure" "material:new-file|0" "$(cat "$fresh/out")|$rc"
rm -rf "$fresh"

echo "check-materiality.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
