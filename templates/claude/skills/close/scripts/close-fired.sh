#!/usr/bin/env bash
# close-fired.sh — the double-fire guard for auto-close.
#
# A skill that auto-invokes /close (the auto-close gate; SSOT:
# .claude/skills/close/references/auto-close-gate.md) may halt at a hard stop or
# a deferral AskUserQuestion and then RESUME after the user answers. Without a
# marker the gate would dispatch /close a second time on the resume path. This
# session-scoped marker records that a given caller's auto-close already fired.
#
# THE MARKER IS PER-CALLER, NOT PER-SESSION (changed 2026-08-18). It used to be
# one marker per session, which was safe while only /spec, /implement and
# /update auto-closed — each of those ENDS the session, and the loop's
# fresh-context boundary means two of them never run in one session. Enrolling
# five mid-session skills (/ingest, /reflection, /quarterly-review,
# /team-member, /mock-trial) broke that assumption: a session-wide latch set by
# a 10am /ingest would suppress the auto-close of anything that ran afterward,
# stranding hours of later work uncommitted and unjournaled — the exact loss the
# gate exists to prevent, caused by the gate. Keying on the caller keeps the
# resume-path guard each caller needs while leaving every other caller free.
#
# WHAT THIS GUARD IS NOT. It does NOT and MUST NOT suppress a close the USER
# asks for. A user typing /close, or saying "close the session", is not a
# double-dispatch — it is an instruction, and @rule:user-is-final-arbiter says
# it wins. Only an auto-close gate consults this marker.
#
# Marker key: the Claude session id + the caller name. The harness exports
# CLAUDE_CODE_SESSION_ID (Claude Code >=2.x); older/parent-fed contexts set
# CLAUDE_SESSION_ID, kept in the fallback chain. When NEITHER is set the key is
# empty and the guard fails SAFE — status `not-fired`, mark skipped — so
# auto-close still fires (a rare same-session double-fire is far less harmful
# than the prior `:-nosession` collision, which made one session's fired-marker
# SUPPRESS auto-close in every later id-less session).
#
# peers:
#   .claude/skills/close/references/auto-close-gate.md
#   .claude/skills/close/scripts/close-fired.test.sh
#
# Usage:
#   close-fired.sh status <caller>   → `not-fired` (exit 0) OR `fired` (exit 0).
#   close-fired.sh mark   <caller>   → record that <caller>'s auto-close fired.
#   close-fired.sh any               → `fired` if ANY caller marked this session.
#
#   `any` answers a different question from `status`, and only /close asks it:
#   "am I running as somebody's auto-close, or did the user invoke me directly?"
#   /close's § 2.5 recurrence check uses that to decide whether to offer an
#   interactive fix (manual close) or log silently (auto-close). Before the
#   marker became per-caller, a bare `status` answered this by accident; it no
#   longer does, because there is no longer a single session-wide key.
#
#   <caller> is the dispatching skill's name (spec, implement, update, ingest,
#   reflection, quarterly-review, team-member, mock-trial). It is optional for
#   back-compat and defaults to `session`; new callers MUST pass it.
#
# Exit: 0 ok; 2 usage error (missing/!unknown verb, or a malformed caller name).

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
# argument is ABSENT. An argument that is present but empty means a caller
# interpolated an unset variable, and silently treating that as the shared
# `session` key would merge two callers' markers — exactly the collision this
# rewrite removed. It is rejected below instead.
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
