#!/usr/bin/env bash
# spec-review.sh — adversarial review of a SPEC, run on a reviewer that is not
# the author (see reviewer-chain.sh for how one is chosen).
#
# The SPEC-side mirror of code-review.sh, and the cheaper of the two: a design
# flaw caught here costs a paragraph to fix, and the same flaw caught after the
# code is written costs the implementation.
#
# Called by /spec-audit. Round 1 attacks the SPEC. Round 2 fires only when the
# author pushed back on round-1 findings, and asks the reviewer to concede or
# restate each one.
#
# USAGE
#   spec-review.sh <spec-file> <brief> [<pushback-file>]
#
#   <spec-file>      path to the SPEC under review
#   <brief>          one line on what the SPEC is for
#   <pushback-file>  (round 2 only) the author's rebuttals to round-1 findings
#
# OUTPUT (stdout): triaged findings, one per line, and nothing else.
#   [must-fix]   <section-or-target>: <issue> — <suggested fix> — <rule>
#   [should-fix] <target>: <issue>
#   [nit]        <issue>
#   [concede]    <id>                       (round 2 only)
#   [disagree]   <id> <restated rationale>  (round 2 only)
#
# OUTPUT (stderr): every diagnostic, including which reviewer answered.
#
# EXIT
#   0    review completed
#   1    the review did NOT happen — the chain was exhausted, or the reviewer
#        answered with output holding neither a finding nor NO_FINDINGS
#   2    caller error (bad arity, missing file)
#   3    no external reviewer configured — caller MUST fall back to a
#        fresh-context agent and report the reduced independence
#   124  the chain was exhausted and the last failure was a timeout

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Where this repo keeps its rules. A project that INSTALLED the layer has them at
# .agents/rules/; the repo that AUTHORS it has them at templates/agents/rules/.
# Naming the wrong one tells the reviewer to read a directory that is not there,
# and it then judges the SPEC without the conventions it was told to apply.
REVIEW_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [ -d "$REVIEW_REPO_ROOT/.agents/rules" ]; then
  RULES_DIR=".agents/rules/"
elif [ -d "$REVIEW_REPO_ROOT/templates/agents/rules" ]; then
  RULES_DIR="templates/agents/rules/"
else
  RULES_DIR=".agents/rules/"
fi

if [[ $# -lt 2 ]]; then
  err "Usage: $0 <spec-file> <brief> [<pushback-file>]"
  exit 2
fi

SPEC_FILE="$1"
BRIEF="$2"
PUSHBACK_FILE="${3:-}"

[[ -f "$SPEC_FILE" ]] || { err "Error: SPEC file not found: $SPEC_FILE"; exit 2; }
if [[ -n "$PUSHBACK_FILE" && ! -f "$PUSHBACK_FILE" ]]; then
  err "Error: pushback file not found: $PUSHBACK_FILE"
  exit 2
fi

SPEC_CONTENTS="$(cat "$SPEC_FILE")"

if [[ -n "$PUSHBACK_FILE" ]]; then
  PUSHBACK_CONTENTS="$(cat "$PUSHBACK_FILE")"
  ROUND_INSTRUCTIONS="$(cat <<EOF

ROUND 2 — the author has responded to your prior findings. For each item below,
either CONCEDE (the pushback is valid; drop the finding) or DISAGREE (the finding
stands; restate the rationale once, briefly).

Output format for round 2 — STRICT. Each verdict MUST appear on its own line with
the literal bracket prefix at the very start of the line. No markdown bold. No
alternate prefixes like \`concede:\`. The caller parses by line-anchored match;
deviations are silently dropped.

  [concede] <number>
  [disagree] <number> <one-sentence restated rationale>

The pushbacks below are numbered. Emit EXACTLY ONE verdict line per number. Each
line starts with the bracket prefix, and the number comes immediately after it —
\`[concede] 2\`, never \`2 [concede]\`. Answering some and
skipping others is not agreement on the rest — the caller counts your verdicts
against the number of pushbacks and re-runs this round if any are missing. An
empty response is a FAILED review, not agreement: a round with no verdicts is
indistinguishable from a crash.

THE AUTHOR'S PUSHBACKS:
$PUSHBACK_CONTENTS
EOF
)"
else
  ROUND_INSTRUCTIONS="$(cat <<'EOF'

ROUND 1 — adversarial review of the SPEC below. Find design flaws BEFORE code is
written.

CRITICAL FRAMING — weigh every defense-in-depth finding (per-caller credentials,
allowlists, retry primitives, isolation layers) against the project's
simplest-solution-default rule. If a finding adds a control surface against a
threat nobody has named, downgrade it to [nit] or omit it. Defense-in-depth is
over-engineering until a real threat is named.

Attack across these dimensions:

1. Behavior contract gaps — anything ambiguous, contradictory, or missing.
2. Boundary cases — are the 0 / 1 / empty / max / error rows present, or
   hand-waved?
3. Downstream consumers — does the SPEC name who else depends on what changes,
   or does it assume nothing else calls this?
4. Peer consistency — are there sibling files doing the same job that this
   change leaves inconsistent?
5. Doc surface — which READMEs, SPECs, or index files go stale, and does the SPEC
   account for them?
6. Failure modes — refuse-to-write conditions, partial success, retry-exhausted
   state.
7. Deferral — if this fixes a shared mechanism, does the SPEC sweep every peer in
   the same pass, or does it quietly leave some for "later"?
8. Shape proportionality — is the proposed shape (function / module / daemon /
   service) proportionate to what was actually asked for? A SPEC proposing a
   deployed service where a function satisfies the ask is a [must-fix].
9. Verifiability — is the "done" section an actual command with an actual
   expected output, or an aspiration like "tests pass"?

Required: every [must-fix] finding MUST cite the rule it enforces or the concrete
failure it prevents. A finding that is neither cannot be must-fix.

OUTPUT CAP: at most 8 findings total, ranked by severity. If you have more than 8,
the top 8 displace the rest. Prioritize instead of flooding the channel.

If the SPEC is too vague to attack on any of the above, that is itself a
[must-fix] — say so explicitly. Don't invent praise.

Output format for round 1 — STRICT. Each finding MUST appear on its own line with
the literal bracket prefix at the very start of the line. No markdown bold (no
`**[must-fix]**`). No alternate prefixes. The caller parses by line-anchored
match; deviations are silently dropped.

  [must-fix]   <section-or-target>: <issue> — <suggested fix> — <rule>
  [should-fix] <target-or-section>: <issue>
  [nit]        <issue>

IF YOU REVIEWED THE SPEC AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean review. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED review
rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.
EOF
)"
fi

PROMPT="$(cat <<EOF
You are an adversarial reviewer of a SPEC. You are reviewing a SPEC, not code.

The SPEC follows a four-section shape: 1 Ask (what the human asked for, in their
words), 2 Behavior (the contract, including boundary cases), 3 Files (what
changes, and the patterns being mirrored), 4 Done (the exact commands and
expected output that prove it works). Hold it to that shape and to the project's
own rules in ${RULES_DIR}.

BRIEF: $BRIEF
$ROUND_INSTRUCTIONS

SPEC CONTENTS:
$SPEC_CONTENTS
EOF
)"

PROMPT_FILE="$(mktemp -t spec-review-prompt-XXXXXX)"
RAW_OUT="$(mktemp -t spec-review-out-XXXXXX)"
# shellcheck disable=SC2329 # invoked indirectly by the EXIT trap below
cleanup() { rm -f "$PROMPT_FILE" "$RAW_OUT"; }
trap cleanup EXIT

# Prompt as a FILE piped on stdin, never argv: a long SPEC plus a pushback file
# is exactly the input that dies with "Argument list too long", and a CLI hanging
# on an unfed stdin is the other half the pipe closes.
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

err "[spec-review] reviewing ${SPEC_FILE}$([[ -n "$PUSHBACK_FILE" ]] && echo ' (round 2)')"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/reviewer-chain.sh"

rc=0
reviewer_run_chain "$PROMPT_FILE" > "$RAW_OUT" || rc=$?

case "$rc" in
  0) : ;;
  3)
    err "[spec-review] no external reviewer — the caller must fall back to a"
    err "              fresh-context agent and say so in its report."
    exit 3
    ;;
  124) err "[spec-review] the reviewer chain timed out. The review did NOT happen."; exit 124 ;;
  *)   err "[spec-review] the reviewer chain is exhausted. The review did NOT happen."; exit 1 ;;
esac

# Parse by MODE, not by one permissive pattern. Round 2 asks for a verdict on
# every pushback; a round 2 that comes back with fresh findings and no verdicts
# has not adjudicated anything, and accepting those findings as a successful
# round reports consensus that was never reached.
if [[ -n "$PUSHBACK_FILE" ]]; then
  FINDINGS="$(grep -E '^\[(concede|disagree)\]' "$RAW_OUT" || true)"
else
  FINDINGS="$(grep -E '^\[(must-fix|should-fix|nit)\]' "$RAW_OUT" || true)"
fi

if [[ -n "$FINDINGS" ]]; then
  printf '%s\n' "$FINDINGS"
  exit 0
fi

# Nothing parsed. In round 1 that is clean only if the reviewer emitted the
# sentinel. In round 2 it is never clean: every pushback needs a verdict, so a
# round with no verdicts crashed rather than agreed.
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

if [[ -z "$PUSHBACK_FILE" ]] && sentinel_only "$RAW_OUT"; then
  err "[spec-review] reviewed clean (NO_FINDINGS)."
  exit 0
fi

if [[ -n "$PUSHBACK_FILE" ]]; then
  err "[spec-review] round 2 returned no [concede] or [disagree] verdicts. A round with"
  err "              no verdicts is indistinguishable from a crash, so this is a FAILED"
  err "              round, not agreement. First lines of what it said:"
else
  err "[spec-review] the reviewer answered, but nothing in its output could be parsed"
  err "              as a finding and it did not emit NO_FINDINGS. Treating this as a"
  err "              FAILED review rather than a clean one. First lines of what it said:"
fi
head -5 "$RAW_OUT" >&2
exit 1
