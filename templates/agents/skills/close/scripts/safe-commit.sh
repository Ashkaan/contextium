#!/usr/bin/env bash
# Contract: commit ONLY this session's files, unstaging any other session's staged work first (non-destructively) so it cannot ride along.
# Usage: safe-commit.sh <subject> <file> [file...]   Exit 2 = bad args; 3 = lock timeout; other non-zero = commit failed.
#
# Reading the index and committing are one critical section under a lock file,
# the same one any other automated committer to this repo should take. Without
# the lock, a file another session stages between the check and the commit rides
# along under this session's subject; narrowing the window never closes it.
# flock(1) when it is installed; on a system without it (stock macOS) the
# lock.sh symlink lock with the same wait bound.
set -euo pipefail

SUBJECT="${1:-}"
shift || true

REPO_ROOT="${CLAUDE_PROJECT_DIR:-}"
if [[ -z "$REPO_ROOT" ]]; then
  REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
    echo "safe-commit: not in a git repo and CLAUDE_PROJECT_DIR is unset" >&2
    exit 2
  }
fi

if [[ -z "$SUBJECT" ]]; then
  echo "safe-commit: commit subject required" >&2
  exit 2
fi

if [[ $# -eq 0 ]]; then
  echo "safe-commit: at least one file required — this script exists so the file list is explicit" >&2
  exit 2
fi

MINE=("$@")

# ── Take the shared repo lock for the whole read-then-write ────────────────
# fd 201 rather than 200 so an inherited-and-unlocked fd 200 from a calling
# script can never be confused with this one. Both knobs are overridable so the
# paired test can contend on its own lock file with a short bound.
LOCK_FILE="${CONTEXT_REPO_GIT_LOCK:-${SAFE_COMMIT_LOCK:-/tmp/context-repo-git.lock}}"
LOCK_WAIT="${SAFE_COMMIT_LOCK_WAIT:-120}"
lock_timeout() {
  echo "safe-commit: could not acquire $LOCK_FILE within ${LOCK_WAIT}s." >&2
  echo "Another /close or an automation writer is committing to this repo." >&2
  echo "NOTHING was staged or committed. Re-run in a moment." >&2
  exit 3
}
if command -v flock >/dev/null 2>&1 && [[ -z "${SAFE_COMMIT_NO_FLOCK:-}" ]]; then
  exec 201>"$LOCK_FILE"
  flock -w "$LOCK_WAIT" 201 || lock_timeout
else
  # No flock (stock macOS): lock.sh's pid symlink, with a dead holder's lock
  # taken over one taker at a time.
  # shellcheck disable=SC1091  # sibling file, resolved at run time
  source "$(dirname "${BASH_SOURCE[0]}")/lock.sh"
  lock_take "$LOCK_FILE.d" "$LOCK_WAIT" || lock_timeout
fi

# Everything currently staged that this session did not ask for. On a shared
# working tree that is another session's work, and a plain `git commit` would
# file it under this session's subject line.
FOREIGN=()
while IFS= read -r staged; do
  [[ -n "$staged" ]] || continue
  keep=""
  for f in "${MINE[@]}"; do
    [[ "$staged" == "$f" ]] && { keep=1; break; }
  done
  [[ -n "$keep" ]] || FOREIGN+=("$staged")
done < <(git -C "$REPO_ROOT" diff --cached --name-only)

# Unstage, never discard: `git restore --staged` leaves the working-tree content
# untouched, so the other session keeps its changes and only loses its staging.
# Losing staging is recoverable in one command; having your work committed under
# someone else's subject is not.
if [[ ${#FOREIGN[@]} -gt 0 ]]; then
  echo "safe-commit: unstaging ${#FOREIGN[@]} file(s) staged by another session (working tree untouched):" >&2
  for f in "${FOREIGN[@]}"; do
    printf '  %s\n' "$f" >&2
  done
  git -C "$REPO_ROOT" restore --staged -- "${FOREIGN[@]}"
fi

git -C "$REPO_ROOT" add -- "${MINE[@]}"

# A normal commit, not a pathspec commit: the pre-commit hook regenerates the
# generated indexes and `git add`s them, and a pathspec commit builds its tree
# from HEAD plus the named paths only, so those regenerated files would be
# silently dropped from the commit.
git -C "$REPO_ROOT" commit -m "$SUBJECT"
