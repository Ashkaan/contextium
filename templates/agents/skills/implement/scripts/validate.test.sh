#!/usr/bin/env bash
# validate.test.sh — the fixed-order Phase 4 driver.
#
# The thing worth testing here is not that each layer runs. It is that the ORDER
# cannot be chosen: there is no argument that reaches the reviewer without
# layer 1 passing first, and no phase that skips E2E after a clean review. A
# suite that only asserted "layer 1 ran" would pass against the SKILL.md table
# this script replaced, which had exactly that hole.
#
# The reviewer is stubbed everywhere. What is under test is how this script
# READS a reviewer — every documented exit code, and the difference between a
# [nit] and a [must-fix] — not whether a vendor answers.
#
# Run: bash .agents/skills/implement/scripts/validate.test.sh
#
# peers:
#   .agents/skills/implement/scripts/validate.sh
#   .agents/skills/qa/scripts/mark-qa-done.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATE="${SCRIPT_DIR}/validate.sh"
SKILLS_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MARK_QA_DONE="${SKILLS_DIR}/qa/scripts/mark-qa-done.sh"
# shellcheck disable=SC1091  # the stamp path lives in /qa's lib, one formula
source "${SKILLS_DIR}/qa/scripts/lib.sh"
set +e # lib.sh turns on errexit; this suite collects failures instead
# These cases test the marker's keys and the gate that reads them, not the
# interaction check behind a served app's marker (tested in
# .agents/skills/qa/scripts/tests/interaction-check.test.sh), so they lay its stamp down.
stamp_interaction() { # <done-dir> <tree> <app>
  local f
  f="$(QA_DONE_DIR="$1" qa_interaction_stamp_path "$3" "$2")"
  mkdir -p "$(dirname "$f")" && touch "$f"
}

TMP="$(mktemp -d -t validate-test-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}
check_rc() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected rc=$expect, got rc=$got"; fi
}
check_has() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle' in:"$'\n'"$hay"; fi
}
check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle' in:"$'\n'"$hay"; else ok; fi
}
check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}

echo "validate.sh: the fixed-order Phase 4 driver"

# ── A worktree that looks like the real one ───────────────────────────

REPO="$TMP/repo"
mkdir -p "$REPO/.agents/checks"
git -C "$REPO" init -q . 2>/dev/null || git init -q "$REPO"
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
printf 'seed\n' >"$REPO/seed.txt"
git -C "$REPO" add seed.txt
git -C "$REPO" commit -qm init

# The snapshot half of the reviewer contract is real git plumbing, so the stub
# implements it rather than faking it — --since scoping and the tree-moved
# branch both depend on a snapshot that actually reflects the working tree.
make_reviewer() {
  local out="$1" rc="$2" path="$TMP/reviewer-$3.sh"
  cat >"$path" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--snapshot" ]]; then
  idx="\$(mktemp)"; rm -f "\$idx"
  GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree HEAD 2>/dev/null || GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree --empty
  GIT_INDEX_FILE="\$idx" git -C "$REPO" add -A 2>/dev/null
  GIT_INDEX_FILE="\$idx" git -C "$REPO" write-tree
  rm -f "\$idx"
  exit 0
fi
echo "\${REVIEWER_ARGS_FILE:-/dev/null}" >/dev/null
printf '%s\n' "\$@" >>"$TMP/reviewer-calls.log"
$(if [[ -n "$out" ]]; then printf 'printf %s "%s"\n' "'%s\\n'" "$out"; fi)
exit $rc
EOF
  chmod +x "$path"
  printf '%s\n' "$path"
}

# No-op stand-ins for the pieces this script only orchestrates.
NOOP="$TMP/noop.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$NOOP"
chmod +x "$NOOP"

run_validate() {
  CLAUDE_PROJECT_DIR="$REPO" \
  VALIDATE_AUTOMATED_CHECKS="${STUB_CHECKS:-$NOOP}" \
  VALIDATE_CODE_REVIEW="${STUB_REVIEW:-$NOOP}" \
  VALIDATE_QA_TARGETS="${STUB_TARGETS:-$NOOP}" \
  VALIDATE_MARK_QA_DONE="$MARK_QA_DONE" \
  QA_DONE_DIR="$TMP/qa-done" \
    bash "$VALIDATE" --repo "$REPO" "$@"
}

# ── The order is not choosable ────────────────────────────────────────
#
# This is the whole point of the script existing. There is no phase name, and no
# combination of flags, that spells "review, then lint".

usage="$(bash "$VALIDATE" --repo "$REPO" --phase review-first 2>&1 || true)"
check_has "an invented phase is refused" "unknown phase" "$usage"
rc=0
bash "$VALIDATE" --repo "$REPO" --phase review-first >/dev/null 2>&1 || rc=$?
check_rc "and refusing it is a caller error" 2 "$rc"

rc=0
bash "$VALIDATE" --repo "$REPO" >/dev/null 2>&1 || rc=$?
check_rc "no phase at all is a caller error" 2 "$rc"

rc=0
bash "$VALIDATE" --repo "$TMP/not-a-repo" --phase checks >/dev/null 2>&1 || rc=$?
check_rc "a non-worktree is a caller error" 2 "$rc"

# ── --phase checks ────────────────────────────────────────────────────

out="$(run_validate --phase checks --scope 'seed.txt' 2>/dev/null)"
check_has "a clean checks phase emits NEED_FIX=0" "NEED_FIX=0" "$out"
# The first E2E is unconditional: an unchanged review must not buy a skipped one.
check_has "checks always asks for the E2E walk" "NEED_E2E=1" "$out"
check_has "and says so in words" "walk SPEC § 6" "$out"

# Layer 1 failing must stop everything. A typecheck error makes a test result
# meaningless and a review of it worse than meaningless.
BAD="$TMP/bad-layer1"
mkdir -p "$BAD"
cat >"$TMP/fail-layer1.sh" <<'EOF'
#!/usr/bin/env bash
cat >/dev/null
echo "FAIL: layer-1 lint (apps/foo)"
exit 1
EOF
chmod +x "$TMP/fail-layer1.sh"
FAKE_SCRIPTS="$TMP/fake-scripts"
mkdir -p "$FAKE_SCRIPTS"
for f in layer-1.sh layer-2.sh layer-3.sh resolve-scope.sh validate.sh; do
  cp "$SCRIPT_DIR/$f" "$FAKE_SCRIPTS/$f"
done
cp "$TMP/fail-layer1.sh" "$FAKE_SCRIPTS/layer-1.sh"
printf '#!/usr/bin/env bash\ncat >/dev/null\necho "layer-2 RAN"\nexit 0\n' >"$FAKE_SCRIPTS/layer-2.sh"
chmod +x "$FAKE_SCRIPTS/layer-2.sh"
REVIEW_CALLED="$TMP/review-called"
# shellcheck disable=SC2016  # the ${1:-} is the stub's own, written into its file unexpanded
printf '#!/usr/bin/env bash\nif [[ "${1:-}" == "--snapshot" ]]; then echo 0000000000000000000000000000000000000000; exit 0; fi\ntouch "%s"\necho NO_FINDINGS\nexit 0\n' "$REVIEW_CALLED" >"$TMP/marking-reviewer.sh"
chmod +x "$TMP/marking-reviewer.sh"

rc=0
out="$(CLAUDE_PROJECT_DIR="$REPO" VALIDATE_CODE_REVIEW="$TMP/marking-reviewer.sh" \
  bash "$FAKE_SCRIPTS/validate.sh" --repo "$REPO" --phase checks --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "layer-1 FAIL fails the checks phase" 1 "$rc"
check_has "layer-1 FAIL still emits NEED_FIX" "NEED_FIX=1" "$out"
check_lacks "layer-1 FAIL does not run layer 2" "layer-2 RAN" "$out"
if [[ -f "$REVIEW_CALLED" ]]; then bad "layer-1 FAIL must not reach the reviewer"; else ok; fi

# ── --phase review reads every documented reviewer exit ───────────────

review_case() {
  local name="$1" stdout="$2" rc_in="$3"
  local stub
  stub="$(make_reviewer "$stdout" "$rc_in" "$name")"
  STUB_REVIEW="$stub" run_validate --phase review --since "$(bash "$stub" --snapshot)" --scope 'seed.txt' 2>/dev/null
}
review_rc() {
  local name="$1" stdout="$2" rc_in="$3" rc=0
  local stub
  stub="$(make_reviewer "$stdout" "$rc_in" "$name")"
  STUB_REVIEW="$stub" run_validate --phase review --since "$(bash "$stub" --snapshot)" --scope 'seed.txt' >/dev/null 2>&1 || rc=$?
  printf '%s\n' "$rc"
}

out="$(review_case clean NO_FINDINGS 0)"
check_has "NO_FINDINGS is NEED_FIX=0" "NEED_FIX=0" "$out"
check_rc "and the phase passes" 0 "$(review_rc clean2 NO_FINDINGS 0)"

out="$(review_case mustfix '[must-fix] a.ts:1: broken — fix it — x' 0)"
check_has "a must-fix sets NEED_FIX=1" "NEED_FIX=1" "$out"
check_has "and the finding is passed through" "[must-fix] a.ts:1" "$out"
check_rc "and the phase fails" 1 "$(review_rc mustfix2 '[must-fix] a.ts:1: broken' 0)"

out="$(review_case shouldfix '[should-fix] a.ts: tidy this' 0)"
check_has "a should-fix also sets NEED_FIX=1" "NEED_FIX=1" "$out"

# A nit is held for the end of the loop, never a reason to re-enter it — nits
# are an unbounded supply.
out="$(review_case nit '[nit] name this better' 0)"
check_has "a nit alone is NEED_FIX=0" "NEED_FIX=0" "$out"
check_has "but the nit is still reported" "[nit] name this better" "$out"
check_rc "and the phase passes on a nit" 0 "$(review_rc nit2 '[nit] x' 0)"

check_rc "exit 4 (converged) is not a failure" 0 "$(review_rc conv '' 4)"
check_has "and says so" "converged" "$(review_case conv2 '' 4)"
check_rc "exit 5 (round ceiling) is not a failure" 0 "$(review_rc ceil '' 5)"
check_has "and says what to do" "still open" "$(review_case ceil2 '' 5)"

check_rc "exit 1 (chain exhausted) fails the phase" 1 "$(review_rc dead '' 1)"
# Exit 3: no independent reviewer answered. That is a review still OWED, not a
# pass and not a failure: the phase exits 3 (pending) until the fresh-context
# fallback reviewer has run and --fallback-review has read its findings. A
# phase that reported success here would let the loop go on with no review.
check_rc "exit 3 (no independent reviewer) leaves the phase pending" 3 "$(review_rc claude '' 3)"
out="$(review_case claude2 '' 3)"
check_has "exit 3 asks for the fresh-context fallback review" "NEED_FALLBACK_REVIEW=1" "$out"
check_has "exit 3 names the line to record" "claude-fallback (fresh context, NOT independent)" "$out"
check_has "exit 3 is not a fix request" "NEED_FIX=0" "$out"
check_lacks "a normal review asks for no fallback" "NEED_FALLBACK_REVIEW=1" "$(review_case clean3 NO_FINDINGS 0)"
# --fallback-review <file> reads the fallback reviewer's triage lines, and is
# the only way out of pending: a finding is NEED_FIX=1 / exit 1, none is a pass.
printf '[nit] tidy this\n' >"$TMP/fb-clean.txt"
printf '[must-fix] a.ts:1: wrong\n[nit] x\n' >"$TMP/fb-dirty.txt"
rc=0; out="$(run_validate --fallback-review "$TMP/fb-clean.txt" 2>/dev/null)" || rc=$?
check_rc "a clean fallback review passes" 0 "$rc"
check_has "…recorded as not independent" "claude-fallback (fresh context, NOT independent)" "$out"
check_has "…with no fix owed" "NEED_FIX=0" "$out"
rc=0; out="$(run_validate --fallback-review "$TMP/fb-dirty.txt" 2>/dev/null)" || rc=$?
check_rc "a fallback finding fails like any review finding" 1 "$rc"
check_has "…and is reported" "[must-fix] a.ts:1: wrong" "$out"
rc=0; run_validate --fallback-review "$TMP/no-such.txt" >/dev/null 2>&1 || rc=$?
check_rc "a missing findings file is a caller error" 2 "$rc"
# An empty file, or one with neither a finding nor the NO_FINDINGS sentinel, is
# a review that did not happen — never a clean one.
: >"$TMP/fb-empty.txt"
printf 'I looked at the diff and it seems fine overall.\n' >"$TMP/fb-prose.txt"
printf 'NO_FINDINGS\n' >"$TMP/fb-none.txt"
rc=0; run_validate --fallback-review "$TMP/fb-empty.txt" >/dev/null 2>&1 || rc=$?
check_rc "an empty fallback findings file fails" 1 "$rc"
rc=0; out="$(run_validate --fallback-review "$TMP/fb-prose.txt" 2>&1)" || rc=$?
check_rc "prose with no finding line and no sentinel fails" 1 "$rc"
check_has "…saying the review did not happen" "did NOT happen" "$out"
rc=0; run_validate --fallback-review "$TMP/fb-none.txt" >/dev/null 2>&1 || rc=$?
check_rc "NO_FINDINGS is a clean fallback review" 0 "$rc"
# The fallback reviewer's own format (.agents/agents/implement-audit-reviewer.md)
# is read as it is: a fix-now or deferred-batch verdict is a fix owed, and its
# "Zero findings." line is a clean review.
# shellcheck disable=SC2016  # the reviewer's format has literal backticks
printf '## Findings\n\n1. **Off by one**: `a.ts:3` — loop bound — verdict: **fix-now** — violated rule: none — use <\n' >"$TMP/fb-agent.txt"
# shellcheck disable=SC2016  # the reviewer's format has literal backticks
printf '## Findings\n\n1. **Maybe**: `a.ts:3` — hunch — verdict: **speculative** — violated rule: none — none\n' >"$TMP/fb-agent-spec.txt"
printf 'Zero findings. Work is consistent, complete, and downstream-clean within the reviewed scope.\n' >"$TMP/fb-agent-zero.txt"
rc=0; run_validate --fallback-review "$TMP/fb-agent.txt" >/dev/null 2>&1 || rc=$?
check_rc "the agent's fix-now verdict is a fix owed" 1 "$rc"
rc=0; run_validate --fallback-review "$TMP/fb-agent-spec.txt" >/dev/null 2>&1 || rc=$?
check_rc "the agent's speculative-only verdict is a pass" 0 "$rc"
rc=0; run_validate --fallback-review "$TMP/fb-agent-zero.txt" >/dev/null 2>&1 || rc=$?
check_rc "the agent's Zero findings line is a clean review" 0 "$rc"
check_rc "exit 124 (timeout) fails the phase" 1 "$(review_rc slow '' 124)"
# review_case swallows stderr on purpose (the stub is noisy); this one case
# wants it, so it calls the driver directly.
DEAD="$(make_reviewer '' 1 dead2)"
check_has "a dead chain says the review did not happen" "did NOT happen" \
  "$(STUB_REVIEW="$DEAD" run_validate --phase review --since "$(bash "$DEAD" --snapshot)" --scope 'seed.txt' 2>&1 || true)"

# A missing reviewer is a failed audit, never a quiet pass.
rc=0
out="$(STUB_REVIEW="$TMP/no-such-reviewer.sh" run_validate --phase review \
  --base HEAD --head HEAD --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "a missing reviewer fails the phase" 1 "$rc"
check_has "and sets NEED_FIX=1" "NEED_FIX=1" "$out"

# Round 1 needs a range; rounds 2+ need a tree. Neither is guessed.
rc=0
STUB_REVIEW="$(make_reviewer NO_FINDINGS 0 arity)" run_validate --phase review \
  --scope 'seed.txt' >/dev/null 2>&1 || rc=$?
check_rc "review with neither --base/--head nor --since is a caller error" 2 "$rc"

# The automated checks are mandatory: a FAIL there stops the phase before a
# vendor call is spent.
printf '#!/usr/bin/env bash\necho "FAIL: check-refs a.ts:1 dangling"\nexit 1\n' >"$TMP/failing-checks.sh"
chmod +x "$TMP/failing-checks.sh"
rc=0
out="$(STUB_CHECKS="$TMP/failing-checks.sh" STUB_REVIEW="$(make_reviewer NO_FINDINGS 0 checksfail)" \
  run_validate --phase review --base HEAD --head HEAD --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "a failing automated check fails the phase" 1 "$rc"
check_has "and sets NEED_FIX=1" "NEED_FIX=1" "$out"

# ── The tree moving over a review re-arms E2E ─────────────────────────
#
# The reviewer never edits the tree, so a moved tree means something else did —
# and the layers already ran against bytes that are no longer what ships.

MOVER="$TMP/tree-mover.sh"
cat >"$MOVER" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--snapshot" ]]; then
  idx="\$(mktemp)"; rm -f "\$idx"
  GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree HEAD 2>/dev/null || GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree --empty
  GIT_INDEX_FILE="\$idx" git -C "$REPO" add -A 2>/dev/null
  GIT_INDEX_FILE="\$idx" git -C "$REPO" write-tree
  rm -f "\$idx"
  exit 0
fi
# Something edits the tree while the round is in flight.
date +%s%N >"$REPO/moved.txt"
echo NO_FINDINGS
exit 0
EOF
chmod +x "$MOVER"
out="$(STUB_REVIEW="$MOVER" run_validate --phase review --base HEAD --head HEAD --scope 'seed.txt' 2>/dev/null)"
check_has "a tree that moved over the review re-arms E2E" "NEED_E2E=1" "$out"
rm -f "$REPO/moved.txt"

STILL="$(make_reviewer NO_FINDINGS 0 still)"
out="$(STUB_REVIEW="$STILL" run_validate --phase review --base HEAD --head HEAD --scope 'seed.txt' 2>/dev/null)"
check_has "an unmoved tree does not re-arm E2E" "NEED_E2E=0" "$out"

# ── --phase qa-list ───────────────────────────────────────────────────

printf '#!/usr/bin/env bash\nexit 0\n' >"$TMP/no-targets.sh"
chmod +x "$TMP/no-targets.sh"
out="$(STUB_TARGETS="$TMP/no-targets.sh" run_validate --phase qa-list 2>/dev/null)"
check_has "no web target prints an empty QA_TARGETS" "QA_TARGETS=" "$out"
check_has "and names the record to keep" "skipped-not-web" "$out"

printf '#!/usr/bin/env bash\necho /apps/one\necho /apps/two\n' >"$TMP/two-targets.sh"
chmod +x "$TMP/two-targets.sh"
out="$(STUB_TARGETS="$TMP/two-targets.sh" run_validate --phase qa-list 2>/dev/null)"
check_eq "two targets are two QA_TARGETS lines" "2" "$(grep -c '^QA_TARGETS=/apps/' <<<"$out")"
check_has "the first target" "QA_TARGETS=/apps/one" "$out"
check_has "the second target" "QA_TARGETS=/apps/two" "$out"

# The enumerator failing is a HALT. A detector failure that read as "no UI
# changed" would close a UI session with no QA at all.
printf '#!/usr/bin/env bash\nexit 2\n' >"$TMP/broken-targets.sh"
chmod +x "$TMP/broken-targets.sh"
rc=0
errf="$TMP/qa-list.err"
STUB_TARGETS="$TMP/broken-targets.sh" run_validate --phase qa-list >/dev/null 2>"$errf" || rc=$?
check_rc "a failing enumerator is a HALT" 2 "$rc"
check_has "and says why" "must never read as 'no UI changed'" "$(cat "$errf")"

# ── --require-qa ──────────────────────────────────────────────────────
#
# The gate that makes "QA must run fully if there's a UI" a mechanism rather
# than an instruction.

APP_A="$TMP/app-a"
APP_B="$TMP/app-b"
mkdir -p "$APP_A" "$APP_B"
printf '%s\n%s\n' "$APP_A" "$APP_B" >"$TMP/targets.txt"
: >"$TMP/empty-targets.txt"

TREE1=1111111111111111111111111111111111111111
TREE2=2222222222222222222222222222222222222222

rm -rf "$TMP/qa-done"
rc=0
out="$(run_validate --require-qa --targets-file "$TMP/targets.txt" --tree "$TREE1" 2>/dev/null)" || rc=$?
check_rc "a web target with no marker blocks the close" 1 "$rc"
check_has "and names the target" "FAIL: qa-marker $APP_A" "$out"

stamp_interaction "$TMP/qa-done" "$TREE1" "$APP_A"
QA_DONE_DIR="$TMP/qa-done" bash "$MARK_QA_DONE" --tree "$TREE1" "$APP_A" >/dev/null
rc=0
out="$(run_validate --require-qa --targets-file "$TMP/targets.txt" --tree "$TREE1" 2>/dev/null)" || rc=$?
check_rc "one of two marked is still a block" 1 "$rc"
check_has "the marked one passes" "PASS: qa-marker $APP_A" "$out"
check_has "the unmarked one fails" "FAIL: qa-marker $APP_B" "$out"

stamp_interaction "$TMP/qa-done" "$TREE1" "$APP_B"
QA_DONE_DIR="$TMP/qa-done" bash "$MARK_QA_DONE" --tree "$TREE1" "$APP_B" >/dev/null
rc=0
out="$(run_validate --require-qa --targets-file "$TMP/targets.txt" --tree "$TREE1" 2>/dev/null)" || rc=$?
check_rc "both marked passes" 0 "$rc"
check_has "and says how many" "2 target(s) complete" "$out"

# The two-target case from SPEC § 4: B's /qa edited source, so the tree moved,
# so A's pass no longer describes what ships. A must run again.
rc=0
out="$(run_validate --require-qa --targets-file "$TMP/targets.txt" --tree "$TREE2" 2>/dev/null)" || rc=$?
check_rc "a marker from the OLD tree does not satisfy the new one" 1 "$rc"
check_has "A is re-armed by the tree move" "FAIL: qa-marker $APP_A" "$out"
check_has "and so is B" "FAIL: qa-marker $APP_B" "$out"

# 0 targets: nothing to require.
rc=0
out="$(run_validate --require-qa --targets-file "$TMP/empty-targets.txt" --tree "$TREE2" 2>/dev/null)" || rc=$?
check_rc "0 targets is a no-op pass" 0 "$rc"

rc=0
run_validate --require-qa --targets-file "$TMP/targets.txt" >/dev/null 2>&1 || rc=$?
check_rc "--require-qa without --tree is a caller error" 2 "$rc"
rc=0
run_validate --require-qa --tree "$TREE1" >/dev/null 2>&1 || rc=$?
check_rc "--require-qa without --targets-file is a caller error" 2 "$rc"
rc=0
run_validate --require-qa --targets-file "$TMP/no-such-file" --tree "$TREE1" >/dev/null 2>&1 || rc=$?
check_rc "an unreadable targets file is a caller error" 2 "$rc"

# ── --phase qa-revalidate ─────────────────────────────────────────────

UNMOVED="$(make_reviewer NO_FINDINGS 0 qaclean)"
SNAP_NOW="$(bash "$UNMOVED" --snapshot)"
out="$(STUB_REVIEW="$UNMOVED" run_validate --phase qa-revalidate --since "$SNAP_NOW" --scope 'seed.txt' 2>/dev/null)"
check_has "/qa that changed nothing needs no re-review" "changed nothing" "$out"
check_has "and does not re-arm E2E" "NEED_E2E=0" "$out"

# /qa edited source: those edits are code nobody reviewed.
printf 'a fix /qa made\n' >"$REPO/qa-fix.txt"
out="$(STUB_REVIEW="$UNMOVED" run_validate --phase qa-revalidate --since "$SNAP_NOW" --scope 'seed.txt' 2>/dev/null)"
check_has "/qa's edits re-arm E2E" "NEED_E2E=1" "$out"
check_has "and come back reviewed clean" "NEED_FIX=0" "$out"

DIRTY="$(make_reviewer '[must-fix] qa-fix.txt:1: /qa broke it' 0 qadirty)"
rc=0
out="$(STUB_REVIEW="$DIRTY" run_validate --phase qa-revalidate --since "$SNAP_NOW" --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "a finding in /qa's own edits fails the phase" 1 "$rc"
check_has "and is reported" "/qa broke it" "$out"
rm -f "$REPO/qa-fix.txt"

# No independent reviewer for /qa's edits: pending, exactly as in --phase review.
printf 'another /qa fix\n' >"$REPO/qa-fix.txt"
NOREV="$(make_reviewer '' 3 qanorev)"
rc=0
out="$(STUB_REVIEW="$NOREV" run_validate --phase qa-revalidate --since "$SNAP_NOW" --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "qa-revalidate with no independent reviewer is pending" 3 "$rc"
check_has "…and asks for the fallback review" "NEED_FALLBACK_REVIEW=1" "$out"
rm -f "$REPO/qa-fix.txt"

rc=0
run_validate --phase qa-revalidate --scope 'seed.txt' >/dev/null 2>&1 || rc=$?
check_rc "qa-revalidate without --since is a caller error" 2 "$rc"

# A web repo that is NOT the workbench carries no reviewer of its own. It
# borrows the workbench's rather than refusing — otherwise a product repo's
# post-QA gate could never pass.
OTHER="$TMP/other-repo"
mkdir -p "$OTHER" "$TMP/shared/.agents/skills/review" "$TMP/shared/tools"
git -C "$OTHER" init -q . 2>/dev/null
git -C "$OTHER" config user.email t@t
git -C "$OTHER" config user.name t
printf 'x\n' >"$OTHER/page.txt"
git -C "$OTHER" add page.txt
git -C "$OTHER" commit -qm init
cat >"$TMP/shared/.agents/skills/review/code-review.sh" <<'CLONEREVIEWER'
#!/usr/bin/env bash
if [[ "${1:-}" == "--snapshot" ]]; then
  idx="$(mktemp)"; rm -f "$idx"
  GIT_INDEX_FILE="$idx" git read-tree HEAD
  GIT_INDEX_FILE="$idx" git add -A
  GIT_INDEX_FILE="$idx" git write-tree
  rm -f "$idx"; exit 0
fi
echo "shared-reviewer ran" >&2
echo NO_FINDINGS
exit 0
CLONEREVIEWER
chmod +x "$TMP/shared/.agents/skills/review/code-review.sh"
# A reviewer planted anywhere else in the shared checkout must never be the one
# that runs: the fallback reads .agents/skills/review/ and nothing else.
ELSEWHERE="$TMP/shared/tools"
sed 's/shared-reviewer ran/old-path reviewer ran/' "$TMP/shared/.agents/skills/review/code-review.sh" \
  >"$ELSEWHERE/code-review.sh"
chmod +x "$ELSEWHERE/code-review.sh"
OTHER_SNAP="$(git -C "$OTHER" write-tree)"
printf 'a /qa fix\n' >"$OTHER/fix.txt"
rc=0
out="$(cd "$OTHER" && CLAUDE_PROJECT_DIR="$OTHER" WORKBENCH_SHARED_DIR="$TMP/shared" \
  VALIDATE_AUTOMATED_CHECKS="$NOOP" VALIDATE_QA_TARGETS="$NOOP" VALIDATE_MARK_QA_DONE="$MARK_QA_DONE" \
  QA_DONE_DIR="$TMP/qa-done" bash "$VALIDATE" --repo "$OTHER" --phase qa-revalidate --since "$OTHER_SNAP" 2>&1)" || rc=$?
check_lacks "a repo with no reviewer of its own borrows the shared workbench checkout's" "no reviewer at" "$out"
check_has "and the borrowed reviewer is the one that ran" "shared-reviewer ran" "$out"
check_lacks "and no other path in the shared checkout is consulted" "old-path reviewer ran" "$out"

# A repo that carries its own reviewer under .agents/skills/review uses that one, never
# the shared checkout's — the only reviewer root the script reads.
OWN="$TMP/own-repo"
mkdir -p "$OWN/.agents/skills/review"
git -C "$OWN" init -q . 2>/dev/null
git -C "$OWN" config user.email t@t
git -C "$OWN" config user.name t
printf 'x\n' >"$OWN/page.txt"
sed 's/shared-reviewer ran/own-reviewer ran/' "$TMP/shared/.agents/skills/review/code-review.sh" \
  >"$OWN/.agents/skills/review/code-review.sh"
chmod +x "$OWN/.agents/skills/review/code-review.sh"
git -C "$OWN" add -A
git -C "$OWN" commit -qm init
OWN_SNAP="$(git -C "$OWN" write-tree)"
printf 'a /qa fix\n' >"$OWN/fix.txt"
rc=0
out="$(cd "$OWN" && CLAUDE_PROJECT_DIR="$OWN" WORKBENCH_SHARED_DIR="$TMP/shared" \
  VALIDATE_AUTOMATED_CHECKS="$NOOP" VALIDATE_QA_TARGETS="$NOOP" VALIDATE_MARK_QA_DONE="$MARK_QA_DONE" \
  QA_DONE_DIR="$TMP/qa-done" bash "$VALIDATE" --repo "$OWN" --phase qa-revalidate --since "$OWN_SNAP" 2>&1)" || rc=$?
check_has "a repo's own .agents/skills/review reviewer is the one that runs" "own-reviewer ran" "$out"
check_lacks "and the shared checkout's does not" "shared-reviewer ran" "$out"

# ── The findings of this change's own machine review ──────────────────

# An unresolvable scope is a caller error, not an empty run. Every caller
# invokes run_layers_1_2 in an OR-list, which suspends errexit for the whole
# body — so a failing resolve-scope left the file list empty and the layers
# reported PASS over nothing.
rc=0
out="$(run_validate --phase checks --scope 'apps/definitely-not-an-app' 2>/dev/null)" || rc=$?
check_rc "an unresolvable scope fails the phase" 1 "$rc"
check_has "and does not read as a clean run" "NEED_FIX=1" "$out"

# On a FOLLOW-UP round, $PRE is taken after the fixes were written, so comparing
# POST against it declares them validated. The baseline has to be $SINCE — the
# snapshot from before the previous round — because everything between is this
# round's unvalidated fixes.
FIXED="$(make_reviewer NO_FINDINGS 0 roundfix)"
SNAP_BEFORE_FIXES="$(bash "$FIXED" --snapshot)"
printf 'a fix written between rounds
' >"$REPO/between-rounds.txt"
out="$(STUB_REVIEW="$FIXED" run_validate --phase review --since "$SNAP_BEFORE_FIXES" --scope 'seed.txt' 2>/dev/null)"
check_has "a follow-up round re-arms E2E for the fixes since --since" "NEED_E2E=1" "$out"
rm -f "$REPO/between-rounds.txt"

# …and does not re-arm it when nothing moved since that snapshot.
SNAP_SETTLED="$(bash "$FIXED" --snapshot)"
out="$(STUB_REVIEW="$FIXED" run_validate --phase review --since "$SNAP_SETTLED" --scope 'seed.txt' 2>/dev/null)"
check_has "a settled follow-up round does not re-arm E2E" "NEED_E2E=0" "$out"

# qa-list passes --base through, so a UI change the session already COMMITTED
# still enumerates.
BASE_PROBE="$TMP/base-probe.sh"
printf '#!/usr/bin/env bash
printf "%%s\n" "$@" >"%s"
exit 0
' "$TMP/qa-targets-args" >"$BASE_PROBE"
chmod +x "$BASE_PROBE"
_=$(STUB_TARGETS="$BASE_PROBE" run_validate --phase qa-list --base "deadbeef" 2>/dev/null)
check_has "qa-list forwards --base to the enumerator" "--base" "$(cat "$TMP/qa-targets-args")"
check_has "and the value with it" "deadbeef" "$(cat "$TMP/qa-targets-args")"
_=$(STUB_TARGETS="$BASE_PROBE" run_validate --phase qa-list 2>/dev/null)
check_lacks "and omits it when there is none" "--base" "$(cat "$TMP/qa-targets-args")"

# The post-QA review gets its OWN round budget. The implementation fix loop can
# spend all four rounds, and without a separate counter this review would return
# exit 5 without calling a vendor — shipping /qa's own source edits unreviewed
# behind a "ceiling reached" note.
ARGS_PROBE="$TMP/round-probe.sh"
cat >"$ARGS_PROBE" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "--snapshot" ]]; then
  idx="\$(mktemp)"; rm -f "\$idx"
  GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree HEAD 2>/dev/null || GIT_INDEX_FILE="\$idx" git -C "$REPO" read-tree --empty
  GIT_INDEX_FILE="\$idx" git -C "$REPO" add -A 2>/dev/null
  GIT_INDEX_FILE="\$idx" git -C "$REPO" write-tree
  rm -f "\$idx"
  exit 0
fi
printf '%s
' "\${CODE_REVIEW_ROUND_STATE_DIR:-unset}" >"$TMP/round-dir"
echo NO_FINDINGS
exit 0
EOF
chmod +x "$ARGS_PROBE"
SNAP_QA_ROUNDS="$(bash "$ARGS_PROBE" --snapshot)"
printf 'a fix /qa made
' >"$REPO/qa-round-fix.txt"
_=$(CODE_REVIEW_ROUND_STATE_DIR="$TMP/impl-rounds" STUB_REVIEW="$ARGS_PROBE"   run_validate --phase qa-revalidate --since "$SNAP_QA_ROUNDS" --scope 'seed.txt' 2>/dev/null)
check_has "the post-QA review gets its own round counter" "impl-rounds-qa" "$(cat "$TMP/round-dir")"

# And if the ceiling somehow fires there, it is unreviewed code, not a note.
CEIL_STUB="$(make_reviewer '' 5 qaceil)"
rc=0
out="$(STUB_REVIEW="$CEIL_STUB" run_validate --phase qa-revalidate --since "$SNAP_QA_ROUNDS" --scope 'seed.txt' 2>/dev/null)" || rc=$?
check_rc "a ceilinged post-QA review fails the phase" 1 "$rc"
check_has "and says NEED_FIX" "NEED_FIX=1" "$out"

# The post-QA layers run over what /qa MOVED. Its fixes are routinely unstaged
# or untracked, and a blank scope resolves to the STAGED set — so this used to
# report PASS over files it had never opened.
LAYER_PROBE="$TMP/layer-probe"
mkdir -p "$LAYER_PROBE"
for f in layer-1.sh layer-2.sh layer-3.sh resolve-scope.sh validate.sh; do
  cp "$SCRIPT_DIR/$f" "$LAYER_PROBE/$f"
done
printf '#!/usr/bin/env bash
cat >"%s"
exit 0
' "$TMP/layer1-stdin" >"$LAYER_PROBE/layer-1.sh"
printf '#!/usr/bin/env bash
cat >/dev/null
exit 0
' >"$LAYER_PROBE/layer-2.sh"
chmod +x "$LAYER_PROBE/layer-1.sh" "$LAYER_PROBE/layer-2.sh"
SNAP_FILES="$(bash "$ARGS_PROBE" --snapshot)"
printf 'untracked qa fix
' >"$REPO/qa-untracked-fix.txt"
_=$(CLAUDE_PROJECT_DIR="$REPO" VALIDATE_CODE_REVIEW="$ARGS_PROBE"   VALIDATE_MARK_QA_DONE="$MARK_QA_DONE" QA_DONE_DIR="$TMP/qa-done"   bash "$LAYER_PROBE/validate.sh" --repo "$REPO" --phase qa-revalidate   --since "$SNAP_FILES" --scope '' 2>/dev/null)
check_has "the post-QA layers see /qa's UNTRACKED fix" "qa-untracked-fix.txt" "$(cat "$TMP/layer1-stdin")"
rm -f "$REPO/qa-round-fix.txt" "$REPO/qa-untracked-fix.txt"

# ── The marker keys are two, and only one of them is ours ─────────────
#
# The Stop hook in the context repo computes `$(basename "$repo")-$hash` inline
# and has never heard of this script. Moving the CHANGE-SET marker to the
# collision-safe slug silently stopped every completed /qa from clearing it.

MARKREPO="$TMP/markrepo"
mkdir -p "$MARKREPO"
git -C "$MARKREPO" init -q . 2>/dev/null || git init -q "$MARKREPO"
git -C "$MARKREPO" config user.email t@t
git -C "$MARKREPO" config user.name t
printf 'x
' >"$MARKREPO/f.txt"
rm -rf "$TMP/marker-keys"
stamp_interaction "$TMP/marker-keys" "$TREE1" "$MARKREPO"
QA_DONE_DIR="$TMP/marker-keys" bash "$MARK_QA_DONE" --tree "$TREE1" "$MARKREPO" >/dev/null
legacy_hash="$(git -C "$MARKREPO" status --porcelain 2>/dev/null | cksum | cut -d' ' -f1)"
if [[ -f "$TMP/marker-keys/markrepo-$legacy_hash" ]]; then ok
else bad "the change-set marker must keep the bare-basename key the Stop hook reads"; fi
marker="$(QA_DONE_DIR="$TMP/marker-keys" bash "$MARK_QA_DONE" --marker-path --tree "$TREE1" "$MARKREPO")"
if [[ -f "$marker" ]]; then ok; else bad "the tree marker was not written at its own key"; fi
check_lacks "and the two keys are not the same file" "markrepo-$legacy_hash" "$marker"

# ── Every phase emits both machine fields ─────────────────────────────
#
# A caller branching on NEED_FIX must never have to tell "0" from "the script
# died before printing it" — an absent field reads as a pass in every shell
# idiom there is.

for probe in \
  "--phase checks --scope seed.txt" \
  "--phase qa-list"; do
  # shellcheck disable=SC2086  # deliberate word-splitting of the probe args
  out="$(STUB_TARGETS="$TMP/no-targets.sh" run_validate $probe 2>/dev/null || true)"
  check_has "[$probe] emits NEED_FIX" "NEED_FIX=" "$out"
  check_has "[$probe] emits NEED_E2E" "NEED_E2E=" "$out"
done
out="$(review_case fields NO_FINDINGS 0)"
check_has "[review] emits NEED_FIX" "NEED_FIX=" "$out"
check_has "[review] emits NEED_E2E" "NEED_E2E=" "$out"

echo "validate: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
