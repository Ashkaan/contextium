#!/usr/bin/env bash
# audit-dedupe.sh — run the code review once per session, not once per caller.
#
# WHY THIS EXISTS
#
# /implement fires the code review when it finishes building. /close fires it as
# a backstop for work that never went through /implement. In a normal session
# both fire, and without a marker the second one re-reviews a diff the first one
# already cleared — a full reviewer call, and a fix loop, spent re-deciding
# settled code.
#
# Prose cannot close this. "Skip if /implement already audited" is a judgment the
# second caller has to make about a fact it cannot observe, and it will sometimes
# decide wrong. This marker turns it into a file test, and stores the first run's
# trailer so the second caller can re-emit it instead of re-earning it.
#
# MARKER KEY: the Claude session id. Claude Code exports CLAUDE_CODE_SESSION_ID;
# older contexts set CLAUDE_SESSION_ID, kept in the fallback chain. When NEITHER
# is set the key is empty and the guard fails SAFE — status is always `fresh` and
# `mark` is a no-op — rather than colliding on a shared constant. A shared
# constant would make every id-less session write the SAME marker, so one
# session's trailer could certify the next session's unreviewed code.
#
# USAGE
#   audit-dedupe.sh status   → line 1 `fresh` or `done`; on `done`, line 2+ is
#                              the stored trailer. Always exits 0.
#   audit-dedupe.sh mark "<trailer>"
#                            → record that the audit ran, and its trailer.
#
# EXIT: 0 ok; 2 usage error.

set -euo pipefail

DONE_DIR="${CONTEXTIUM_AUDIT_STATE_DIR:-/tmp/contextium-audit-done}"
SID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
MARKER="${SID:+$DONE_DIR/${SID//[^A-Za-z0-9_-]/_}}"

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
      echo "audit-dedupe: no session id (CLAUDE_CODE_SESSION_ID unset) — dedupe skipped;" >&2
      echo "              carry the trailer inline to the commit yourself." >&2
      exit 0
    fi
    mkdir -p "$DONE_DIR"
    printf '%s\n' "$trailer" > "$MARKER"
    echo "audit-dedupe: session marked audited ($MARKER)"
    ;;
  *)
    echo "usage: audit-dedupe.sh status|mark" >&2
    exit 2
    ;;
esac
