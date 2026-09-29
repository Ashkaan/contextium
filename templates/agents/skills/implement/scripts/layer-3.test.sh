#!/usr/bin/env bash
# Test harness for layer-3.sh.
# peers: layer-3.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/layer-3.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0
assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

make_repo() {
  local d
  d=$(mktemp -d)
  # The workbench's checks, where an install puts them: stubs, so RAN lines are
  # deterministic — one that passes, one that fails.
  mkdir -p "$d/.agents/checks"
  printf '#!/usr/bin/env bash\nexit 0\n' >"$d/.agents/checks/check-decision-records.sh"
  printf '#!/usr/bin/env bash\necho "a key" >&2\nexit 1\n' >"$d/.agents/checks/check-secrets.sh"
  printf '%s' "$d"
}

# ── Case 1: the workbench's checks run, each one reported ──
case1() {
  local repo out rc
  repo=$(make_repo)
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT" --scope "apps/foo" 2>&1) || rc=$?
  rc="${rc:-0}"
  [[ "$rc" -eq 0 ]] || { assert_fail "case1" "expected zero; got $rc"; return; }
  echo "$out" | grep -q "RAN: check-decision-records.sh → PASS" \
    || { assert_fail "case1" "missing the passing RAN line: $out"; return; }
  echo "$out" | grep -q "RAN: check-secrets.sh → FAIL" \
    || { assert_fail "case1" "missing the failing RAN line: $out"; return; }
  echo "$out" | grep -q "check-skills.sh" \
    && { assert_fail "case1" "an absent check was reported: $out"; return; }
  assert_pass "case1 each-present-check-runs-and-is-reported"
}

# ── Case 2: a repo with no checks → NO-MATCH ──
case2() {
  local repo out rc
  repo=$(mktemp -d)
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT" --scope "integrations/google" 2>&1) || rc=$?
  rc="${rc:-0}"
  [[ "$rc" -eq 0 ]] || { assert_fail "case2" "expected zero; got $rc"; return; }
  echo "$out" | grep -q "NO-MATCH:" || { assert_fail "case2" "missing NO-MATCH: $out"; return; }
  assert_pass "case2 no-checks-no-match"
}

# ── Case 3 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo →
# resolve root via git rev-parse → RAN lines (exit 0) ──
case3() {
  local repo out rc=0
  repo=$(make_repo)
  git -C "$repo" init -q
  out=$( cd "$repo" && env -i HOME="$repo" PATH="/usr/bin:/bin" "$SCRIPT" --scope "apps/foo" 2>&1 ) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected zero with env unset inside repo; got $rc: $out"; return; }
  echo "$out" | grep -q "RAN: check-decision-records.sh" \
    || { assert_fail "case3" "missing RAN with env unset: $out"; return; }
  assert_pass "case3 env-unset-in-repo-resolves-via-git"
}

# ── Case 4 (Fix B): CLAUDE_PROJECT_DIR unset AND outside a git repo →
# hard-error preserved at exit 1 ──
case4() {
  local nongit out rc=0
  nongit=$(mktemp -d)
  out=$( cd "$nongit" && env -i HOME="$nongit" PATH="/usr/bin:/bin" "$SCRIPT" --scope "apps/foo" 2>&1 ) || rc=$?
  rm -rf "$nongit"
  [[ "$rc" -eq 1 ]] || { assert_fail "case4" "expected exit 1 unset+outside-repo; got $rc"; return; }
  echo "$out" | grep -q "not inside a git repo" || { assert_fail "case4" "missing hard-error msg: $out"; return; }
  assert_pass "case4 env-unset-outside-repo-hard-errors"
}

# ── Case 5: an advisory layer never fails the phase ──
case5() {
  local repo out rc=0
  repo=$(make_repo)
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT" --scope "" 2>&1) || rc=$?
  rm -rf "$repo"
  [[ "$rc" -eq 0 ]] || { assert_fail "case5" "a failing check must not fail layer 3; got $rc: $out"; return; }
  assert_pass "case5 a-failing-check-is-advisory"
}

case1
case2
case3
case4
case5

echo
echo "layer-3.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]