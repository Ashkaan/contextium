#!/usr/bin/env bash
# Test harness for resolve-scope.sh — boundary cases mirror SPEC § 4 of
# validate-rebuild.spec.md.
#
# peers: resolve-scope.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/resolve-scope.sh"

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

make_repo() {
  local d
  d=$(mktemp -d)
  (
    cd "$d"
    git init -q
    git config user.email t@t
    git config user.name t
    mkdir -p apps/foo apps/bar integrations/baz projects/p/2026-01-01_x
    mkdir -p apps/dom/wanted apps/dom/sibling
    echo "a" > apps/foo/a.ts
    echo "b" > apps/foo/b.ts
    echo "c" > apps/bar/c.ts
    echo "w" > apps/dom/wanted/w.ts
    echo "s" > apps/dom/sibling/s.ts
    echo "d" > integrations/baz/d.ts
    echo "e" > projects/p/2026-01-01_x/notes.md
    git add -A
    git commit -q -m init
  )
  printf '%s' "$d"
}

# ── Case 11: a package that is not TypeScript still has files in scope ──
# The layers find each file's package and run its own lint and tests, so a
# JavaScript (or any other) package must reach them; filtering to *.ts made a
# JS-only package an empty scope that passed without running anything.
# Installed dependencies and git internals stay out.
case11() {
  local repo out rc
  repo=$(make_repo)
  mkdir -p "$repo/apps/jsapp/src" "$repo/apps/jsapp/node_modules/dep" "$repo/integrations/py"
  echo '{"name":"jsapp"}' >"$repo/apps/jsapp/package.json"
  echo "x" >"$repo/apps/jsapp/src/index.js"
  echo "x" >"$repo/apps/jsapp/node_modules/dep/i.js"
  echo "x" >"$repo/integrations/py/client.py"
  out=$(run_script "$repo" --scope "apps/jsapp")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case11" "exit $rc"; return; }
  echo "$out" | grep -qx "apps/jsapp/src/index.js" || { assert_fail "case11" "index.js missing: $out"; return; }
  echo "$out" | grep -qx "apps/jsapp/package.json" || { assert_fail "case11" "package.json missing: $out"; return; }
  echo "$out" | grep -q "node_modules" && { assert_fail "case11" "installed deps listed: $out"; return; }
  out=$(run_script "$repo" --scope "integrations/py")
  echo "$out" | grep -qx "integrations/py/client.py" || { assert_fail "case11" "client.py missing: $out"; return; }
  assert_pass "case11 non-typescript-packages-in-scope"
}

run_script() {
  local repo="$1"; shift
  local rc=0 out
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT" "$@" 2>&1) || rc=$?
  printf '%s\n---RC=%s\n' "$out" "$rc"
}

# ── Case 1: blank scope, no staged files → empty stdout, exit 0 ──
case1() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case1" "expected zero exit; got $rc"; return; }
  # First line should be empty (no staged files) — count non-RC lines
  body=$(echo "$out" | sed '$d' | grep -v '^$' || true)
  [[ -z "$body" ]] || { assert_fail "case1" "expected empty body, got: $body"; return; }
  assert_pass "case1 blank-no-staged-empty"
}

# ── Case 2: blank scope with 1 staged .ts → emits it ──
case2() {
  local repo out rc
  repo=$(make_repo)
  (cd "$repo" && echo "x" > new.ts && git add new.ts)
  out=$(run_script "$repo" --scope "")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case2" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "^new.ts$" || { assert_fail "case2" "missing new.ts: $out"; return; }
  assert_pass "case2 blank-with-staged"
}

# ── Case 3: apps/non-existent → fail loud ──
case3() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "apps/nonexistent")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case3" "expected non-zero on missing app"; return; }
  echo "$out" | grep -q "app not found" || { assert_fail "case3" "missing err msg"; return; }
  assert_pass "case3 app-not-found-fails"
}

# ── Case 4: apps/foo → emits 2 .ts files ──
case4() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "apps/foo")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case4" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "apps/foo/a.ts" || { assert_fail "case4" "missing a.ts: $out"; return; }
  echo "$out" | grep -q "apps/foo/b.ts" || { assert_fail "case4" "missing b.ts"; return; }
  assert_pass "case4 apps-foo-two-files"
}

# ── Case 5: bare name 'bar' matches apps/bar ──
case5() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "bar")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case5" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "apps/bar/c.ts" || { assert_fail "case5" "missing c.ts: $out"; return; }
  assert_pass "case5 bare-name-matches-app"
}

# ── Case 5b: apps/<domain>/<app> resolves to THE APP, not the domain ──
#
# Apps are grouped by domain, and this branch used to take the first path
# segment and nothing else — so `apps/dom/wanted` resolved to `apps/dom` and
# dragged every sibling in with it. Downstream that is not a wider scope, it is
# a WRONG verdict: layer 1 fails the caller's phase on a type error in an app
# the caller never named.
case5b() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "apps/dom/wanted")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case5b" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "apps/dom/wanted/w.ts" || { assert_fail "case5b" "missing w.ts: $out"; return; }
  echo "$out" | grep -q "apps/dom/sibling/s.ts" && { assert_fail "case5b" "the sibling app leaked in: $out"; return; }
  assert_pass "case5b nested-app-does-not-widen-to-domain"
}

# ── Case 5c: a DOMAIN scope still means the whole domain ──
#
# The widening is only wrong when the caller named something narrower. Asking
# for the domain by name still gets the domain.
case5c() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "apps/dom")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case5c" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "apps/dom/wanted/w.ts" || { assert_fail "case5c" "missing w.ts: $out"; return; }
  echo "$out" | grep -q "apps/dom/sibling/s.ts" || { assert_fail "case5c" "missing s.ts: $out"; return; }
  assert_pass "case5c domain-scope-still-means-the-domain"
}

# ── Case 5d: a path that is not a directory fails loud, never widens ──
#
# The ONLY input the old first-segment fallback could still catch was a typo,
# and widening a typo to its parent domain is the bug above wearing a hat.
case5d() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "apps/dom/nope")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 1 ]] || { assert_fail "case5d" "expected exit 1; got $rc"; return; }
  assert_pass "case5d nested-nonexistent-app-fails-loud"
}

# ── Case 6: integrations/baz → emits 1 .ts file ──
case6() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "integrations/baz")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case6" "expected zero exit; got $rc"; return; }
  echo "$out" | grep -q "integrations/baz/d.ts" || { assert_fail "case6" "missing d.ts: $out"; return; }
  assert_pass "case6 integration-match"
}

# ── Case 7: glob matching no files → fail loud ──
case7() {
  local repo out rc
  repo=$(make_repo)
  out=$(run_script "$repo" --scope "nothing/*.ts")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case7" "expected non-zero on no-match glob"; return; }
  assert_pass "case7 no-match-glob-fails"
}

# ── Case 8 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo →
# resolve root via git rev-parse; apps/foo → emits 2 files (exit 0) ──
case8() {
  local repo out rc=0
  repo=$(make_repo)
  out=$( cd "$repo" && env -i HOME="$repo" PATH="/usr/bin:/bin" "$SCRIPT" --scope "apps/foo" 2>&1 ) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case8" "expected zero with env unset inside repo; got $rc: $out"; return; }
  echo "$out" | grep -q "apps/foo/a.ts" || { assert_fail "case8" "missing a.ts with env unset: $out"; return; }
  assert_pass "case8 env-unset-in-repo-resolves-via-git"
}

# ── Case 9 (Fix B): CLAUDE_PROJECT_DIR unset AND outside a git repo →
# hard-error preserved at exit 1 ──
case9() {
  local nongit out rc=0
  nongit=$(mktemp -d)
  out=$( cd "$nongit" && env -i HOME="$nongit" PATH="/usr/bin:/bin" "$SCRIPT" --scope "apps/foo" 2>&1 ) || rc=$?
  rm -rf "$nongit"
  [[ "$rc" -eq 1 ]] || { assert_fail "case9" "expected exit 1 unset+outside-repo; got $rc"; return; }
  echo "$out" | grep -q "not inside a git repo" || { assert_fail "case9" "missing hard-error msg: $out"; return; }
  assert_pass "case9 env-unset-outside-repo-hard-errors"
}

# ── Case 10: run from a LINKED WORKTREE, where .git is a file rather than a
# directory. /implement runs Phase 4 inside one, so this is the
# common path, not an edge. Both env-set and env-unset resolutions must work. ──
case10() {
  local repo wt out rc=0
  repo=$(make_repo)
  wt="${repo}-wt"
  git -C "$repo" worktree add -q -b wtbranch "$wt" >/dev/null 2>&1
  [[ -f "$wt/.git" ]] || { assert_fail "case10" "expected .git to be a FILE in the worktree"; return; }

  out=$( cd "$wt" && env -i HOME="$wt" PATH="/usr/bin:/bin" "$SCRIPT" --scope "apps/foo" 2>&1 ) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case10" "expected zero inside worktree; got $rc: $out"; return; }
  echo "$out" | grep -q "apps/foo/a.ts" || { assert_fail "case10" "missing a.ts inside worktree: $out"; return; }

  rc=0
  out=$(CLAUDE_PROJECT_DIR="$wt" "$SCRIPT" --scope "apps/foo" 2>&1) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case10" "expected zero with env set to worktree; got $rc: $out"; return; }

  git -C "$repo" worktree remove --force "$wt" >/dev/null 2>&1 || true
  assert_pass "case10 runs-inside-linked-worktree"
}

case1
case2
case3
case4
case5
case5b
case5c
case5d
case6
case7
case8
case9
case10
case11

echo
echo "resolve-scope.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
