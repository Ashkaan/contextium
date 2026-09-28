#!/usr/bin/env bash
# journal-file.sh — the path this session's journal entry goes to.
#
# A journal day is a FOLDER, `journal/<date>/`, and a session is one file in
# it: `<HHMM>-<stem>.md` (.agents/skills/close/references/journal-entry.md).
# One file per session means two sessions never write the same file, so
# concurrent closes cannot merge into, or drop, each other's entries.
#
# THE PATH IS RECORDED, not remembered, under the repo's git dir. A second
# /close in the same session — work continued after the first — resumes on the
# entry already written instead of filing a second one. The record is keyed by
# the session id when the harness exports one; without one, a recorded entry
# is resumed only while it is still uncommitted or modified, so the next
# session never inherits the last session's entry.
#
# Usage:
#   journal-file.sh "<stem>"   reserve and print the path — the file is
#                              created EMPTY, atomically, so two closes in the
#                              same minute with the same stem cannot get one
#                              path — and record it
#   journal-file.sh --existing print the recorded path if that file exists
#                              (a reserved, still-empty one included); exit 1
#                              if not
#   journal-file.sh --check    run check-journal-entry.sh on the recorded
#                              entry, then print its path; no writes
#
# Env:
#   CLAUDE_PROJECT_DIR     repo root; defaults to git's toplevel of the cwd
#   CLAUDE_CODE_SESSION_ID, CLAUDE_SESSION_ID, JOURNAL_SESSION_ID
#                          the session key, first one set wins
#   JOURNAL_STARTED        "YYYY-MM-DD HH:MM", the session's start, when the
#                          harness knows it; defaults to now (local time)
#
# Exit: 0 ok (path on stdout) · 1 no recorded entry on disk · 2 usage or repo
#       error · 3 --check found an invalid entry
#
# peers:
#   .agents/skills/close/scripts/journal-file.test.sh
#   .agents/skills/close/scripts/check-journal-entry.sh
#   .agents/skills/close/references/journal-entry.md

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fail() { echo "journal-file: $*" >&2; exit 2; }

[[ $# -eq 1 ]] || fail 'usage: journal-file.sh "<stem>" | --existing | --check'

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$ROOT" && -d "$ROOT" ]] || fail "not inside a git repo, and CLAUDE_PROJECT_DIR is unset"
ROOT="$(cd "$ROOT" && pwd)"
GIT_DIR_ABS="$(cd "$ROOT" && d="$(git rev-parse --git-common-dir 2>/dev/null)" && cd "$d" && pwd)" \
  || fail "not a git repo: $ROOT"

SID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-${JOURNAL_SESSION_ID:-}}}"
KEY="$(printf '%s' "${SID:-default}" | tr -c 'A-Za-z0-9_-' '_')"
RECORD="$GIT_DIR_ABS/contextium/journal-$KEY"

# The recorded path, if this session may still resume it; empty otherwise.
recorded() {
  local chosen
  [[ -f "$RECORD" ]] || return 0
  chosen="$(head -n 1 "$RECORD")"
  [[ -n "$chosen" && -f "$chosen" ]] || return 0
  if [[ -z "$SID" ]] && [[ -z "$(git -C "$ROOT" status --porcelain -- "$chosen" 2>/dev/null)" ]]; then
    return 0   # no session id and already committed: it belongs to an earlier session
  fi
  printf '%s\n' "$chosen"
}

if [[ "$1" == "--existing" || "$1" == "--check" ]]; then
  chosen="$(recorded)"
  [[ -n "$chosen" ]] || exit 1
  if [[ "$1" == "--check" ]]; then
    bash "$SCRIPT_DIR/check-journal-entry.sh" "$chosen" || exit 3
  fi
  printf '%s\n' "$chosen"
  exit 0
fi

# Kebab: lower-case, every run of anything else collapsed to one hyphen, ends
# trimmed, 60 characters at most.
STEM="$(printf '%s' "$1" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-60 \
  | sed -E 's/-+$//')"
[[ -n "$STEM" ]] || fail "stem '$1' has no usable characters"

# One `date` call, so the day and the time cannot straddle midnight.
STARTED="${JOURNAL_STARTED:-$(date '+%Y-%m-%d %H:%M')}"
STARTED_RE='^([0-9]{4}-[0-9]{2}-[0-9]{2})[ T]([0-9]{2}):([0-9]{2})'
[[ "$STARTED" =~ $STARTED_RE ]] \
  || fail "JOURNAL_STARTED must be 'YYYY-MM-DD HH:MM', got '$STARTED'"
DAY="${BASH_REMATCH[1]}"
HHMM="${BASH_REMATCH[2]}${BASH_REMATCH[3]}"

DAY_DIR="$ROOT/journal/$DAY"
mkdir -p "$DAY_DIR"

# Reserve the name by creating the file with noclobber: the create fails if
# the name exists, so of two sessions racing for one name exactly one wins and
# the other moves on to -2. A name tracked at HEAD but deleted from disk is
# taken too: it belongs to an earlier session.
reserve() {
  git -C "$ROOT" cat-file -e "HEAD:journal/$DAY/$1" 2>/dev/null && return 1
  ( set -C; : >"$DAY_DIR/$1" ) 2>/dev/null
}
NAME="$HHMM-$STEM.md"
N=1
until reserve "$NAME"; do
  N=$((N + 1))
  [[ "$N" -le 999 ]] || fail "no free name for $HHMM-$STEM in $DAY_DIR"
  NAME="$HHMM-$STEM-$N.md"
done

CHOSEN="$DAY_DIR/$NAME"
mkdir -p "$(dirname "$RECORD")"
printf '%s\n' "$CHOSEN" >"$RECORD"
printf '%s\n' "$CHOSEN"
