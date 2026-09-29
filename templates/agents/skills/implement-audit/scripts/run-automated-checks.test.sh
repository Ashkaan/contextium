#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures hold literal backticks and $ in single quotes
# Test harness for run-automated-checks.sh — boundary cases per
# the boundary inputs (0 / 1 / empty / max / error).
#
# Hermetic: shims shellcheck via a per-test PATH so we don't touch the real
# binary; the lint step (layer-1.sh) is a stub named by AUTOMATED_CHECKS_LAYER1;
# the standards and secrets checks are stubs planted at the fixture's
# .agents/checks/; find-peers.sh is read from the repo's .agents/skills/review/
# (case16 plants one), so a fixture without it WARNs.
#
# peers: run-automated-checks.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$SCRIPT_DIR/run-automated-checks.sh"

[[ -x "$SCRIPT" ]] || { echo "FAIL: not executable: $SCRIPT" >&2; exit 1; }

pass=0
fail=0

assert_pass() {
  local label="$1"
  echo "ok: $label"
  pass=$((pass + 1))
}

assert_fail() {
  local label="$1" reason="$2"
  echo "FAIL: $label — $reason" >&2
  fail=$((fail + 1))
}

# A stub check: $1 = path, $2 = exit code, $3 = a line it prints to stderr.
# It also records its argv, its stdin and the CLAUDE_PROJECT_DIR it saw beside
# itself, so a case can assert what it was handed.
mkstub() {
  local path="$1" code="$2" msg="${3:-}"
  mkdir -p "$(dirname "$path")"
  cat > "$path" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$@" > "$path.args"
cat > "$path.stdin" 2>/dev/null || true
printf '%s\n' "\${CLAUDE_PROJECT_DIR:-}" > "$path.env"
echo "$msg" >&2
exit $code
EOF
  chmod +x "$path"
}

# ── Per-test fixture builder ──────────────────────────────────────────
make_repo() {
  local d
  d=$(mktemp -d)
  (
    cd "$d"
    git init -q
    git config user.email t@t
    git config user.name t
    # The standards and secrets checks WARN-skip a repo with no .agents/checks
    # (a product repo), so every case that exercises them needs the pair.
    mkstub .agents/checks/check-standards-refs.sh 0
    mkstub .agents/checks/check-secrets.sh 0
    printf '*.args\n*.stdin\n*.env\n_lint/\n_home/\n' > .gitignore
    # Make a minimal initial commit so HEAD is parseable.
    echo "init" > README.md
    git add -A
    git commit -q -m "init"
  )
  printf '%s' "$d"
}

# Build a fake binary cache: $1 = name, $2 = exit code, $3 = stdout/stderr text
mkbin() {
  local dir="$1" name="$2" code="$3" msg="${4:-}"
  cat > "$dir/$name" <<EOF
#!/usr/bin/env bash
echo "$msg" >&2
exit $code
EOF
  chmod +x "$dir/$name"
}

# The lint stub every case uses unless it plants its own: exit $2.
setup_fake_lint() {
  local repo="$1" code="$2"
  mkstub "$repo/_lint/layer-1.sh" "$code"
}

run_script() {
  local repo="$1"; shift
  local fakebin="$1"; shift
  local rc=0 out
  out=$(env -i \
    HOME="$repo/_home" \
    PATH="$fakebin:/usr/bin:/bin" \
    CLAUDE_PROJECT_DIR="$repo" \
    AUTOMATED_CHECKS_LAYER1="${LINT_OVERRIDE:-$repo/_lint/layer-1.sh}" \
    "$SCRIPT" "$@" </dev/null 2>&1) || rc=$?
  printf '%s\n---RC=%s\n' "$out" "$rc"
}

# Helper: ensure the shellcheck shim exists (so the script doesn't WARN-skip)
setup_fake_tools() {
  local fakebin="$1"
  mkdir -p "$fakebin"
  mkbin "$fakebin" shellcheck 0
}

# Helper: make changed .ts/.sh/.md files so the file-collection paths fire.
add_changes() {
  local repo="$1" kinds="$2"
  (
    cd "$repo"
    [[ "$kinds" == *ts* ]]  && { echo "x" > foo.ts; }
    [[ "$kinds" == *sh* ]]  && { echo "echo" > foo.sh; }
    [[ "$kinds" == *md* ]]  && { echo "x" > foo.md; }
    git add -A >/dev/null
  )
}

# ── Case 1: --session-base missing → fail loud ──
case1() {
  local repo fakebin out rc
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  out=$(run_script "$repo" "$fakebin")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case1" "expected non-zero on missing --session-base"; return; }
  echo "$out" | grep -q "session-base.*required" || { assert_fail "case1" "no err message"; return; }
  assert_pass "case1 missing-session-base-fails"
}

# ── Case 2: --session-base unparseable → fail loud ──
case2() {
  local repo fakebin out rc
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  out=$(run_script "$repo" "$fakebin" --session-base "not-a-sha")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case2" "expected non-zero on bad SHA"; return; }
  assert_pass "case2 bad-sha-fails"
}

# ── Case 3: 0 files changed → all checks emit PASS / nothing-to-check ──
case3() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case3" "expected zero exit; got $rc: $out"; return; }
  echo "$out" | grep -q "SUMMARY:.*PASS" || { assert_fail "case3" "missing summary"; return; }
  echo "$out" | grep -q "PASS: lint (0 files)" || { assert_fail "case3" "lint (0 files) missing"; return; }
  assert_pass "case3 zero-files-all-pass"
}

# ── Case 4: 1 .ts file, lint clean → PASS: lint (1 files) ──
case4() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case4" "expected zero exit; got $rc: $out"; return; }
  echo "$out" | grep -q "PASS: lint (1 files)" || { assert_fail "case4" "lint PASS missing: $out"; return; }
  assert_pass "case4 one-ts-lint-clean"
}

# ── Case 5: 1 .ts file, lint dirty → FAIL: lint ──
case5() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 1
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case5" "expected non-zero on lint dirty"; return; }
  echo "$out" | grep -q "FAIL: lint" || { assert_fail "case5" "FAIL: lint missing"; return; }
  assert_pass "case5 ts-lint-dirty-fails"
}

# ── Case 6: only .md changed → lint PASS (0), nothing else fires ──
case6() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 1
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "md"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case6" "expected zero exit (md-only); got $rc"; return; }
  echo "$out" | grep -q "PASS: lint (0 files)" || { assert_fail "case6" "lint (0 files) missing"; return; }
  assert_pass "case6 md-only"
}

# ── Case 7: shellcheck-missing-warn ──
# Build a minimal PATH containing only the binaries the script needs (git,
# sed, awk, grep, head, find, mktemp, dirname, basename, cat, sort) — no SC
# binary — so `command -v` for SC returns empty even on hosts that have real
# SC installed in /usr/bin.
case7() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d)
  for bin in git sed awk grep head find mktemp dirname basename cat sort \
             tail uname tr printf chmod rm bash cut wc cp; do
    if command -v "$bin" >/dev/null 2>&1; then
      ln -sf "$(command -v "$bin")" "$fakebin/$bin"
    fi
  done
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "sh"
  rc=0
  out=$(env -i HOME="$repo/_home" \
    PATH="$fakebin" \
    CLAUDE_PROJECT_DIR="$repo" \
    AUTOMATED_CHECKS_LAYER1="$repo/_lint/layer-1.sh" \
    "$SCRIPT" --session-base "$base" </dev/null 2>&1) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case7" "WARN should not fail; got $rc: $out"; return; }
  echo "$out" | grep -q "WARN: shellcheck missing" || { assert_fail "case7" "WARN missing: $out"; return; }
  assert_pass "case7 shellcheck-missing-warn"
}

# ── Case 8: secrets dirty → FAIL, and the scan covers the session's span ──
case8() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  mkstub "$repo/.agents/checks/check-secrets.sh" 1 "a likely secret"
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case8" "expected non-zero on secrets dirty"; return; }
  echo "$out" | grep -q "FAIL: secrets" || { assert_fail "case8" "FAIL: secrets missing"; return; }
  [[ "$(tr '\n' ' ' < "$repo/.agents/checks/check-secrets.sh.args")" == "--since $base " ]] \
    || { assert_fail "case8" "scan not run --since the session base: $(cat "$repo/.agents/checks/check-secrets.sh.args")"; return; }
  assert_pass "case8 secrets-dirty-fails"
}

# ── Case 12: no .agents/checks in the repo → WARN, not FAIL ──
#
# A product repo carries none of the workbench's checks. A FAIL there would be
# for a missing file rather than for the diff.
case12() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  rm -rf "$repo/.agents/checks"
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case12" "checks-absent must not fail; got $rc: $out"; return; }
  echo "$out" | grep -q "WARN: check-secrets.sh missing" || { assert_fail "case12" "secrets WARN missing: $out"; return; }
  echo "$out" | grep -q "WARN: check-standards-refs.sh missing" || { assert_fail "case12" "standards WARN missing: $out"; return; }
  echo "$out" | grep -qE "FAIL: (secrets|standards-refs)" && { assert_fail "case12" "still FAILs on absent checks: $out"; return; }
  assert_pass "case12 checks-absent-warns"
}

# ── Case 13: no layer-1.sh + a changed .ts → lint WARNs, never FAILs ──
case13() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(LINT_OVERRIDE="$repo/_lint/absent.sh" run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case13" "missing lint step must not fail; got $rc: $out"; return; }
  echo "$out" | grep -q "WARN: lint missing" || { assert_fail "case13" "expected lint WARN: $out"; return; }
  echo "$out" | grep -q "FAIL: lint" && { assert_fail "case13" "still FAILs with no lint step: $out"; return; }
  assert_pass "case13 lint-step-absent-warns"
}

# ── Case 14: a dangling standards citation → FAIL, over this change's files only ──
case14() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  mkstub "$repo/.agents/checks/check-standards-refs.sh" 1 "foo.sh:1: no such standard"
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "sh"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -ne 0 ]] || { assert_fail "case14" "expected non-zero on a dangling citation: $out"; return; }
  echo "$out" | grep -q "FAIL: standards-refs" || { assert_fail "case14" "FAIL: standards-refs missing: $out"; return; }
  if ! grep -qx "foo.sh" "$repo/.agents/checks/check-standards-refs.sh.args" \
    || grep -qx "README.md" "$repo/.agents/checks/check-standards-refs.sh.args"; then
    assert_fail "case14" "not scoped to the change: $(cat "$repo/.agents/checks/check-standards-refs.sh.args")"; return
  fi
  assert_pass "case14 standards-refs-dangling-fails"
}

# ── Case 15: lint runs against THIS repo, over the changed files ──
#
# A stub that only exits 0 cannot tell "ran over the change" from "ran over
# nothing" — both PASS. This one records what it was handed, which is the
# thing under test.
case15() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  (cd "$repo" && git rm -q README.md)
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case15" "expected zero; got $rc: $out"; return; }
  echo "$out" | grep -q "PASS: lint (1 files)" || { assert_fail "case15" "lint should run over foo.ts only: $out"; return; }
  [[ "$(cat "$repo/_lint/layer-1.sh.stdin")" == "foo.ts" ]] || { assert_fail "case15" "lint handed: $(cat "$repo/_lint/layer-1.sh.stdin")"; return; }
  [[ "$(cat "$repo/_lint/layer-1.sh.env")" == "$repo" ]] || { assert_fail "case15" "lint ran against $(cat "$repo/_lint/layer-1.sh.env"), not $repo"; return; }
  assert_pass "case15 lint-runs-over-the-change"
}

# ── Case 16: find-peers.sh is read from .agents/skills/review, nowhere else ──
#
# A copy planted ONLY at another path must not be found; the one under
# .agents/skills/review must run and its verdict must be the one reported.
case16() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  local elsewhere="$repo/tools"
  mkdir -p "$repo/.agents/skills/review" "$elsewhere"
  printf '#!/usr/bin/env bash\necho "new-path find-peers ran" >&2\nexit 0\n' >"$repo/.agents/skills/review/find-peers.sh"
  printf '#!/usr/bin/env bash\necho "old-path find-peers ran" >&2\nexit 1\n' >"$elsewhere/find-peers.sh"
  chmod +x "$repo/.agents/skills/review/find-peers.sh" "$elsewhere/find-peers.sh"
  (cd "$repo" && git add -A && git commit -q -m "plant find-peers")
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case16" "expected zero; got $rc: $out"; return; }
  echo "$out" | grep -q "PASS: find-peers (0 left-behind)" || { assert_fail "case16" "find-peers under .agents/skills/review should have run and passed: $out"; return; }
  echo "$out" | grep -q "old-path find-peers ran" && { assert_fail "case16" "the copy elsewhere ran: $out"; return; }
  assert_pass "case16 find-peers-read-from-skills-review"
}

# ── Case 9: --repo-dir not a git repo → fail loud ──
case9() {
  local d fakebin out rc
  d=$(mktemp -d); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  out=$(env -i HOME=/tmp PATH="$fakebin:/usr/bin:/bin" "$SCRIPT" \
    --session-base HEAD --repo-dir "$d" 2>&1) || rc=$?
  rc="${rc:-0}"
  [[ "$rc" -ne 0 ]] || { assert_fail "case9" "expected non-zero on non-git dir"; return; }
  assert_pass "case9 not-a-git-repo-fails"
}

# ── Case 10 (Fix B): CLAUDE_PROJECT_DIR unset, no --repo-dir, cwd inside a git
# repo → resolve root via git rev-parse; 0 files → all PASS (exit 0) ──
case10() {
  local repo fakebin out rc=0 base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  out=$( cd "$repo" && env -i HOME="$repo/_home" \
    PATH="$fakebin:/usr/bin:/bin" AUTOMATED_CHECKS_LAYER1="$repo/_lint/layer-1.sh" \
    "$SCRIPT" --session-base "$base" </dev/null 2>&1 ) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case10" "expected zero with env unset inside repo; got $rc: $out"; return; }
  echo "$out" | grep -q "SUMMARY:.*PASS" || { assert_fail "case10" "missing summary with env unset: $out"; return; }
  assert_pass "case10 env-unset-in-repo-resolves-via-git"
}

# ── Case 11 (Fix B): --repo-dir overrides env/git. Set a bogus CLAUDE_PROJECT_DIR
# but pass --repo-dir "$repo" → the flag wins, run succeeds (exit 0) ──
case11() {
  local repo fakebin out rc=0 base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  out=$( env -i HOME="$repo/_home" \
    PATH="$fakebin:/usr/bin:/bin" AUTOMATED_CHECKS_LAYER1="$repo/_lint/layer-1.sh" \
    CLAUDE_PROJECT_DIR="/nonexistent-bogus-path" \
    "$SCRIPT" --session-base "$base" --repo-dir "$repo" </dev/null 2>&1 ) || rc=$?
  [[ "$rc" -eq 0 ]] || { assert_fail "case11" "expected zero; --repo-dir should override bogus env; got $rc: $out"; return; }
  echo "$out" | grep -q "SUMMARY:.*PASS" || { assert_fail "case11" "missing summary: $out"; return; }
  assert_pass "case11 repo-dir-overrides-env"
}

case1
case2
case3
case4
case5
case6
case7
case8
case9
case10
case11
case12
case13
case14
case15
# ── Case 17: find-peers' left-behind warnings are surfaced, not swallowed ──
case17() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  mkdir -p "$repo/.agents/skills/review"
  printf '#!/usr/bin/env bash\necho "  PEER: lib/other.sh" >&2\necho "⚠ 1 peer(s) may be mid-sweep" >&2\nexit 0\n' >"$repo/.agents/skills/review/find-peers.sh"
  (cd "$repo" && git add -A && git commit -q -m "plant find-peers")
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case17" "warn-only must not fail; got $rc: $out"; return; }
  echo "$out" | grep -q "WARN: find-peers (1 left-behind)" || { assert_fail "case17" "peer warning swallowed: $out"; return; }
  echo "$out" | grep -q "PEER: lib/other.sh" || { assert_fail "case17" "the peer is not named: $out"; return; }
  echo "$out" | grep -q "PASS: find-peers" && { assert_fail "case17" "still reports a clean sweep: $out"; return; }
  assert_pass "case17 find-peers-warnings-surfaced"
}

# ── Case 18: a lint step layer-1 skipped is reported, not counted as linted ──
case18() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  mkdir -p "$repo/_lint"
  printf '#!/usr/bin/env bash\ncat >/dev/null\necho "WARN: layer-1 lint (apps/a) — no lint script or make target; skipped"\nexit 0\n' >"$repo/_lint/layer-1.sh"
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 0 ]] || { assert_fail "case18" "a skipped step must not fail; got $rc: $out"; return; }
  echo "$out" | grep -q "WARN: lint (apps/a) — no lint script or make target; skipped" || { assert_fail "case18" "skip not surfaced: $out"; return; }
  echo "$out" | grep -qx "PASS: lint (1 files)" && { assert_fail "case18" "still reported as linted: $out"; return; }
  assert_pass "case18 lint-skips-surfaced"
}

# ── Case 19: an untracked file is scanned for citations too ──
# check-standards-refs.sh reads files through git, and git ignores an untracked
# path even when it is named — so a brand-new file's citation went unchecked.
case19() {
  local repo fakebin out rc base
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  printf '#!/usr/bin/env bash\ngit ls-files -- "$@" >"%s/seen"\nexit 0\n' "$repo/.agents/checks" >"$repo/.agents/checks/check-standards-refs.sh"
  (cd "$repo" && git add -A && git commit -q -m "stub")
  base=$(cd "$repo" && git rev-parse HEAD)
  echo "See § Standards → X." >"$repo/new-note.md"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  grep -qx "new-note.md" "$repo/.agents/checks/seen" 2>/dev/null || { assert_fail "case19" "the checker could not see the untracked file: $(cat "$repo/.agents/checks/seen" 2>/dev/null)"; return; }
  [[ -z "$(cd "$repo" && git ls-files -- new-note.md)" ]] || { assert_fail "case19" "the real index was changed"; return; }
  assert_pass "case19 untracked-files-scanned-for-citations"
}

# ── Case 20: a git that cannot list the change is an error, not a clean run ──
# Inside a process substitution the failed read listed nothing, and every check
# reported PASS over an empty change.
case20() {
  local repo fakebin out rc base real
  repo=$(make_repo); fakebin=$(mktemp -d); setup_fake_tools "$fakebin"
  setup_fake_lint "$repo" 0
  base=$(cd "$repo" && git rev-parse HEAD)
  add_changes "$repo" "ts"
  real="$(command -v git)"
  printf '#!/usr/bin/env bash\ncase " $* " in *" ls-files --others "*) exit 128 ;; esac\nexec "%s" "$@"\n' "$real" >"$fakebin/git"
  chmod +x "$fakebin/git"
  out=$(run_script "$repo" "$fakebin" --session-base "$base")
  rc=$(echo "$out" | tail -n 1 | sed 's/---RC=//')
  [[ "$rc" -eq 1 ]] || { assert_fail "case20" "a failed listing passed: $rc $out"; return; }
  echo "$out" | grep -q "could not list the change" || { assert_fail "case20" "not said: $out"; return; }
  assert_pass "case20 failed-listing-is-an-error"
}

case16
case17
case18
case19
case20

echo
echo "run-automated-checks.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
