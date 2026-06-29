#!/usr/bin/env bash
# Test harness for push-with-retry.sh.
#
# Boundaries: env-unset-but-in-repo resolves the root via git and pushes (1),
# env-unset-outside-a-repo blocks loud (error case, 0/error), and the env-set
# fast path still pushes (1).
#
# peers: push-with-retry.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/push-with-retry.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

# Build a work repo on branch main with a local bare origin it can push to.
make_pushable_repo() {
  local work bare
  work=$(mktemp -d)
  bare=$(mktemp -d)
  git -C "$bare" init --bare --quiet
  git -C "$work" init --quiet
  git -C "$work" config user.email test@example.com
  git -C "$work" config user.name tester
  git -C "$work" checkout -q -b main 2>/dev/null || git -C "$work" branch -q -M main
  : > "$work/f"
  git -C "$work" add f
  git -C "$work" commit --quiet -m "seed commit"
  git -C "$work" remote add origin "$bare"
  printf '%s\n%s\n' "$work" "$bare"
}

# ── Case 1: CLAUDE_PROJECT_DIR unset, cwd inside a git repo with a reachable
# origin → resolve root via git, push succeeds (exit 0). ──
case1() {
  local work bare out rc=0
  { read -r work; read -r bare; } < <(make_pushable_repo)
  out=$( cd "$work" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" main 2>&1 ) || rc=$?
  rm -rf "$work" "$bare"
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: case1 — expected exit 0 (push via git-resolved root), got $rc: $out" >&2
    fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "Pushed main to origin"; then
    echo "FAIL: case1 — expected push success line; got: $out" >&2
    fail=$((fail + 1)); return
  fi
  echo "ok: case1 env-unset-in-repo-resolves-via-git"
  pass=$((pass + 1))
}

# ── Case 2: CLAUDE_PROJECT_DIR unset AND outside a git repo → block loud. ──
case2() {
  local nongit rc=0
  nongit=$(mktemp -d)
  ( cd "$nongit" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" main >/dev/null 2>&1 ) || rc=$?
  rm -rf "$nongit"
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: case2 — expected non-zero with env unset outside a git repo" >&2
    fail=$((fail + 1)); return
  fi
  echo "ok: case2 env-unset-outside-repo-fails"
  pass=$((pass + 1))
}

# ── Case 3: CLAUDE_PROJECT_DIR set explicitly → push succeeds against the bare
# origin (fast path unchanged). ──
case3() {
  local work bare out rc=0
  { read -r work; read -r bare; } < <(make_pushable_repo)
  out=$( CLAUDE_PROJECT_DIR="$work" "$SCRIPT" main 2>&1 ) || rc=$?
  rm -rf "$work" "$bare"
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: case3 — env-set fast path broken, got $rc: $out" >&2
    fail=$((fail + 1)); return
  fi
  echo "ok: case3 env-set-fast-path-unchanged"
  pass=$((pass + 1))
}

case1
case2
case3

echo
echo "push-with-retry.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
