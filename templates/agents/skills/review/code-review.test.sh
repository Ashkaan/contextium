#!/usr/bin/env bash
# code-review.test.sh — the INCREMENTAL review modes (`--snapshot`, `--since`),
# which stop the fix loop from re-reading settled code every round.
#
# The vendor-chain behaviors of this same script (fall-through on a dead or hung
# primary, hard failure on exhaustion, `--fixture`, the diff-byte budget) are
# asserted in policy-chain.test.sh's "caller-scoped rows" section and are NOT
# duplicated here — one fact, one home. What lives here is everything about
# WHICH BYTES reach the reviewer, which that suite does not look at.
#
# It also pins the BLAST-RADIUS PACK — the caller context
# blast-radius.sh computes and this script splices into SUBJECT. Same question,
# same reason: the packer has its own suite for whether the pack is RIGHT, and
# what lives here is whether it reaches the prompt, stays scoped on `--since`,
# and fails open when it cannot run.
#
# Every case drives a stub vendor that dumps its stdin, so the assertions are
# about the prompt actually sent, not about what a live model said. No case
# needs auth, quota, or a network.
#
# Run: bash skills/review/code-review.test.sh
#
# `set -uo pipefail` without `-e`, matching every other test script in this dir:
# a suite whose job is driving expected non-zero exits cannot run under `-e`.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REVIEW="${SCRIPT_DIR}/code-review.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/code-review-test.XXXXXX")"
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
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle'"; fi
}
check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle'"; else ok; fi
}
check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}

# ── Fixtures ──────────────────────────────────────────────────────────

POLICY="$TMP/policy.json"
cat >"$POLICY" <<'EOF'
{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    }
  }
}
EOF

# Model resolution reads a vendor's live catalog; these cases stub the vendor,
# so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.sh). It
# resolves the fixture families the way a real catalog would and
# fails a family named `unresolvable-{v}`.
cat >"$TMP/resolve-model.sh" <<'RESOLVER'
#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2 in the $1 catalog" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
RESOLVER
chmod +x "$TMP/resolve-model.sh"
export POLICY_CHAIN_RESOLVER="$TMP/resolve-model.sh"

# Dumps the prompt it was handed, then reviews clean. Every assertion about what
# the reviewer SAW reads the dump.
SEEN="$TMP/seen.txt"
STUB="$TMP/dump-prompt.sh"
cat >"$STUB" <<EOF
#!/usr/bin/env bash
cat > "$SEEN"
echo NO_FINDINGS
EOF
chmod +x "$STUB"

# A scratch repo standing in for a session worktree: two committed files, so a
# later `--since` diff can be shown to carry ONE of them and not the other.
REPO="$TMP/repo"
mkdir -p "$REPO"
git -C "$REPO" init -q .
git -C "$REPO" config user.email t@t
git -C "$REPO" config user.name t
printf 'alpha one\nalpha two\nalpha three\n' >"$REPO/alpha.txt"
printf 'beta one\nbeta two\nbeta three\n' >"$REPO/beta.txt"
printf 'ignored/\n' >"$REPO/.gitignore"
git -C "$REPO" add -A
git -C "$REPO" commit -qm init

run_review() {
  # Round state in this suite's OWN scratch dir. It defaults to a shared
  # /tmp path keyed by session id, so without this the suite both inherits the
  # round count of whatever session is running it — tripping the round-4
  # ceiling and failing with exit 5 on the second run of the day — and leaves
  # its own counts behind for the next one.
  CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
    CODE_REVIEW_ROUND_STATE_DIR="$TMP/rounds" \
    CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" "$@"
}
snapshot() { CODEX_REVIEW_REPO="$REPO" bash "$REVIEW" --snapshot; }

echo "code-review.sh: incremental review modes"

# ── --snapshot ────────────────────────────────────────────────────────

SNAP0="$(snapshot)"
if [[ "$SNAP0" =~ ^[0-9a-f]{40}$ ]]; then ok; else bad "snapshot prints a 40-hex object id — got '$SNAP0'"; fi
check_eq "snapshot's object is a tree" "tree" "$(git -C "$REPO" cat-file -t "$SNAP0" 2>&1)"

# The script runs mid-session against uncommitted work, so a snapshot that
# disturbed the session's own git state would be worse than no snapshot at all.
printf 'staged edit\n' >>"$REPO/beta.txt"
git -C "$REPO" add beta.txt
HEAD_BEFORE="$(git -C "$REPO" rev-parse HEAD)"
STATUS_BEFORE="$(git -C "$REPO" status --porcelain)"
STASH_BEFORE="$(git -C "$REPO" stash list | wc -l)"
BETA_BEFORE="$(cat "$REPO/beta.txt")"
_=$(snapshot)
check_eq "snapshot leaves HEAD alone" "$HEAD_BEFORE" "$(git -C "$REPO" rev-parse HEAD)"
check_eq "snapshot leaves the index alone" "$STATUS_BEFORE" "$(git -C "$REPO" status --porcelain)"
check_eq "snapshot leaves the stash alone" "$STASH_BEFORE" "$(git -C "$REPO" stash list | wc -l)"
check_eq "snapshot leaves the working tree alone" "$BETA_BEFORE" "$(cat "$REPO/beta.txt")"

# Untracked capture is the reason this is not `git stash create`: a file a fix
# round CREATES must not read as new surface in every round after it.
git -C "$REPO" reset -q --hard
printf 'untracked helper\n' >"$REPO/helper.txt"
mkdir -p "$REPO/ignored"
printf 'noise\n' >"$REPO/ignored/junk.txt"
SNAP_UNTRACKED="$(snapshot)"
TREE_FILES="$(git -C "$REPO" ls-tree -r --name-only "$SNAP_UNTRACKED")"
check_has "snapshot captures untracked files" "helper.txt" "$TREE_FILES"
check_lacks "snapshot honors .gitignore" "ignored/junk.txt" "$TREE_FILES"

# ── --since: the converged case ───────────────────────────────────────

rc=0
errf="$TMP/since.err"
run_review --since "$SNAP_UNTRACKED" >/dev/null 2>"$errf" || rc=$?
check_rc "--since with nothing changed exits 4 (converged)" 4 "$rc"
check_has "the converged exit says so" "converged" "$(cat "$errf")"
check_eq "the converged exit spends no vendor call" "" "$(cat "$SEEN" 2>/dev/null || echo "")"

# ── --since: the delta only ───────────────────────────────────────────

SNAP1="$(snapshot)"
printf 'alpha one\nalpha two FIXED\nalpha three\n' >"$REPO/alpha.txt"
rc=0
run_review --since "$SNAP1" >/dev/null 2>&1 || rc=$?
check_rc "--since with a fix reviews and exits 0" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the fixed file reaches the reviewer" "alpha two FIXED" "$SEEN_TEXT"
# The point of the whole change: settled code stops being re-sent every round.
check_lacks "the untouched file does NOT reach the reviewer" "beta two" "$SEEN_TEXT"
check_has "the reviewer is told this is a follow-up round" "FOLLOW-UP ROUND" "$SEEN_TEXT"
check_has "the follow-up brief asks about fix-induced defects" "introduce a NEW defect" "$SEEN_TEXT"

# A file created BY a fix round belongs in that round's diff — and, once
# snapshotted, must not reappear in the next one.
SNAP2="$(snapshot)"
printf 'export const shared = 1\n' >"$REPO/created-by-fix.ts"
rc=0
run_review --since "$SNAP2" >/dev/null 2>&1 || rc=$?
check_rc "a file created by a fix round is reviewable" 0 "$rc"
check_has "the newly created file reaches the reviewer" "created-by-fix.ts" "$(cat "$SEEN")"

SNAP3="$(snapshot)"
rc=0
run_review --since "$SNAP3" >/dev/null 2>&1 || rc=$?
check_rc "the created file does not re-review forever" 4 "$rc"

# ── A git read that FAILS is not "nothing changed" ───────────────────
# A failed `git diff` read as empty would print "converged" (exit 4) — an
# APPROVE over a review that never compared anything. It is a failed review.
fakegit="$TMP/fakegit"; mkdir -p "$fakegit"
realgit="$(command -v git)"
cat >"$fakegit/git" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  if [ "\$a" = "\${FAKE_GIT_FAIL:-}" ]; then echo "fatal: simulated \$a failure" >&2; exit 128; fi
done
exec "$realgit" "\$@"
EOF
chmod +x "$fakegit/git"
SNAP_GF="$(snapshot)"
printf 'export const afterGitFail = 1\n' >>"$REPO/created-by-fix.ts"
rc=0
PATH="$fakegit:$PATH" FAKE_GIT_FAIL=diff run_review --since "$SNAP_GF" >/dev/null 2>"$TMP/gitfail.err" || rc=$?
check_rc "a failed git diff on --since is exit 1, not converged" 1 "$rc"
check_has "…and names the failed read" "git diff failed" "$(cat "$TMP/gitfail.err")"
rc=0
PATH="$fakegit:$PATH" FAKE_GIT_FAIL=diff run_review HEAD HEAD >/dev/null 2>"$TMP/gitfail2.err" || rc=$?
check_rc "a failed git diff on a full review is exit 1" 1 "$rc"
check_has "…and names the failed read" "git diff failed" "$(cat "$TMP/gitfail2.err")"

# The blast-radius pack's own diff read fails open — the review still runs —
# but it says so: silently incomplete caller context is not acceptable.
cat >"$fakegit/git" <<EOF
#!/usr/bin/env bash
if [ "\$*" = "\${FAKE_GIT_FAIL_ARGV:-}" ]; then echo "fatal: simulated failure" >&2; exit 128; fi
exec "$realgit" "\$@"
EOF
chmod +x "$fakegit/git"
printf 'export const packProbe = 1\n' >"$REPO/pack-probe.ts"
git -C "$REPO" add -A && git -C "$REPO" commit -qm pack-probe
PACK_BASE="$(git -C "$REPO" rev-parse HEAD~1)"
rc=0
PATH="$fakegit:$PATH" FAKE_GIT_FAIL_ARGV="diff $PACK_BASE" run_review HEAD~1 HEAD >/dev/null 2>"$TMP/packfail.err" || rc=$?
check_rc "a failed pack diff still reviews (fails open)" 0 "$rc"
check_has "…and says the caller context is incomplete" "blast-radius diff could not be read" "$(cat "$TMP/packfail.err")"

# ── --since: caller errors ────────────────────────────────────────────

rc=0
errf="$TMP/badtree.err"
run_review --since "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" >/dev/null 2>"$errf" || rc=$?
check_rc "an unresolvable --since tree is a caller error" 2 "$rc"
check_has "the caller error names the snapshot contract" "written by --snapshot" "$(cat "$errf")"

rc=0
run_review --since >/dev/null 2>&1 || rc=$?
check_rc "--since with no tree is a caller error" 2 "$rc"

# An over-budget follow-up is refused rather than truncated, exactly as the full
# review is — a partial review reported as clean is the failure this script exists
# to prevent, and the follow-up path must not be the hole in it.
SNAP4="$(snapshot)"
head -c 2000 /dev/zero | tr '\0' 'x' >"$REPO/big.txt"
rc=0
errf="$TMP/big.err"
CODEX_REVIEW_MAX_DIFF_BYTES=500 CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
  CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" --since "$SNAP4" >/dev/null 2>"$errf" || rc=$?
check_rc "an over-budget follow-up is refused, not truncated" 1 "$rc"
check_has "the refusal says why" "Refusing rather than reviewing a truncated slice" "$(cat "$errf")"

# ── The round-4 ceiling ───────────────────────────────────────────────
#
# The skill's prose said "stop" before this script did, and a 34-round audit is
# what that was worth. These cases assert the mechanism, not the instruction.

CEIL_STATE="$TMP/rounds"
ceil_review() {
  CODE_REVIEW_ROUND_STATE_DIR="$CEIL_STATE" CLAUDE_CODE_SESSION_ID="ceiling-test" \
    CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
    CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" --since "$1"
}
# Each round needs a real edit, or the converged exit fires before the ceiling.
ceil_round() {
  local snap
  snap="$(snapshot)"
  printf 'round %s edit\n' "$1" >>"$REPO/alpha.txt"
  local rc=0
  ceil_review "$snap" >/dev/null 2>"$TMP/ceil.err" || rc=$?
  echo "$rc"
}
check_rc "round 2 is allowed" 0 "$(ceil_round 2)"
check_rc "round 3 is allowed" 0 "$(ceil_round 3)"
check_rc "round 4 is allowed" 0 "$(ceil_round 4)"
check_rc "round 5 is refused" 5 "$(ceil_round 5)"
CEIL_ERR="$(cat "$TMP/ceil.err")"
check_has "the refusal names the reason" "re-opens ground" "$CEIL_ERR"
check_has "the refusal says what to do instead" "what is still open" "$CEIL_ERR"

# A refused round must not have spent the call it was refusing.
: >"$SEEN"
_=$(ceil_round 6)
check_eq "a refused round spends no vendor call" "" "$(cat "$SEEN")"

# A converged round is not a round — otherwise a clean loop would burn ceiling
# budget it never used.
rm -rf "$CEIL_STATE"
SNAP_CONV="$(snapshot)"
rc=0
ceil_review "$SNAP_CONV" >/dev/null 2>&1 || rc=$?
check_rc "a converged round exits 4, not 5" 4 "$rc"
check_eq "a converged round does not consume ceiling budget" "0" \
  "$(cat "$CEIL_STATE"/* 2>/dev/null | head -1 || echo 0)"

# No session id: the worktree stands in as the session, so the cap still holds
# on a harness that exports none.
NOSID_STATE="$TMP/nosid-rounds"
nosid_round() {
  local snap rc=0
  snap="$(CLAUDE_CODE_SESSION_ID="" CLAUDE_SESSION_ID="" CODE_REVIEW_SNAP_STATE_DIR="$TMP/nosid-snaps" \
    CODEX_REVIEW_REPO="$REPO" bash "$REVIEW" --snapshot 2>/dev/null)"
  printf 'no-session round %s edit\n' "$1" >>"$REPO/alpha.txt"
  CODE_REVIEW_ROUND_STATE_DIR="$NOSID_STATE" CODE_REVIEW_SNAP_STATE_DIR="$TMP/nosid-snaps" \
    CLAUDE_CODE_SESSION_ID="" CLAUDE_SESSION_ID="" \
    CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
    CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" --since "$snap" >/dev/null 2>&1 || rc=$?
  echo "$rc"
}
check_rc "no session id: round 2 is allowed" 0 "$(nosid_round 2)"
check_rc "no session id: round 3 is allowed" 0 "$(nosid_round 3)"
check_rc "no session id: round 4 is allowed" 0 "$(nosid_round 4)"
check_rc "no session id: round 5 is still refused" 5 "$(nosid_round 5)"
check_eq "no session id: the counter is keyed on the worktree" "wt-" \
  "$(find "$NOSID_STATE" -type f -name 'wt-*' | head -1 | sed 's|.*/||' | cut -c1-3)"

# Sessions are independent: one session's loop cannot exhaust another's budget.
rm -rf "$CEIL_STATE"
for r in 2 3 4; do _=$(ceil_round "$r"); done
SNAP_OTHER="$(snapshot)"
printf 'other session edit\n' >>"$REPO/alpha.txt"
rc=0
CODE_REVIEW_ROUND_STATE_DIR="$CEIL_STATE" CLAUDE_CODE_SESSION_ID="a-different-session" \
  CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
  CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" --since "$SNAP_OTHER" >/dev/null 2>&1 || rc=$?
check_rc "a second session starts at round 2" 0 "$rc"

# ── Round 1 is unchanged ──────────────────────────────────────────────
#
# The two-arg form is what every round-1 review and every existing caller uses;
# adding the incremental modes must not have moved it.

git -C "$REPO" add -A
git -C "$REPO" commit -qm second
rc=0
run_review HEAD~1 HEAD >/dev/null 2>&1 || rc=$?
check_rc "the two-arg full review still works" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the full review carries the committed range" "CHANGED FILES (committed range)" "$SEEN_TEXT"
check_lacks "the full review is not framed as a follow-up" "FOLLOW-UP ROUND" "$SEEN_TEXT"

# ── A NEW review starts a NEW fix loop ────────────────────────────────────────
#
# The counter was keyed on the session id alone and only ever climbed, so it
# measured the SESSION rather than the loop. The cap is
# about ONE change's fix loop re-reading its own fixes; a session that reviews
# four unrelated changes is four loops, not one.
#
# Keyed on the session alone, a session's fourth separate change had its FIRST
# follow-up refused as "round 5 of at most 4" — the work that most needed
# re-reviewing got none.
#
# A full review IS the start of a loop, so it resets the counter.

rm -rf "$CEIL_STATE"

_=$(ceil_round 2)
_=$(ceil_round 3)
_=$(ceil_round 4)
check_rc "the budget is spent on the first loop" 5 "$(ceil_round 5)"

# A new full review — a different change, the same session.
#
# Its exit status is ASSERTED, not discarded. The reset happens before the
# review validates its arguments or reaches a vendor, so a full review that
# failed would still renew the budget — and every assertion below would pass
# against a broken review, proving nothing.
rc=0
CODE_REVIEW_ROUND_STATE_DIR="$CEIL_STATE" CLAUDE_CODE_SESSION_ID="ceiling-test" \
  CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
  CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" HEAD~1 HEAD >/dev/null 2>&1 || rc=$?
check_rc "the new full review itself succeeded" 0 "$rc"

check_rc "a full review starts a new loop, so its first fix round is allowed" 0 "$(ceil_round 2)"
check_rc "the new loop still has its own ceiling" 0 "$(ceil_round 3)"
check_rc "and it still ends at four" 0 "$(ceil_round 4)"
check_rc "the new loop's fifth round is refused like any other" 5 "$(ceil_round 5)"

# ── The blast-radius pack reaches the reviewer ────────────────────────
#
# Everything above this point edits .txt files, so the pack is empty for all of
# it — which is itself the first assertion: a change in no packable language
# must not put an empty heading in front of the reviewer.
check_lacks "a .txt-only change carries no pack" "BLAST RADIUS" "$(cat "$SEEN")"

# Every case below is its OWN fix loop, not a fifth round of one, so each gets a
# fresh round counter. Sharing the ceiling budget with the sections above made
# these fail with exit 5 for a reason that has nothing to do with the pack.
PACK_ROUNDS="$TMP/pack-rounds"
pack_review() {
  rm -rf "$PACK_ROUNDS"
  CODE_REVIEW_ROUND_STATE_DIR="$PACK_ROUNDS" \
    CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
    CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" "$@"
}
# …and one that also points the packer somewhere: $1 is the packer path.
pack_review_with() {
  local packer="$1"; shift
  rm -rf "$PACK_ROUNDS"
  CODE_REVIEW_BLAST_RADIUS="$packer" \
    CODE_REVIEW_ROUND_STATE_DIR="$PACK_ROUNDS" \
    CODEX_REVIEW_REPO="$REPO" POLICY_JSON="$POLICY" \
    CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" "$@"
}

# A .ts change with a real caller in another file. This is the finding class the
# pack exists for: the caller lives in a file the diff never mentions.
mkdir -p "$REPO/pack"
cat >"$REPO/pack/api.ts" <<'EOF'
export function packedThing() {
  return 1
}
EOF
cat >"$REPO/pack/consumer.ts" <<'EOF'
import { packedThing } from './api'
export const used = packedThing()
EOF
git -C "$REPO" add pack
git -C "$REPO" commit -qm pack-fixture

SNAP_PACK="$(snapshot)"
printf 'export function packedThing() {\n  return 2\n}\n' >"$REPO/pack/api.ts"
rc=0
pack_review --since "$SNAP_PACK" >/dev/null 2>&1 || rc=$?
check_rc "a .ts change reviews normally with a pack attached" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the pack reaches the reviewer" "BLAST RADIUS" "$SEEN_TEXT"
check_has "the pack names the changed symbol" "packedThing" "$SEEN_TEXT"
check_has "the pack names the caller the diff never shows" "pack/consumer.ts" "$SEEN_TEXT"
# Order matters: the pack is context for the diff, so it must arrive before it.
pack_at=$(grep -n "BLAST RADIUS" <<<"$SEEN_TEXT" | head -1 | cut -d: -f1)
diff_at=$(grep -n "^DIFF:" <<<"$SEEN_TEXT" | head -1 | cut -d: -f1)
if [[ -n "$pack_at" && -n "$diff_at" && "$pack_at" -lt "$diff_at" ]]; then ok
else bad "the pack sits between the file list and DIFF: — pack at '$pack_at', DIFF at '$diff_at'"; fi

# A follow-up round packs only ITS files. Re-packing the settled ones would put
# back exactly the code `--since` exists to keep out.
SNAP_SCOPE="$(snapshot)"
cat >"$REPO/pack/later.ts" <<'EOF'
export function laterThing() {
  return 3
}
EOF
rc=0
pack_review --since "$SNAP_SCOPE" >/dev/null 2>&1 || rc=$?
check_rc "the follow-up round reviews the new file" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the follow-up pack names this round's symbol" "laterThing" "$SEEN_TEXT"
check_eq "the follow-up pack does NOT re-pack the settled file" "0" \
  "$(grep -cx 'pack/api\.ts' <<<"$SEEN_TEXT")"

git -C "$REPO" add pack
git -C "$REPO" commit -qm pack-second

# ── The pack fails open ───────────────────────────────────────────────
#
# Unknown callers are not a defect, so a packer that is missing or broken costs
# the review its extra context and NOTHING else. A packer failure that took a
# real review down would be strictly worse than having no packer.

SNAP_MISSING="$(snapshot)"
printf 'export function packedThing() {\n  return 4\n}\n' >"$REPO/pack/api.ts"
rc=0
errf="$TMP/nopacker.err"
pack_review_with "$TMP/definitely-not-here.sh" --since "$SNAP_MISSING" >/dev/null 2>"$errf" || rc=$?
check_rc "a missing packer still reviews" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "a missing packer still sends the diff" "DIFF:" "$SEEN_TEXT"
check_lacks "a missing packer sends no pack" "BLAST RADIUS" "$SEEN_TEXT"
check_has "a missing packer says so on stderr" "no blast-radius packer" "$(cat "$errf")"

BROKEN="$TMP/broken-packer.sh"
printf '#!/usr/bin/env bash\necho "packer broke" >&2\nexit 2\n' >"$BROKEN"
chmod +x "$BROKEN"
SNAP_BROKEN="$(snapshot)"
printf 'export function packedThing() {\n  return 5\n}\n' >"$REPO/pack/api.ts"
rc=0
errf="$TMP/badpacker.err"
pack_review_with "$BROKEN" --since "$SNAP_BROKEN" >/dev/null 2>"$errf" || rc=$?
check_rc "a packer exiting 2 still reviews" 0 "$rc"
check_has "a packer exiting 2 still sends the diff" "DIFF:" "$(cat "$SEEN")"
check_has "a packer exiting 2 says so on stderr" "exited 2" "$(cat "$errf")"

# A packer that prints nothing (nothing to say about this change) must not leave
# an empty heading behind.
QUIET="$TMP/quiet-packer.sh"
printf '#!/usr/bin/env bash\nexit 0\n' >"$QUIET"
chmod +x "$QUIET"
SNAP_QUIET="$(snapshot)"
printf 'export function packedThing() {\n  return 6\n}\n' >"$REPO/pack/api.ts"
rc=0
pack_review_with "$QUIET" --since "$SNAP_QUIET" >/dev/null 2>&1 || rc=$?
check_rc "an empty pack still reviews" 0 "$rc"
check_lacks "an empty pack leaves no heading" "BLAST RADIUS" "$(cat "$SEEN")"

# ── The range-mode pack gets ONE diff, not a concatenation ────────────
#
# `$diff_body` glues `base..head` onto `HEAD..working-tree`. For a file touched
# in BOTH, the committed hunks' new-side line numbers index the HEAD version
# while the packer parses the WORKING TREE — so a working-tree insertion above
# them shifts every committed coordinate and the lookup lands somewhere else
# entirely. The symbol that actually changed is then never named, and its
# callers never reach the reviewer: a pack that is confidently about the wrong
# code.
#
# The fixture makes the miss total rather than partial. The committed edit is
# ADD-ONLY, so there is no removed line for the old-side text match to rescue it
# with, and the working tree then prepends 40 lines.

mkdir -p "$REPO/skew"
{
  for i in 1 2 3 4 5; do printf 'export const base%02d = %d\n' "$i" "$i"; done
  printf 'export function deepSymbol() {\n  return 1\n}\n'
  printf 'export function tailSymbol() {\n  return 2\n}\n'
} >"$REPO/skew/api.ts"
cat >"$REPO/skew/consumer.ts" <<'EOF'
import { deepSymbol } from './api'
export const used = deepSymbol()
EOF
git -C "$REPO" add skew
git -C "$REPO" commit -qm skew-base
SKEW_BASE="$(git -C "$REPO" rev-parse HEAD)"

python3 - "$REPO/skew/api.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
open(p, 'w').write(s.replace("  return 1\n", "  const extra = 42\n  return 1\n"))
PY
git -C "$REPO" add skew/api.ts
git -C "$REPO" commit -qm skew-insert

python3 - "$REPO/skew/api.ts" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()
pad = "".join("export const newpad%02d = %d\n" % (i, i) for i in range(1, 41))
open(p, 'w').write(pad + s)
PY

rc=0
pack_review "$SKEW_BASE" HEAD >/dev/null 2>&1 || rc=$?
check_rc "a range with committed+uncommitted work reviews" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the pack names the symbol the committed hunk changed" "deepSymbol — callers:" "$SEEN_TEXT"
check_has "and its caller, which the diff never shows" "skew/consumer.ts" "$SEEN_TEXT"

git -C "$REPO" checkout -q -- skew/api.ts

# ── The packer is bounded, and its stderr is not swallowed ────────────
#
# "Fail open" has to include failing to FINISH: optional context that hangs is
# blocking the review it was only meant to enrich.

HANG="$TMP/hanging-packer.sh"
printf '#!/usr/bin/env bash
sleep 30
' >"$HANG"
chmod +x "$HANG"
SNAP_HANG="$(snapshot)"
printf 'export function packedThing() {\n  return 8\n}\n' >"$REPO/pack/api.ts"
rc=0
errf="$TMP/hang.err"
start=$(date +%s)
CODE_REVIEW_BLAST_RADIUS_TIMEOUT_S=2 pack_review_with "$HANG" --since "$SNAP_HANG" >/dev/null 2>"$errf" || rc=$?
elapsed=$(( $(date +%s) - start ))
check_rc "a hanging packer still reviews" 0 "$rc"
if [[ "$elapsed" -lt 20 ]]; then ok; else bad "the packer timeout is enforced — took ${elapsed}s"; fi
check_has "the timeout says so" "timed out" "$(cat "$errf")"
check_has "and the diff still reached the reviewer" "DIFF:" "$(cat "$SEEN")"

# A packer that WARNs (a parser that fell back to regex, say) must have that
# warning reach a human. Dropping it makes a degraded pack look like a good one.
NOISY="$TMP/noisy-packer.sh"
printf '#!/usr/bin/env bash
echo "blast-radius: WARN the parser fell back to regex" >&2
echo "BLAST RADIUS"
echo "noisy/file.ts"
exit 0
' >"$NOISY"
chmod +x "$NOISY"
SNAP_NOISY="$(snapshot)"
printf 'export function packedThing() {\n  return 9\n}\n' >"$REPO/pack/api.ts"
rc=0
errf="$TMP/noisy.err"
pack_review_with "$NOISY" --since "$SNAP_NOISY" >/dev/null 2>"$errf" || rc=$?
check_rc "a warning packer still reviews" 0 "$rc"
check_has "the packer's warning reaches stderr" "fell back to regex" "$(cat "$errf")"
check_has "and its pack still reaches the reviewer" "BLAST RADIUS" "$(cat "$SEEN")"

# ── --fixture gets no pack ────────────────────────────────────────────
#
# There is no working tree behind a fixture directory, so there is nothing to
# compute a blast radius from.

FIXTURE="$TMP/fixture"
mkdir -p "$FIXTURE"
printf 'export function fixtureThing() {\n  return 1\n}\n' >"$FIXTURE/thing.ts"
rc=0
pack_review --fixture "$FIXTURE" >/dev/null 2>&1 || rc=$?
check_rc "a fixture review still works" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the fixture files reach the reviewer" "fixtureThing" "$SEEN_TEXT"
check_lacks "a fixture review carries no pack" "BLAST RADIUS" "$SEEN_TEXT"

# ── The two-arg full review carries a pack too ────────────────────────

git -C "$REPO" add pack
git -C "$REPO" commit -qm pack-third
printf 'export function packedThing() {\n  return 7\n}\n' >"$REPO/pack/api.ts"
git -C "$REPO" add pack/api.ts
git -C "$REPO" commit -qm pack-fourth
rc=0
pack_review HEAD~1 HEAD >/dev/null 2>&1 || rc=$?
check_rc "the two-arg full review still works with a pack" 0 "$rc"
SEEN_TEXT="$(cat "$SEEN")"
check_has "the full review carries the pack" "BLAST RADIUS" "$SEEN_TEXT"
check_has "the full review's pack names the caller" "pack/consumer.ts" "$SEEN_TEXT"
check_has "the full review still carries the committed range" "CHANGED FILES (committed range)" "$SEEN_TEXT"

# ── No repo anywhere: a one-line failure, never the script's own checkout ──
# A cwd outside any repo must not fall back to the folder above the script —
# the main checkout, the tree a session never touched.
(
  cd "$TMP" || exit 1
  git rev-parse --show-toplevel >/dev/null 2>&1 && exit 0 # inside a repo: skip
  exit 42
) >/dev/null 2>&1
if [[ $? -eq 42 ]]; then
  rc=0
  err_out="$(cd "$TMP" && env -u CODEX_REVIEW_REPO bash "$REVIEW" HEAD~1 HEAD 2>&1 >/dev/null)" || rc=$?
  check_rc "outside any repo with no CODEX_REVIEW_REPO: exit 2" 2 "$rc"
  check_has "and the line names the cause" "code-review: not inside a git repository" "$err_out"
  # --fixture reads a directory, not a repo, so it runs from anywhere; the
  # usage line likewise. Neither may die on the repo check first.
  rc=0
  err_out="$(cd "$TMP" && env -u CODEX_REVIEW_REPO bash "$REVIEW" 2>&1 >/dev/null)" || rc=$?
  check_rc "usage outside any repo is still the usage line" 2 "$rc"
  check_has "and prints it" "Usage:" "$err_out"
  check_lacks "not the repo error" "not inside a git repository" "$err_out"
  mkdir -p "$TMP/fixture-norepo"
  printf 'export function norepoThing() {\n  return 1\n}\n' >"$TMP/fixture-norepo/thing.ts"
  rc=0
  err_out="$(cd "$TMP" && env -u CODEX_REVIEW_REPO CODEX_BIN="$STUB" GROK_BIN="$STUB" bash "$REVIEW" --fixture "$TMP/fixture-norepo" 2>&1 >/dev/null)" || rc=$?
  check_rc "--fixture outside any repo still reviews the directory" 0 "$rc"
  check_lacks "and never hits the repo check" "not inside a git repository" "$err_out"
else
  echo "note: $TMP is inside a git checkout; skipping the no-repo case" >&2
fi

# ── The eval's free half finds the scripts one level above evals/ ─────
rc=0
bash "${SCRIPT_DIR}/evals/caller-contract.eval.sh" --pack-only >/dev/null 2>&1 || rc=$?
check_rc "caller-contract.eval.sh --pack-only resolves the scripts from .agents/skills/review/evals/" 0 "$rc"

echo "code-review: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
