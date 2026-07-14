#!/usr/bin/env bash
# push-with-retry.sh — Bounded retry for `git push origin <branch>`.
#
# No rebase / no fetch fallback. On a persistent push race, halt loud and surface
# to the user for manual reconciliation rather than auto-recovering with a
# history-rewriting move.
#
# Retries handle transient origin contention (a brief network flake, another
# push landing at the same moment). They do NOT handle a genuine divergence where
# origin/<branch> has commits this branch lacks — that's a manual decision the
# user makes, not something this script resolves on its own.
#
# Args:
#   $1 — branch name to push (typically "main")
#
# Env:
#   CLAUDE_PROJECT_DIR — absolute path to the repo. Optional; falls back to
#                        `git rev-parse --show-toplevel` when unset.
#
# Exit:
#   0 — push succeeded within the retry budget
#   3 — push race not resolving after N attempts (loud halt)
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

# CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall back to git
# when unset. The hard-error is preserved when not inside a git repo (no silent
# wrong-root).
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  echo "BLOCKED: CLAUDE_PROJECT_DIR unset and not inside a git repo" >&2
  exit 1
fi

MAX_ATTEMPTS=5
attempt=1
while [[ $attempt -le $MAX_ATTEMPTS ]]; do
  if git -C "$REPO_ROOT" push origin "$BRANCH"; then
    echo "Pushed $BRANCH to origin on attempt $attempt."
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
echo "Another session likely pushed to origin/$BRANCH while this session was committing." >&2
echo "" >&2
echo "Resolve manually:" >&2
echo "  cd \"$REPO_ROOT\"" >&2
echo "  git log HEAD..origin/$BRANCH    # see what's on origin that you lack" >&2
echo "  # decide your reconciliation strategy out-of-band, then re-invoke /close" >&2
exit 3
