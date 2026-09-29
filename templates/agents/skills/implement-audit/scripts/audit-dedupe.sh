#!/usr/bin/env bash
# audit-dedupe.sh — once-per-session guard for /implement-audit.
#
# The implement-audit review can be invoked twice in one session: /implement
# fires it at phase-4.7, and it is also standalone-callable by hand afterwards.
# Without a guard the second invocation would fire a second full fresh-context
# review. This marker makes it a no-op that re-emits the first run's trailer
# instead of re-reviewing.
#
# Marker key: the harness's session id — CONTEXTIUM_SESSION, else Claude Code's
# CLAUDE_CODE_SESSION_ID, else a caller-fed CLAUDE_SESSION_ID (harness.sh reads
# them). When none is set the key is empty and the guard fails SAFE — status
# always `fresh`, mark skipped — instead of colliding on a shared constant: a
# `:-nosession` fallback makes every id-less session share ONE marker, so a
# completed audit's trailer bleeds into the next session and can falsely
# certify unreviewed code. The id is reduced to [A-Za-z0-9_-] so it names a file
# inside the state folder and nothing outside it. Worktree-independent so it
# works in both /implement worktree mode and standalone direct mode. The marker
# file stores the emitted `implement-audit:` trailer so the no-op path can
# reprint it for the close commit.
#
# Env: CONTEXTIUM_AUDIT_STATE_DIR — the marker folder (default
#      /tmp/implement-audit-done); the test suite points it at a temp dir.
#
# peers:
#   .agents/skills/implement-audit/SKILL.md
#   .agents/skills/implement/SKILL.md
#
# Usage:
#   audit-dedupe.sh status        → line 1 `fresh` (no prior run) OR `done`;
#                                    on `done`, line 2+ is the stored trailer.
#                                    Always exits 0 (informational).
#   audit-dedupe.sh mark "<trailer>" → record that the audit ran + its trailer.
# Exit: 0 ok; 2 usage error.

set -euo pipefail

DONE_DIR="${CONTEXTIUM_AUDIT_STATE_DIR:-/tmp/implement-audit-done}"
HARNESS_LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../close/scripts/harness.sh"
if [[ -f "$HARNESS_LIB" ]]; then
  # shellcheck disable=SC1090  # a sibling skill's file, resolved at run time
  source "$HARNESS_LIB"
  SID="$(harness_session_id)"
else
  SID="${CONTEXTIUM_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"
fi
# harness.sh sanitizes; the fallbacks are sanitized here the same way.
SID="${SID:-${CLAUDE_SESSION_ID:-}}"
SID="$(printf '%s' "$SID" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-64)"
MARKER="${SID:+$DONE_DIR/$SID}"

case "${1:-}" in
  status)
    if [[ -n "$MARKER" && -f "$MARKER" ]]; then
      echo "done"
      cat "$MARKER"
    else
      echo "fresh"
    fi
    ;;
  mark)
    trailer="${2:-}"
    [[ -n "$trailer" ]] || { echo "usage: audit-dedupe.sh mark \"<trailer>\"" >&2; exit 2; }
    if [[ -z "$MARKER" ]]; then
      echo "implement-audit: no session id (CONTEXTIUM_SESSION / CLAUDE_CODE_SESSION_ID unset) — dedupe skipped; carry the trailer inline" >&2
      exit 0
    fi
    mkdir -p "$DONE_DIR"
    printf '%s\n' "$trailer" > "$MARKER"
    echo "implement-audit: marked session $SID audited ($MARKER)"
    ;;
  *)
    echo "usage: audit-dedupe.sh status|mark" >&2
    exit 2
    ;;
esac
