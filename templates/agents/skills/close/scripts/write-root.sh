#!/usr/bin/env bash
# write-root.sh — where does THIS thread write files in THIS repo?
#
# A harness that makes worktrees (T3 Code, `claude -w`, a Codex app thread)
# gives a session a worktree of ONE repo. Every OTHER repo a session writes to
# gets nothing, and writing through a checkout other sessions share is how a
# close's `git add -A` sweeps another session's files into its commit. The
# workbench holds the code, the records and the skills, so the session's own
# worktree covers them, and other repos are the product satellites a session
# touches now and then. This script gives every repo the same shape — a
# worktree owned by this thread — and records it in a ledger the close walks
# later. A session that started in the main checkout gets its first one here too.
#
# WHY AT FIRST WRITE, not at close time. By close time the shared checkout holds
# this session's files mixed with two other sessions', and no script can tell
# them apart. The two alternatives both depend on that impossible split:
# committing a pathspec (a session may work across folders and repos) and asking
# the model to list what it touched (a list from memory misses files).
#
# THE THREAD'S OWN WORKTREE IS NOT A SPECIAL CASE. The first call in a thread
# registers the worktree the harness gave it (thread.ts --worktree) in the same
# ledger with the branch it actually has, so the close lands it the same way it
# lands every satellite. The harness's own merge button still works; the close
# no longer depends on someone clicking it.
#
# Usage:
#   write-root.sh .                — the repo the shell stands in
#   write-root.sh /abs/path        — that repo
#   write-root.sh --main <repo>    — the SHARED checkout, creating nothing
#   write-root.sh --existing <repo>
#                                  — this thread's worktree of that repo if it
#                                    already has one; creates and records
#                                    nothing; exit 1 when there is none
#   write-root.sh --adopt <worktree>
#                                  — record a worktree something else made (a
#                                    named /implement worktree) as this
#                                    thread's worktree of its repo, so the
#                                    close lands it; refused when the thread
#                                    already has a different one of that repo
#
# The answer is always an absolute path to a directory that already exists.
# Anything but `.`, `~` or an absolute path is refused rather than routed
# anywhere by a guess.
#
# Env:
#   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts, documented there.
#   CONTEXTIUM_HARNESS — read by harness.sh: where a NEW worktree goes. With no
#                        harness recorded, under ~/.cache/workbench/worktrees/.
#
# peers:
#   .agents/skills/close/scripts/write-root.test.ts
#   .agents/skills/close/scripts/thread.ts    (the thread id)
#   .agents/skills/close/scripts/land.ts      (walks the ledger this writes)
#   .agents/skills/close/scripts/trunk.ts     (the trunk name, per repo)
#   .agents/skills/close/scripts/harness.sh   (where a new worktree goes)
#   .agents/skills/close/scripts/lock.sh      (the per-repo lock)
#
# Exit: 0 ok (path on stdout) · 1 --existing found none · 2 no thread, unknown
#       repo, no trunk branch, or an --adopt refused

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# thread.ts and trunk.ts are TypeScript: EXECUTED through node, never sourced —
# bash cannot source TypeScript. `--experimental-strip-types` because it is the
# spelling every Node this template supports accepts (22.6+ and 26 alike).
# harness.sh and lock.sh are bash libraries, sourced.
THREAD="${SCRIPT_DIR}/thread.ts"
TRUNK_TS="${SCRIPT_DIR}/trunk.ts"
# shellcheck disable=SC1091  # sibling files, resolved at run time
source "${SCRIPT_DIR}/harness.sh"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lock.sh"

fail() {
  echo "write-root: $*" >&2
  exit 2
}

MODE="worktree"
REPO_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --main|--existing|--adopt)
      MODE="${1#--}"
      REPO_ARG="${2:-}"
      [ -n "${REPO_ARG}" ] || fail "$1 needs a repo"
      shift 2
      ;;
    -*) fail "usage: write-root.sh [--main | --existing | --adopt] <. | /abs/path>" ;;
    *)
      [ -z "${REPO_ARG}" ] || fail "one repo at a time, got '${REPO_ARG}' and '$1'"
      REPO_ARG="$1"
      shift
      ;;
  esac
done
[ -n "${REPO_ARG}" ] || fail "usage: write-root.sh [--main | --existing | --adopt] <. | /abs/path>"

# ── Which repo is being asked about? ───────────────────────────────────────
#
# Two spellings, one answer: the repo the shell stands in, or a path.

# shellcheck disable=SC2088  # the `~` here is a case PATTERN being matched
# against the argument, not a path being used — expanding it would be the bug,
# because then nothing could ever match a literal tilde: a `~/...` path reaches
# this script unexpanded whenever a caller quoted it.
case "${REPO_ARG}" in
  .)       RAW="$(pwd)" ;;
  "~")     RAW="${HOME}" ;;
  "~/"*)   RAW="${HOME}/${REPO_ARG#\~/}" ;;
  /*)      RAW="${REPO_ARG}" ;;
  *)       fail "not a repo I know: '${REPO_ARG}' (want '.' or an absolute path)" ;;
esac

[ -d "${RAW}" ] || fail "no such directory: ${RAW}"

# THE CANONICAL FORM OF A REPO IS ITS SHARED CHECKOUT, and `--git-common-dir` is
# what finds it: inside any worktree the toplevel is the WORKTREE, but the
# common dir is always the shared checkout's `.git`, so its parent is the shared
# checkout from anywhere. Without this, `write-root.sh .` run from inside a
# satellite would treat that satellite as a repo of its own and nest a worktree
# in a worktree; and two spellings of one repo (a symlinked path, a subdirectory)
# would produce two different repo-keys and two different worktrees.
canonical_shared() {
  local dir="$1" common
  common="$(git -C "${dir}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "${common}" ] && [ -d "${common}" ] || return 1
  (cd "${common}/.." && pwd -P)
}

SHARED="$(canonical_shared "${RAW}")" || fail "not a git repo: ${RAW}"

if [ "${MODE}" = "main" ]; then
  printf '%s\n' "${SHARED}"
  exit 0
fi

# ── Which thread? ──────────────────────────────────────────────────────────
#
# No thread means no isolation to give and no close to land it. Nothing is
# guessed here: thread.ts names the session (T3's thread, the harness's session
# id, or one it generates for this tree), and where it cannot — a shell in no
# git tree at all — this refuses and writes nothing.
# The id is stdout alone. stderr is kept apart for the failure message: a Node
# 22.x prints an ExperimentalWarning there on every run, and read as `2>&1` it
# became the head of the id.
TID_ERR="$(mktemp)"
if ! TID="$(node --experimental-strip-types "${THREAD}" --id 2>"${TID_ERR}")"; then
  WHY="$(grep '^thread: ' "${TID_ERR}" | tail -n 1 || true)"
  # The last line that is not Node 22's type-stripping warning or its hint.
  [ -n "${WHY}" ] || WHY="$(grep -v -e 'ExperimentalWarning' -e '^(Use `node --trace-warnings' "${TID_ERR}" | tail -n 1 || true)"
  rm -f "${TID_ERR}"
  fail "${WHY#thread: }"
fi
rm -f "${TID_ERR}"

LEDGER_DIR="${HOME}/.cache/workbench/threads/${TID}"
LEDGER="${LEDGER_DIR}/worktrees"
mkdir -p "${LEDGER_DIR}"

# Ledger lines are unique by their FIRST column. A second call for the same repo
# must append nothing, and two concurrent first calls must not produce two lines
# for the one worktree they agreed on.
ledger_has() {
  [ -f "${LEDGER}" ] || return 1
  awk -F'\t' -v want="$1" '$1 == want { found = 1 } END { exit !found }' "${LEDGER}"
}

ledger_add() {
  ledger_has "$1" && return 0
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >>"${LEDGER}"
}

# The thread's worktree of a shared checkout, as the ledger records it — only
# while it is still on disk: `land.ts` keeps a line after removing its worktree,
# as the record that it landed.
ledger_live() {
  [ -f "${LEDGER}" ] || return 1
  local wt
  wt="$(awk -F'\t' -v s="$1" '$2 == s { print $1 }' "${LEDGER}" | while IFS= read -r w; do
    [ -d "${w}" ] && { printf '%s\n' "${w}"; break; }
  done)"
  [ -n "${wt}" ] || return 1
  printf '%s\n' "${wt}"
}

# The thread's own harness worktree, when it is a worktree of $1. Records nothing.
own_of() {
  local wt
  wt="$(node --experimental-strip-types "${THREAD}" --worktree 2>/dev/null || true)"
  [ -n "${wt}" ] && [ -d "${wt}" ] || return 1
  [ "$(canonical_shared "${wt}" || true)" = "$1" ] || return 1
  printf '%s\n' "${wt}"
}

# ── Read-only: the worktree this thread already has ─────────────────────────
if [ "${MODE}" = "existing" ]; then
  own_of "${SHARED}" || ledger_live "${SHARED}" || exit 1
  exit 0
fi

# ── Adopt a worktree something else made ──────────────────────────────────
#
# /implement names its worktree after the work (setup-worktree.sh). Made there,
# it is in no ledger, and `land.ts` walks only the ledger — so the close would
# report success over code still sitting in it. Recording it here is what
# makes it this thread's worktree of its repo, answered by every later call.
if [ "${MODE}" = "adopt" ]; then
  WT="$(git -C "${RAW}" rev-parse --show-toplevel 2>/dev/null)" || fail "not a git worktree: ${RAW}"
  WT="$(cd "${WT}" && pwd -P)"
  [ "${WT}" != "${SHARED}" ] || fail "${WT} is the shared checkout, not a worktree of it"
  HAVE="$(own_of "${SHARED}" || ledger_live "${SHARED}" || true)"
  if [ -n "${HAVE}" ] && [ "${HAVE}" != "${WT}" ]; then
    fail "this thread already has ${HAVE} for ${SHARED}; not adopting ${WT} beside it"
  fi
  BR="$(git -C "${WT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  [ -n "${BR}" ] && [ "${BR}" != HEAD ] || fail "cannot read the branch of ${WT}"
  ledger_add "${WT}" "${SHARED}" "${BR}"
  printf '%s\n' "${WT}"
  exit 0
fi

# ── Register the thread's own T3 worktree, once ────────────────────────────
#
# Its branch is read from the harness (or git), never invented. T3 renames the
# branch when it titles the thread — `t3code/8c4bf4be` becomes
# `t3code/<a-title>` mid-thread — so a script that assumed a prefix would land
# the wrong branch or none.
#
# The SHARED column is the real checkout, not the worktree itself: it is what
# `land.ts` fast-forwards, and it is where `land.ts` looks for
# `.agents/deployable-prefixes.json` to decide whether this repo's pushes
# deploy at all.
T3_WT="$(node --experimental-strip-types "${THREAD}" --worktree 2>/dev/null || true)"
if [ -n "${T3_WT}" ] && [ -d "${T3_WT}" ]; then
  T3_SHARED="$(canonical_shared "${T3_WT}" || true)"
  if [ -n "${T3_SHARED}" ] && ! ledger_has "${T3_WT}"; then
    T3_BRANCH="$(node --experimental-strip-types "${THREAD}" --branch 2>/dev/null || true)"
    if [ -z "${T3_BRANCH}" ]; then
      T3_BRANCH="$(git -C "${T3_WT}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
    fi
    [ -n "${T3_BRANCH}" ] || fail "cannot read the branch of ${T3_WT}"
    ledger_add "${T3_WT}" "${T3_SHARED}" "${T3_BRANCH}"
  fi
  # The thread already has a worktree of this repo — that is the answer.
  if [ -n "${T3_SHARED:-}" ] && [ "${T3_SHARED}" = "${SHARED}" ]; then
    printf '%s\n' "${T3_WT}"
    exit 0
  fi
fi

# A worktree the thread already has — one it adopted, or a satellite an
# earlier call made — is the answer before any new one is considered.
if HAVE="$(ledger_live "${SHARED}")"; then
  printf '%s\n' "${HAVE}"
  exit 0
fi

# ── A satellite for every other repo ───────────────────────────────────────
#
# `<basename>-<8 hex of the path's sha1>` (harness.sh harness_repo_key): the
# basename so a human reading ~/.cache can tell what it is, the hash so two
# checkouts both called `dashboard` do not collide. The thread id is the full id
# for the same reason — an 8-character prefix is shared by two threads sooner
# than it looks.
KEY="$(harness_repo_key "${SHARED}")"
TARGET="${HOME}/.cache/workbench/worktrees/${KEY}/${TID}"
# A recorded harness puts the worktree where that harness keeps its own
# (harness.sh), so its worktree tools see it; with none recorded, ~/.cache.
if [ "$(harness_name "${SHARED}")" != "default" ]; then
  TARGET="$(harness_worktree_root "${SHARED}")/${TID}"
fi
BRANCH="$(harness_worktree_branch "${TID}" "${SHARED}")"

# Not under $T3CODE_HOME/worktrees/: that folder is T3's, and its stale-worktree
# sweep would reap these.
mkdir -p "$(dirname "${TARGET}")"

# ONE LOCK PER REPO, the same one the close takes to merge and any other
# automated committer to the repo should take. Two concurrent first calls in one
# thread must not both run `git worktree add`; and a worktree being created while
# an automation commits the same checkout is the interleave this lock prevents.
# lock.sh: flock(1) where it exists, a portable lock where it does not (macOS).
LOCK="/tmp/$(basename "${SHARED}")-git.lock"
if ! lock_repo "${LOCK}" 120; then
  fail "could not take ${LOCK} within 120s"
fi

# Re-checked inside the lock: the loser of a race arrives here after the winner
# has finished, and must print the winner's path rather than create a second.
if [ -d "${TARGET}" ]; then
  # …and it must be a worktree of THIS repo. A root keyed coarser than the
  # checkout (the in-repo claude/gemini roots are per checkout, the rest carry
  # the repo key, but a folder made by hand or by an older layout is not) can
  # hold another repo's folder here, and handing that back sends this repo's
  # edits into the other one.
  [ "$(canonical_shared "${TARGET}" || true)" = "${SHARED}" ] \
    || fail "${TARGET} exists and is not a worktree of ${SHARED}"
  ledger_add "${TARGET}" "${SHARED}" "${BRANCH}"
  printf '%s\n' "${TARGET}"
  exit 0
fi

# A repo with no TRUNK cannot be landed, so refusing here is better than
# creating a worktree the close will choke on. The fetch is allowed to fail —
# an unreachable remote is not the same as no remote, and a stale local trunk
# ref still gives a base to branch from.
#
# The name is ASKED FOR rather than spelled `main`: a repo whose trunk is
# `master` would otherwise be refused outright, and the session that had to
# write there would build its own worktree by hand, landed by nobody and
# recorded in no ledger.
TRUNK="$(node --experimental-strip-types "${TRUNK_TS}" "${SHARED}" 2>/dev/null)" \
  || fail "no trunk branch in ${SHARED} (origin/HEAD unset and no origin/main or origin/master)"
git -C "${SHARED}" fetch -q origin "${TRUNK}" 2>/dev/null || true
git -C "${SHARED}" rev-parse --verify -q "origin/${TRUNK}" >/dev/null 2>&1 \
  || fail "no origin/${TRUNK} in ${SHARED}"

if git -C "${SHARED}" rev-parse --verify -q "refs/heads/${BRANCH}" >/dev/null 2>&1; then
  # An earlier close crashed after creating the branch and before landing it, or
  # its worktree directory was deleted by hand. Reclaim rather than refuse: the
  # commits on that branch are this thread's own work and must not be stranded.
  echo "write-root: reclaimed existing branch ${BRANCH} in ${SHARED}" >&2
  git -C "${SHARED}" worktree add -q "${TARGET}" "${BRANCH}" \
    || fail "could not attach a worktree to ${BRANCH} in ${SHARED}"
else
  git -C "${SHARED}" worktree add -q -b "${BRANCH}" "${TARGET}" "origin/${TRUNK}" \
    || fail "could not create a worktree of ${SHARED} at ${TARGET}"
fi

ledger_add "${TARGET}" "${SHARED}" "${BRANCH}"
printf '%s\n' "${TARGET}"
