#!/usr/bin/env bash
# artifact-review.sh — adversarial review of a freshly-authored .claude/ artifact
# (a skill, hook, agent, rule, or output style), run on a reviewer that is not
# the author. Called by /author's design-review step.
#
# The format checks in /author prove an artifact is well-FORMED. This asks
# whether it is WRONG, which no format check can see: a skill whose description
# means it will never fire, a step graph with no body behind it, a gate that
# cannot fail, a deterministic step written as prose for a model to re-derive
# each run.
#
# USAGE
#   artifact-review.sh <artifact-path> <brief-file>
#
#   <brief-file>  what the artifact is for and what to attack — /author writes
#                 this from the angles table in .agents/reviewers/ai-layer-reviewer.md
#
# OUTPUT (stdout): triaged findings, one per line, nothing else.
#   [must-fix] / [should-fix] / [nit]
#
# EXIT
#   0    reviewed (findings on stdout, or a clean NO_FINDINGS pass)
#   1    the review did NOT happen — chain exhausted, or unparsable output
#   2    caller error
#   3    no external reviewer configured — caller MUST fall back to the
#        ai-layer-reviewer agent and report the reduced independence
#   124  the chain timed out

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ARTIFACT="${1:-}"
BRIEF_FILE="${2:-}"

[[ -n "$ARTIFACT" && -f "$ARTIFACT" ]] || { err "Usage: $0 <artifact-path> <brief-file>"; exit 2; }
[[ -n "$BRIEF_FILE" && -f "$BRIEF_FILE" ]] || { err "Error: brief file not found: ${BRIEF_FILE:-(none)}"; exit 2; }

PROMPT="$(cat <<EOF
You are an adversarial reviewer of a newly authored artifact in an AI agent's
configuration layer — a skill, hook, agent, rule, or output style. It already
passes its format checks. Your job is to find where the DESIGN is wrong.

Attack across these angles:

1. Will it ever fire? A skill's description is what the model routes on. One that
   never states its trigger produces a skill nobody invokes, and nothing reports
   that.
2. Does the step graph match the body? A declared step with no section behind it
   is a promise the artifact does not keep.
3. Is a deterministic step written as prose? A lookup, a grep, a format check or
   a fixed transform described in words gets re-derived — slightly differently —
   every run. It belongs in a script.
4. Can the gate fail? A check that returns the same answer whatever the state is
   not a gate.
5. What happens when something it depends on is missing — a CLI, a file, a
   network call? Does it degrade, or does it break?
6. Does it duplicate an existing artifact, or contradict one?
7. For a hook: does a blocking path exit 2 (exit 1 does not block), and does the
   error name the file and the fix?

Weigh every "add more safety" finding against how simple the thing needs to be.
A control surface against a threat nobody has named is over-engineering.

OUTPUT CAP: at most 8 findings, most severe first.

OUTPUT FORMAT — STRICT. One finding per line, the bracket prefix at the very
start of the line. No markdown bold, no alternate prefixes. The caller parses by
line-anchored match; anything else is dropped.

  [must-fix]   <where>: <issue> — <the specific change> — <why it fails>
  [should-fix] <where>: <issue>
  [nit]        <issue>

IF YOU REVIEWED IT AND FOUND NOTHING, emit exactly this one line and nothing
else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED review
rather than a pass.

Be concise. No preamble, no closing summary. Just findings.

BRIEF:
$(cat "$BRIEF_FILE")

ARTIFACT (${ARTIFACT}):
$(cat "$ARTIFACT")
EOF
)"

PROMPT_FILE="$(mktemp -t artifact-review-prompt-XXXXXX)"
RAW_OUT="$(mktemp -t artifact-review-out-XXXXXX)"
# shellcheck disable=SC2329 # invoked indirectly by the EXIT trap below
cleanup() { rm -f "$PROMPT_FILE" "$RAW_OUT"; }
trap cleanup EXIT

printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

err "[artifact-review] reviewing ${ARTIFACT}"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/reviewer-chain.sh"

rc=0
reviewer_run_chain "$PROMPT_FILE" > "$RAW_OUT" || rc=$?

case "$rc" in
  0) : ;;
  3)
    err "[artifact-review] no external reviewer — fall back to the ai-layer-reviewer"
    err "                  agent and say so in the summary."
    exit 3
    ;;
  124) err "[artifact-review] the reviewer chain timed out. The review did NOT happen."; exit 124 ;;
  *)   err "[artifact-review] the reviewer chain is exhausted. The review did NOT happen."; exit 1 ;;
esac

FINDINGS="$(grep -E '^\[(must-fix|should-fix|nit)\]' "$RAW_OUT" || true)"
if [[ -n "$FINDINGS" ]]; then
  printf '%s\n' "$FINDINGS"
  exit 0
fi

# Same strictness as the other two reviewers: the contract is that one line and
# nothing else, so output that merely contains the sentinel does not pass.
sentinel_only() {
  local body
  body="$(grep -vE '^[[:space:]]*$' "$1" || true)"
  [[ "$(printf '%s' "$body" | grep -c . || true)" -eq 1 ]] || return 1
  printf '%s' "$body" | grep -qE '^[[:space:]]*NO_FINDINGS[[:space:]]*$'
}

if sentinel_only "$RAW_OUT"; then
  err "[artifact-review] reviewed clean (NO_FINDINGS)."
  exit 0
fi

err "[artifact-review] the reviewer answered, but nothing in its output could be"
err "                  parsed as a finding and it did not emit NO_FINDINGS. Treating"
err "                  this as a FAILED review. First lines of what it said:"
head -5 "$RAW_OUT" >&2
exit 1
