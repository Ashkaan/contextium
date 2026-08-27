#!/usr/bin/env bash
# check-audit-trailers.sh — a commit that changes code or a SPEC must say who
# reviewed it.
#
# WHY A GIT HOOK AND NOT A SKILL STEP
#
# The skills already fire the reviews. But a skill only binds the agent running
# it: a hand-written commit, a different agent, or a session that skipped the
# loop all land unreviewed with nothing to notice. This hook fires during every
# commit regardless of who made it, which makes it the backstop rather than the
# gate — by the time it runs, the review should already have happened.
#
# WHAT IT CHECKS
#   staged code changed   → the message needs an `implement-audit:` line
#   a staged SPEC changed → the message needs a `spec-audit:` line
#
# It checks that the line EXISTS. It cannot tell a real trailer from an invented
# one, and it is not trying to: the point is that skipping the review has to be
# a deliberate lie rather than an oversight.
#
# WHAT COUNTS AS "CODE"
#   Any staged file with a code extension, outside the AI layer itself, with more
#   than a trivial number of changed lines in total. Docs, journals, and config
#   are exempt — the loop's review is for behavior, and gating a README typo on a
#   reviewer call is how a gate teaches people to bypass it.
#
#   The AI layer (.claude/ and .githooks/) is exempt for a different reason: it
#   is code you installed rather than code you wrote. Without that exemption the
#   first commit after installing — the one that commits the layer — is refused
#   by the gate the layer just installed, and so is every template upgrade after
#   it. A gate whose first act is to block a commit nobody could have reviewed
#   teaches people to reach for the escape hatch on day one.
#
# USAGE (from .githooks/commit-msg):
#   bash .githooks/checks/check-audit-trailers.sh "$1"
#
# ESCAPE HATCH: set CONTEXTIUM_SKIP_AUDIT_GATE=1 for one commit. Deliberate,
# visible, and not the default.
#
# EXIT: 0 pass; 1 a required trailer is missing.

set -euo pipefail

MSG_FILE="${1:?commit message file required}"
[[ -f "$MSG_FILE" ]] || { echo "check-audit-trailers: no message file at $MSG_FILE" >&2; exit 1; }

if [[ "${CONTEXTIUM_SKIP_AUDIT_GATE:-}" == "1" ]]; then
  echo "check-audit-trailers: skipped (CONTEXTIUM_SKIP_AUDIT_GATE=1)" >&2
  exit 0
fi

# Line threshold before a code change is "substantial" enough to need a review.
CODE_LINE_THRESHOLD="${CONTEXTIUM_AUDIT_LINE_THRESHOLD:-50}"

CODE_EXT_RE='\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|c|h|cc|cpp|sh|bash)$'
LAYER_PATH_RE='^(\.claude/|\.githooks/)'
SPEC_PATH_RE='(SPEC\.md$|\.spec\.md$|/specs/.*\.md$)'

staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
[[ -n "$staged" ]] || exit 0   # nothing staged: nothing to gate

msg="$(cat "$MSG_FILE")"
fail=0

# ── Code ─────────────────────────────────────────────────────────────
code_files="$(grep -E "$CODE_EXT_RE" <<<"$staged" | grep -vE "$LAYER_PATH_RE" || true)"
if [[ -n "$code_files" ]]; then
  changed_lines=0
  while IFS= read -r f; do
    [[ -n "$f" ]] || continue
    n="$(git diff --cached --numstat -- "$f" 2>/dev/null | awk '{a+=$1; d+=$2} END {print a+d+0}')"
    [[ "$n" =~ ^[0-9]+$ ]] || n=0
    changed_lines=$((changed_lines + n))
  done <<< "$code_files"

  if [[ "$changed_lines" -gt "$CODE_LINE_THRESHOLD" ]]; then
    if ! grep -qE '^[[:space:]]*implement-audit:' <<<"$msg"; then
      echo "COMMIT BLOCKED: ${changed_lines} changed lines of code with no code review on the record." >&2
      echo "  Run /implement-audit (or let /implement fire it), then put its trailer in the message:" >&2
      echo "    implement-audit: <reviewer>, <N> rounds, <M> findings (<X> fixed, <Y> open) — APPROVE" >&2
      echo "  If the review genuinely does not apply, commit once with CONTEXTIUM_SKIP_AUDIT_GATE=1." >&2
      fail=1
    fi
  fi
fi

# ── SPECs ────────────────────────────────────────────────────────────
spec_files="$(grep -E "$SPEC_PATH_RE" <<<"$staged" || true)"
if [[ -n "$spec_files" ]]; then
  if ! grep -qE '^[[:space:]]*spec-audit:' <<<"$msg"; then
    echo "COMMIT BLOCKED: a SPEC changed with no SPEC review on the record." >&2
    printf '  %s\n' $spec_files >&2
    echo "  Run /spec-audit, then put its trailer in the message:" >&2
    echo "    spec-audit: <reviewer> round-1; spirit MATCH" >&2
    echo "  A non-material edit still emits a trailer — format-trailer.sh skipped-non-material <reason>." >&2
    fail=1
  fi
fi

exit "$fail"
