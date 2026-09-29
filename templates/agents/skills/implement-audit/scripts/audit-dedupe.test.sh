#!/usr/bin/env bash
# audit-dedupe.test.sh — peer of audit-dedupe.sh: fresh → mark → done with the
# stored line, sessions isolated, and the fail-safe with no session id.
# Run: bash audit-dedupe.test.sh
set -uo pipefail

SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/audit-dedupe.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export CONTEXTIUM_AUDIT_STATE_DIR="$TMP/state"

pass=0; fail=0
is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$3]"; echo "  actual:   [$2]"; fi; }
as() { local sid="$1"; shift; env -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION CLAUDE_CODE_SESSION_ID="$sid" bash "$SUT" "$@" 2>/dev/null; }
LINE="implement-audit: codex, round-2, 3 findings (3 fixed, 0 open) — APPROVE"

is "a new session is fresh" "$(as s1 status)" "fresh"
as s1 mark "$LINE" >/dev/null
is "after mark it is done, with the line" "$(as s1 status)" "done
$LINE"
is "another session is still fresh" "$(as s2 status)" "fresh"
is "a session id with a slash cannot escape the state dir" "$(as '../x' mark "$LINE" >/dev/null; find "$TMP" -mindepth 1 -maxdepth 1 -exec basename {} \; | paste -s -d' ' -)" "state"

rc=0; env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION bash "$SUT" mark "$LINE" >/dev/null 2>&1 || rc=$?
is "no session id: mark is a no-op, exit 0" "$rc" "0"
is "no session id: status is always fresh" "$(env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION bash "$SUT" status)" "fresh"

env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID CONTEXTIUM_SESSION=cx1 bash "$SUT" mark "$LINE" >/dev/null 2>&1
is "CONTEXTIUM_SESSION keys the marker too" "$(env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID CONTEXTIUM_SESSION=cx1 bash "$SUT" status)" "done
$LINE"

rc=0; as s3 mark "" >/dev/null 2>&1 || rc=$?
is "mark with no line is a usage error" "$rc" "2"
rc=0; as s3 bogus >/dev/null 2>&1 || rc=$?
is "an unknown verb is a usage error" "$rc" "2"

echo "audit-dedupe.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
