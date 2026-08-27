#!/usr/bin/env bash
# Tests for close-fired.sh — the per-caller auto-close double-fire guard.
#
# Run:  bash .claude/skills/close/scripts/close-fired.test.sh
# Exit: 0 all pass; 1 any failure.
#
# The load-bearing row is `isolation:ingest-does-not-suppress-spec`: that is the
# 2026-08-18 defect this script was rewritten to fix, and it is the one that
# must be able to come back negative.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/close-fired.sh"
PASS=0
FAIL=0

# Each case runs under its own fake session id so markers cannot leak between
# rows. /tmp/close-fired is the script's fixed home; the ids below are unique
# enough that a real session's marker can never be read or clobbered.
sid() { echo "test-close-fired-$1-$$"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL [$label]: expected '$expected', got '$actual'" >&2
  fi
}

check_exit() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL [$label]: expected exit $expected, got $actual" >&2
  fi
}

cleanup() { rm -f /tmp/close-fired/test-close-fired-*-$$.* 2>/dev/null || true; }
trap cleanup EXIT

# ── 0: nothing marked ──────────────────────────────────────────────────
S=$(sid a)
check "zero:status-is-not-fired" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" status spec)"

# ── 1: one mark, same caller ───────────────────────────────────────────
CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" mark spec >/dev/null 2>&1
check "one:same-caller-now-fired" "fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" status spec)"

# ── THE REGRESSION ROW ─────────────────────────────────────────────────
# A mid-session caller's mark MUST NOT suppress a different caller's
# auto-close in the same session. Before 2026-08-18 the marker was
# session-wide and this returned `fired`, stranding all later work.
S2=$(sid b)
CLAUDE_CODE_SESSION_ID="$S2" bash "$SCRIPT" mark ingest >/dev/null 2>&1
check "isolation:ingest-does-not-suppress-spec" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S2" bash "$SCRIPT" status spec)"
check "isolation:ingest-still-marked" "fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S2" bash "$SCRIPT" status ingest)"

# ── Sessions are isolated from each other ──────────────────────────────
S3=$(sid c)
check "isolation:other-session-unaffected" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S3" bash "$SCRIPT" status spec)"

# ── Idempotence: marking twice is not an error ─────────────────────────
CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" mark spec >/dev/null 2>&1
check_exit "idempotent:double-mark-exit0" "0" "$?"
check "idempotent:still-fired" "fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" status spec)"

# ── empty: no session id → fails SAFE (not-fired, mark is a no-op) ─────
check "empty:no-session-id-status" "not-fired" \
  "$(env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID bash "$SCRIPT" status spec)"
env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID bash "$SCRIPT" mark spec >/dev/null 2>&1
check_exit "empty:no-session-id-mark-exit0" "0" "$?"

# ── back-compat: caller omitted defaults to `session` ──────────────────
S4=$(sid d)
CLAUDE_CODE_SESSION_ID="$S4" bash "$SCRIPT" mark >/dev/null 2>&1
check "backcompat:default-caller-marked" "fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S4" bash "$SCRIPT" status)"
check "backcompat:default-is-its-own-key" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S4" bash "$SCRIPT" status spec)"

# ── legacy fallback env var still resolves ─────────────────────────────
S5=$(sid e)
CLAUDE_SESSION_ID="$S5" bash "$SCRIPT" mark spec >/dev/null 2>&1
check "legacy:CLAUDE_SESSION_ID-honored" "fired" \
  "$(CLAUDE_SESSION_ID="$S5" bash "$SCRIPT" status spec)"

# ── max: a 64-char caller is accepted, 65 is rejected ──────────────────
S6=$(sid f)
MAXC="a$(printf 'b%.0s' $(seq 1 63))"          # 64 chars
TOOLONG="a$(printf 'b%.0s' $(seq 1 64))"       # 65 chars
CLAUDE_CODE_SESSION_ID="$S6" bash "$SCRIPT" mark "$MAXC" >/dev/null 2>&1
check_exit "max:64-char-caller-accepted" "0" "$?"
CLAUDE_CODE_SESSION_ID="$S6" bash "$SCRIPT" status "$TOOLONG" >/dev/null 2>&1
check_exit "max:65-char-caller-rejected" "2" "$?"

# ── `any`: is this close running as SOMEBODY's auto-close? ─────────────
# /close § 2.5 asks this to pick interactive-vs-silent. It must see a mark made
# under any caller key, and must stay `not-fired` for a session with none.
S7=$(sid g)
check "any:none-marked" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S7" bash "$SCRIPT" any)"
CLAUDE_CODE_SESSION_ID="$S7" bash "$SCRIPT" mark reflection >/dev/null 2>&1
check "any:sees-another-callers-mark" "fired" \
  "$(CLAUDE_CODE_SESSION_ID="$S7" bash "$SCRIPT" any)"
check "any:other-session-still-clean" "not-fired" \
  "$(CLAUDE_CODE_SESSION_ID="$(sid h)" bash "$SCRIPT" any)"
check "any:no-session-id-is-not-fired" "not-fired" \
  "$(env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID bash "$SCRIPT" any)"

# ── error rows ─────────────────────────────────────────────────────────
bash "$SCRIPT" >/dev/null 2>&1
check_exit "error:no-verb" "2" "$?"
bash "$SCRIPT" bogus spec >/dev/null 2>&1
check_exit "error:unknown-verb" "2" "$?"

# A caller name must not be able to escape the marker directory.
CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" mark "../../etc/passwd" >/dev/null 2>&1
check_exit "error:path-traversal-rejected" "2" "$?"
CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" mark "Spec" >/dev/null 2>&1
check_exit "error:uppercase-caller-rejected" "2" "$?"
CLAUDE_CODE_SESSION_ID="$S" bash "$SCRIPT" mark "" >/dev/null 2>&1
check_exit "error:empty-caller-rejected" "2" "$?"

echo "close-fired: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
