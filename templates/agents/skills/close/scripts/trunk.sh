#!/usr/bin/env bash
# trunk.sh — what is THIS repo's trunk branch called?
#
# A close script that spells the answer `main` is correct for most repos and
# wrong for any that predates the rename: a repo whose trunk is `master` gets
# refused outright ("no origin/main"), a session that has to write there builds
# its worktree and pushes by hand, and nothing in the ledger records that it
# happened. A close cannot vouch for a repo it was never able to touch.
#
# So the name is ASKED FOR rather than assumed, per repo.
#
# Usage:
#   trunk.sh <repo-dir>        — the branch name, e.g. `main` or `master`
#   trunk.sh --ref <repo-dir>  — the remote-tracking ref, e.g. `origin/main`
#
# The two spellings exist because callers need both and deriving one from the
# other at 47 sites is how they drift: `git fetch origin <name>` takes the bare
# branch, every rev-parse and merge-base takes the `origin/<name>` ref.
#
# Resolution order, and the first one wins:
#   1. `refs/remotes/origin/HEAD` — what the REMOTE says its default is. Local,
#      deterministic, no network. Set on every
#      repo git cloned normally.
#   2. `git remote set-head origin --auto` — asks the remote once and WRITES
#      the answer into (1), so the next call is local again. Network; allowed
#      to fail, because an unreachable remote is not the same as no remote.
#   3. A probe of `origin/main` then `origin/master`, in that order. The floor
#      for a repo whose origin/HEAD was never set and whose remote is down.
#
# It NEVER falls back to a bare `main`. A guess that happens to be right on
# three repos out of four is what this file exists to delete: the failure it
# produces is silent, and it costs a close that thinks it landed everything.
#
# peers:
#   .agents/skills/close/scripts/trunk.test.sh
#   .agents/skills/close/scripts/land.sh        (per ledger repo)
#   .agents/skills/close/scripts/write-root.sh  (the base a worktree branches from)
#
# Exit: 0 ok (name or ref on stdout) · 2 not a git repo, or no trunk found

set -euo pipefail

MODE="name"
REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) MODE="ref"; shift ;;
    --name) MODE="name"; shift ;;
    -*) echo "trunk: usage: trunk.sh [--ref] <repo-dir>" >&2; exit 2 ;;
    *)
      if [ -n "${REPO}" ]; then
        echo "trunk: one repo at a time, got '${REPO}' and '$1'" >&2
        exit 2
      fi
      REPO="$1"; shift ;;
  esac
done

if [ -z "${REPO}" ]; then
  echo "trunk: usage: trunk.sh [--ref] <repo-dir>" >&2
  exit 2
fi

if [ ! -d "${REPO}" ] || ! git -C "${REPO}" rev-parse --git-dir >/dev/null 2>&1; then
  echo "trunk: not a git repo: ${REPO}" >&2
  exit 2
fi

# `--short` on a symbolic ref to a remote-tracking branch prints `origin/main`,
# so the `origin/` prefix is stripped rather than assumed away: a remote that is
# not called `origin` would otherwise yield a branch name with a slash in it.
read_head() {
  local full
  full="$(git -C "${REPO}" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" || return 1
  [ -n "${full}" ] || return 1
  printf '%s\n' "${full#origin/}"
}

NAME="$(read_head || true)"

if [ -z "${NAME}" ]; then
  # Asks the remote and caches the answer in refs/remotes/origin/HEAD. Silenced
  # and allowed to fail: offline is a normal state for a close and the probe
  # below still answers for the two names that cover every repo here.
  git -C "${REPO}" remote set-head origin --auto >/dev/null 2>&1 || true
  NAME="$(read_head || true)"
fi

if [ -z "${NAME}" ]; then
  for candidate in main master; do
    if git -C "${REPO}" rev-parse --verify -q "origin/${candidate}" >/dev/null 2>&1; then
      NAME="${candidate}"
      break
    fi
  done
fi

if [ -z "${NAME}" ]; then
  echo "trunk: no trunk branch in ${REPO} — origin/HEAD is unset and neither origin/main nor origin/master exists" >&2
  exit 2
fi

if [ "${MODE}" = "ref" ]; then
  printf 'origin/%s\n' "${NAME}"
else
  printf '%s\n' "${NAME}"
fi
