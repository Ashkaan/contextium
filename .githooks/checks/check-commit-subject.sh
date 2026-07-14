#!/usr/bin/env bash
# check-commit-subject.sh — validate a commit message subject. Single source of
# truth for the subject discipline, called by BOTH the Claude Code commit-gate
# hook and the tool-agnostic git commit-msg hook.
#
# Subject MUST be verb-led, <= 100 chars; the message MUST NOT carry an AI
# co-author trailer (the commit author is you). Wires @rule:mechanisms-not-prose.
#
# Usage: check-commit-subject.sh [<message-file>]   (default .git/COMMIT_EDITMSG)
#   The git commit-msg hook passes the message file path as $1.
# Exit 0 = ok, 1 = reject.
set -uo pipefail

MSGFILE="${1:-.git/COMMIT_EDITMSG}"
[[ -f "$MSGFILE" ]] || exit 0   # nothing to check
msg="$(cat "$MSGFILE")"
subject="$(printf '%s\n' "$msg" | grep -vE '^[[:space:]]*#|^[[:space:]]*$' | head -1)"
[[ -n "$subject" ]] || exit 0
case "$subject" in "Merge "*|"Revert "*) exit 0 ;; esac   # generated subjects exempt

fail() { echo "commit-msg: $*" >&2; exit 1; }

# AI co-author trailers — the commit author is the human operator.
if printf '%s\n' "$msg" | grep -qiE 'co-authored-by:.*(claude|gpt|codex|gemini|copilot|anthropic|openai)'; then
  fail "remove the AI Co-Authored-By trailer — the commit author is you."
fi

# Length.
if [[ "${#subject}" -gt 100 ]]; then
  fail "subject is ${#subject} chars (max 100). Move detail to the body."
fi

# Verb-led. Accept a bare leading verb OR a 'scope: verb ...' prefix.
verbs='add|fix|update|refactor|remove|rename|move|merge|revert|bump|docs|wip|chore|feat|build|test|style|perf|ci|hotfix|port|migrate|wire|consolidate|retire|archive|promote|extend|tighten|split|collapse|restore|replace|drop|land|ship|deploy|format|lint|enable|disable|audit|scaffold|seed|inline|extract|pin|init|setup|configure|document|clean|implement'
content="$(printf '%s' "$subject" | sed -E 's/^[a-z0-9_-]+(\([^)]*\))?:[[:space:]]*//I')"
first="$(printf '%s' "$content" | awk '{print tolower($1)}')"
if ! printf '%s' "$first" | grep -qiE "^($verbs)$"; then
  fail "subject must start with an action verb (e.g. add/fix/update). Got: '$subject'"
fi

# A verb with nothing after it says nothing. "wip", "chore", "fix" are the
# subjects this check exists to keep out of the log; the verb list alone would
# wave them through, so require the verb to actually act on something.
if [[ "$(printf '%s' "$content" | wc -w)" -lt 2 ]]; then
  fail "subject is a bare verb with no object. Say what changed. Got: '$subject'"
fi

exit 0
