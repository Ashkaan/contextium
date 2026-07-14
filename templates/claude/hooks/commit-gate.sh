#!/usr/bin/env bash
# commit-gate.sh — Claude Code PreToolUse(Bash) adapter for the commit checks.
# It is the Claude-Code-specific front end; the actual checks live ONCE in
# .githooks/checks/check-commit-subject.sh + .githooks/checks/check-secrets.sh, which the
# tool-agnostic git hooks (.githooks/) also call. Single source of truth per
# @rule:mechanisms-not-prose + the no-duplication principle.
#
# Behavior: only inspects `git commit` invocations; extracts the inline message
# (-m / --message= / -F); runs the shared subject check on it and the shared
# secret scan on the staged diff. A reject (exit 1 from a check) becomes a
# PreToolUse hard-refuse (exit 2). Editor-mode commits (no inline message) skip
# the subject check; the git commit-msg hook covers those.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SUBJECT_CHECK="$REPO_ROOT/.githooks/checks/check-commit-subject.sh"
SECRET_CHECK="$REPO_ROOT/.githooks/checks/check-secrets.sh"

INPUT="$(cat 2>/dev/null || true)"
CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"
[[ -n "$CMD" ]] || exit 0
printf '%s' "$CMD" | grep -qE '\bgit\b.*\bcommit\b' || exit 0

block() { echo "COMMIT GATE: $*" >&2; exit 2; }

# ── Extract an inline message, if any ──────────────────────────────────────
msg=""
if [[ "$CMD" =~ -m[[:space:]]+\"([^\"]*)\" ]]; then msg="${BASH_REMATCH[1]}"
elif [[ "$CMD" =~ -m[[:space:]]+\'([^\']*)\' ]]; then msg="${BASH_REMATCH[1]}"
elif [[ "$CMD" =~ --message=\"([^\"]*)\" ]]; then msg="${BASH_REMATCH[1]}"
elif [[ "$CMD" =~ -F[[:space:]]+([^[:space:]]+) ]] || [[ "$CMD" =~ --file=([^[:space:]]+) ]]; then
  f="${BASH_REMATCH[1]}"; [[ -f "$f" ]] && msg="$(cat "$f")"
fi

# ── Subject discipline (delegate to the shared check) ──────────────────────
if [[ -n "$msg" ]] && [[ -x "$SUBJECT_CHECK" || -f "$SUBJECT_CHECK" ]]; then
  tmp="$(mktemp)"; printf '%s\n' "$msg" > "$tmp"
  out="$(bash "$SUBJECT_CHECK" "$tmp" 2>&1)"; rc=$?
  rm -f "$tmp"
  [[ $rc -eq 0 ]] || block "${out#commit-msg: }"
fi

# ── Secret scan (delegate to the shared check) ─────────────────────────────
if [[ -x "$SECRET_CHECK" || -f "$SECRET_CHECK" ]]; then
  out="$(bash "$SECRET_CHECK" 2>&1)"; rc=$?
  [[ $rc -eq 0 ]] || block "${out#pre-commit: }"
fi

exit 0