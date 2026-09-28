#!/usr/bin/env bash
# Test harness for build-agent-prompts.sh — each format, both seat counts,
# and the bad-input cases.
#
# peers: build-agent-prompts.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/build-agent-prompts.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

# ── Case 1: dialectic + claude → 2 prompts (thesis + antithesis) ──
case1() {
  local out rc=0 dir
  out=$("$SCRIPT" --question "X or Y?" --format dialectic --config claude) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case1" "expected 0; got $rc"; return; }
  dir="${out#prompts_dir=}"
  [[ -d "$dir" ]] || { assert_fail "case1" "dir not created: $dir"; return; }
  local n
  n=$(find "$dir" -name '*.prompt' | wc -l)
  [[ "$n" -eq 2 ]] || { assert_fail "case1" "expected 2 prompts; got $n"; return; }
  [[ -f "$dir/thesis.prompt" && -f "$dir/antithesis.prompt" ]] \
    || { assert_fail "case1" "missing expected role files"; return; }
  assert_pass "case1 dialectic+claude=2"
}

# ── Case 2: dialectic + cross → 3 prompts (thesis + antithesis + third-position) ──
case2() {
  local out rc=0 dir n
  out=$("$SCRIPT" --question "X or Y?" --format dialectic --config cross) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case2" "expected 0; got $rc"; return; }
  dir="${out#prompts_dir=}"
  n=$(find "$dir" -name '*.prompt' | wc -l)
  [[ "$n" -eq 3 ]] || { assert_fail "case2" "expected 3; got $n"; return; }
  [[ -f "$dir/third-position.prompt" ]] || { assert_fail "case2" "missing third-position"; return; }
  assert_pass "case2 dialectic+cross=3"
}

# ── Case 3: redteam (any config) → 2 prompts (advocate + critic) ──
case3() {
  local out rc=0 dir n
  out=$("$SCRIPT" --question "Should we ship feature X?" --format redteam --config cross) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected 0; got $rc"; return; }
  dir="${out#prompts_dir=}"
  n=$(find "$dir" -name '*.prompt' | wc -l)
  [[ "$n" -eq 2 ]] || { assert_fail "case3" "expected 2; got $n"; return; }
  [[ -f "$dir/advocate.prompt" && -f "$dir/critic.prompt" ]] || { assert_fail "case3" "missing roles"; return; }
  # Critic uses different schema (Fatal Flaw section)
  grep -q "Fatal Flaw" "$dir/critic.prompt" || { assert_fail "case3" "critic missing Fatal Flaw schema"; return; }
  assert_pass "case3 redteam-2-roles-critic-schema"
}

# ── Case 4: a council with only 2 seats → reject ──
case4() {
  local out rc=0
  out=$("$SCRIPT" --question "What should we prioritize?" --format council --agents 2 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case4" "expected non-zero on council with 2 agents"; return; }
  echo "$out" | grep -q "council is a 3-agent format" || { assert_fail "case4" "missing reject msg: $out"; return; }
  # The old vendor-flavoured names still map to a seat count, so an existing
  # invocation keeps working rather than erroring on an unknown flag.
  rc=0
  out=$("$SCRIPT" --question "What should we prioritize?" --format council --config duo 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case4" "old --config duo should still map to 2 seats and be rejected for council"; return; }
  assert_pass "case4 council-needs-3-seats"
}

# ── Case 5: --question empty → fail loud, exit 2 ──
case5() {
  local out rc=0
  out=$("$SCRIPT" --question "" --format dialectic --config claude 2>&1) || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case5" "expected exit 2; got $rc"; return; }
  echo "$out" | grep -q "question empty" || { assert_fail "case5" "missing empty msg"; return; }
  assert_pass "case5 empty-question-rejected"
}

# ── Case 6: --context-file path missing → fail loud ──
case6() {
  local out rc=0
  out=$("$SCRIPT" --question "q" --format dialectic --config claude \
    --context-file /tmp/does-not-exist-$$ 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case6" "expected non-zero on missing context"; return; }
  echo "$out" | grep -q "context file not found" || { assert_fail "case6" "missing not-found msg"; return; }
  assert_pass "case6 missing-context-file-rejected"
}

case1
case2
case3
case4
case5
case6

echo
echo "build-agent-prompts.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
