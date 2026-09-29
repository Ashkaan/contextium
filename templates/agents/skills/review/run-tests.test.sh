#!/usr/bin/env bash
# run-tests.test.sh — the folder runner aggregates: one planted red suite makes
# the run exit 1 and names it, a folder of green suites exits 0, and a missing
# folder is a caller error rather than a silent pass.
#
# Run: bash .agents/skills/review/run-tests.test.sh
#
# peers:
#   .agents/skills/review/run-tests.sh

set -uo pipefail

RUNNER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/run-tests.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/review-run-tests.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $*" >&2; }
check_rc() {
  if [[ "$2" == "$3" ]]; then ok; else bad "$1 — expected rc=$2, got rc=$3"; fi
}
check_has() {
  if grep -qF -- "$2" <<<"$3"; then ok; else bad "$1 — missing '$2'"; fi
}

mkdir -p "$TMP/green" "$TMP/mixed"
printf 'exit 0\n' >"$TMP/green/a.test.sh"
printf 'exit 0\n' >"$TMP/green/b.test.sh"
printf 'exit 0\n' >"$TMP/mixed/a.test.sh"
printf 'echo planted >&2; exit 1\n' >"$TMP/mixed/planted.test.sh"
printf 'exit 0\n' >"$TMP/mixed/z.test.sh"

rc=0; out="$(bash "$RUNNER" "$TMP/green" 2>&1)" || rc=$?
check_rc "all green exits 0" 0 "$rc"
check_has "and says so, with the count" "review: all 2 suites passed" "$out"

mkdir -p "$TMP/empty"
rc=0; out="$(bash "$RUNNER" "$TMP/empty" 2>&1)" || rc=$?
check_rc "a folder with no suites is not a pass" 1 "$rc"
check_has "and says what it found" "no *.test.sh in" "$out"

rc=0; out="$(bash "$RUNNER" "$TMP/mixed" 2>&1)" || rc=$?
check_rc "a planted failing suite makes the run exit 1" 1 "$rc"
check_has "naming the suite" "FAILED (1): planted.test.sh" "$out"
check_has "and the suites after it still ran" "── z.test.sh" "$out"

rc=0; out="$(bash "$RUNNER" "$TMP/nowhere" 2>&1)" || rc=$?
check_rc "a missing folder is a caller error" 2 "$rc"

echo "run-tests: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
