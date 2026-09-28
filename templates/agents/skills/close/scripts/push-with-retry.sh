#!/usr/bin/env bash
# push-with-retry.sh — bounded retry for `git push origin <branch>`.
#
# Retries handle transient contention (another session pushing at the same
# moment, a brief network or lock failure). They do NOT pull, fetch or rebase:
# a genuine divergence, where origin has commits this branch lacks, is a
# decision the user makes, so the script halts loud and names the commands that
# show what is on origin.
#
# Args:
#   $1 — branch name to push
#
# Env:
#   CLAUDE_PROJECT_DIR — repo root. Optional; falls back to
#                        `git rev-parse --show-toplevel`.
#
# Exit:
#   0 — push succeeded within the retry budget
#   3 — push still rejected after N attempts (loud halt)
#   1 — invalid args or env

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: push-with-retry.sh <branch>" >&2
  exit 1
fi

BRANCH="$1"
BRANCH_REGEX='^[a-zA-Z][a-zA-Z0-9_/-]*$'
if ! [[ "$BRANCH" =~ $BRANCH_REGEX ]]; then
  echo "BLOCKED: branch name \"$BRANCH\" does not match $BRANCH_REGEX" >&2
  exit 1
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  echo "BLOCKED: CLAUDE_PROJECT_DIR unset and not inside a git repo" >&2
  exit 1
fi

MAX_ATTEMPTS=5
attempt=1
while [[ $attempt -le $MAX_ATTEMPTS ]]; do
  if git -C "$REPO_ROOT" push origin "$BRANCH"; then
    echo "✓ Pushed $BRANCH to origin on attempt $attempt."
    exit 0
  fi

  if [[ $attempt -lt $MAX_ATTEMPTS ]]; then
    delay=$((2 ** attempt))
    echo "Push attempt $attempt failed — retrying in ${delay}s..." >&2
    sleep "$delay"
  fi
  attempt=$((attempt + 1))
done

echo "" >&2
echo "BLOCKED: push race not resolving after $MAX_ATTEMPTS attempts." >&2
echo "origin/$BRANCH likely has commits this branch lacks, or the remote refused the push." >&2
echo "" >&2
echo "Resolve manually:" >&2
echo "  cd \"$REPO_ROOT\"" >&2
echo "  git log HEAD..origin/$BRANCH    # see what's on origin that you lack" >&2
echo "  # decide how to reconcile (merge or rebase is the user's call), then re-run /close" >&2
exit 3
