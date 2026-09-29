#!/usr/bin/env bash
# code-review.sh — Adversarial code review of a diff, on whichever vendor the
# policy's `adversarial-review` row selects.
#
# The diff-side mirror of spec-audit.sh. One model writes nearly all the code in
# a workbench (Claude, usually), so a reviewer of that model is not independent
# in the sense the assignment policy asks for; this script puts the review on a
# different vendor by construction. WHICH vendor is not decided here — it is
# read from the policy table (policy.json beside this script) via
# .agents/skills/review/policy-chain.sh, which also skips the vendor recorded
# as the author in .agents/harness.
# Renamed from an old vendor-named filename: that name was a pin, and a filename
# naming a vendor is a promise the table cannot keep.
#
# Usage:
#   code-review.sh <base-sha> <head-sha>      full review (round 1)
#   code-review.sh --since <tree>             follow-up round: ONLY what changed
#                                             since <tree>
#   code-review.sh --snapshot                 print a tree SHA capturing the
#                                             current working tree
#   code-review.sh --fixture <dir>
#
# ROUNDS 2+ REVIEW ONLY THE FIXES, NOT THE WHOLE DIFF. Until this
# change every round re-read the entire cumulative diff, so the reviewer kept
# re-deciding settled code and each round's own fixes became the next round's
# findings. Measured across 225 audits in the session transcripts: by round 5,
# 61% of must-fix findings landed within 25 lines of a spot an earlier round had
# already flagged, and that share never fell again — the loop was mostly
# re-opening its own work. Fix loops of 14, 17, 24 and 34 rounds are what that
# cost, at one full vendor call per round.
#
# The follow-up round is scoped with `--since <tree>`, where <tree> came from a
# `--snapshot` taken immediately before the PREVIOUS round's review. Snapshots
# are plain git tree objects written through a temporary index: HEAD, the real
# index, the stash and the working tree are all left alone, which matters
# because this script runs mid-session against uncommitted work by design.
# `git stash create` was the obvious alternative and is wrong here — it does not
# capture untracked files, so a file a fix ROUND created would read as new
# surface in every later round, which is the exact loop being closed.
#
# Output (stdout): ONLY triaged findings, one per line. The /implement-audit
# fix loop parses this stream, so nothing else may appear on it.
#   [must-fix]   <file:line> <issue> — <suggested fix> — <the failure it causes>
#   [should-fix] <target> <issue>
#   [nit]        <issue>
#
# Output (stderr): every diagnostic, progress line, and error — including one
# line per chain slot tried and an `answered: <vendor>/<model>` line naming who
# actually did the review.
#
# Exit:
#   0    Review completed. Zero or more findings on stdout.
#   1    Review did NOT complete — the whole chain was exhausted, or the
#        answering vendor produced empty stdout with no sentinel and no
#        parseable triage line. The caller MUST treat this as "not reviewed"
#        even when partial findings were printed; partial findings are never a
#        pass.
#   2    Caller error (bad arity, unresolvable SHA/tree, base not an ancestor).
#   4    `--since` only: nothing changed since the snapshot, so there is nothing
#        to review and the fix loop has converged. NOT a failure — the caller
#        stops the loop and approves. Distinct from the empty-diff exit 1 below,
#        which means a FULL review was pointed at the wrong tree.
#   5    `--since` only: the fix loop hit the round-4 ceiling
#        Also not a failure — the caller stops
#        the loop and reports what is still open. Session-keyed (the
#        worktree stands in when no session id is set); see the ceiling block in
#        the --since branch.
#   3    No independent reviewer: the chain reached a CLAUDE slot, or (on the
#        shipped table) every vendor in the row was unavailable. Contextium:
#        the caller runs the implement-audit-reviewer agent in a FRESH context
#        and records `implement-audit: claude-fallback (fresh context, NOT
#        independent) …` — a completed but weaker review, never a clean
#        independent pass. See below.
#   124  Chain exhausted and the last slot's failure was a timeout. The caller
#        treats it exactly like 1.
#
# FALLBACK IS AUTOMATIC. Before it, a
# primary that was absent, non-zero, or hung ended the review at exit 1/124 with
# no second attempt, so a four-day Codex quota lockout took the gate down
# entirely. The `adversarial-review` row already declared a backup; nothing
# walked it. Now the chain walks itself, and only whole-chain exhaustion fails.
#
# What that does NOT relax: this script never reviews with the author's model
# itself. Contextium's one exception to the source is the exit-3 path: when no
# independent vendor can answer, the caller runs a FRESH-CONTEXT review with its
# own agent and records it as `claude-fallback (fresh context, NOT
# independent)`, so a weaker review is never mistaken for an independent one.
# Most installs have a single model CLI; no review at all is worse than a weaker
# one that says so.
#
# CODEX_BIN / GROK_BIN override the vendor binaries so the failure paths
# (absent, non-zero, hang, empty) are testable against stubs without touching
# real auth or quota. Both are honored by policy-chain.sh; see
# .agents/skills/review/policy-chain.test.sh.
#
# CODEX_REVIEW_TIMEOUT_S is now the PER-SLOT budget, not a total one, and this
# script deliberately does NOT wrap the chain in its own `timeout`: an outer
# wrap becomes a total-chain cap that kills the walk mid-fallthrough, the exact
# behavior the per-slot design removes.
#
# THE SUBJECT CARRIES A BLAST-RADIUS PACK. Between the file list
# and the DIFF sits blast-radius.sh's output: who imports each changed file, what
# it imports, and who calls each symbol the diff actually changed. That is the
# whole-repo context a GitHub-app code reviewer sells, computed here at review
# time instead of read out of an index. It is context and never a verdict — the
# packer fails open, and `--fixture` gets no pack at all because there is no
# working tree to walk. See the blast_radius_pack helper below.
#
# policy-chain.sh holds the CLI invocation shapes. Runs on: /implement-audit
# step-2 (via the agent's tool call), not pre-commit.

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Sourced here for _policy_chain_timeout, which the blast-radius pack needs
# before the chain runs (a stock macOS has no GNU `timeout`).
# shellcheck source=/dev/null
source "$SCRIPT_DIR/policy-chain.sh"

# Per-slot wall clock. CODEX_REVIEW_TIMEOUT_S is kept as an alias so every
# existing caller and runbook keeps working; the MEANING changed from total to
# per-slot, which is stated in the header above. An explicit
# POLICY_CHAIN_SLOT_TIMEOUT_S wins — writing the walker's own knob and having it
# silently overwritten here is the kind of "I set it and nothing happened" that
# makes a timeout look un-tunable.
export POLICY_CHAIN_SLOT_TIMEOUT_S="${POLICY_CHAIN_SLOT_TIMEOUT_S:-${CODEX_REVIEW_TIMEOUT_S:-900}}"
# A diff past this budget is REFUSED, not truncated — reviewing a silent slice
# of a change while reporting a clean pass is the failure this gate prevents.
MAX_DIFF_BYTES="${CODEX_REVIEW_MAX_DIFF_BYTES:-400000}"

# The repo whose SHAs get resolved and diffed. CODEX_REVIEW_REPO points it at a
# SEPARATE repo — a product with its own checkout — so work living there can
# still get the independent review the gate exists to provide; without it the
# only way is to copy the script and patch this line, which quietly becomes "we
# didn't review it".
# Resolution order: explicit override, then the CALLER's repo — never the
# script's own location. The caller's repo is the one under review, because
# every editing session works inside a linked worktree and invokes this script
# by absolute path out of the main checkout. Deriving the root from $0 points
# the review at the main checkout — a tree the session never touched — which
# yields findings about untouched files, or an EMPTY diff reported as "reviewed
# clean (NO_FINDINGS)". A gate that reports a pass on work it never read is
# worse than no gate. That is also why a cwd outside any repo is a one-line
# failure and not a fallback to the script's checkout.
REPO_ROOT="${CODEX_REVIEW_REPO:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
# Checked by the modes that read a repo — a full review, --since, --snapshot —
# and not by --fixture or the usage line, which have no repo to need.
# Ask git, don't stat for a `.git` DIRECTORY. In a linked worktree `.git` is a
# FILE holding a gitdir pointer, so the directory test rejected every worktree —
# and every editing session runs in one, which would make this gate unrunnable
# for the sessions it exists to review. Still a real check:
# a non-repo path fails exactly as before.
require_repo() {
  if [[ -z "$REPO_ROOT" ]]; then
    err "code-review: not inside a git repository (cwd $PWD) and CODEX_REVIEW_REPO is unset"
    exit 2
  fi
  if ! git -C "$REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
    err "Error: CODEX_REVIEW_REPO is not a git repo: $REPO_ROOT"
    exit 2
  fi
}

# ── Argument parsing ──────────────────────────────────────────────────

# A git read that FAILS is not an empty one. Swallowed, a failed diff is "the
# fix loop converged" (exit 4, an approve) or a review of part of the change
# reported as the whole. The review did not happen: exit 1, named.
git_read_failed() { # git_read_failed <subcommand> <exit>
  err "Error: git $1 failed (exit $2) — the review did NOT happen; not reading the failure as an empty diff."
  exit 1
}

usage() {
  err "Usage: $(basename "$0") <base-sha> <head-sha>   full review"
  err "       $(basename "$0") --since <tree>          follow-up round"
  err "       $(basename "$0") --snapshot              print a tree SHA"
  err "       $(basename "$0") --fixture <dir>"
}

# Capture the working tree as a git tree object without touching HEAD, the real
# index, the stash, or any file on disk. Includes untracked-but-not-ignored
# files, which is the whole reason this is not `git stash create` — see the
# header. Writes through GIT_INDEX_FILE pointed at a temp path so the session's
# own staged state survives untouched.
snapshot_tree() {
  local idx rc=0
  idx=$(mktemp "${TMPDIR:-/tmp}/code-review-index.XXXXXX")
  rm -f "$idx"
  (
    cd "$REPO_ROOT" || exit 2
    export GIT_INDEX_FILE="$idx"
    git read-tree HEAD 2>/dev/null || git read-tree --empty
    git add -A 2>/dev/null
    git write-tree
  ) || rc=$?
  rm -f "$idx"
  return "$rc"
}

# ── The blast-radius pack ─────────────────────────────────────────────
#
# The reviewer reads a DIFF, and a diff cannot answer "who calls this?". That is
# a whole finding class an isolated review structurally cannot produce — a
# signature moves, the three callers in directories the diff never mentions stay
# broken, and the review comes back clean. Hosted review apps sell exactly that
# answer over a persistent whole-repo index; blast-radius.sh computes it per
# review from the working tree instead, so there is no vendor and no index going
# stale while the session edits.
#
# It is pasted into SUBJECT rather than offered as "read any file you need",
# because the prompt already says that (see the PROMPT block below) and a
# reviewer that has to choose to go looking mostly does not.
#
# FAIL-OPEN, ALWAYS. A missing packer, a packer that exits 2, a packer that
# hangs — each costs the review its extra context and nothing else. Unknown
# callers are not a defect, so a packer failure must never become the reason a
# real diff went unreviewed.
#
# Its byte budget is its own (32KiB, inside blast-radius.sh) and is never taken
# out of MAX_DIFF_BYTES: a large pack shrinking the DIFF would mean reviewing a
# truncated slice, which is the failure this whole script exists to prevent.
BLAST_RADIUS_SH="${CODE_REVIEW_BLAST_RADIUS:-$SCRIPT_DIR/blast-radius.sh}"

# Bounded, because "fail open" has to include failing to FINISH. The packer
# greps the repo once per changed symbol, and a pathological pattern or a
# gigantic tree could sit there — at which point optional context is blocking
# the review it was only ever meant to enrich, which is worse than no packer.
BLAST_RADIUS_TIMEOUT_S="${CODE_REVIEW_BLAST_RADIUS_TIMEOUT_S:-120}"

blast_radius_pack() {
  local files="$1" diff_text="$2" old_ref="$3"
  local tmpdir pack rc=0

  [[ -n "$files" ]] || return 0
  if [[ ! -f "$BLAST_RADIUS_SH" ]]; then
    err "[code-review] no blast-radius packer at $BLAST_RADIUS_SH — reviewing the diff without caller context"
    return 0
  fi

  tmpdir=$(mktemp -d -t code-review-pack-XXXXXX)
  printf '%s\n' "$files" >"$tmpdir/files"
  printf '%s\n' "$diff_text" >"$tmpdir/diff"

  pack=$(_policy_chain_timeout "$BLAST_RADIUS_TIMEOUT_S" env CODEX_REVIEW_REPO="$REPO_ROOT" \
    bash "$BLAST_RADIUS_SH" \
    --repo "$REPO_ROOT" \
    --files-file "$tmpdir/files" \
    --diff-file "$tmpdir/diff" \
    --old-ref "$old_ref" 2>"$tmpdir/err") || rc=$?

  # Forward the packer's stderr BEFORE the temp dir goes. A parser that fell
  # back to regex, or a grammar that would not load, says so here and nowhere
  # else; dropping it makes a degraded pack indistinguishable from a good one.
  if [[ -s "$tmpdir/err" ]]; then
    while IFS= read -r _l; do err "$_l"; done <"$tmpdir/err"
  fi
  rm -rf "$tmpdir"

  if [[ "$rc" -eq 124 ]]; then
    err "[code-review] the blast-radius packer timed out after ${BLAST_RADIUS_TIMEOUT_S}s — reviewing the diff without caller context"
    return 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    err "[code-review] the blast-radius packer exited ${rc} — reviewing the diff without caller context"
    return 0
  fi
  printf '%s' "$pack"
}

# Where `--snapshot` records every tree it hands out, so `--since` can refuse a
# ref it did not issue. Same session-keyed shape as the round counter below;
# overridable for the fixture tests.
SNAP_STATE_DIR="${CODE_REVIEW_SNAP_STATE_DIR:-/tmp/code-review-snapshots}"

# The key the snapshot ledger and the round counter are filed under. The session
# id when the harness exports one; otherwise one is generated from the worktree's
# own git dir — every session works in its own worktree, so the worktree IS the
# session — rather than leaving the ledger and the round cap unenforced on a
# harness that sets no id. Prints "" only when no repo resolves at all.
session_key() {
  local sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}" gd
  if [[ -z "$sid" && -n "$REPO_ROOT" ]]; then
    gd="$(git -C "$REPO_ROOT" rev-parse --absolute-git-dir 2>/dev/null || true)"
    if [[ -n "$gd" ]]; then sid="wt-$(printf '%s' "$gd" | cksum | cut -d' ' -f1)"; fi
  fi
  printf '%s\n' "${sid//[^A-Za-z0-9_-]/_}"
}

# The file this session's snapshots are appended to, or "" when no key
# resolves. Callers MUST treat "" as "cannot verify" and fall through, never as
# "reject".
snap_ledger_path() {
  local key
  key="$(session_key)"
  [[ -n "$key" ]] || return 1
  printf '%s/%s\n' "$SNAP_STATE_DIR" "$key"
}

MODE=""
FIXTURE_DIR=""
BASE_SHA=""
HEAD_SHA=""
PREV_TREE=""

if [[ $# -eq 1 && "$1" == "--snapshot" ]]; then
  require_repo
  _snap=""
  _snap=$(snapshot_tree) || { err "Error: could not snapshot the working tree."; exit 2; }
  # Record it before printing, so a tree the caller can see is always a tree
  # `--since` will accept. Ledger failures are non-fatal: the snapshot is still
  # valid, and refusing to emit one because a /tmp write failed would break the
  # loop this guard exists to protect.
  if _ledger=$(snap_ledger_path); then
    mkdir -p "$SNAP_STATE_DIR" 2>/dev/null && printf '%s\n' "$_snap" >> "$_ledger" 2>/dev/null || true
  fi
  printf '%s\n' "$_snap"
  exit 0
elif [[ $# -eq 2 && "$1" == "--fixture" ]]; then
  MODE="fixture"
  FIXTURE_DIR="$2"
  if [[ ! -d "$FIXTURE_DIR" ]]; then
    err "Error: fixture dir not found: $FIXTURE_DIR"
    exit 2
  fi
elif [[ $# -eq 2 && "$1" == "--since" ]]; then
  require_repo
  MODE="since"
  PREV_TREE="$2"
elif [[ $# -eq 2 ]]; then
  require_repo
  MODE="range"
  BASE_SHA="$1"
  HEAD_SHA="$2"
else
  usage
  exit 2
fi

# ── Build the review subject ──────────────────────────────────────────

SUBJECT=""
SUBJECT_LABEL=""
DIRTY_NOTE=""
ROUND_NOTE=""

if [[ "$MODE" == "range" ]]; then
  cd "$REPO_ROOT"

  base_resolved=""
  head_resolved=""
  if ! base_resolved=$(git rev-parse --verify "${BASE_SHA}^{commit}" 2>/dev/null); then
    err "Error: cannot resolve base SHA: $BASE_SHA"
    exit 2
  fi
  if ! head_resolved=$(git rev-parse --verify "${HEAD_SHA}^{commit}" 2>/dev/null); then
    err "Error: cannot resolve head SHA: $HEAD_SHA"
    exit 2
  fi

  # Reviewing a nonsense range is worse than refusing one.
  if ! git merge-base --is-ancestor "$base_resolved" "$head_resolved" 2>/dev/null; then
    err "Error: base $BASE_SHA is not an ancestor of head $HEAD_SHA"
    exit 2
  fi

  # Uncommitted state is reviewed as-is — /implement-audit runs pre-commit by
  # design — but the reviewer is told, so it never reports on a tree it did not
  # see.
  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    DIRTY_NOTE="NOTE: the working tree has uncommitted changes. The diff below is
the committed range PLUS uncommitted work; you are NOT reviewing a clean tree."
  fi

  # ── A FULL REVIEW STARTS A NEW FIX LOOP, so the round counter resets ──
  #
  # The counter below used to be keyed on the session id alone and only ever
  # climbed, which measured the SESSION rather than the loop.
  # The cap is about one change's fix loop re-reading its
  # own fixes; a session that reviews four unrelated changes is four loops, and
  # the evidence behind the cap — 61% of round-5 findings re-opening earlier
  # ground — is about repeated passes over the SAME diff.
  #
  # Keyed on the session alone, a session that shipped four separate fixes saw
  # its fourth change's FIRST follow-up refused as "round 5 of at most 4" — the
  # cap stopping coverage on whatever came last instead of stopping churn.
  #
  # Reset here rather than expiring the counter on a timer, because "a new full
  # review" is exactly the event that means a new loop — no clock has to guess.
  _reset_dir="${CODE_REVIEW_ROUND_STATE_DIR:-/tmp/code-review-rounds}"
  _reset_sid="$(session_key)"
  if [[ -n "$_reset_sid" ]]; then
    mkdir -p "$_reset_dir" 2>/dev/null || true
    rm -f "${_reset_dir}/${_reset_sid}" 2>/dev/null || true
  fi

  changed_files=$(git diff --name-only "$base_resolved" "$head_resolved") || git_read_failed diff $?
  working_files=$(git diff --name-only HEAD) || git_read_failed diff $?

  # `git diff HEAD` shows only files git already TRACKS, so a file the session
  # created and has not staged is invisible to it. That is a false GREEN, not a
  # gap in coverage: a brand-new script goes through a round-1 review unread
  # and the review still reports clean. The --since
  # path never had this hole (its snapshot writes untracked files into a temp
  # index), so this is the two-arg form catching up. --exclude-standard keeps
  # build output and other gitignored noise out.
  untracked=$(git ls-files --others --exclude-standard) || git_read_failed ls-files $?
  if [[ -n "$untracked" ]]; then
    working_files=$(printf '%s\n%s' "${working_files}" "$untracked" \
      | grep -v '^[[:space:]]*$' || true)
  fi

  # Each read is checked on its own: a failed one inside a `{ …; } || true`
  # group would drop that part of the change and review the rest as if whole.
  _committed_diff=$(git diff "$base_resolved" "$head_resolved") || git_read_failed diff $?
  _working_diff=$(git diff HEAD) || git_read_failed diff $?
  _untracked_diff=""
  while IFS= read -r u; do
    [[ -n "$u" ]] || continue
    # --no-index against /dev/null renders a whole untracked file as an
    # addition; it exits 1 on any difference, which is the normal case here.
    _rc=0
    _one=$(git diff --no-index -- /dev/null "$u") || _rc=$?
    [[ "$_rc" -le 1 ]] || git_read_failed diff "$_rc"
    _untracked_diff+="$_one"$'\n'
  done <<< "$untracked"
  # $(...) drops the trailing newlines, so three empty reads are an empty diff.
  diff_body=$(printf '%s\n%s\n%s' "$_committed_diff" "$_working_diff" "$_untracked_diff")

  diff_bytes=$(printf '%s' "$diff_body" | wc -c)
  # Backstop for the wrong-tree class above. There is no such thing as a clean
  # review of nothing: an empty diff means the range or the repo is wrong, and
  # reporting NO_FINDINGS on it hands the caller a passing gate for work that was
  # never read. Refuse loudly instead — the caller treats exit 1 as "not
  # reviewed", which is the truth.
  if [[ "$diff_bytes" -eq 0 ]]; then
    err "Error: the diff is empty — nothing was reviewed."
    err "  repo:  $REPO_ROOT"
    err "  range: ${base_resolved:0:8}..${head_resolved:0:8} (plus uncommitted)"
    err "This usually means the resolved repo is not the tree holding the work"
    err "(a session worktree invoking the script from the main checkout), or the"
    err "SHA range is wrong. Set CODEX_REVIEW_REPO or fix the range and re-run."
    exit 1
  fi
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    err "Error: diff is ${diff_bytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget."
    err "Refusing rather than reviewing a truncated slice. Split the range or"
    err "raise CODEX_REVIEW_MAX_DIFF_BYTES deliberately."
    exit 1
  fi

  SUBJECT_LABEL="diff ${base_resolved:0:8}..${head_resolved:0:8}"
  # The pack's file list is the UNION of both lists above — the same bytes the
  # reviewer is about to read, so the pack can never cite a file the diff did
  # not show it.
  pack_files=$(printf '%s\n%s' "${changed_files}" "${working_files}" \
    | grep -v '^[[:space:]]*$' | sort -u || true)

  # …but the DIFF it gets is not the one above. `$diff_body` concatenates two
  # diffs with two different bases (base..head, then HEAD..working-tree), so for
  # a file touched in both, the committed hunks' new-side line numbers index the
  # HEAD version while the packer parses the WORKING TREE — and an export added
  # after the base and then deleted in the working tree exists in neither side
  # it can reach. Both make the pack name the wrong symbol with full confidence.
  #
  # One diff, one pair of endpoints: base on the old side, the working tree on
  # the new side. `git diff <base>` is exactly that for tracked files, and the
  # untracked walk supplies the rest. Now every new-side line number indexes the
  # bytes the packer reads, and `--old-ref $base_resolved` is precisely the tree
  # the `-` lines came from.
  # The pack fails open, so a failed read here does not stop the review — but
  # it is said: a pack built on part of the diff names fewer callers than it
  # should, and "no callers found" must not read as a fact.
  # (`git diff` exits non-zero only on an error; `--no-index` exits 1 for "the
  # files differ", which is the normal case, and 2 or more on an error.)
  _pack_rc=0
  pack_diff=$(git diff "$base_resolved" 2>/dev/null) || _pack_rc=$?
  while IFS= read -r u; do
    [[ -n "$u" ]] || continue
    _rc=0
    _one=$(git diff --no-index -- /dev/null "$u" 2>/dev/null) || _rc=$?
    if [[ "$_rc" -gt 1 ]]; then _pack_rc="$_rc"; fi
    pack_diff+=$'\n'"$_one"
  done <<< "$untracked"
  if [[ "$_pack_rc" -ne 0 ]]; then
    err "[code-review] the blast-radius diff could not be read (git exit ${_pack_rc}) — the caller context in this review is incomplete"
  fi
  blast_pack=$(blast_radius_pack "$pack_files" "$pack_diff" "$base_resolved")
  SUBJECT="CHANGED FILES (committed range):
${changed_files:-(none)}

CHANGED FILES (uncommitted, vs HEAD):
${working_files:-(none)}
${blast_pack:+
${blast_pack}}

DIFF:
${diff_body}"
elif [[ "$MODE" == "since" ]]; then
  cd "$REPO_ROOT"

  if ! git rev-parse --verify "${PREV_TREE}^{tree}" >/dev/null 2>&1; then
    err "Error: --since needs a tree written by --snapshot; cannot resolve: $PREV_TREE"
    exit 2
  fi

  # Resolving to a tree is NOT enough, and the gap is not theoretical: EVERY
  # commit resolves to a tree, so a commit sha — the thing a caller reaches for
  # by mistake — passes the check above and gets reviewed as if it were a
  # snapshot, producing confident findings about files the session never
  # touched, because the diff spans other sessions' commits on main.
  #
  # With no ledger yet for this key (no --snapshot taken) it falls through. A
  # ledger that exists but lacks this tree IS a rejection — that is the whole
  # check.
  if _ledger=$(snap_ledger_path) && [[ -f "$_ledger" ]]; then
    if ! grep -Fxq "$PREV_TREE" "$_ledger" 2>/dev/null; then
      err "Error: --since was given a ref this session's --snapshot never issued: $PREV_TREE"
      err "A commit sha resolves to a tree and will pass the resolve check above, so it"
      err "would silently review everything between that commit and now — including other"
      err "sessions' work. Pass the tree printed by the --snapshot taken just before the"
      err "PREVIOUS round. Snapshots issued this session:"
      while IFS= read -r _s; do err "  ${_s}"; done < "$_ledger"
      exit 2
    fi
  fi

  now_tree=""
  if ! now_tree=$(snapshot_tree); then
    err "Error: could not snapshot the working tree for the follow-up round."
    exit 2
  fi

  changed_files=$(git diff --name-only "$PREV_TREE" "$now_tree") || git_read_failed diff $?
  diff_body=$(git diff "$PREV_TREE" "$now_tree") || git_read_failed diff $?

  # Converged. Nothing was edited between the last review and this one, so there
  # is no new surface and another vendor call would re-read settled code — the
  # precise waste this mode exists to stop. Exit 4 says "stop the loop and
  # approve", which is a different claim from the exit 1 below.
  if [[ -z "$diff_body" ]]; then
    err "[code-review] nothing changed since the last round — the fix loop has converged."
    exit 4
  fi

  diff_bytes=$(printf '%s' "$diff_body" | wc -c)
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    err "Error: follow-up diff is ${diff_bytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget."
    err "Refusing rather than reviewing a truncated slice."
    exit 1
  fi

  # ── The round-4 ceiling, enforced here rather than only in the skill ──
  #
  # A review fix loop ends at 4 rounds. Leaving
  # that to the skill's prose alone is what the 34-round audit did: the
  # instruction existed, the loop ran anyway, and nothing could observe it until
  # the vendor calls were already spent. Round 1 is the two-arg full review, so
  # the Nth `--since` call is round N+1 and the 4th one is round 5 — refused.
  #
  # Keyed on session_key: the session id, or the worktree when a harness sets
  # none — so the cap holds on every harness.
  #
  # It counts rounds within ONE fix loop, not within the session. The two-arg
  # branch above clears it, because a full review IS the start of a loop — see
  # the reset there for what keying it on the session alone cost.
  ROUND_STATE_DIR="${CODE_REVIEW_ROUND_STATE_DIR:-/tmp/code-review-rounds}"
  _sid="$(session_key)"
  if [[ -n "$_sid" ]]; then
    mkdir -p "$ROUND_STATE_DIR"
    _counter="${ROUND_STATE_DIR}/${_sid}"
    _prior=0
    [[ -f "$_counter" ]] && _prior=$(cat "$_counter" 2>/dev/null || echo 0)
    [[ "$_prior" =~ ^[0-9]+$ ]] || _prior=0
    _round=$((_prior + 2))
    if [[ "$_round" -gt 4 ]]; then
      err "Error: the fix loop has reached the round-4 ceiling — a fifth round mostly re-opens ground earlier rounds already touched."
      err "Refusing round ${_round}. Stop the loop: fix any held nits, then report"
      err "what is still open in the implement-audit: trailer and the summary."
      err "Past round 4 the majority of findings re-open ground an earlier round"
      err "already touched — measured across 225 audits — so another"
      err "vendor call buys churn, not coverage."
      exit 5
    fi
    printf '%s\n' "$((_prior + 1))" > "$_counter"
    err "[code-review] round ${_round} of at most 4"
  fi

  SUBJECT_LABEL="fixes since ${PREV_TREE:0:8}"
  # The reviewer is told what it is looking at. Without this it reads a diff of
  # fixes as if it were fresh feature code, reports that the surrounding
  # function is missing context it cannot see, and the round produces findings
  # about code that was already dispositioned.
  ROUND_NOTE="THIS IS A FOLLOW-UP ROUND, NOT A FULL REVIEW. The diff below is
ONLY the changes made since the previous review round — that is, the FIXES
applied in response to earlier findings, plus any work done alongside them.
Earlier rounds already reviewed the rest of the change and their findings are
dispositioned; do NOT re-report them.

Review these fixes for two things specifically:
  1. Does each fix actually close the defect it was meant to close?
  2. Did the fix introduce a NEW defect — an inverted condition, a mirror-image
     bug at the opposite boundary, a broken caller, a contract it no longer
     honors?

If the fixes are correct, emit NO_FINDINGS. Do not hunt for something to say
about the surrounding file: code outside this diff is out of scope for this
round."

  # A follow-up round packs ONLY this round's files. Re-packing the original
  # diff's files would put the settled code back in front of the reviewer that
  # `--since` exists to keep out — the 34-round failure described at the top of
  # this file, arriving by a different door.
  blast_pack=$(blast_radius_pack "$changed_files" "$diff_body" "$PREV_TREE")
  SUBJECT="CHANGED FILES (since the last review round):
${changed_files:-(none)}
${blast_pack:+
${blast_pack}}

DIFF:
${diff_body}"
else
  SUBJECT_LABEL="fixture $FIXTURE_DIR"
  fixture_files=$(find "$FIXTURE_DIR" -type f | sort)
  if [[ -z "$fixture_files" ]]; then
    err "Error: fixture dir is empty: $FIXTURE_DIR"
    exit 2
  fi
  fixture_body=""
  while IFS= read -r f; do
    fixture_body="${fixture_body}
--- FILE: ${f} ---
$(cat "$f")
"
  done <<< "$fixture_files"
  SUBJECT="FILES UNDER REVIEW:
${fixture_body}"
fi

# ── Prompt ────────────────────────────────────────────────────────────

PROMPT=$(cat <<EOF
You are an adversarial reviewer of freshly-written code in a small repo where
every caller is the owner's own code. You are reviewing CODE, not a SPEC. Assume things were missed and
find them. Do not confirm the work is good; find what is wrong. You have
read access to the repo — read any file you need for context before judging.

The conventions you must hold the code to: behaviour enumerated at 0 / 1 /
empty / max / error inputs; a fix to a shared mechanism lands in every
instance; no enforcement for a failure that has not happened; a bad fetch
keeps the last good value rather than overwriting it; outcomes are validated
for correctness, not just presence; one writer per stored data product;
external data is validated at every boundary; shell scripts run under
\`set -euo pipefail\`; and the simplest mechanism that works wins.

CRITICAL FRAMING — this code runs where every caller is the owner's own code. Defense-in-depth findings (per-caller credentials, allowlists,
retry primitives, isolation layers) MUST be weighed against the simplest
mechanism that works, and nothing is built for a failure mode that has not
occurred. If a finding adds a control surface against an unenumerated threat,
downgrade it to [nit] or omit it. Defense-in-depth is over-engineering until a
real threat is named.

Attack across these dimensions:

1. Correctness — logic errors, off-by-one, wrong operator, inverted condition.
2. Boundary cases — behavior at 0 / 1 / empty / max / error inputs.
3. Error handling — swallowed errors, empty catch, silent degradation, a
   failure path that reports success.
4. Integration — do imports resolve, do callers/callees still agree, does data
   survive the boundaries it crosses.
5. Peer/sibling consistency — does a sibling file do this same thing
   differently, and is one of them now wrong?
6. Class-fix atomicity — if this fixes a shared mechanism, did every peer get
   fixed, or was one quietly left behind?
7. Contract drift — does the code do what its own header/SPEC/comment claims?

Required: every [must-fix] finding MUST name the concrete failure it causes
(the wrong output, the lost data, the crash, the silent skip). A finding that
names no failure cannot be must-fix.

OUTPUT CAP: at most 8 findings, ranked by severity. If you have more than 8,
the top 8 displace the rest.

OUTPUT FORMAT — STRICT. Each finding MUST appear on its own line with the
literal bracket prefix at the very start of the line. No markdown bold (no
\`**[must-fix]**\`). No alternate prefixes (no \`must-fix:\`, no \`-- must-fix --\`).
The caller parses by line-anchored match; deviations are silently dropped.

  [must-fix]   <file:line>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <file-or-target>: <issue>
  [nit]        <issue>

IF YOU REVIEWED THE CODE AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED
review rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.

REVIEW SUBJECT: ${SUBJECT_LABEL}
${DIRTY_NOTE}
${ROUND_NOTE}

${SUBJECT}
EOF
)

# ── Invoke ────────────────────────────────────────────────────────────

RAW_OUT=$(mktemp "${TMPDIR:-/tmp}/code-review-out.XXXXXX")
PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/code-review-prompt.XXXXXX")
# shellcheck disable=SC2329 # invoked indirectly by the trap on EXIT below
cleanup() { rm -f "$RAW_OUT" "$PROMPT_FILE"; }
trap cleanup EXIT

# The prompt reaches the chain walker as a FILE and is piped on stdin, never
# placed on argv. The diff is embedded in it, so passing it as an argument dies
# with "Argument list too long" (exit 126) on exactly the large changes that
# most need reviewing — a 26-file, ~2,700-line commit once could not be reviewed
# at all.
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

err "[code-review] reviewing ${SUBJECT_LABEL} (per-slot timeout ${POLICY_CHAIN_SLOT_TIMEOUT_S}s)"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/policy-chain.sh"

# ── Dispatch, parse, and ONE re-ask ───────────────────────────────────
#
# A vendor that answers with only progress narration ("I'll review the full
# diff...Reading the changed implementations.") has spent the review without
# delivering one. That is not chain exhaustion — the walk already stopped,
# because from the chain's side the slot succeeded — so the fall-through cannot
# help, and the caller gets a FAILED review for work the vendor was willing to
# do. Observed three times in one session, twice in a row.
#
# So: one re-ask, same slot, naming what was missing. ONLY for the
# answered-but-unusable case — a non-zero RC is a genuinely exhausted chain and
# stays terminal below, because re-asking a chain that has no live slot left
# just spends the timeout twice.
# Deliberately vendor-agnostic ("a previous attempt", not "your previous
# attempt"): the re-ask re-walks the WHOLE chain rather than pinning the slot
# that narrated, so the vendor reading this may not be the one that produced the
# narration. Re-walking is the right default anyway — any slot returning a real
# review is a valid independent review, and a dead primary re-fails in seconds —
# but it does mean the text must not accuse its reader of something it may not
# have done, which would be a confusing instruction to act on.
REASK_PREAMBLE='A previous attempt at this review returned only progress
narration and no review output. Do the review and reply with ONLY the triage
lines the format below specifies (or the bare word NO_FINDINGS if the diff is
clean). No preamble, no narration, no announcement of what you are about to do.

'

# ── Parse ─────────────────────────────────────────────────────────────
#
# stdout carries triage lines only. Anything else is echoed to stderr rather
# than dropped silently, so an unparseable review is diagnosable.

parse_review_output() {
  FINDINGS=""
  FINDING_COUNT=0
  SENTINEL=0
  while IFS= read -r line; do
  # Salvage a marker an agent CLI glued onto its own progress narration with no
  # newline between them. Grok does this on every call ("Reading the engine
  # paths...[must-fix] engine.ts:1: ..."), so strict line-anchoring silently
  # discarded its entire review and the caller read that as a dead vendor — a
  # false "chain exhausted" that cost a session while grok was answering
  # correctly the whole time. The contract still ASKS for line-anchored
  # output; this only stops a real finding from being thrown away when a vendor
  # scuffs the prefix. Ordered marker-first so a findings line that merely
  # mentions the sentinel is not misread as a clean review.
  case "$line" in
    "[must-fix]"*|"[should-fix]"*|"[nit]"*) ;;
    *"[must-fix]"*|*"[should-fix]"*|*"[nit]"*)
      err "[code-review] salvaged a triage marker from a prefixed line"
      # Cut at the LEFTMOST marker on the line, via parameter expansion. A sed
      # "strip non-bracket prefix" cannot do this: narration containing any
      # earlier "[" would stop the strip short and the finding would still drop.
      # Leftmost rather than highest-severity: when a vendor glues two findings
      # onto one line, the first one is the one whose text follows, so picking by
      # severity would keep the wrong marker for that text.
      _best=""
      _bestlen=0
      for _mk in "[must-fix]" "[should-fix]" "[nit]"; do
        case "$line" in *"$_mk"*) ;; *) continue ;; esac
        _pre="${line%%"$_mk"*}"
        if [[ -z "$_best" || "${#_pre}" -lt "$_bestlen" ]]; then
          _best="$_mk"
          _bestlen="${#_pre}"
        fi
      done
      [[ -n "$_best" ]] && line="${_best}${line#*"$_best"}"
      ;;
    NO_FINDINGS) ;;
    *NO_FINDINGS*)
      err "[code-review] salvaged the NO_FINDINGS sentinel from a prefixed line"
      line="NO_FINDINGS"
      ;;
  esac
  case "$line" in
    "[must-fix]"*|"[should-fix]"*|"[nit]"*)
      FINDINGS="${FINDINGS}${line}"$'\n'
      FINDING_COUNT=$((FINDING_COUNT + 1))
      ;;
    NO_FINDINGS)
      SENTINEL=1
      ;;
    "")
      ;;
    *)
      err "[code-review] dropped non-triage line: $line"
      ;;
  esac
  done < "$RAW_OUT"
}

# Code review is read-only repo investigation, so scope grok to the read-only
# ALLOWLIST rather than a denylist. Under the denylist the run was
# CANCELLED the moment the model reaches for the shell, and the gate reported a
# healthy vendor as exhausted. Verified: same prompt, denylist ->
# stopReason "cancelled", 0 findings; allowlist -> end_turn, 9 turns, 8 findings.
# Complementary to the narration re-ask below: the allowlist removes the cause,
# the re-ask covers a vendor that narrates for any other reason.
export POLICY_CHAIN_GROK_TOOLS="read_file,list_dir,grep"

# The chain's shape test: is this output a REVIEW at all? Deliberately the
# cheapest question that separates a review from prose — one triage marker, or
# the clean-pass sentinel. `parse_review_output` still does the full parse
# afterwards, including its salvage rules; this is only the gate that decides
# whether the slot answered.
#
# It exists because the full parse used to run OUTSIDE the walk. A vendor that
# replied "Sure, I can help you review that" was banked as the answer, the
# backup was never tried, and the gate reported the whole chain exhausted while
# a healthy vendor sat untried behind it.
#
# The salvage cases are matched WITHOUT the line anchor for the same reason
# parse_review_output salvages them: grok routinely glues its marker onto the
# end of a narration line, and anchoring here would reject a review the parser
# would have accepted — a stricter gate than the parser it feeds, which turns
# good answers into chain burn.
# shellcheck disable=SC2329 # invoked indirectly, by name, through POLICY_CHAIN_VALIDATOR
_code_review_looks_like_a_review() {
  grep -qE '\[(must-fix|should-fix|nit)\]|NO_FINDINGS' "$1"
}

for attempt in 1 2; do
  if [[ "$attempt" -eq 2 ]]; then
    err "[code-review] the chain answered with narration only — re-asking once"
    printf '%s%s\n' "$REASK_PREAMBLE" "$PROMPT" > "$PROMPT_FILE"
  fi

  RC=0
  # Set immediately before the call: policy_run_chain unsets it on return, so
  # one gate's contract cannot bleed onto another's answer.
  # shellcheck disable=SC2034 # read by policy-chain.sh, which this script sources
  POLICY_CHAIN_VALIDATOR=_code_review_looks_like_a_review
  policy_run_chain adversarial-review "$PROMPT_FILE" > "$RAW_OUT" || RC=$?

  # 125: every vendor was alive and answered, and none produced a review. That
  # is exactly what the re-ask below is for, so spend it — and ONLY here. A
  # plain exhaustion (1) means there is nobody left to ask, and re-walking a
  # dead chain would double the outage's cost for no chance of an answer.
  if [[ "$RC" -eq 125 ]]; then
    if [[ "$attempt" -eq 1 ]]; then
      continue
    fi
    err "Error: no vendor in the chain produced a parseable review, on two attempts."
    err "Treating as a FAILED review, not a clean pass."
    exit 1
  fi

  if [[ "$RC" -eq 2 ]]; then
    err "Error: the review could not be dispatched (see above). Review did NOT run."
    exit 2
  fi

  if [[ "$RC" -eq 3 ]]; then
    err "[code-review] no independent reviewer answered the 'adversarial-review' row."
    err "Run the implement-audit-reviewer agent (.agents/agents/implement-audit-reviewer.md)"
    err "in a FRESH context on this diff, and record it as"
    err "  implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); …"
    err "It is a completed but weaker review — never an independent pass. Install"
    err "codex or grok for an independent one."
    exit 3
  fi

  if [[ "$RC" -eq 124 ]]; then
    err "Error: every vendor in the chain timed out at ${POLICY_CHAIN_SLOT_TIMEOUT_S}s per slot. Review did NOT complete."
    exit 124
  fi

  if [[ "$RC" -ne 0 ]]; then
    err "Error: the 'adversarial-review' chain is exhausted. Review did NOT complete."
    exit 1
  fi

  parse_review_output

  if [[ "$FINDING_COUNT" -gt 0 ]]; then
    printf '%s' "$FINDINGS"
    if [[ "$SENTINEL" -eq 1 ]]; then
      err "[code-review] both findings and NO_FINDINGS present; findings win."
    fi
    _via=""
    [[ "$attempt" -eq 2 ]] && _via=" (on the re-ask)"
    err "[code-review] complete — ${FINDING_COUNT} finding(s) from ${POLICY_CHAIN_VENDOR:-unknown}${_via}."
    exit 0
  fi

  if [[ "$SENTINEL" -eq 1 ]]; then
    err "[code-review] complete — reviewed clean (NO_FINDINGS) by ${POLICY_CHAIN_VENDOR:-unknown}."
    exit 0
  fi
done

# Empty stdout with no sentinel, TWICE. This is the highest-severity failure the
# contract guards: without the sentinel it is byte-identical to a clean review,
# so treating it as a pass ships unreviewed code carrying the gate's assurance.
# It is NOT chain fallthrough — a vendor answered; what it said was unusable —
# so the walk has already stopped and this verdict is the caller's to make.
err "Error: ${POLICY_CHAIN_VENDOR:-the reviewer} produced no parseable findings and no NO_FINDINGS sentinel, on two attempts."
err "Treating as a FAILED review, not a clean pass."
exit 1
