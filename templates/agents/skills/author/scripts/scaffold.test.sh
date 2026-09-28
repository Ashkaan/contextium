#!/usr/bin/env bash
# Test harness for scaffold.sh — the boundary cases of each type: a valid
# name, a non-kebab name, an unknown type, a collision.
#
# scaffold.sh writes into CLAUDE_PROJECT_DIR when it is set, so this harness
# pins it to the checkout it asserts against; otherwise a live session could
# have the scaffold write into a different tree than the one being checked.
#
# Destructive cases (skill/hook/agent writes) use throwaway kebab names under a
# `zz-` prefix and clean up after themselves.
#
# peers: scaffold.sh, verify.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/scaffold.sh"
# Five levels, not four: scripts -> author -> skills -> agents -> templates -> the
# repo root. Stopping at templates/ left the collision case with no rules to
# compare against, so a slug that already exists came back clean.
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../../.." && pwd)"
export CLAUDE_PROJECT_DIR="$REPO_ROOT"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0
assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

# Track artifacts to clean up on exit.
CLEANUP=()
cleanup() {
  for p in "${CLEANUP[@]:-}"; do
    [[ -n "$p" ]] && rm -rf "${REPO_ROOT:?}/${p:?}"
  done
}
trap cleanup EXIT

run() {
  # echo combined stdout+stderr then ---RC=<code>
  local rc=0 out
  out=$("$SCRIPT" "$@" 2>&1) || rc=$?
  printf '%s\n---RC=%s\n' "$out" "$rc"
}
rc_of() { echo "$1" | tail -n 1 | sed 's/---RC=//'; }
out_of() { echo "$1" | sed '$d'; }

# ── Case 1: unknown type → exit 2, no write ──
case_unknown_type() {
  local res rc
  res=$(run command foo); rc=$(rc_of "$res")
  [[ "$rc" -eq 2 ]] || { assert_fail "unknown-type" "expected exit 2; got $rc"; return; }
  out_of "$res" | grep -q "valid types" || { assert_fail "unknown-type" "missing valid-types hint"; return; }
  assert_pass "unknown-type rejected exit2"
}

# ── Case 2: empty name (no name) → exit 2, prompt message ──
case_empty_name() {
  local res rc
  res=$(run skill ""); rc=$(rc_of "$res")
  [[ "$rc" -eq 2 ]] || { assert_fail "empty-name" "expected exit 2; got $rc"; return; }
  out_of "$res" | grep -qi "name required" || { assert_fail "empty-name" "missing name-required msg"; return; }
  assert_pass "empty-name prompts exit2"
}

# ── Case 3: non-kebab name → exit 1, regex cited, no write ──
case_non_kebab() {
  local res rc
  res=$(run skill MySkill); rc=$(rc_of "$res")
  [[ "$rc" -eq 1 ]] || { assert_fail "non-kebab" "expected exit 1; got $rc"; return; }
  out_of "$res" | grep -q '\[a-z\]' || { assert_fail "non-kebab" "missing kebab regex"; return; }
  [[ ! -e "$REPO_ROOT/.agents/skills/MySkill" ]] || { assert_fail "non-kebab" "wrote a dir anyway"; return; }
  assert_pass "non-kebab rejected exit1"
}

# ── Case 4: skill round-trip → writes SKILL.md, prints path ──
case_skill_write() {
  local name="zz-scaffold-test-skill" res rc path
  CLEANUP+=(".agents/skills/$name")
  res=$(run skill "$name"); rc=$(rc_of "$res")
  [[ "$rc" -eq 0 ]] || { assert_fail "skill-write" "expected exit 0; got $rc: $res"; return; }
  path=$(out_of "$res")
  [[ "$path" == ".agents/skills/$name/SKILL.md" ]] || { assert_fail "skill-write" "bad path: $path"; return; }
  [[ -f "$REPO_ROOT/$path" ]] || { assert_fail "skill-write" "file not written"; return; }
  grep -q "name: $name" "$REPO_ROOT/$path" || { assert_fail "skill-write" "{{name}} not substituted"; return; }
  ! grep -q "{{name}}" "$REPO_ROOT/$path" || { assert_fail "skill-write" "unsubstituted placeholder remains"; return; }
  assert_pass "skill-write round-trip"
}

# ── Case 5: collision → 2nd write exits 1, 1st file intact ──
case_collision() {
  local name="zz-scaffold-test-collide" res rc
  CLEANUP+=(".agents/skills/$name")
  run skill "$name" >/dev/null
  [[ -f "$REPO_ROOT/.agents/skills/$name/SKILL.md" ]] || { assert_fail "collision" "first write missing"; return; }
  res=$(run skill "$name"); rc=$(rc_of "$res")
  [[ "$rc" -eq 1 ]] || { assert_fail "collision" "expected exit 1 on 2nd; got $rc"; return; }
  out_of "$res" | grep -qi "exists" || { assert_fail "collision" "missing exists msg"; return; }
  [[ -f "$REPO_ROOT/.agents/skills/$name/SKILL.md" ]] || { assert_fail "collision" "first file clobbered"; return; }
  assert_pass "collision refuses overwrite"
}

# ── Case 6: hook round-trip (default + checks placement) ──
case_hook_write() {
  local name="zz-scaffold-test-hook" res rc path
  CLEANUP+=(".claude/hooks/$name.sh" ".githooks/checks/$name.sh")
  res=$(run hook "$name"); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".claude/hooks/$name.sh" ]] || { assert_fail "hook-write" "default placement wrong: rc=$rc path=$path"; return; }
  [[ -x "$REPO_ROOT/$path" ]] || { assert_fail "hook-write" "hook not executable"; return; }
  res=$(run hook "$name" checks); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".githooks/checks/$name.sh" ]] || { assert_fail "hook-write" "checks placement wrong: rc=$rc path=$path"; return; }
  assert_pass "hook-write both placements"
}

# ── Case 7: agent round-trip ──
case_agent_write() {
  local name="zz-scaffold-test-agent" res rc path
  CLEANUP+=(".agents/reviewers/$name.md")
  res=$(run agent "$name"); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".agents/reviewers/$name.md" ]] || { assert_fail "agent-write" "rc=$rc path=$path"; return; }
  grep -q "name: $name" "$REPO_ROOT/$path" || { assert_fail "agent-write" "{{name}} not substituted"; return; }
  assert_pass "agent-write round-trip"
}

# ── Case 8: rule writes nothing, prints guidance ──
case_rule_no_write() {
  local res rc
  res=$(run rule "zz-scaffold-test-rule-slug"); rc=$(rc_of "$res")
  [[ "$rc" -eq 0 ]] || { assert_fail "rule-no-write" "expected exit 0; got $rc: $res"; return; }
  out_of "$res" | grep -qi "scaffolds inline" || { assert_fail "rule-no-write" "missing inline guidance"; return; }
  assert_pass "rule prints guidance no-write"
}

# ── Case 9: rule slug collision → exit 1 citing rule-stable-id ──
case_rule_collision() {
  # Use a slug known to exist in .agents/rules/ (mechanisms-not-prose).
  local res rc
  res=$(run rule "mechanisms-not-prose"); rc=$(rc_of "$res")
  [[ "$rc" -eq 1 ]] || { assert_fail "rule-collision" "expected exit 1; got $rc: $res"; return; }
  out_of "$res" | grep -q "rule-stable-id" || { assert_fail "rule-collision" "missing rule-stable-id citation"; return; }
  assert_pass "rule-collision rejected"
}

case_unknown_type
case_empty_name
case_non_kebab
case_skill_write
case_collision
case_hook_write
case_agent_write
case_rule_no_write
case_rule_collision

echo
echo "scaffold.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
