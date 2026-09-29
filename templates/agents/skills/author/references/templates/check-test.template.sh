#!/usr/bin/env bash
# {{name}}.test.sh — boundary rows for {{name}}.sh: 0 files, 1 clean file, 1
# violating file, the error names file + line + remediation.
#
# Every fixture lives in a throwaway directory; the check is run as a
# subprocess, never sourced.
set -uo pipefail  # no -e: each run below is expected to fail and is judged by `check`; an abort would hide the verdict

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/{{name}}.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [[ "$expected_rc" == "$actual_rc" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — expected rc=$expected_rc, got rc=$actual_rc" >&2
  fi
}

# has <name> <haystack> <needle> — the error names the thing the test claims.
has() {
  if [[ "$2" == *"$3"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output lacks '$3':" >&2
    printf '%s\n' "$2" | sed 's/^/    /' >&2
  fi
}

# ── 0 files: nothing to check is a pass ──
rc=0
bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
check "no files → exit 0" 0 "$rc"

# ── 1 clean file ──
printf 'clean\n' > "$TMP/clean.txt"
rc=0
bash "$SCRIPT" "$TMP/clean.txt" >/dev/null 2>&1 || rc=$?
check "clean file → exit 0" 0 "$rc"

# ── 1 violating file: TODO write the violation the check exists for ──
# The error must name the file, the line and the fix;
# fill the remediation needle with the words the check prints.
printf 'TODO the violating line\n' > "$TMP/bad.txt"
rc=0
out=$(bash "$SCRIPT" "$TMP/bad.txt" 2>&1) || rc=$?
check "violating file → exit 1" 1 "$rc"
has "the error names the file" "$out" "bad.txt"
has "the error names the line" "$out" "bad.txt:1"
has "the error names the fix" "$out" "TODO the remediation"

echo "{{name}}.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
