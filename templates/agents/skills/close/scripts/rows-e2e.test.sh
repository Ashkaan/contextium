#!/usr/bin/env bash
# rows-e2e.test.sh — roadmap rows, end to end, in a scratch install.
#
# Every other suite tests one script against a fixture. This one proves the
# loop the scripts make together: a fresh install, a project with three rows
# (R1 and R2 independent, R3 depending on both), two sessions building R1 and
# R2 in parallel, each closed with the close's own scripts — and afterwards R1
# and R2 `done`, `next:` re-derived to R3, R3 ready, and origin carrying both
# merges. No model is called: the scripts are driven directly, in the order
# /implement and /close run them.
#
# Scratch only: a temp HOME, the installer run into a temp folder with
# --harness claude, and a bare local "origin". Nothing outside the temp folder
# is read or written.
#
# Run: bash .agents/skills/close/scripts/rows-e2e.test.sh   (from the Contextium
# repo; the installer is four folders above this one)
#
# peers:
#   install.sh
#   .agents/skills/implement/scripts/setup-worktree.sh
#   .agents/skills/project/scripts/detect-stage.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/scripts/next-implement-command.sh
#   .agents/skills/close/scripts/land.sh

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../../../../.." && pwd)"
INSTALL="${REPO_ROOT}/install.sh"

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }

if [ ! -f "${INSTALL}" ]; then
  echo "SKIP: no install.sh at ${INSTALL} (run from the Contextium repo)"
  echo "rows-e2e.test.sh: 0 passed, 0 failed"
  exit 0
fi

S="$(mktemp -d)"
S="$(cd "${S}" && pwd -P)"
cleanup() {
  [ -d "${WB:-}" ] && git -C "${WB}" worktree prune 2>/dev/null
  rm -rf "${S}"
}
trap cleanup EXIT

# The scratch world. The session variables of the shell running the suite must
# not leak in: each session below names its own.
export HOME="${S}/home" T3CODE_HOME="${S}/no-t3" LAND_PUSH_SLEEP=0
unset CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CONTEXTIUM_SESSION CONTEXTIUM_HARNESS \
  WORKBENCH_THREAD_ID CLAUDE_PROJECT_DIR CONTEXT_WRITE_ROOT CLAUDE_WORKTREE_HOME CODEX_HOME
mkdir -p "${HOME}"

# The basename is unique per run: land.sh's repo lock is keyed on it.
WB="${S}/rows-e2e-$$"
P="projects/demo/2026-01-01_rows-demo"
C=".agents/skills/close/scripts"

# ── Install, then make it a repo with an origin ────────────────────────────

if ! bash "${INSTALL}" "${WB}" --yes --harness claude --name Tester --no-integrations \
  </dev/null >"${S}/install.log" 2>&1; then
  bad "install.sh --yes --harness claude: $(tail -3 "${S}/install.log")"
  echo "rows-e2e.test.sh: ${PASS} passed, ${FAIL} failed"
  exit 1
fi
is "the install records the harness" "$(sed -n 's/^harness=//p' "${WB}/.agents/harness")" "claude"

# The installer makes the workbench a repo when it is not one; this names the
# branch the same either way.
[ -e "${WB}/.git" ] || git init -q "${WB}"
git -C "${WB}" symbolic-ref HEAD refs/heads/main
git -C "${WB}" config user.email tester@example.com
git -C "${WB}" config user.name Tester

# The project: three rows, each with a spec folder whose one task is a file.
mkdir -p "${WB}/${P}"
cat >"${WB}/${P}/README.md" <<'README'
---
project: rows-demo
status: active
priority: medium
created: 2026-01-01
tags: [demo]
description: Three rows, two of them in parallel
next: "R1: first"
---

# Project: Rows demo

## Goal

Show that roadmap rows ship: two in parallel, then the one that needs both.
README
cat >"${WB}/${P}/ROADMAP.md" <<'ROADMAP'
# Roadmap: rows demo

| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|
| R1 | first | write notes/r1.txt | in | — | planned | `specs/001-first/` |
| R2 | second | write notes/r2.txt | in | — | planned | `specs/002-second/` |
| R3 | third | write notes/r3.txt | in | R1, R2 | planned | `specs/003-third/` |
ROADMAP
for n in 1:first 2:second 3:third; do
  i="${n%%:*}" name="${n#*:}" d="${WB}/${P}/specs/00${n%%:*}-${n#*:}"
  mkdir -p "${d}"
  printf '# Feature Specification: %s\n\n**Input**: "write notes/r%s.txt"\n' "${name}" "${i}" >"${d}/spec.md"
  printf '# Implementation Plan: %s\n' "${name}" >"${d}/plan.md"
  printf '# Tasks: %s\n\n- [ ] T001 Write notes/r%s.txt containing r%s\n' "${name}" "${i}" "${i}" >"${d}/tasks.md"
done

git -C "${WB}" add -A
git -C "${WB}" commit -qm "Seed the workbench"
git init -q --bare -b main "${S}/origin.git"
git -C "${WB}" remote add origin "${S}/origin.git"
git -C "${WB}" push -q -u origin main
git -C "${WB}" remote set-head origin main

# ── Before: R1 and R2 are the parallel set ─────────────────────────────────

cd "${WB}" || exit 1
STAGE="$(bash .agents/skills/project/scripts/detect-stage.sh "${P}" 2>&1)"
has "detect-stage: ready to implement" "${STAGE}" "stage: ready-to-implement"
has "…starting with R1" "${STAGE}" "next-row: R1"
READY="$(bash "${C}/roadmap.sh" "${P}" --ready | cut -f1 | paste -sd' ' -)"
is "roadmap --ready lists R1 and R2 together" "${READY}" "R1 R2"
NEXT="$(bash "${C}/next-implement-command.sh" "${P}")"
is "next-implement-command prints one command per ready row" "${NEXT}" "/implement rows-demo r1
/implement rows-demo r2"
is "reading the project made no worktree" "$(git worktree list | wc -l | tr -d ' ')" "1"

# ── Two sessions start, one row each ───────────────────────────────────────

# session <id> <cmd...> — run as that session, from the main checkout.
session() { local id="$1"; shift; (cd "${WB}" && CONTEXTIUM_SESSION="${id}" "$@"); }
start() {  # start <session> <row> — prints the worktree
  session "$1" bash .agents/skills/implement/scripts/setup-worktree.sh --slug rows-demo --shard "$2" \
    2>"${S}/setup-$2.err" | sed -n 's/^WORKTREE_DIR=//p'
}
WT1="$(start e2e-one r1)"
WT2="$(start e2e-two r2)"
is "session one gets a worktree for R1" "$([ -d "${WT1}" ] && basename "${WT1}")" "rows-demo-r1"
is "session two gets its own for R2" "$([ -d "${WT2}" ] && basename "${WT2}")" "rows-demo-r2"
is "the shared checkout is untouched" "$(git -C "${WB}" status --porcelain)" ""
row() { awk -F'|' -v id="$2" '$2 ~ "^ *" id " *$" {gsub(/^ +| +$/, "", $7); print $7}' "$1/${P}/ROADMAP.md"; }
is "R1 is in progress in session one's worktree" "$(row "${WT1}" R1)" "in-progress"
is "R2 is in progress in session two's worktree" "$(row "${WT2}" R2)" "in-progress"

# ── Each session builds its row and closes ─────────────────────────────────

# build <worktree> <n> <spec> — the task, the report, the close's project step.
build() {
  local wt="$1" n="$2" spec="$3"
  mkdir -p "${wt}/notes"
  printf 'r%s\n' "${n}" >"${wt}/notes/r${n}.txt"
  printf -- '---\nspec: %s\nspec-status: complete\n---\n\n# Implementation Report\n\n**Status**: COMPLETE\n' \
    "${spec}" >"${wt}/${P}/specs/${spec}/report.md"
  (cd "${wt}" && bash "${C}/roadmap.sh" "${P}" --set "R${n}" "done" >/dev/null \
    && bash "${C}/roadmap.sh" "${P}" --sync-next >/dev/null)
}
# journal <session> <worktree> <n> — the close's journal step.
journal() {
  local j day
  local name
  j="$(cd "$2" && CONTEXTIUM_SESSION="$1" bash "${C}/journal-file.sh" "row r$3")" || return 1
  day="$(basename "$(dirname "${j}")")"
  name="$(basename "${j}")"
  cat >"${j}" <<ENTRY
---
date: ${day}
time: "${name:0:2}:${name:2:2}"
slug: row-r$3
project: demo/2026-01-01_rows-demo
tags: []
---

### row-r$3
**Action:** Built row R$3 of rows-demo.
**Changes:** notes/r$3.txt; R$3 done.
ENTRY
  (cd "$2" && CONTEXTIUM_SESSION="$1" bash "${C}/journal-file.sh" --check >/dev/null 2>"${S}/journal-$3.err")
}
# land <session> <worktree> <subject>
land() { (cd "$2" && CONTEXTIUM_SESSION="$1" bash "${C}/land.sh" "$3" 2>&1); }

build "${WT1}" 1 001-first
build "${WT2}" 2 002-second
journal e2e-one "${WT1}" 1 || bad "session one's journal entry fails its check: $(cat "${S}/journal-1.err")"
journal e2e-two "${WT2}" 2 || bad "session two's journal entry fails its check: $(cat "${S}/journal-2.err")"

OUT1="$(land e2e-one "${WT1}" "Ship R1 of rows-demo")"
RC1=$?
is "session one's close lands" "${RC1}" "0"
has "…and proves it against origin" "${OUT1}" "closing this tab loses nothing."

# Session two's branch and the trunk both changed ROADMAP.md on adjacent rows
# (R1 on the trunk, R2 here) and both re-derived `next:`. git's line merge
# calls that a conflict; land.sh merges the table row by row
# (roadmap-merge.sh), so this close lands with no hand step, and then
# re-derives README.md's `next:` from the merged table — each session's value
# described only its own copy. Both are checked on origin below.
OUT2="$(land e2e-two "${WT2}" "Ship R2 of rows-demo")"
RC2=$?
is "session two's close lands" "${RC2}" "0"
has "…and proves it against origin" "${OUT2}" "closing this tab loses nothing."
[ "${RC1}${RC2}" = "00" ] || { echo "--- session one"; echo "${OUT1}"; echo "--- session two"; echo "${OUT2}"; }

# ── After: both merged, R3 is next ─────────────────────────────────────────

git -C "${WB}" fetch -q origin
AT() { git -C "${WB}" show "origin/main:$1" 2>/dev/null; }
is "origin carries R1's change" "$(AT notes/r1.txt)" "r1"
is "origin carries R2's change" "$(AT notes/r2.txt)" "r2"
SUBJECTS="$(git -C "${WB}" log --format=%s origin/main)"
has "both closes' commits are on origin" "${SUBJECTS}" "Ship R1 of rows-demo"
has "…session two's too" "${SUBJECTS}" "Ship R2 of rows-demo"
ROWS="$(AT "${P}/ROADMAP.md" | awk -F'|' '$2 ~ /^ *R[0-9]/ {gsub(/ /, "", $2); gsub(/^ +| +$/, "", $7); printf "%s=%s ", $2, $7}')"
is "R1 and R2 are done on origin, R3 still planned" "${ROWS}" "R1=done R2=done R3=planned "
is "next: is re-derived to R3" "$(AT "${P}/README.md" | sed -n 's/^next: //p')" '"R3: third"'
is "the shared checkout was fast-forwarded to origin" \
  "$(git -C "${WB}" rev-parse HEAD)" "$(git -C "${WB}" rev-parse origin/main)"
is "R3 is now the ready row" "$(bash "${C}/roadmap.sh" "${P}" --ready | cut -f1 | paste -sd' ' -)" "R3"
is "the next command is R3's" "$(bash "${C}/next-implement-command.sh" "${P}")" "/implement rows-demo r3"
is "no worktree is left behind" "$(git -C "${WB}" worktree list | wc -l | tr -d ' ')" "1"

echo
echo "rows-e2e.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
