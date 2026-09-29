#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures hold literal backticks and $ in single quotes
# Test harness for setup-worktree.sh — one case per boundary of its contract.
#
# peers: setup-worktree.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REAL_SCRIPT="$SCRIPT_DIR/setup-worktree.sh"

[[ -x "$REAL_SCRIPT" ]] || { echo "FAIL: not executable: $REAL_SCRIPT" >&2; exit 1; }

# setup-worktree.sh puts a worktree where the recorded harness keeps its own
# (harness.sh), which for most harnesses is OUTSIDE the case's repo. Two
# consequences for this harness:
#
#   1. Every case builds a throwaway repo with mktemp and asserts against
#      "$repo/.claude/worktrees/...". Left alone, the script would write
#      somewhere else entirely and those assertions would inspect a directory it
#      never touched.
#   2. Worse, "somewhere else" could be the developer's REAL worktree folder.
#
# So every invocation pins CLAUDE_WORKTREE_HOME back into the case's own repo,
# and the suite runs as the claude harness, whose branch names these cases
# assert; case_default_harness covers the rest. HOME is a throwaway too: the
# script records each worktree in this thread's ledger under ~/.cache.
export HOME
HOME="$(mktemp -d)"
export T3CODE_HOME="$HOME/.t3"
export CONTEXTIUM_HARNESS=claude
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID CONTEXTIUM_SESSION CLAUDE_WORKTREE_HOME CLAUDE_PROJECT_DIR WORKBENCH_THREAD_ID
SUITE_HOME="$HOME"
trap 'rm -rf "$SUITE_HOME"' EXIT
LEDGERS="$HOME/.cache/workbench/threads"
# sed -i without GNU's spelling of it (BSD sed wants a suffix argument).
sedi() { sed "$1" "$2" >"$2.tmp" && mv "$2.tmp" "$2"; }

SCRIPT="run_setup"
run_setup() {
  CLAUDE_WORKTREE_HOME="${CLAUDE_WORKTREE_HOME:-${CLAUDE_PROJECT_DIR:-}/.claude/worktrees}" \
    "$REAL_SCRIPT" "$@"
}

pass=0
fail=0

# Build a hermetic upstream + downstream pair so origin/HEAD resolves.
make_repo() {
  local upstream downstream
  upstream=$(mktemp -d)
  git -C "$upstream" init --quiet --bare
  downstream=$(mktemp -d)
  git -C "$downstream" init --quiet
  git -C "$downstream" -c user.email=t@t -c user.name=t \
    commit --allow-empty --quiet -m "init"
  git -C "$downstream" remote add origin "$upstream"
  git -C "$downstream" push --quiet origin master 2>/dev/null \
    || git -C "$downstream" push --quiet origin HEAD:main
  git -C "$downstream" fetch --quiet origin
  # Set origin/HEAD explicitly (push didn't always set it).
  local head_branch
  head_branch=$(git -C "$downstream" rev-parse --abbrev-ref HEAD)
  git -C "$downstream" remote set-head origin "$head_branch" >/dev/null 2>&1 || true
  printf '%s' "$downstream"
}

make_repo_no_remote() {
  local d
  d=$(mktemp -d)
  git -C "$d" init --quiet
  git -C "$d" -c user.email=t@t -c user.name=t \
    commit --allow-empty --quiet -m "init"
  printf '%s' "$d"
}

# ── Mode 3: --print-regex ──
case_print_regex() {
  local out
  out=$("$SCRIPT" --print-regex)
  if [[ "$out" != '^[a-z][a-z0-9-]{0,63}$' ]]; then
    echo "FAIL: print-regex — got: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: --print-regex"
  pass=$((pass + 1))
}

# ── Mode 2: --validate-slug (valid) ──
case_validate_valid() {
  local rc=0
  "$SCRIPT" --validate-slug "my-slug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: validate-slug valid — exit $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: --validate-slug valid"
  pass=$((pass + 1))
}

# ── Mode 2: --validate-slug (invalid) ──
case_validate_invalid() {
  local rc=0
  "$SCRIPT" --validate-slug "BadSlug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 2 ]]; then
    echo "FAIL: validate-slug invalid — expected exit 2, got $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: --validate-slug invalid"
  pass=$((pass + 1))
}

# ── Mode 2: --validate-slug (empty) ──
case_validate_empty() {
  local rc=0
  "$SCRIPT" --validate-slug "" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 2 ]]; then
    echo "FAIL: validate-slug empty — expected exit 2, got $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: --validate-slug empty"
  pass=$((pass + 1))
}

# ── Mode 1: create from origin/HEAD (worktree+branch absent) ──
case_create_fresh() {
  local repo out
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  out=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug")
  if [[ "$out" != "WORKTREE_DIR=$repo/.claude/worktrees/my-slug" ]]; then
    echo "FAIL: create_fresh — wrong stdout: $out" >&2; fail=$((fail + 1)); return
  fi
  if [[ ! -d "$repo/.claude/worktrees/my-slug" ]]; then
    echo "FAIL: create_fresh — worktree dir missing" >&2; fail=$((fail + 1)); return
  fi
  if [[ ! -f "$repo/.claude/worktrees/my-slug/.claude-session-abc" ]]; then
    echo "FAIL: create_fresh — marker missing" >&2; fail=$((fail + 1)); return
  fi
  if [[ "$(git -C "$repo/.claude/worktrees/my-slug" rev-parse --abbrev-ref HEAD)" != "worktree-my-slug" ]]; then
    echo "FAIL: create_fresh — wrong branch" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: create-fresh (worktree+branch absent → -b new branch)"
  pass=$((pass + 1))
}

# ── Mode 1: branch survives prior worktree removal ──
case_branch_survives() {
  local repo
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  # Create + remove worktree, branch keeps the tip.
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug" >/dev/null
  # Add a commit on the worktree so the branch tip diverges from origin/HEAD.
  cd "$repo/.claude/worktrees/my-slug"
  git -c user.email=t@t -c user.name=t commit --allow-empty --quiet -m "local"
  local tip_before
  tip_before=$(git rev-parse HEAD)
  cd - >/dev/null
  # Remove the worktree; the branch survives.
  git -C "$repo" worktree remove --force "$repo/.claude/worktrees/my-slug"
  # Reinvoke — must reuse branch (no -B reset).
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug" >/dev/null
  local tip_after
  tip_after=$(git -C "$repo/.claude/worktrees/my-slug" rev-parse HEAD)
  if [[ "$tip_before" != "$tip_after" ]]; then
    echo "FAIL: branch_survives — branch tip changed ($tip_before → $tip_after)" >&2
    fail=$((fail + 1))
    return
  fi
  echo "ok: branch-survives (no -B reset, local commits preserved)"
  pass=$((pass + 1))
}

# ── Mode 1: no remote — falls back to HEAD ──
case_no_remote() {
  local repo out rc
  repo=$(make_repo_no_remote)
  trap 'rm -rf "$repo"' RETURN
  out=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug" 2>&1) || rc=$?
  rc=${rc:-0}
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: no_remote — expected exit 0, got $rc; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "WORKTREE_DIR=$repo/.claude/worktrees/my-slug"; then
    echo "FAIL: no_remote — missing WORKTREE_DIR; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "WARN: origin/HEAD unresolvable"; then
    echo "FAIL: no_remote — missing WARN; out: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: no-remote (falls back to HEAD with WARN)"
  pass=$((pass + 1))
}

# ── Mode 1: re-claim existing worktree, branch matches ──
# Re-claim is for the SAME session re-entering (a resumed session calls this
# again). Same slug, same id, same worktree, no complaint.
case_reclaim() {
  local repo first second
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  first=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug")
  second=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug")
  if [[ "$first" != "$second" ]]; then
    echo "FAIL: reclaim — stdout differs ($first vs $second)" >&2; fail=$((fail + 1)); return
  fi
  if [[ ! -f "$repo/.claude/worktrees/my-slug/.claude-session-abc" ]]; then
    echo "FAIL: reclaim — own marker missing after re-claim" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: reclaim (same session, existing worktree, branch matches)"
  pass=$((pass + 1))
}

# ── A DIFFERENT session must NOT be able to join an existing worktree ──
# Session `def` succeeding against session `abc`'s worktree and dropping its own
# marker beside it would be two sessions on one git index — the precise failure
# worktrees exist to prevent, merely relocated from the main tree into a
# worktree. Refuse instead.
case_foreign_claim() {
  local repo rc out
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug" >/dev/null
  rc=0
  out=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="def" "$SCRIPT" "my-slug" 2>&1) || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: foreign_claim — second session was allowed into another's worktree" >&2
    fail=$((fail + 1)); return
  fi
  if [[ -f "$repo/.claude/worktrees/my-slug/.claude-session-def" ]]; then
    echo "FAIL: foreign_claim — refused but still planted the second marker" >&2
    fail=$((fail + 1)); return
  fi
  if [[ ! -f "$repo/.claude/worktrees/my-slug/.claude-session-abc" ]]; then
    echo "FAIL: foreign_claim — clobbered the holder's marker" >&2
    fail=$((fail + 1)); return
  fi
  if ! grep -q "already claimed by another session" <<<"$out"; then
    echo "FAIL: foreign_claim — refused without naming the conflict: $out" >&2
    fail=$((fail + 1)); return
  fi
  echo "ok: foreign-claim (second session refused, holder untouched)"
  pass=$((pass + 1))
}

# ── Mode 1: worktree exists, branch differs — fail loud ──
case_branch_differs() {
  local repo rc
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  mkdir -p "$repo/.claude/worktrees"
  # Create worktree manually on a different branch
  git -C "$repo" worktree add -b some-other-branch "$repo/.claude/worktrees/my-slug" >/dev/null 2>&1
  rc=0
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "my-slug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: branch_differs — expected non-zero" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: branch-differs (fail loud)"
  pass=$((pass + 1))
}

# ── Mode 1: slug fails regex ──
case_bad_slug() {
  local repo rc
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  rc=0
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" "Bad-Slug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 2 ]]; then
    echo "FAIL: bad_slug — expected exit 2, got $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: bad-slug (regex miss → exit 2, no git state)"
  pass=$((pass + 1))
}

# ── Mode 1: CLAUDE_PROJECT_DIR unset AND outside a git repo → fail loud ──
# (Fix B: the git fallback only resolves inside a repo; run from a non-git
# temp dir so the hard-error path is exercised.)
case_no_project_dir() {
  local rc=0 nongit
  nongit=$(mktemp -d)
  ( cd "$nongit" && env -u CLAUDE_PROJECT_DIR CLAUDE_SESSION_ID=abc "$SCRIPT" "my-slug" ) >/dev/null 2>&1 || rc=$?
  rm -rf "$nongit"
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: no_project_dir — expected non-zero outside a git repo" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: missing CLAUDE_PROJECT_DIR outside repo (fail loud)"
  pass=$((pass + 1))
}

# ── Mode 1 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo →
# resolve root via git rev-parse and create the worktree ──
case_env_unset_in_repo() {
  local repo out rc=0
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  # `env` execs a binary, so this one case calls REAL_SCRIPT rather than the
  # run_setup shim (a shell function is not on PATH — exit 127). The point of the
  # case is the CLAUDE_PROJECT_DIR-unset fallback to `git rev-parse`, so the
  # worktree home is pinned explicitly here instead of being derived from the
  # variable the case exists to unset.
  out=$( cd "$repo" && env -u CLAUDE_PROJECT_DIR CLAUDE_SESSION_ID=abc \
    CLAUDE_WORKTREE_HOME="$repo/.claude/worktrees" "$REAL_SCRIPT" "my-slug" 2>&1 ) || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: env_unset_in_repo — expected exit 0, got $rc; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -qE 'WORKTREE_DIR=.*/\.claude/worktrees/my-slug$'; then
    echo "FAIL: env_unset_in_repo — missing WORKTREE_DIR; out: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: env-unset-in-repo resolves via git rev-parse"
  pass=$((pass + 1))
}

# ── Mode 1: CLAUDE_PROJECT_DIR points at non-repo ──
case_non_repo() {
  local d rc=0
  d=$(mktemp -d)
  trap 'rm -rf "$d"' RETURN
  CLAUDE_PROJECT_DIR="$d" CLAUDE_SESSION_ID=abc "$SCRIPT" "my-slug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: non_repo — expected non-zero" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: non-repo dir (fail loud)"
  pass=$((pass + 1))
}

# ── Mode 1: no session id anywhere → the one thread.sh generates, not a refusal ──
case_no_session_id() {
  local repo rc=0 out sid
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  out=$(cd "$repo" && env -u CLAUDE_SESSION_ID CLAUDE_WORKTREE_HOME="$repo/.claude/worktrees" \
    "$REAL_SCRIPT" "my-slug" 2>&1) || rc=$?
  if [[ "$rc" -ne 0 || "$out" != "WORKTREE_DIR=$repo/.claude/worktrees/my-slug" ]]; then
    echo "FAIL: no_session_id — rc $rc; out: $out" >&2; fail=$((fail + 1)); return
  fi
  sid=$(cd "$repo" && bash "$SCRIPT_DIR/../../close/scripts/thread.sh" --id 2>/dev/null)
  if [[ "$sid" != session-* || ! -f "$repo/.claude/worktrees/my-slug/.claude-session-$sid" ]]; then
    echo "FAIL: no_session_id — no marker for the generated session '$sid'" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: no session id (a generated one names the marker)"
  pass=$((pass + 1))
}

# ── The worktree is in this thread's ledger, so the close lands it ──
case_adopted_for_close() {
  local repo line
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="led" "$SCRIPT" "my-slug" >/dev/null 2>&1 || true
  line=$(awk -F'\t' -v w="$repo/.claude/worktrees/my-slug" '$1 == w { print $3 }' "$LEDGERS/led/worktrees" 2>/dev/null || true)
  if [[ "$line" != "worktree-my-slug" ]]; then
    echo "FAIL: adopted_for_close — ledger line: '$line'" >&2; fail=$((fail + 1)); return
  fi
  if [[ -n "$(git -C "$repo/.claude/worktrees/my-slug" status --porcelain 2>&1 || true)" ]]; then
    echo "FAIL: adopted_for_close — the markers would be committed: $(git -C "$repo/.claude/worktrees/my-slug" status --porcelain)" >&2
    fail=$((fail + 1)); return
  fi
  echo "ok: adopted-for-close (in the ledger, markers not committable)"
  pass=$((pass + 1))
}

# ── A thread that already has a worktree of this repo builds there ──
case_thread_worktree_reused() {
  local repo own out
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  own="$repo.own"
  git -C "$repo" worktree add -q -b thread-own "$own" >/dev/null 2>&1
  (cd "$repo" && CLAUDE_SESSION_ID="has" bash "$SCRIPT_DIR/../../close/scripts/write-root.sh" --adopt "$own" >/dev/null) || true
  out=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="has" "$SCRIPT" "my-slug" 2>&1) || true
  rm -rf "$own"
  if [[ "$out" != "WORKTREE_DIR=$(cd "$repo" && pwd -P).own" ]]; then
    echo "FAIL: thread_worktree_reused — out: $out" >&2; fail=$((fail + 1)); return
  fi
  if [[ -d "$repo/.claude/worktrees/my-slug" ]]; then
    echo "FAIL: thread_worktree_reused — a second worktree was made beside it" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: thread-worktree-reused (no second worktree of one repo)"
  pass=$((pass + 1))
}

# ── No harness recorded: beside the repo, on a session/ branch ──
case_default_harness() {
  local repo out want
  repo=$(make_repo)
  trap 'rm -rf "$repo" "$repo.worktrees"' RETURN
  want="$(dirname "$repo")/$(basename "$repo").worktrees/my-slug"
  out=$(CONTEXTIUM_HARNESS=default CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="dflt" "$REAL_SCRIPT" "my-slug" 2>&1) || true
  if [[ "$out" != "WORKTREE_DIR=$want" ]]; then
    echo "FAIL: default_harness — out: $out" >&2; fail=$((fail + 1)); return
  fi
  if [[ "$(git -C "$want" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" != "session/my-slug" ]]; then
    echo "FAIL: default_harness — branch $(git -C "$want" rev-parse --abbrev-ref HEAD 2>/dev/null || true)" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: default-harness (beside the repo, session/ branch)"
  pass=$((pass + 1))
}

# ── Mode 1b: --slug + --shard creates composite worktree ──
case_slug_shard_fresh() {
  local repo out rc=0
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  out=$(CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug "my-slug" --shard "foo") || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    echo "FAIL: slug_shard_fresh — exit $rc; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "^SLUG=my-slug$"; then
    echo "FAIL: slug_shard_fresh — missing SLUG line; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "^SHARD=foo$"; then
    echo "FAIL: slug_shard_fresh — missing SHARD line; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if ! echo "$out" | grep -q "WORKTREE_DIR=$repo/.claude/worktrees/my-slug-foo$"; then
    echo "FAIL: slug_shard_fresh — wrong WORKTREE_DIR; out: $out" >&2; fail=$((fail + 1)); return
  fi
  if [[ ! -d "$repo/.claude/worktrees/my-slug-foo" ]]; then
    echo "FAIL: slug_shard_fresh — composite worktree dir missing" >&2; fail=$((fail + 1)); return
  fi
  if [[ "$(git -C "$repo/.claude/worktrees/my-slug-foo" rev-parse --abbrev-ref HEAD)" != "worktree-my-slug-foo" ]]; then
    echo "FAIL: slug_shard_fresh — wrong branch" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: slug-shard-fresh (composite worktree + branch)"
  pass=$((pass + 1))
}

# ── Mode 1b: composite overflows 64-char regex → fail ──
case_slug_shard_overflow() {
  local repo rc=0
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  # 35-char slug + 30-char shard + hyphen = 66 chars, blows the 64 ceiling.
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" \
    --slug "aaaaabbbbbcccccdddddeeeeefffffggggg" \
    --shard "hhhhhiiiiijjjjjkkkkklllllmmmmm" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 2 ]]; then
    echo "FAIL: slug_shard_overflow — expected exit 2, got $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: slug-shard-overflow (composite > 64 chars → exit 2)"
  pass=$((pass + 1))
}

# ── Mode 1b: bad shard token (uppercase) → fail ──
case_slug_shard_bad_shard() {
  local repo rc=0
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" \
    --slug "my-slug" --shard "Bad_Shard" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -ne 2 ]]; then
    echo "FAIL: slug_shard_bad_shard — expected exit 2, got $rc" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: slug-shard-bad-shard (regex miss → exit 2)"
  pass=$((pass + 1))
}

# ── Mode 1b: missing --shard arg ──
case_slug_shard_missing_shard() {
  local repo rc=0
  repo=$(make_repo)
  trap 'rm -rf "$repo"' RETURN
  CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" \
    --slug "my-slug" >/dev/null 2>&1 || rc=$?
  if [[ "$rc" -eq 0 ]]; then
    echo "FAIL: slug_shard_missing_shard — expected non-zero" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: slug-shard-missing-shard (fail loud)"
  pass=$((pass + 1))
}

# ── ROADMAP.md rows ─────────────────────────────────────────────────────────
# A records fixture the script finds through CONTEXT_WRITE_ROOT, holding one
# project `rmx` with a two-row roadmap: R1 has a spec folder, R2 has none.
make_records() {
  local lib p
  lib=$(mktemp -d)
  p="$lib/projects/t/2026-01-01_rmx"
  mkdir -p "$p/specs/001-a"
  printf -- '---\nproject: rmx\nstatus: active\n---\n\n# P\n' >"$p/README.md"
  printf '%s\n' '# Roadmap: t' '' \
    '| ID | Sub-feature | Depends on | Status | Sub-spec |' \
    '|----|-------------|------------|--------|----------|' \
    '| R1 | a | — | planned | `specs/001-a/` |' \
    '| R2 | b | — | planned | — |' >"$p/ROADMAP.md"
  echo '# spec' >"$p/specs/001-a/spec.md"
  printf '%s' "$lib"
}
rm_status() { awk -F'|' -v id="$2" '$2 ~ "^ *" id " *$" {gsub(/^ +| +$/, "", $5); print $5}' "$1/projects/t/2026-01-01_rmx/ROADMAP.md"; }

case_roadmap_shard_flips() {
  local repo lib rc=0 out
  repo=$(make_repo); lib=$(make_records)
  out=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1) || rc=$?
  if [[ "$rc" -ne 0 || "$(rm_status "$lib" R1)" != "in-progress" ]]; then
    echo "FAIL: roadmap_shard_flips — rc $rc, R1 is '$(rm_status "$lib" R1)'; out: $out" >&2; fail=$((fail + 1)); return
  fi
  [[ -d "$repo/.claude/worktrees/rmx-r1" ]] || { echo "FAIL: roadmap_shard_flips — no worktree" >&2; fail=$((fail + 1)); return; }
  echo "ok: roadmap --shard r1 flips R1 to in-progress"
  pass=$((pass + 1))
}

case_roadmap_bare_resolves() {
  local repo lib rc=0 out
  repo=$(make_repo); lib=$(make_records)
  out=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" rmx 2>&1) || rc=$?
  if [[ "$rc" -ne 0 || "$(rm_status "$lib" R1)" != "in-progress" ]]; then
    echo "FAIL: roadmap_bare_resolves — rc $rc, R1 is '$(rm_status "$lib" R1)'; out: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap bare slug resolves R1 and flips it"
  pass=$((pass + 1))
}

case_roadmap_marker_refuses() {
  local repo lib form rc err
  for form in shard bare; do
    repo=$(make_repo); lib=$(make_records); rc=0
    printf 'FR-1 [NEEDS CLARIFICATION: which store?]\n' >"$lib/projects/t/2026-01-01_rmx/specs/001-a/spec.md"
    if [[ "$form" == shard ]]; then
      err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1 >/dev/null) || rc=$?
    else
      err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" rmx 2>&1 >/dev/null) || rc=$?
    fi
    if [[ "$rc" -eq 0 ]]; then
      echo "FAIL: roadmap_marker_refuses ($form) — exit 0" >&2; fail=$((fail + 1)); return
    fi
    if [[ "$err" != *"which store?"* ]]; then
      echo "FAIL: roadmap_marker_refuses ($form) — marker not in stderr: $err" >&2; fail=$((fail + 1)); return
    fi
    if [[ "$form" == bare && "$err" != *"needs-planning"* ]]; then
      echo "FAIL: roadmap_marker_refuses ($form) — stage not named: $err" >&2; fail=$((fail + 1)); return
    fi
    if compgen -G "$repo/.claude/worktrees/rmx*" >/dev/null || git -C "$repo" branch --list 'worktree-rmx*' | grep -q .; then
      echo "FAIL: roadmap_marker_refuses ($form) — a worktree or branch was left behind" >&2; fail=$((fail + 1)); return
    fi
    [[ "$(rm_status "$lib" R1)" == planned ]] || { echo "FAIL: roadmap_marker_refuses ($form) — R1 flipped" >&2; fail=$((fail + 1)); return; }
  done
  echo "ok: roadmap open marker refuses in both forms, nothing created"
  pass=$((pass + 1))
}

case_roadmap_unknown_row() {
  local repo lib rc=0 err
  repo=$(make_repo); lib=$(make_records)
  err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r99 2>&1 >/dev/null) || rc=$?
  if [[ "$rc" -eq 0 || "$err" != *"rows: R1, R2"* ]]; then
    echo "FAIL: roadmap_unknown_row — rc $rc; err: $err" >&2; fail=$((fail + 1)); return
  fi
  if compgen -G "$repo/.claude/worktrees/rmx*" >/dev/null || git -C "$repo" branch --list 'worktree-rmx*' | grep -q .; then
    echo "FAIL: roadmap_unknown_row — a worktree or branch was left behind" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap r99 refuses with the ID list, nothing created"
  pass=$((pass + 1))
}

case_roadmap_row_not_ready() {
  local repo lib rc err sid want p
  for sid in r2 r1-done r1-blocked; do
    repo=$(make_repo); lib=$(make_records); rc=0; p="$lib/projects/t/2026-01-01_rmx"
    case "$sid" in
      r2) want="has no spec yet" ;;
      r1-done) sedi 's/| R1 | a | — | planned |/| R1 | a | — | done |/' "$p/ROADMAP.md"; want="not ready" ;;
      r1-blocked) sedi 's/| R1 | a | — | planned |/| R1 | a | — | blocked: vendor |/' "$p/ROADMAP.md"; want="not ready" ;;
    esac
    err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard "${sid%%-*}" 2>&1 >/dev/null) || rc=$?
    if [[ "$rc" -eq 0 || "$err" != *"$want"* ]]; then
      echo "FAIL: roadmap_row_not_ready ($sid) — rc $rc; err: $err" >&2; fail=$((fail + 1)); return
    fi
    if compgen -G "$repo/.claude/worktrees/rmx*" >/dev/null; then
      echo "FAIL: roadmap_row_not_ready ($sid) — a worktree was left behind" >&2; fail=$((fail + 1)); return
    fi
  done
  repo=$(make_repo); lib=$(make_records); rc=0; p="$lib/projects/t/2026-01-01_rmx"
  printf -- '---\nspec-status: complete\n---\n' >"$p/specs/001-a/report.md"
  err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1 >/dev/null) || rc=$?
  if [[ "$rc" -eq 0 || "$err" != *"already reported complete"* ]]; then
    echo "FAIL: roadmap_row_not_ready (complete) — rc $rc; err: $err" >&2; fail=$((fail + 1)); return
  fi
  repo=$(make_repo); lib=$(make_records); rc=0; p="$lib/projects/t/2026-01-01_rmx"
  sedi 's/^status: active/status: completed/' "$p/README.md"
  err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1 >/dev/null) || rc=$?
  if [[ "$rc" -eq 0 || "$err" != *"not active"* || "$(rm_status "$lib" R1)" != planned ]]; then
    echo "FAIL: roadmap_row_not_ready (completed project) — rc $rc; err: $err" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap named row that is not ready, has no spec, or is complete refuses"
  pass=$((pass + 1))
}

case_roadmap_readonly_warns() {
  local repo lib rc=0 err p
  repo=$(make_repo); lib=$(make_records); p="$lib/projects/t/2026-01-01_rmx"
  chmod a-w "$p/ROADMAP.md" "$p"
  err=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1 >/dev/null) || rc=$?
  chmod u+w "$p" "$p/ROADMAP.md"
  if [[ "$rc" -ne 0 || "$err" != *"WARN: could not mark R1 in-progress"* || ! -d "$repo/.claude/worktrees/rmx-r1" ]]; then
    echo "FAIL: roadmap_readonly_warns — rc $rc; err: $err" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap read-only ROADMAP.md warns, worktree still created"
  pass=$((pass + 1))
}

# A row whose spec is not the last one spec-state.sh prints. The reader that
# picks the row's state used to quit on its match, spec-state.sh died of
# SIGPIPE writing the next line, and under pipefail this script exited 141
# with nothing on stderr and no worktree.
case_roadmap_many_specs() {
  local repo lib rc=0 out i p
  repo=$(make_repo); lib=$(make_records); p="$lib/projects/t/2026-01-01_rmx"
  for i in $(seq 10 60); do mkdir -p "$p/specs/0$i-x"; echo '# spec' >"$p/specs/0$i-x/spec.md"; done
  out=$(CONTEXT_WRITE_ROOT="$lib" CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1) || rc=$?
  if [[ "$rc" -ne 0 || ! -d "$repo/.claude/worktrees/rmx-r1" ]]; then
    echo "FAIL: roadmap_many_specs — rc $rc; out: $out" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap row among many specs starts"
  pass=$((pass + 1))
}

# A project that lives in the repo itself (no CONTEXT_WRITE_ROOT): the row is
# read from the main checkout, and the in-progress flip must land in the new
# worktree's copy — a flip in the shared checkout is a dirty file no close
# commits.
case_roadmap_flip_in_worktree() {
  local repo lib rc=0 out p
  repo=$(make_repo); lib=$(make_records)
  cp -R "$lib/projects" "$repo/"
  (cd "$repo" && git add -A && git -c user.email=t@t -c user.name=t commit -qm projects && git push -q origin HEAD)
  git -C "$repo" fetch -q origin
  printf '.claude/\n' >>"$repo/.git/info/exclude"   # the installer's .gitignore line
  out=$(cd "$repo" && CLAUDE_PROJECT_DIR="$repo" CLAUDE_SESSION_ID="abc" "$SCRIPT" --slug rmx --shard r1 2>&1) || rc=$?
  p="projects/t/2026-01-01_rmx/ROADMAP.md"
  if [[ "$rc" -ne 0 ]]; then echo "FAIL: roadmap_flip_in_worktree — rc $rc: $out" >&2; fail=$((fail + 1)); return; fi
  if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
    echo "FAIL: roadmap_flip_in_worktree — the shared checkout was written: $(git -C "$repo" status --porcelain)" >&2; fail=$((fail + 1)); return
  fi
  if ! grep -q '| R1 | a | — | in-progress |' "$repo/.claude/worktrees/rmx-r1/$p"; then
    echo "FAIL: roadmap_flip_in_worktree — the worktree's R1 is not in-progress: $(grep '| R1' "$repo/.claude/worktrees/rmx-r1/$p")" >&2; fail=$((fail + 1)); return
  fi
  echo "ok: roadmap flip lands in the worktree, the shared checkout stays clean"
  pass=$((pass + 1))
}

case_roadmap_many_specs
case_roadmap_flip_in_worktree
case_roadmap_shard_flips
case_roadmap_bare_resolves
case_roadmap_marker_refuses
case_roadmap_unknown_row
case_roadmap_row_not_ready
case_roadmap_readonly_warns
case_print_regex
case_validate_valid
case_validate_invalid
case_validate_empty
case_create_fresh
case_branch_survives
case_no_remote
case_reclaim
case_foreign_claim
case_branch_differs
case_bad_slug
case_no_project_dir
case_env_unset_in_repo
case_non_repo
case_no_session_id
case_adopted_for_close
case_thread_worktree_reused
case_default_harness
case_slug_shard_fresh
case_slug_shard_overflow
case_slug_shard_bad_shard
case_slug_shard_missing_shard

echo
echo "setup-worktree.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
