#!/usr/bin/env bash
# Contract: commit ONLY this session's files, unstaging any other session's staged work first (non-destructively) so it cannot ride along.
# Usage: safe-commit.sh <subject> <file> [file...]   Exit 2 = bad args; 3 = lock timeout; other non-zero = commit failed.
#
# The check-then-commit race this header used to document as a KNOWN LIMIT is
# CLOSED as of 2026-07-25. Foreign files were read from the index once and then
# the commit ran; anything another session staged in that window rode along —
# observed 2026-07-24 on this script's own first live use, when a concurrent
# session's file deletion was staged after the check and landed in the commit.
# Narrowing the window never closes it; only a lock does. The unstage + commit
# now runs under /tmp/context-repo-git.lock, the SAME lock the SSH-automation
# path has taken since 2026-06-03 (integrations/github/git_local.ts) and that
# any other automated committer holds across its own commit + push. One lock, every writer to this
# repo's shared index.
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
# The refuse-loud
#         shape), integrations/github/git_local.ts:424-425 (same lock, same 120s
#         bound). fd 201 rather than 200 so an inherited-and-unlocked fd 200 from
#         a calling script can never be confused with this one.
# Everything from here to the commit is one critical section: reading the index,
# unstaging what is not ours, staging what is, and committing. A lock around only
# the commit would leave the original race exactly where it was.
# Both overridable so the paired test can exercise contention against its own
# lock file with a short bound, instead of taking the real host-wide lock and
# blocking live automation for two minutes.
LOCK_FILE="${CONTEXT_REPO_GIT_LOCK:-${SAFE_COMMIT_LOCK:-/tmp/context-repo-git.lock}}"
LOCK_WAIT="${SAFE_COMMIT_LOCK_WAIT:-120}"
exec 201>"$LOCK_FILE"
if ! flock -w "$LOCK_WAIT" 201; then
  echo "safe-commit: could not acquire $LOCK_FILE within ${LOCK_WAIT}s." >&2
  echo "Another /close or an automation writer is committing to this repo." >&2
  echo "NOTHING was staged or committed. Re-run in a moment." >&2
  exit 3
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
