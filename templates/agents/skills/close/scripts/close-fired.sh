#!/usr/bin/env bash
# close-fired.sh — the double-fire guard for auto-close.
#
# A skill that auto-invokes /close (the gate:
# .agents/skills/close/references/auto-close-gate.md) may halt at a question and
# RESUME after the user answers. Without a marker the gate would dispatch /close
# a second time on the resume path. This session-scoped marker records that a
# given caller's auto-close already fired.
#
# THE MARKER IS PER CALLER. A session-wide latch set by one caller would
# suppress a later caller's auto-close in the same session, stranding that work
# uncommitted and unjournaled — the loss the gate exists to prevent.
#
# It never suppresses a close the USER asks for. A typed /close is an
# instruction, not a double-dispatch; only an auto-close gate consults this.
#
# Marker key: the session id + the caller name. Claude Code exports
# CLAUDE_CODE_SESSION_ID; older contexts set CLAUDE_SESSION_ID. When neither is
# set the guard fails SAFE — status `not-fired`, mark skipped — so auto-close
# still fires: a rare double close is less harmful than a shared constant key
# suppressing auto-close in every later id-less session.
#
# peers:
#   .agents/skills/close/references/auto-close-gate.md
#   .agents/skills/close/scripts/close-fired.test.sh
#
# Usage:
#   close-fired.sh status <caller>   → `not-fired` or `fired` (exit 0).
#   close-fired.sh mark   <caller>   → record that <caller>'s auto-close fired.
#   close-fired.sh any               → `fired` if ANY caller marked this session.
#
#   <caller> is the dispatching skill's name (spec, implement, implement-audit).
#   It defaults to `session` when absent; an EMPTY argument is refused, because
#   it means a caller interpolated an unset variable.
#
# Exit: 0 ok; 2 usage error (unknown verb, or a malformed caller name).

set -euo pipefail

FIRED_DIR="/tmp/close-fired"
SID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"

VERB="${1:-}"

# `any` takes no caller, so it is answered before the caller validation below.
if [ "$VERB" = "any" ]; then
  if [ -n "$SID" ] && compgen -G "$FIRED_DIR/${SID}.*" >/dev/null 2>&1; then
    echo "fired"
  else
    echo "not-fired"
  fi
  exit 0
fi

# `${2-session}`, not `${2:-session}`: the default applies only when the
# argument is ABSENT; a present-but-empty one is rejected below.
CALLER="${2-session}"

# The caller name becomes part of a filename. Constrain it to the same shape
# skill directories use so it can never escape FIRED_DIR or collide with a
# different caller through path trickery.
if ! [[ "$CALLER" =~ ^[a-z][a-z0-9-]{0,63}$ ]]; then
  echo "close-fired: invalid caller name \"$CALLER\" (expected ^[a-z][a-z0-9-]{0,63}\$)" >&2
  exit 2
fi

MARKER="${SID:+$FIRED_DIR/${SID}.${CALLER}}"

case "$VERB" in
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
    echo "close-fired: marked $CALLER for session $SID ($MARKER)"
    ;;
  *)
    echo "usage: close-fired.sh status|mark <caller> | close-fired.sh any" >&2
    exit 2
    ;;
esac
