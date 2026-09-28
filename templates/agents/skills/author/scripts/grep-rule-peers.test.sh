#!/usr/bin/env bash
# Test harness for grep-rule-peers.sh — covers the empty, single, many and error cases.
#
# peers: grep-rule-peers.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/grep-rule-peers.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# ── Case 1: missing arg → exit 2 ──
case1() {
  local rc=0 out
  out=$("$SCRIPT" 2>&1) || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case1" "expected exit 2; got $rc"; return; }
  echo "$out" | grep -q "usage:" || { assert_fail "case1" "missing usage"; return; }
  assert_pass "case1 missing-arg-fails"
}

# ── Case 2: missing file → non-zero ──
case2() {
  local rc=0
  "$SCRIPT" "$tmpdir/does-not-exist.md" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case2" "expected non-zero on missing file"; return; }
  assert_pass "case2 missing-file-fails"
}

# ── Case 3: zero sections → empty stdout, exit 0 ──
case3() {
  local f="$tmpdir/empty.md"
  cat > "$f" <<EOF
# Title only

Body with no h2 sections.
EOF
  local out rc=0
  out=$("$SCRIPT" "$f") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected exit 0; got $rc"; return; }
  [[ -z "$out" ]] || { assert_fail "case3" "expected empty stdout; got: $out"; return; }
  assert_pass "case3 zero-sections-empty-stdout"
}

# ── Case 4: N sections → N lines of `<n>:## <slug>` ──
case4() {
  local f="$tmpdir/with-rules.md"
  cat > "$f" <<EOF
# Some Rules

## first-rule
Body 1.

## second-rule
Body 2.

## third-rule
Body 3.
EOF
  local out rc=0
  out=$("$SCRIPT" "$f") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case4" "expected exit 0; got $rc"; return; }
  local n
  n=$(echo "$out" | grep -c '^[0-9]*:## ' || true)
  [[ "$n" -eq 3 ]] || { assert_fail "case4" "expected 3 sections; got $n. out=$out"; return; }
  echo "$out" | grep -q "## first-rule" || { assert_fail "case4" "missing first-rule"; return; }
  echo "$out" | grep -q "## second-rule" || { assert_fail "case4" "missing second-rule"; return; }
  echo "$out" | grep -q "## third-rule" || { assert_fail "case4" "missing third-rule"; return; }
  assert_pass "case4 three-sections-three-lines"
}

case1
case2
case3
case4

echo
echo "grep-rule-peers.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
