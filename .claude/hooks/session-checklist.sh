#!/usr/bin/env bash
# First-message session checklist (UserPromptSubmit hook).
# Fires once per session via a session_id sentinel so the checklist surfaces
# at session start and not on every prompt.
#
# additionalContext injects a short start-of-session checklist: classify the
# session, then journal + commit at the end via /close.

set -euo pipefail

INPUT=$(cat)

SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
DEDUP_KEY_RAW="${SESSION_ID:-$PPID}"
DEDUP_KEY=$(printf '%s' "$DEDUP_KEY_RAW" | tr -cd 'a-zA-Z0-9-')
[ -z "$DEDUP_KEY" ] && DEDUP_KEY="$PPID"

SENTINEL="/tmp/claude-session-checklist-${DEDUP_KEY}"
[ -f "$SENTINEL" ] && exit 0

touch "$SENTINEL"

echo "$(date -Iseconds) session-checklist fired (dedup-key=${DEDUP_KEY})" >> "/tmp/claude-hooks-log-${DEDUP_KEY}"

jq -n '{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit",
    "additionalContext": "SESSION START CHECKLIST:\n1. Classify this session: New Project | Existing | One-Off (default: journal-only).\n2. For non-trivial work, skim the relevant knowledge/ context before starting.\n3. Before ending: create or update today'"'"'s journal, commit, and push (via /close)."
  }
}'
