#!/usr/bin/env bash
# Test harness for layer-2.sh — each package's tests, by convention.
# peers: layer-2.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/layer-2.sh"
[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "SKIP: npm not installed"; echo "layer-2.sh: 0/0 passed"; exit 0; }

pass=0
fail=0
assert_pass() { echo "ok: $1"; pass=$((pass + 1)); }
assert_fail() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
# One root for every fixture, removed on exit. make_repo runs inside $(...),
# a subshell, so a list it appended to would never reach this trap.
ROOT="$(mktemp -d)"
cleanup() { rm -rf "$ROOT"; }
trap cleanup EXIT

make_repo() { local d; d=$(mktemp -d "$ROOT/repo.XXXXXX"); git -C "$d" init -q; printf '%s' "$d"; }
run() { OUT=$(CLAUDE_PROJECT_DIR="$1" "$SCRIPT" 2>/dev/null <<<"$2"); RC=$?; }
ok_test='import { test } from "node:test"; import { strict as assert } from "node:assert"; test("ok", () => assert.equal(1, 1));'
bad_test='import { test } from "node:test"; import { strict as assert } from "node:assert"; test("bad", () => assert.equal(1, 2));'

# ── Case 1: empty stdin → PASS (no tests in scope) ──
case1() {
  local repo; repo=$(make_repo)
  run "$repo" "" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 (no tests in scope)"* ]] || { assert_fail "case1" "$RC $OUT"; return; }
  assert_pass "case1 empty-stdin"
}

# ── Case 2: a package with no test script and no test files → no tests in scope ──
case2() {
  local repo; repo=$(make_repo)
  mkdir -p "$repo/apps/foo/src"; printf '{"name":"foo"}\n' >"$repo/apps/foo/package.json"
  run "$repo" "apps/foo/src/x.ts" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 apps/foo (no tests in scope)"* ]] || { assert_fail "case2" "$RC $OUT"; return; }
  assert_pass "case2 package-without-tests"
}

# ── Case 3: the package's own test script wins, pass and fail ──
case3() {
  local repo; repo=$(make_repo)
  mkdir -p "$repo/apps/foo"; printf '{"name":"foo","scripts":{"test":"true"}}\n' >"$repo/apps/foo/package.json"
  run "$repo" "apps/foo/x.ts" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 apps/foo (npm test)"* ]] || { assert_fail "case3" "$RC $OUT"; return; }
  printf '{"name":"foo","scripts":{"test":"exit 1"}}\n' >"$repo/apps/foo/package.json"
  run "$repo" "apps/foo/x.ts" || true
  [[ "$RC" -eq 1 && "$OUT" == *"FAIL: layer-2 apps/foo"* ]] || { assert_fail "case3" "a red npm test passed: $RC $OUT"; return; }
  assert_pass "case3 own-test-script-pass-and-fail"
}

# ── Case 4: a Makefile test target ──
case4() {
  if ! command -v make >/dev/null 2>&1; then echo "SKIP: case4 (no make)"; return; fi
  local repo; repo=$(make_repo)
  mkdir -p "$repo/tools/gen"; printf 'test:\n\t@true\n' >"$repo/tools/gen/Makefile"
  run "$repo" "tools/gen/main.go" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 tools/gen (make test)"* ]] || { assert_fail "case4" "$RC $OUT"; return; }
  assert_pass "case4 make-test-target"
}

# ── Case 5: an integration with no package runs its *.test.ts in place ──
case5() {
  if ! node --experimental-strip-types -e '' 2>/dev/null; then echo "SKIP: case5 (node cannot strip types)"; return; fi
  local repo; repo=$(make_repo)
  mkdir -p "$repo/integrations/bar"
  printf '%s\n' "$ok_test" >"$repo/integrations/bar/client.test.ts"
  run "$repo" "integrations/bar/client.ts" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 integrations/bar (1 tests)"* ]] || { assert_fail "case5" "$RC $OUT"; return; }
  printf '%s\n' "$bad_test" >"$repo/integrations/bar/client.test.ts"
  run "$repo" "integrations/bar/client.ts" || true
  [[ "$RC" -eq 1 && "$OUT" == *"FAIL: layer-2 integrations/bar"* ]] || { assert_fail "case5" "a red in-place test passed: $RC $OUT"; return; }
  assert_pass "case5 in-place-tests-pass-and-fail"
}

# ── Case 6: records and markdown select no tests ──
case6() {
  local repo; repo=$(make_repo)
  printf '{"name":"root","scripts":{"test":"exit 1"}}\n' >"$repo/package.json"
  run "$repo" $'README.md\njournal/2026-01-12/1200-x.md\nprojects/web/x/README.md' || true
  [[ "$RC" -eq 0 && "$OUT" == *"no tests in scope"* ]] || { assert_fail "case6" "records ran a suite: $RC $OUT"; return; }
  assert_pass "case6 records-run-nothing"
}

# ── Case 7 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo ──
case7() {
  local repo out rc=0; repo=$(make_repo)
  out=$(cd "$repo" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" </dev/null 2>&1) || rc=$?
  [[ "$rc" -eq 0 && "$out" == *"PASS: layer-2"* ]] || { assert_fail "case7" "$rc $out"; return; }
  assert_pass "case7 env-unset-in-repo-resolves-via-git"
}

# ── Case 8 (Fix B): CLAUDE_PROJECT_DIR unset AND outside a git repo → exit 1 ──
case8() {
  local nongit out rc=0
  nongit=$(mktemp -d "$ROOT/nongit.XXXXXX")
  out=$(cd "$nongit" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" </dev/null 2>&1) || rc=$?
  [[ "$rc" -eq 1 && "$out" == *"not inside a git repo"* ]] || { assert_fail "case8" "$rc $out"; return; }
  assert_pass "case8 env-unset-outside-repo-hard-errors"
}

# ── Case 9: JavaScript test files are found in place too ──
# Scope now carries every file a package owns, JavaScript included, so the
# in-place fallback must run *.test.js / .mjs / .cjs as well as *.test.ts —
# otherwise a JS package's failing tests pass as "no tests in scope".
case9() {
  local repo; repo=$(make_repo)
  mkdir -p "$repo/integrations/js"
  printf '%s\n' "const { test } = require('node:test'); const assert = require('node:assert'); test('bad', () => assert.equal(1, 2));" >"$repo/integrations/js/a.test.cjs"
  printf '%s\n' "import { test } from 'node:test'; test('ok', () => {});" >"$repo/integrations/js/b.test.mjs"
  printf '%s\n' "const { test } = require('node:test'); test('ok', () => {});" >"$repo/integrations/js/c.test.js"
  run "$repo" "integrations/js/index.js" || true
  [[ "$RC" -eq 1 && "$OUT" == *"FAIL: layer-2 integrations/js"* ]] || { assert_fail "case9" "a failing .cjs test was not run: $RC $OUT"; return; }
  rm "$repo/integrations/js/a.test.cjs"
  run "$repo" "integrations/js/index.js" || true
  [[ "$RC" -eq 0 && "$OUT" == *"PASS: layer-2 integrations/js (2 tests)"* ]] || { assert_fail "case9" "the .mjs and .js tests were not both run: $RC $OUT"; return; }
  assert_pass "case9 js-tests-in-place"
}

case1; case2; case3; case4; case5; case6; case7; case8; case9

echo
echo "layer-2.sh: ${pass}/$((pass + fail)) passed"
[[ "$fail" -eq 0 ]]
