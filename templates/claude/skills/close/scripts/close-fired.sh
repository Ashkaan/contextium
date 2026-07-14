#!/usr/bin/env bash
# close-fired.sh — the double-fire guard for auto-close.
#
# /spec and /implement auto-invoke /close on clean completion (the auto-close
# gate, SSOT: .claude/skills/close/references/auto-close-gate.md). If a verb
# halts at a depth-policy decision or a deferral AskUserQuestion and then
# resumes after the user answers, the auto-close gate must not dispatch /close a
# SECOND time. This session-scoped marker records that auto-close already fired.
#
# Marker key: the Claude session id. The harness exports CLAUDE_CODE_SESSION_ID
# (Claude Code >=2.x); older/parent-fed contexts set CLAUDE_SESSION_ID, kept in
# the fallback chain. When NEITHER is set the key is empty and the guard fails
# SAFE — status `not-fired`, mark skipped — so auto-close still fires (a rare
# same-session double-fire is far less harmful than a shared fallback key, which
# would make one session's fired-marker SUPPRESS auto-close in every later
# id-less session). One auto-close per session, regardless of how many times
# control re-reaches the gate.
#
# peers:
#   .claude/skills/close/references/auto-close-gate.md
#   .claude/skills/spec/SKILL.md
#   .claude/skills/implement/SKILL.md
#
# Usage:
#   close-fired.sh status   → `not-fired` (exit 0) OR `fired` (exit 0). Informational.
#   close-fired.sh mark      → record that auto-close fired this session.
# Exit: 0 ok; 2 usage error.

set -euo pipefail

FIRED_DIR="/tmp/close-fired"
SID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"
MARKER="${SID:+$FIRED_DIR/$SID}"

case "${1:-}" in
  status)
    if [[ -n "$MARKER" && -f "$MARKER" ]]; then
      echo "fired"
    else
      echo "not-fired"
    fi
    ;;
  mark)
    if [[ -z "$MARKER" ]]; then
      echo "close-fired: no session id (CLAUDE_CODE_SESSION_ID unset) — dedupe skipped" >&2
      exit 0
    fi
    mkdir -p "$FIRED_DIR"
    touch "$MARKER"
    echo "close-fired: marked session $SID ($MARKER)"
    ;;
  *)
    echo "usage: close-fired.sh status|mark" >&2
    exit 2
    ;;
esac
