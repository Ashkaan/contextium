#!/usr/bin/env bash
# Test harness for detect-mode.sh.
# Boundaries: 0/error inputs (no repo, unset env), the happy path (env set and
# env-unset-but-in-repo), and the quoting edge (space in the repo path).
#
# peers: detect-mode.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/detect-mode.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

make_repo() {
  local d
  d=$(mktemp -d)
  git -C "$d" init --quiet
  printf '%s' "$d"
}

invoke_script() {
  local rc=0
  "$@" 2>/dev/null || rc=$?
  echo "$rc"
}

# ── Case 1: CLAUDE_PROJECT_DIR unset AND outside a git repo → fail loud ──
# (The git fallback only resolves inside a repo; outside one, the hard-error is
# preserved so we never silently pick a wrong root.)
case1() {
  local rc nongit
  nongit=$(mktemp -d)
  rc=$( cd "$nongit" && invoke_script env -u CLAUDE_PROJECT_DIR "$SCRIPT" )
  rm -rf "$nongit"
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: case1 — expected non-zero on unset PROJECT_DIR outside a git repo" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: case1 missing-project-dir-outside-repo-fails"
  pass=$((pass + 1))
}

# ── Case 2: CLAUDE_PROJECT_DIR unset but cwd inside a git repo → resolve root
# via git rev-parse; emit mode=direct ──
case2() {
  local repo out rc=0
  repo=$(make_repo)
  out=$( cd "$repo" && env -u CLAUDE_PROJECT_DIR "$SCRIPT" ) || rc=$?
  rm -rf "$repo"
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: case2 — expected exit 0 with env unset inside repo, got $rc" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -qE '^mode=direct$'; then
    echo "FAIL: case2 — expected mode=direct, got: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: case2 env-unset-in-repo-resolves-via-git"
  pass=$((pass + 1))
}

# ── Case 3: CLAUDE_PROJECT_DIR set explicitly → mode=direct + repo_root ──
case3() {
  local repo out
  repo=$(mktemp -d)
  out=$(CLAUDE_PROJECT_DIR="$repo" "$SCRIPT")
  if ! echo "$out" | grep -qE '^mode=direct$'; then
    echo "FAIL: case3 — expected mode=direct, got: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -qE '^repo_root='; then
    echo "FAIL: case3 — missing repo_root; got: $out" >&2; fail=$((fail + 1)); return
  fi
  rm -rf "$repo"
  echo "ok: case3 env-set-direct"
  pass=$((pass + 1))
}

# ── Case 4: repo_root contains a space → printf %q quotes it, and the quoted
# value eval's back to the real directory (shell-safe) ──
case4() {
  local base out
  base=$(mktemp -d)
  local spaced="$base/path with space"
  mkdir -p "$spaced"
  out=$(CLAUDE_PROJECT_DIR="$spaced" "$SCRIPT")
  if ! echo "$out" | grep -qE '^repo_root=.*path.*with.*space'; then
    echo "FAIL: case4 — quoted path missing; got: $out" >&2; fail=$((fail + 1)); rm -rf "$base"; return
  fi
  # Verify the quoted path is shell-safe by eval'ing it back.
  local rr_line repo_root=""
  rr_line=$(echo "$out" | grep '^repo_root=')
  # shellcheck disable=SC2086,SC2154
  eval "${rr_line}"
  if [[ ! -d "$repo_root" ]]; then
    echo "FAIL: case4 — eval'd path doesn't resolve: $repo_root" >&2; fail=$((fail + 1)); rm -rf "$base"; return
  fi
  rm -rf "$base"
  echo "ok: case4 space-in-path-quoted"
  pass=$((pass + 1))
}

case1
case2
case3
case4

echo
echo "detect-mode.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
