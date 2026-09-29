#!/usr/bin/env bash
# Test harness for build-agent-prompts.sh — always exactly three role prompts,
# named so they sort into seat order, and no format or config to choose.
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

# ── Case 1: any question → exactly the three role prompts, in seat order ──
case1() {
  local out rc=0 dir order
  out=$("$SCRIPT" --question "X or Y?") || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case1" "expected 0; got $rc"; return; }
  dir="${out#prompts_dir=}"
  [[ -d "$dir" ]] || { assert_fail "case1" "dir not created: $dir"; return; }
  # Sorted order IS seat order: dispatch-agents.sh gives seat N to panel voice N.
  # `sed` rather than GNU find's -printf, which BSD find lacks.
  order=$(find "$dir" -name '*.prompt' | sed 's|.*/||' | sort | tr '\n' ' ')
  [[ "$order" == "pragmatist.prompt skeptic.prompt visionary.prompt " ]] \
    || { assert_fail "case1" "expected pragmatist, skeptic, visionary; got: $order"; return; }
  assert_pass "case1 three-roles-in-seat-order"
}

# ── Case 2: every prompt carries the question, its stance and the schema anchor ──
case2() {
  local out dir role
  out=$("$SCRIPT" --question "Should we ship feature X?")
  dir="${out#prompts_dir=}"
  for role in pragmatist skeptic visionary; do
    grep -q "Question: Should we ship feature X?" "$dir/$role.prompt" \
      || { assert_fail "case2" "$role prompt lacks the question"; return; }
    grep -q "^## Position" "$dir/$role.prompt" \
      || { assert_fail "case2" "$role prompt lacks the ## Position anchor the parser reads"; return; }
  done
  grep -q "Your assigned position: Skeptic" "$dir/skeptic.prompt" \
    || { assert_fail "case2" "skeptic prompt lacks its stance"; return; }
  assert_pass "case2 prompts-carry-question-stance-schema"
}

# ── Case 3: the removed choices are refused, not silently ignored ──
case3() {
  local out rc=0
  out=$("$SCRIPT" --question "q" --format council 2>&1) || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case3" "expected exit 2 on --format; got $rc"; return; }
  echo "$out" | grep -q "unknown flag: --format" || { assert_fail "case3" "missing unknown-flag msg: $out"; return; }
  rc=0
  "$SCRIPT" --question "q" --config cross >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case3" "expected exit 2 on --config; got $rc"; return; }
  assert_pass "case3 format-and-config-refused"
}

# ── Case 4: --question empty → fail loud, exit 2 ──
case4() {
  local out rc=0
  out=$("$SCRIPT" --question "" 2>&1) || rc=$?
  [[ "$rc" -eq 2 ]] || { assert_fail "case4" "expected exit 2; got $rc"; return; }
  echo "$out" | grep -q "question empty" || { assert_fail "case4" "missing empty msg"; return; }
  assert_pass "case4 empty-question-rejected"
}

# ── Case 5: --context-file path missing → fail loud ──
case5() {
  local out rc=0
  out=$("$SCRIPT" --question "q" --context-file /tmp/does-not-exist-$$ 2>&1) || rc=$?
  [[ "$rc" -ne 0 ]] || { assert_fail "case5" "expected non-zero on missing context"; return; }
  echo "$out" | grep -q "context file not found" || { assert_fail "case5" "missing not-found msg"; return; }
  assert_pass "case5 missing-context-file-rejected"
}

# ── Case 6: a context file reaches every prompt ──
case6() {
  local ctx out dir role
  ctx=$(mktemp)
  echo "- Decision: pick a queue" > "$ctx"
  out=$("$SCRIPT" --question "q" --context-file "$ctx")
  dir="${out#prompts_dir=}"
  for role in pragmatist skeptic visionary; do
    grep -q "Decision: pick a queue" "$dir/$role.prompt" \
      || { assert_fail "case6" "$role prompt lacks the context"; return; }
  done
  assert_pass "case6 context-reaches-every-prompt"
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
