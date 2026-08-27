#!/usr/bin/env bash
# Test harness for parse-agent-output.sh — boundary cases mirror SPEC § 4
# of debate-rebuild.spec.md. Uses fixture files under scripts/fixtures/.
#
# peers: parse-agent-output.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/parse-agent-output.sh"
FIXTURES="$SCRIPT_DIR/fixtures"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }
[[ -d "$FIXTURES" ]] || { echo "FAIL: fixtures dir missing: $FIXTURES" >&2; exit 1; }

pass=0
fail=0

assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

# Per-case: copy selected fixtures into a tmpdir as `<role>.output`.
make_output_dir() {
  local d
  d=$(mktemp -d)
  while [[ $# -gt 0 ]]; do
    local role="$1" fixture="$2"
    cp "$FIXTURES/$fixture" "$d/${role}.output"
    shift 2
  done
  printf '%s' "$d"
}

# ── Case 1: clean output → cleaned block, no noise ──
case1() {
  local dir out rc=0
  dir=$(make_output_dir thesis clean.output)
  out=$("$SCRIPT" --output-dir "$dir") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case1" "expected 0; got $rc"; return; }
  echo "$out" | grep -q "=== thesis ===" || { assert_fail "case1" "missing role fence"; return; }
  echo "$out" | grep -q "^## Position" || { assert_fail "case1" "missing Position section"; return; }
  assert_pass "case1 clean-output"
}

# ── Case 2: codex header/footer noise → stripped ──
# LEGACY SHAPE. Codex v0.147.0 (2026-08-21) writes its banner and token count to
# STDERR, so live stdout now looks like case7's fixture. This case stays as the
# regression guard for the stripper — an older codex on another host, or a
# vendor that reverts to stdout noise, must still parse. Case 7 covers the
# shape the CLI actually produces today; neither alone is the real contract.
case2() {
  local dir out rc=0
  dir=$(make_output_dir antithesis codex-noise.output)
  out=$("$SCRIPT" --output-dir "$dir") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case2" "expected 0; got $rc"; return; }
  # The cleaned output must NOT include the codex noise header lines
  echo "$out" | grep -q "tokens-in: 1843" && { assert_fail "case2" "header noise leaked through"; return; }
  echo "$out" | grep -q "total tokens" && { assert_fail "case2" "footer noise leaked through"; return; }
  # But it SHOULD include the structured Position block
  echo "$out" | grep -q "Option B is the better choice" || { assert_fail "case2" "content missing"; return; }
  assert_pass "case2 codex-noise-stripped"
}

# ── Case 3: malformed (no ## Position) → warn + skip; exit non-zero if zero usable ──
case3() {
  local dir out rc=0
  dir=$(make_output_dir thesis malformed.output)
  out=$("$SCRIPT" --output-dir "$dir" 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case3" "expected non-zero on zero-usable; got $rc"; return; }
  echo "$out" | grep -q "malformed output" || { assert_fail "case3" "missing warn msg"; return; }
  assert_pass "case3 malformed-zero-usable-nonzero"
}

# ── Case 4: --round 2 against round-2 schema file → parses cleanly ──
case4() {
  local dir out rc=0
  dir=$(make_output_dir thesis round2.output)
  out=$("$SCRIPT" --output-dir "$dir" --round 2) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case4" "expected 0; got $rc: $out"; return; }
  echo "$out" | grep -q "## Rebuttal" || { assert_fail "case4" "missing Rebuttal section"; return; }
  echo "$out" | grep -q "## Revised Position" || { assert_fail "case4" "missing Revised section"; return; }
  assert_pass "case4 round-2-schema"
}

# ── Case 5: output dir contains only .gap files → empty stdout, non-zero exit ──
case5() {
  local dir out rc=0
  dir=$(mktemp -d)
  echo "timeout after 120s" > "$dir/thesis.gap"
  out=$("$SCRIPT" --output-dir "$dir" 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case5" "expected non-zero on no-output"; return; }
  echo "$out" | grep -q "no .output files" || { assert_fail "case5" "missing diagnostic msg"; return; }
  assert_pass "case5 only-gap-files-nonzero"
}

# ── Case 6: missing --output-dir → exit 2 ──
case6() {
  local rc=0
  "$SCRIPT" 2>/dev/null || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case6" "expected exit 2; got $rc"; return; }
  assert_pass "case6 missing-flag-exit-2"
}

# ── Case 7: real codex v0.147.0 stdout (banner on stderr) → parses intact ──
# Captured live from a `codex exec --sandbox=read-only --skip-git-repo-check
# --color never` run on 2026-08-21, the invocation dispatch-agents.sh now uses.
case7() {
  local dir out rc=0
  dir=$(make_output_dir critic codex-v0147-clean-stdout.output)
  out=$("$SCRIPT" --output-dir "$dir") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case7" "expected 0; got $rc"; return; }
  echo "$out" | grep -q "=== critic ===" || { assert_fail "case7" "missing role fence"; return; }
  echo "$out" | grep -q "^## Position" || { assert_fail "case7" "missing Position section"; return; }
  echo "$out" | grep -q "OpenAI Codex" && { assert_fail "case7" "banner leaked into stdout fixture"; return; }
  assert_pass "case7 codex-v0147-clean-stdout"
}

case1
case2
case3
case4
case5
case6
case7

echo
echo "parse-agent-output.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
