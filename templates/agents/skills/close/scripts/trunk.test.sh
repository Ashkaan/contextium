#!/usr/bin/env bash
# trunk.test.sh — the resolver behind every close script's trunk name.
#
# Run: bash .agents/skills/close/scripts/trunk.test.sh
#
# Fixtures are real git repos with real bare origins under a temp dir. The
# `master` rows are the ones that matter: a repo on `master` is the case this
# file exists to keep working.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/trunk.sh"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

trap 'rm -rf "${TMP}"' EXIT

ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }

# A checkout with a bare origin whose default branch is $2.
mkrepo() {
  local name="$1" branch="$2"
  local origin="${TMP}/origins/${name}.git" work="${TMP}/checkouts/${name}"
  mkdir -p "${TMP}/origins" "${TMP}/checkouts"
  git init -q --bare --initial-branch="${branch}" "${origin}"
  git init -q --initial-branch="${branch}" "${work}"
  git -C "${work}" config user.email t@t
  git -C "${work}" config user.name T
  echo x >"${work}/f"
  git -C "${work}" add -A
  git -C "${work}" commit -qm init
  git -C "${work}" remote add origin "${origin}"
  git -C "${work}" push -q -u origin "${branch}"
  git -C "${work}" remote set-head origin --auto >/dev/null 2>&1
  printf '%s\n' "${work}"
}

MAIN="$(mkrepo main-repo main)"
MASTER="$(mkrepo master-repo master)"
ODD="$(mkrepo odd-repo trunk)"

# ── The two spellings ──────────────────────────────────────────────────
is "main repo: name"   "$(bash "${SCRIPT}" "${MAIN}")"         "main"
is "main repo: ref"    "$(bash "${SCRIPT}" --ref "${MAIN}")"   "origin/main"
is "master repo: name" "$(bash "${SCRIPT}" "${MASTER}")"       "master"
is "master repo: ref"  "$(bash "${SCRIPT}" --ref "${MASTER}")" "origin/master"

# A trunk called neither. Nothing in the resolver may hardcode the two common
# names when the remote states the answer outright.
is "arbitrary trunk name is read, not guessed" "$(bash "${SCRIPT}" "${ODD}")" "trunk"

# ── Asked from inside a WORKTREE, not just the checkout ────────────────
# Every caller in land.sh runs `git -C <worktree>`, so the resolver has to
# answer the same there. A worktree shares the checkout's refs, so this is the
# same origin/HEAD by a different path — asserted because "obvious" is how a
# `--git-common-dir` assumption gets broken later.
WT="${TMP}/wt-master"
git -C "${MASTER}" worktree add -q -b side "${WT}" >/dev/null 2>&1
is "from inside a worktree" "$(bash "${SCRIPT}" --ref "${WT}")" "origin/master"
git -C "${MASTER}" worktree remove --force "${WT}" >/dev/null 2>&1

# ── Fallback 2: origin/HEAD unset, remote reachable ────────────────────
# `git clone` sets origin/HEAD; `git remote add` after the fact does not, so an
# unset head is an ordinary state rather than a corrupt one.
git -C "${MASTER}" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null
is "origin/HEAD unset: asks the remote" "$(bash "${SCRIPT}" "${MASTER}")" "master"
# And CACHES it, so the next call needs no network.
is "and writes the answer back" \
  "$(git -C "${MASTER}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" "origin/master"

# ── Fallback 3: origin/HEAD unset AND the remote is gone ───────────────
# The floor. A probe of the two names that cover every repo here, `main` first.
git -C "${MASTER}" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null
git -C "${MASTER}" remote set-url origin "${TMP}/origins/does-not-exist.git"
is "unreachable remote falls back to the probe" "$(bash "${SCRIPT}" "${MASTER}")" "master"

# `main` wins the probe when BOTH tracking refs exist — it is the newer default
# and the one every repo here uses.
git -C "${MAIN}" symbolic-ref -d refs/remotes/origin/HEAD 2>/dev/null
git -C "${MAIN}" update-ref refs/remotes/origin/master "$(git -C "${MAIN}" rev-parse HEAD)"
git -C "${MAIN}" remote set-url origin "${TMP}/origins/does-not-exist.git"
is "probe prefers main over master" "$(bash "${SCRIPT}" "${MAIN}")" "main"

# ── Refusals. It never guesses. ────────────────────────────────────────
NOTHING="${TMP}/checkouts/nothing"
git init -q --initial-branch=main "${NOTHING}"
OUT="$(bash "${SCRIPT}" "${NOTHING}" 2>&1)"; RC=$?
is  "no remote at all: exit 2" "${RC}" "2"
has "no remote at all: says why" "${OUT}" "no trunk branch"

OUT="$(bash "${SCRIPT}" "${TMP}/not-a-repo" 2>&1)"; RC=$?
is  "missing dir: exit 2" "${RC}" "2"
has "missing dir: says why" "${OUT}" "not a git repo"

NOTGIT="${TMP}/plain"; mkdir -p "${NOTGIT}"
OUT="$(bash "${SCRIPT}" "${NOTGIT}" 2>&1)"; RC=$?
is "a plain directory is not a repo" "${RC}" "2"

OUT="$(bash "${SCRIPT}" 2>&1)"; RC=$?
is  "no argument: exit 2" "${RC}" "2"
has "no argument: usage" "${OUT}" "usage"

OUT="$(bash "${SCRIPT}" "${MAIN}" "${MASTER}" 2>&1)"; RC=$?
is  "two repos at once: exit 2" "${RC}" "2"
has "two repos at once: says why" "${OUT}" "one repo at a time"

echo
echo "trunk.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
