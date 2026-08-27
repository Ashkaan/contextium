#!/usr/bin/env bash
# Test harness for run-rule-linters.sh — boundary cases mirror
# SPEC § 4 of propose-rule-rebuild.spec.md.
#
# Hermetic: builds a fake REPO_ROOT with stub linters under .claude/hooks/checks/.
#
# peers: run-rule-linters.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-rule-linters.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

assert_pass() {
  echo "ok: $1"
  pass=$((pass + 1))
}

assert_fail() {
  echo "FAIL: $1 — $2" >&2
  fail=$((fail + 1))
}

# ── Build fake repo with stubbed linters (variable exit codes per case) ──
make_repo() {
  local fmt_code="${1:-0}" refs_code="${2:-0}" int_code="${3:-0}"
  local d
  d=$(mktemp -d)
  mkdir -p "$d/.claude/hooks/checks" "$d/.claude/rules"
  git -C "$d" init -q
  cat > "$d/.claude/hooks/checks/check-rule-format.sh" <<EOF
#!/usr/bin/env bash
echo "stub-format ran on \$*" >&2
exit $fmt_code
EOF
  cat > "$d/.claude/hooks/checks/check-rule-refs.sh" <<EOF
#!/usr/bin/env bash
echo "stub-refs ran" >&2
exit $refs_code
EOF
  cat > "$d/.claude/hooks/checks/check-rule-integration-refs.sh" <<EOF
#!/usr/bin/env bash
echo "stub-int ran on \$*" >&2
exit $int_code
EOF
  chmod +x "$d/.claude/hooks/checks/"*.sh
  echo "## sample-rule" > "$d/.claude/rules/feedback.md"
  printf '%s' "$d"
}

run_script() {
  local repo="$1"; shift
  local rc=0 out
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT" "$@" 2>&1) || rc=$?
  printf '%s\n---RC=%s\n' "$out" "$rc"
}

# ── Case 1: missing arg → exit 2, usage on stderr ──
case1() {
  local out rc
  out=$(env -i PATH="/usr/bin:/bin" "$SCRIPT" 2>&1) || rc=$?
  rc="${rc:-0}"
  [[ "$rc" -eq 2 ]] || { assert_fail "case1" "expected exit 2; got $rc"; return; }
  echo "$out" | grep -q "usage:" || { assert_fail "case1" "missing usage line"; return; }
  assert_pass "case1 missing-arg-fails"
}

# ── Case 2: rule file does not exist → exit 1; no linter invoked ──
case2() {
  local repo out rc
  repo=$(make_repo 0 0 0)
  out=$(run_script "$repo" "$repo/.claude/rules/does-not-exist.md")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case2" "expected non-zero on missing file"; return; }
  echo "$out" | grep -q "not found" || { assert_fail "case2" "missing not-found msg"; return; }
  # Stubs should NOT have run
  echo "$out" | grep -q "stub-format ran" && { assert_fail "case2" "linter ran despite missing file"; return; }
  assert_pass "case2 missing-file-fails-before-linters"
}

# ── Case 3: all shipped linters pass → PASS lines + exit 0 ──
case3() {
  local repo out rc
  repo=$(make_repo 0 0 0)
  out=$(run_script "$repo" "$repo/.claude/rules/feedback.md")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected zero; got $rc: $out"; return; }
  echo "$out" | grep -q "PASS — check-rule-format" || { assert_fail "case3" "missing format PASS"; return; }
  echo "$out" | grep -q "PASS — check-rule-refs" || { assert_fail "case3" "missing refs PASS"; return; }
  assert_pass "case3 all-pass-exits-zero"
}

# ── Case 4: first linter fails → exit 1; linters 2+3 not invoked ──
case4() {
  local repo out rc
  repo=$(make_repo 1 0 0)
  out=$(run_script "$repo" "$repo/.claude/rules/feedback.md")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case4" "expected non-zero on first linter fail"; return; }
  echo "$out" | grep -q "FAIL — check-rule-format" || { assert_fail "case4" "missing FAIL marker"; return; }
  # Make sure linters 2 and 3 never ran
  echo "$out" | grep -q "stub-refs ran" && { assert_fail "case4" "refs linter ran after format failed"; return; }
  assert_pass "case4 first-linter-fails-short-circuits"
}

case1
case2
case3
case4

echo
echo "run-rule-linters.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
