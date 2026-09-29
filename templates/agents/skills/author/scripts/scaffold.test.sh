#!/usr/bin/env bash
# Test harness for scaffold.sh — boundary cases for the name contract (unknown
# type, empty name, non-kebab, collision) and each type's round-trip.
#
# scaffold.sh writes into THIS SESSION's write root (session-write-root.sh), not
# a self-located repo root, so this harness pins CONTEXT_WRITE_ROOT to the
# checkout it is asserting against. Without the pin the test was asserting in one
# tree while the scaffold wrote in another: run from a worktree with a live
# session it wrote into the MAIN checkout, and four cases failed with "file not
# written" while the files sat, uncleaned, one directory over.
#
# Destructive cases (skill/hook/agent writes) still use throwaway kebab names
# under a `zz-` prefix and clean up after themselves.
#
# peers: scaffold.sh, verify.sh, ../../implement/scripts/session-write-root.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/scaffold.sh"
# A scaffolded skill lands under `<workbench>/.agents/skills/`. Skill cases run
# against a throwaway SKILLS_ROOT — without it they would scaffold into the live
# tree and lean on the cleanup trap to take it back out. REPO_ROOT is asked of
# git, and governs the hook/agent cases, which write into a repo.
SKILLS_ROOT="$(mktemp -d -t author-skills-XXXXXX)"
export SKILLS_ROOT
# REPO_ROOT is a THROWAWAY workbench, not a live checkout. Pointing it at the
# real one would make every hook/agent case write a file into the working tree
# and lean on the cleanup trap to take it out again, so the cases run somewhere
# disposable.
REPO_ROOT="$(mktemp -d -t author-repo-XXXXXX)"
mkdir -p "$REPO_ROOT/.agents/hooks" "$REPO_ROOT/.agents/checks" "$REPO_ROOT/.agents/agents"
export CONTEXT_WRITE_ROOT="$REPO_ROOT"

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
  [[ -n "${SKILLS_ROOT:-}" ]] && rm -rf "${SKILLS_ROOT:?}"
  [[ -n "${REPO_ROOT:-}" && "$REPO_ROOT" == */author-repo-* ]] && rm -rf "${REPO_ROOT:?}"
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
  [[ ! -e "$SKILLS_ROOT/MySkill" ]] || { assert_fail "non-kebab" "wrote a dir anyway"; return; }
  assert_pass "non-kebab rejected exit1"
}

# ── Case 4: skill round-trip → writes SKILL.md, prints path ──
case_skill_write() {
  local name="zz-scaffold-test-skill" res rc path
  res=$(run skill "$name"); rc=$(rc_of "$res")
  [[ "$rc" -eq 0 ]] || { assert_fail "skill-write" "expected exit 0; got $rc: $res"; return; }
  path=$(out_of "$res")
  # The skill branch prints an ABSOLUTE path — SKILLS_ROOT need not sit under
  # the write root, so there is nothing for a relative one to be relative to.
  [[ "$path" == "$SKILLS_ROOT/$name/SKILL.md" ]] || { assert_fail "skill-write" "bad path: $path"; return; }
  [[ -f "$path" ]] || { assert_fail "skill-write" "file not written"; return; }
  grep -q "name: $name" "$path" || { assert_fail "skill-write" "{{name}} not substituted"; return; }
  ! grep -q "{{name}}" "$path" || { assert_fail "skill-write" "unsubstituted placeholder remains"; return; }
  assert_pass "skill-write round-trip"
}

# ── Case 5: collision → 2nd write exits 1, 1st file intact ──
case_collision() {
  local name="zz-scaffold-test-collide" res rc
  run skill "$name" >/dev/null
  [[ -f "$SKILLS_ROOT/$name/SKILL.md" ]] || { assert_fail "collision" "first write missing"; return; }
  res=$(run skill "$name"); rc=$(rc_of "$res")
  [[ "$rc" -eq 1 ]] || { assert_fail "collision" "expected exit 1 on 2nd; got $rc"; return; }
  out_of "$res" | grep -qi "exists" || { assert_fail "collision" "missing exists msg"; return; }
  [[ -f "$SKILLS_ROOT/$name/SKILL.md" ]] || { assert_fail "collision" "first file clobbered"; return; }
  assert_pass "collision refuses overwrite"
}

# ── Case 6: hook round-trip (default + checks placement) ──
case_hook_write() {
  local name="zz-scaffold-test-hook" res rc path
  CLEANUP+=(".agents/hooks/$name.sh" ".agents/checks/$name.sh" ".agents/checks/$name.test.sh")
  res=$(run hook "$name"); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".agents/hooks/$name.sh" ]] || { assert_fail "hook-write" "default placement wrong: rc=$rc path=$path"; return; }
  [[ -x "$REPO_ROOT/$path" ]] || { assert_fail "hook-write" "hook not executable"; return; }
  res=$(run hook "$name" checks); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".agents/checks/$name.sh" ]] || { assert_fail "hook-write" "checks placement wrong: rc=$rc path=$path"; return; }
  [[ -x "$REPO_ROOT/$path" ]] || { assert_fail "hook-write" "check not executable"; return; }
  [[ -f "$REPO_ROOT/.agents/checks/$name.test.sh" ]] || { assert_fail "hook-write" "checks placement wrote no $name.test.sh beside the check"; return; }
  grep -q "$name.sh" "$REPO_ROOT/.agents/checks/$name.test.sh" || { assert_fail "hook-write" "the test does not name the check it tests"; return; }
  assert_pass "hook-write both placements"
}

# ── Case 7: agent round-trip ──
case_agent_write() {
  local name="zz-scaffold-test-agent" res rc path
  CLEANUP+=(".agents/agents/$name.md")
  res=$(run agent "$name"); rc=$(rc_of "$res"); path=$(out_of "$res")
  [[ "$rc" -eq 0 && "$path" == ".agents/agents/$name.md" ]] || { assert_fail "agent-write" "rc=$rc path=$path"; return; }
  grep -q "name: $name" "$REPO_ROOT/$path" || { assert_fail "agent-write" "{{name}} not substituted"; return; }
  assert_pass "agent-write round-trip"
}

# ── Case 8: output-style round-trip ──
# Styles live in the shared layer (.agents/output-styles/), which the installer
# links from ~/.claude/output-styles; there is no in-repo .claude/.
case_output_style_write() {
  local name="zz-scaffold-test-style" res rc path
  CLEANUP+=(".agents/output-styles/$name.md")
  res=$(run output-style "$name"); rc=$(rc_of "$res"); path=$(out_of "$res" | head -n 1)
  [[ "$rc" -eq 0 && "$path" == ".agents/output-styles/$name.md" ]] || { assert_fail "output-style-write" "rc=$rc path=$path"; return; }
  grep -q "name: $name" "$REPO_ROOT/$path" || { assert_fail "output-style-write" "{{name}} not substituted"; return; }
  [[ ! -e "$REPO_ROOT/.claude" ]] || { assert_fail "output-style-write" "wrote an in-repo .claude/"; return; }
  res=$(run output-style "$name"); rc=$(rc_of "$res")
  [[ "$rc" -eq 1 ]] || { assert_fail "output-style-write" "a second scaffold must refuse the collision, got rc=$rc"; return; }
  assert_pass "output-style-write round-trip"
}

case_unknown_type
case_empty_name
case_non_kebab
case_skill_write
case_collision
case_hook_write
case_agent_write
case_output_style_write

echo
echo "scaffold.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
