#!/usr/bin/env bash
# code-review.sh — adversarial review of freshly-written code, run on a reviewer
# that is not the author (see reviewer-chain.sh for how one is chosen).
#
# Called by /implement-audit. Round 1 reviews the whole change; every later round
# reviews ONLY the fixes made since the previous round.
#
# WHY LATER ROUNDS ARE NARROWED
#
# When every round re-read the entire cumulative diff, the reviewer kept
# re-deciding settled code and each round's own fixes became the next round's
# findings — fix loops of 14, 17, 24 and 34 rounds, one full reviewer call each.
# A follow-up round is scoped with `--since <tree>`, where <tree> came from a
# `--snapshot` taken immediately before the PREVIOUS round.
#
# Snapshots are plain git tree objects written through a temporary index: HEAD,
# your real index, the stash and the working tree are all left alone, which
# matters because this runs mid-session against uncommitted work by design.
# `git stash create` is the obvious alternative and is wrong here — it does not
# capture untracked files, so a file created by a FIX would read as new surface
# in every later round, which is the exact loop being closed.
#
# USAGE
#   code-review.sh <base-sha> <head-sha>   full review (round 1)
#   code-review.sh --snapshot              print a tree sha for the current tree
#   code-review.sh --since <tree>          follow-up round: only what changed
#
# OUTPUT (stdout): ONLY triaged findings, one per line. The /implement-audit fix
# loop parses this stream, so nothing else may appear on it.
#   [must-fix]   <file:line> <issue> — <suggested fix> — <rule or failure>
#   [should-fix] <target> <issue>
#   [nit]        <issue>
#
# OUTPUT (stderr): every diagnostic, including which reviewer answered.
#
# EXIT
#   0    review completed (zero or more findings on stdout; empty = clean)
#   1    the review did NOT happen — the chain was exhausted, or the reviewer
#        answered with output that held neither a finding nor NO_FINDINGS
#   2    caller error (bad args, unresolvable sha, diff over budget)
#   3    no external reviewer configured — caller MUST fall back to a
#        fresh-context agent and report the reduced independence
#   4    (--since only) nothing changed since the last round: CONVERGED, approve
#   5    (--since only) the round-4 ceiling was reached: stop, report what's open
#   124  the chain was exhausted and the last failure was a timeout

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -n "$REPO_ROOT" ]] || { err "Error: not inside a git repository."; exit 2; }

MAX_DIFF_BYTES="${CONTEXTIUM_REVIEW_MAX_DIFF_BYTES:-400000}"
SNAP_STATE_DIR="${CONTEXTIUM_SNAPSHOT_STATE_DIR:-/tmp/contextium-code-review}"
SID="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}"

# Write a tree object capturing tracked + untracked files, without touching the
# real index, HEAD, the stash, or the working tree.
snapshot_tree() {
  local tmp_index
  tmp_index="$(mktemp -t contextium-index-XXXXXX)"
  rm -f "$tmp_index"
  (
    cd "$REPO_ROOT"
    GIT_INDEX_FILE="$tmp_index" git add -A -- . >/dev/null 2>&1
    GIT_INDEX_FILE="$tmp_index" git write-tree
  )
  local rc=$?
  rm -f "$tmp_index"
  return $rc
}

snap_ledger_path() {
  [[ -n "$SID" ]] || return 1
  mkdir -p "$SNAP_STATE_DIR"
  echo "${SNAP_STATE_DIR}/${SID//[^A-Za-z0-9_-]/_}.snapshots"
}

# ── Argument parsing ──────────────────────────────────────────────────

MODE="range"
PREV_TREE=""
case "${1:-}" in
  --snapshot)
    tree="$(snapshot_tree)" || { err "Error: could not snapshot the working tree."; exit 2; }
    if ledger="$(snap_ledger_path)"; then printf '%s\n' "$tree" >> "$ledger"; fi
    printf '%s\n' "$tree"
    exit 0
    ;;
  --since)
    MODE="since"
    PREV_TREE="${2:-}"
    [[ -n "$PREV_TREE" ]] || { err "Usage: $0 --since <tree>"; exit 2; }
    ;;
  "")
    err "Usage: $0 <base-sha> <head-sha> | --snapshot | --since <tree>"
    exit 2
    ;;
  *)
    BASE_SHA="${1}"
    HEAD_SHA="${2:-}"
    [[ -n "$HEAD_SHA" ]] || { err "Usage: $0 <base-sha> <head-sha>"; exit 2; }
    ;;
esac

cd "$REPO_ROOT"

DIRTY_NOTE=""
ROUND_NOTE=""

if [[ "$MODE" == "range" ]]; then
  base_resolved="$(git rev-parse --verify "${BASE_SHA}^{commit}" 2>/dev/null || true)"
  head_resolved="$(git rev-parse --verify "${HEAD_SHA}^{commit}" 2>/dev/null || true)"
  [[ -n "$base_resolved" && -n "$head_resolved" ]] || {
    err "Error: could not resolve the sha range ${BASE_SHA}..${HEAD_SHA}."
    exit 2
  }

  if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
    DIRTY_NOTE="NOTE: the working tree has uncommitted changes. The diff below is
the committed range PLUS uncommitted work; you are NOT reviewing a clean tree."
  fi

  changed_files="$(git diff --name-only "$base_resolved" "$head_resolved" 2>/dev/null || true)"
  working_files="$(git diff --name-only HEAD 2>/dev/null || true)"

  # `git diff HEAD` shows only files git already TRACKS, so a file the session
  # created and never staged is invisible to it. That is a false GREEN, not a
  # coverage gap: a brand-new script sails through review unread while the
  # review still reports clean.
  untracked="$(git ls-files --others --exclude-standard 2>/dev/null || true)"
  if [[ -n "$untracked" ]]; then
    working_files="$(printf '%s\n%s' "$working_files" "$untracked" | grep -v '^[[:space:]]*$' || true)"
  fi

  diff_body="$(
    {
      git diff "$base_resolved" "$head_resolved" 2>/dev/null || true
      git diff HEAD 2>/dev/null || true
      while IFS= read -r u; do
        [[ -n "$u" ]] || continue
        # --no-index renders a whole untracked file as an addition; it exits 1
        # on any difference, which is the normal case here.
        git diff --no-index -- /dev/null "$u" 2>/dev/null || true
      done <<< "$untracked"
    }
  )"

  diff_bytes="$(printf '%s' "$diff_body" | wc -c)"
  # There is no such thing as a clean review of nothing. An empty diff means the
  # range or the repo is wrong, and reporting a pass on it certifies work nobody
  # read.
  if [[ "$diff_bytes" -eq 0 ]]; then
    err "Error: the diff is empty — nothing was reviewed."
    err "  repo:  $REPO_ROOT"
    err "  range: ${base_resolved:0:8}..${head_resolved:0:8} (plus uncommitted)"
    err "Usually the sha range is wrong, or the work lives in a different checkout."
    exit 2
  fi
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    err "Error: diff is ${diff_bytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget."
    err "Refusing rather than reviewing a truncated slice. Split the range, or raise"
    err "CONTEXTIUM_REVIEW_MAX_DIFF_BYTES deliberately."
    exit 2
  fi

  SUBJECT_LABEL="diff ${base_resolved:0:8}..${head_resolved:0:8}"
  SUBJECT="CHANGED FILES (committed range):
${changed_files:-(none)}

CHANGED FILES (uncommitted, vs HEAD):
${working_files:-(none)}

DIFF:
${diff_body}"

else
  if ! git rev-parse --verify "${PREV_TREE}^{tree}" >/dev/null 2>&1; then
    err "Error: --since needs a tree written by --snapshot; cannot resolve: $PREV_TREE"
    exit 2
  fi

  # Resolving to a tree is NOT enough: EVERY commit resolves to a tree, so a
  # commit sha — the thing a caller reaches for by mistake — would pass the check
  # above and get reviewed as if it were a snapshot, silently pulling in other
  # sessions' commits and producing confident findings about files this session
  # never touched. Fails OPEN when no session id is set.
  if ledger="$(snap_ledger_path)" && [[ -f "$ledger" ]]; then
    if ! grep -Fxq "$PREV_TREE" "$ledger" 2>/dev/null; then
      err "Error: --since was given a ref this session's --snapshot never issued: $PREV_TREE"
      err "Pass the tree printed by the --snapshot taken just before the PREVIOUS round."
      err "Snapshots issued this session:"
      while IFS= read -r s; do err "  $s"; done < "$ledger"
      exit 2
    fi
  fi

  now_tree="$(snapshot_tree)" || { err "Error: could not snapshot the working tree."; exit 2; }

  changed_files="$(git diff --name-only "$PREV_TREE" "$now_tree" 2>/dev/null || true)"
  diff_body="$(git diff "$PREV_TREE" "$now_tree" 2>/dev/null || true)"

  # Converged: nothing was edited between the last review and this one, so
  # another reviewer call would re-read settled code. Exit 4 says "stop the loop
  # and approve" — a different claim from exit 1.
  if [[ -z "$diff_body" ]]; then
    err "[code-review] nothing changed since the last round — the fix loop has converged."
    exit 4
  fi

  diff_bytes="$(printf '%s' "$diff_body" | wc -c)"
  if [[ "$diff_bytes" -gt "$MAX_DIFF_BYTES" ]]; then
    err "Error: follow-up diff is ${diff_bytes} bytes, over the ${MAX_DIFF_BYTES}-byte budget."
    exit 2
  fi

  # The round ceiling, enforced here rather than only in the skill's prose. An
  # instruction that says "cap at 4 rounds" and nothing that can observe the
  # count is how a fix loop reaches round 34. Round 1 is the two-arg full review,
  # so the Nth --since call is round N+1. Fails OPEN with no session id.
  if [[ -n "$SID" ]]; then
    mkdir -p "$SNAP_STATE_DIR"
    counter="${SNAP_STATE_DIR}/${SID//[^A-Za-z0-9_-]/_}.rounds"
    prior=0
    [[ -f "$counter" ]] && prior="$(cat "$counter" 2>/dev/null || echo 0)"
    [[ "$prior" =~ ^[0-9]+$ ]] || prior=0
    round=$((prior + 2))
    if [[ "$round" -gt 4 ]]; then
      err "Error: the fix loop has reached the round-4 ceiling. Refusing round ${round}."
      err "Stop the loop: fix any held nits, then report what is still open in the"
      err "implement-audit: trailer and in your summary. Past round 4 most findings"
      err "re-open ground an earlier round already touched, so another call buys churn."
      exit 5
    fi
    printf '%s\n' "$((prior + 1))" > "$counter"
    err "[code-review] round ${round} of at most 4"
  fi

  SUBJECT_LABEL="fixes since ${PREV_TREE:0:8}"
  # The reviewer is told what it is looking at. Without this it reads a diff of
  # fixes as fresh feature code, reports that the surrounding function is missing
  # context it cannot see, and the round produces findings about code that was
  # already dispositioned.
  ROUND_NOTE="THIS IS A FOLLOW-UP ROUND, NOT A FULL REVIEW. The diff below is
ONLY the changes made since the previous review round — the FIXES applied in
response to earlier findings, plus any work done alongside them. Earlier rounds
already reviewed the rest and their findings are dispositioned; do NOT re-report
them.

Review these fixes for two things specifically:
  1. Does each fix actually close the defect it was meant to close?
  2. Did the fix introduce a NEW defect — an inverted condition, a mirror-image
     bug at the opposite boundary, a broken caller, a contract it no longer
     honors?

If the fixes are correct, emit NO_FINDINGS. Do not hunt for something to say
about the surrounding file: code outside this diff is out of scope this round."

  SUBJECT="CHANGED FILES (since the last review round):
${changed_files:-(none)}

DIFF:
${diff_body}"
fi

# ── Prompt ────────────────────────────────────────────────────────────

PROMPT="$(cat <<EOF
You are an adversarial reviewer of freshly-written code. You are reviewing CODE,
not a SPEC. Assume things were missed and find them. Do not confirm the work is
good; find what is wrong. You have read access to the repo — read any file you
need for context before judging.

The conventions you hold the code to are this project's own rules, in
.claude/rules/. Read the ones that bear on the diff rather than importing
conventions from elsewhere.

CRITICAL FRAMING — weigh every defense-in-depth finding (per-caller credentials,
allowlists, retry primitives, isolation layers) against the project's
simplest-solution-default rule. If a finding adds a control surface against a
threat nobody has named, downgrade it to [nit] or omit it. Defense-in-depth is
over-engineering until a real threat is named.

Attack across these dimensions:

1. Correctness — logic errors, off-by-one, wrong operator, inverted condition.
2. Boundary cases — behavior at 0 / 1 / empty / max / error inputs.
3. Error handling — swallowed errors, empty catch, silent degradation, a failure
   path that reports success.
4. Integration — do imports resolve, do callers and callees still agree, does
   data survive the boundaries it crosses.
5. Peer consistency — does a sibling file do this same thing differently, and is
   one of them now wrong?
6. Class-fix completeness — if this fixes a shared mechanism, did every peer get
   fixed, or was one quietly left behind?
7. Contract drift — does the code do what its own header, SPEC or comment claims?

Required: every [must-fix] finding MUST cite the rule it enforces or name the
concrete failure it causes. A finding that is neither rule-backed nor
failure-backed cannot be must-fix.

OUTPUT CAP: at most 8 findings, ranked by severity. If you have more than 8, the
top 8 displace the rest.

OUTPUT FORMAT — STRICT. Each finding MUST appear on its own line with the literal
bracket prefix at the very start of the line. No markdown bold (no
\`**[must-fix]**\`). No alternate prefixes (no \`must-fix:\`, no \`-- must-fix --\`).
The caller parses by line-anchored match; deviations are silently dropped.

  [must-fix]   <file:line>: <issue> — <suggested fix> — <rule or failure>
  [should-fix] <file-or-target>: <issue>
  [nit]        <issue>

IF YOU REVIEWED THE CODE AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED review
rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.

REVIEW SUBJECT: ${SUBJECT_LABEL}
${DIRTY_NOTE}
${ROUND_NOTE}

${SUBJECT}
EOF
)"

PROMPT_FILE="$(mktemp -t code-review-prompt-XXXXXX)"
RAW_OUT="$(mktemp -t code-review-out-XXXXXX)"
# shellcheck disable=SC2329 # invoked indirectly by the EXIT trap below
cleanup() { rm -f "$PROMPT_FILE" "$RAW_OUT"; }
trap cleanup EXIT

printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

err "[code-review] reviewing ${SUBJECT_LABEL}"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/reviewer-chain.sh"

rc=0
reviewer_run_chain "$PROMPT_FILE" > "$RAW_OUT" || rc=$?

case "$rc" in
  0) : ;;
  3)
    err "[code-review] no external reviewer — the caller must fall back to a"
    err "               fresh-context agent and say so in its report."
    exit 3
    ;;
  124) err "[code-review] the reviewer chain timed out. The review did NOT happen."; exit 124 ;;
  *)   err "[code-review] the reviewer chain is exhausted. The review did NOT happen."; exit 1 ;;
esac

# Only line-anchored findings reach stdout. A reviewer CLI prints its own
# preamble and progress chatter; the fix loop parses this stream, so anything
# that is not a finding is dropped here rather than in the caller.
FINDINGS="$(grep -E '^\[(must-fix|should-fix|nit)\]' "$RAW_OUT" || true)"

if [[ -n "$FINDINGS" ]]; then
  printf '%s\n' "$FINDINGS"
  exit 0
fi

# No findings parsed. That is a clean review ONLY if the reviewer said so with
# the sentinel. Otherwise it answered with something this script cannot read —
# chatter, a refusal, a truncated response — and dropping all of it would leave
# an empty stdout that the caller cannot distinguish from "nothing wrong". The
# whole point of requiring the sentinel is that silence must not read as a pass.
# The contract is "that one line and nothing else". Accepting any output that
# merely CONTAINS the sentinel would pass "I could not review this\nNO_FINDINGS"
# as a clean review — a refusal reported as an approval. Count the non-blank
# lines: exactly one, and it is the sentinel.
sentinel_only() {
  local body
  body="$(grep -vE '^[[:space:]]*$' "$1" || true)"
  [[ "$(printf '%s' "$body" | grep -c . || true)" -eq 1 ]] || return 1
  printf '%s' "$body" | grep -qE '^[[:space:]]*NO_FINDINGS[[:space:]]*$'
}

if sentinel_only "$RAW_OUT"; then
  err "[code-review] reviewed clean (NO_FINDINGS)."
  exit 0
fi

err "[code-review] the reviewer answered, but nothing in its output could be parsed"
err "              as a finding and it did not emit NO_FINDINGS. Treating this as a"
err "              FAILED review rather than a clean one. First lines of what it said:"
head -5 "$RAW_OUT" >&2
exit 1
