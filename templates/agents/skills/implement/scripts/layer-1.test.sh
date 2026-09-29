#!/usr/bin/env bash
# Test harness for layer-1.sh — lint then typecheck, per package, by convention.
# peers: layer-1.sh
# shellcheck disable=SC2016  # the stub scripts are literal
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/layer-1.sh"
[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "SKIP: npm not installed"; echo "layer-1.sh: 0/0 passed"; exit 0; }

pass=0
fail=0
assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
# One root for every fixture, removed on exit. make_repo runs inside $(...),
# a subshell, so a list it appended to would never reach this trap.
ROOT="$(mktemp -d)"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

# make_repo — a repo; LOG records the order steps ran in.
make_repo() {
  local d
  d=$(mktemp -d "$ROOT/repo.XXXXXX")
  git -C "$d" init -q
  : >"$d/order.log"
  printf '%s' "$d"
}
# pkg <repo> <dir> <lint-cmd> <typecheck-cmd> [check-cmd] — "" leaves it out
pkg() {
  local d="$1/$2" s="" k
  mkdir -p "$d"
  for k in "lint:$3" "typecheck:$4" "check:${5:-}"; do
    [[ -n "${k#*:}" ]] && s="$s${s:+,}\"${k%%:*}\":\"${k#*:}\""
  done
  printf '{"name":"x","scripts":{%s}}\n' "$s" >"$d/package.json"
}
run() { OUT=$(CLAUDE_PROJECT_DIR="$1" "$SCRIPT" 2>/dev/null <<<"$2"); RC=$?; }

# ── Case 1: 0 files on stdin → PASS: layer-1 (0 files) ──
case1() {
  local repo; repo=$(make_repo)
  run "$repo" "" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-1 (0 files)"* ]] || { assert_fail "case1" "$RC $OUT"; return; }
  assert_pass "case1 zero-files"
}

# ── Case 2: lint then typecheck, in that order, for every package ──
case2() {
  local repo; repo=$(make_repo)
  pkg "$repo" apps/a "echo a-lint >> $repo/order.log" "echo a-type >> $repo/order.log"
  pkg "$repo" apps/b "echo b-lint >> $repo/order.log" "" "echo b-check >> $repo/order.log"
  run "$repo" $'apps/a/src/x.ts\napps/b/y.js' || true
  [[ "$RC" -eq 0 ]] || { assert_fail "case2" "exit $RC: $OUT"; return; }
  [[ "$(tr '\n' ' ' <"$repo/order.log")" == "a-lint b-lint a-type b-check " ]] \
    || { assert_fail "case2" "order: $(tr '\n' ' ' <"$repo/order.log")"; return; }
  [[ "$OUT" == *"PASS: layer-1 typecheck (apps/b)"* ]] || { assert_fail "case2" "npm check not taken as typecheck: $OUT"; return; }
  assert_pass "case2 lint-then-typecheck-and-check-counts"
}

# ── Case 3: lint fails → FAIL early; typecheck not run ──
case3() {
  local repo; repo=$(make_repo)
  pkg "$repo" apps/a "echo bad; exit 1" "echo a-type >> $repo/order.log"
  run "$repo" "apps/a/x.ts" || true
  [[ "$RC" -eq 1 && "$OUT" == *"FAIL: layer-1 lint (apps/a)"* ]] || { assert_fail "case3" "$RC $OUT"; return; }
  [[ ! -s "$repo/order.log" ]] || { assert_fail "case3" "typecheck ran after a lint failure"; return; }
  assert_pass "case3 lint-fails-early"
}

# ── Case 4: typecheck fails → FAIL ──
case4() {
  local repo; repo=$(make_repo)
  pkg "$repo" apps/a "true" "exit 2"
  run "$repo" "apps/a/x.ts" || true
  [[ "$RC" -eq 1 && "$OUT" == *"FAIL: layer-1 typecheck (apps/a)"* ]] || { assert_fail "case4" "$RC $OUT"; return; }
  assert_pass "case4 typecheck-fails"
}

# ── Case 5: a Makefile package, and a missing step is a WARN, not a FAIL ──
case5() {
  local repo; repo=$(make_repo)
  mkdir -p "$repo/tools/gen"
  printf 'lint:\n\t@true\n' >"$repo/tools/gen/Makefile"
  if ! command -v make >/dev/null 2>&1; then echo "SKIP: case5 (no make)"; return; fi
  run "$repo" "tools/gen/main.go" || true
  [[ "$RC" -eq 0 ]] || { assert_fail "case5" "exit $RC: $OUT"; return; }
  [[ "$OUT" == *"PASS: layer-1 lint (tools/gen)"* ]] || { assert_fail "case5" "make lint not run: $OUT"; return; }
  [[ "$OUT" == *"WARN: layer-1 typecheck (tools/gen) — no typecheck/check script or make target; skipped"* ]] \
    || { assert_fail "case5" "missing step not warned: $OUT"; return; }
  assert_pass "case5 make-target-and-missing-step-warns"
}

# ── Case 6: markdown and records select no package; a deleted file still does ──
case6() {
  local repo; repo=$(make_repo)
  pkg "$repo" . "echo root-lint >> $repo/order.log" ""
  run "$repo" $'README.md\njournal/2026-01-12/1200-x.md' || true
  [[ "$RC" -eq 0 && "$OUT" == *"no package in scope"* ]] || { assert_fail "case6" "records selected a package: $OUT"; return; }
  run "$repo" "src/deleted-file.ts" || true
  [[ "$OUT" == *"PASS: layer-1 lint ((root))"* ]] || { assert_fail "case6" "a deleted path lost its package: $OUT"; return; }
  assert_pass "case6 records-select-nothing-deleted-selects-its-package"
}

# ── Case 7 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo ──
case7() {
  local repo out rc=0; repo=$(make_repo)
  pkg "$repo" apps/a "true" "true"
  out=$(cd "$repo" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" <<<"apps/a/x.ts" 2>&1) || rc=$?
  [[ "$rc" -eq 0 && "$out" == *"PASS: layer-1 lint (apps/a)"* ]] || { assert_fail "case7" "$rc $out"; return; }
  assert_pass "case7 env-unset-in-repo-resolves-via-git"
}

# ── Case 8 (Fix B): CLAUDE_PROJECT_DIR unset AND outside a git repo → exit 1 ──
case8() {
  local nongit out rc=0
  nongit=$(mktemp -d "$ROOT/nongit.XXXXXX")
  out=$(cd "$nongit" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" <<<"x.ts" 2>&1) || rc=$?
  [[ "$rc" -eq 1 && "$out" == *"not inside a git repo"* ]] || { assert_fail "case8" "$rc $out"; return; }
  assert_pass "case8 env-unset-outside-repo-hard-errors"
}

case1; case2; case3; case4; case5; case6; case7; case8

echo
echo "layer-1.sh: ${pass}/$((pass + fail)) passed"
[[ "$fail" -eq 0 ]]
