#!/usr/bin/env bash
# spec-audit.sh — Single-round adversarial review of a SPEC (or plan-mode draft
# containing SPEC content), on whichever vendor the policy's
# `adversarial-review` row selects. Returns triaged findings on stdout for
# Claude to read and orchestrate the consensus protocol.
#
# Renamed from an old vendor-named filename: that name pinned a vendor into a
# path, which the assignment table cannot honor. The vendor comes from the
# policy table (policy.json beside this script), walked by
# .agents/skills/review/policy-chain.sh, and a Codex outage falls through to the
# row's declared backup instead of taking the gate down.
#
# Usage:
#   spec-audit.sh <spec-folder | spec-or-plan-file> <brief> [<pushback-file>]
#
# Inputs:
#   $1  spec-folder        A spec-kit folder, `specs/NNN-name/`, which MUST hold
#                          spec.md and plan.md (exit 2 otherwise). Those two,
#                          then tasks.md, research.md, data-model.md,
#                          quickstart.md and every file under contracts/ that
#                          exists, are handed to the reviewer together, each
#                          under a `=== <file> ===` header, because the design is
#                          split across them. report.md is not design and is
#                          never sent. A file that cannot be read is exit 2.
#       spec-or-plan-file  Or the absolute path to one draft SPEC / plan file
#                          (app SPECs and legacy project SPECs).
#   $2  brief              Short description of what the SPEC is for.
#   $3  pushback-file      (optional, round 2) Path to file containing
#                          Claude's pushbacks against round-1 findings.
#                          When present, the reviewer is asked to concede or
#                          restate each prior finding.
#
# Output (stdout): triaged findings, one per line, and nothing else.
#   [must-fix]   <plan-or-spec-target> <issue> <suggested fix>
#   [should-fix] <issue>
#   [nit]        <issue>
#   [concede]    <id>  (round 2 only — Claude's pushback was valid)
#   [disagree]   <id> <restated rationale>  (round 2 only)
#
# Output (stderr): every diagnostic, including one line per chain slot tried
# and an `answered: <vendor>/<model>` line naming who did the review.
#
# Exit:
#   0    A vendor answered.
#   1    The whole `adversarial-review` chain was exhausted. NOT a review.
#   2    Caller error (bad arity, missing file, unknown row, jq absent).
#   3    No independent reviewer: the chain reached a CLAUDE slot, or (on the
#        shipped table) every vendor was unavailable. Contextium: the caller
#        runs the same attack in a FRESH context with its own agent and records
#        `spec-audit: claude-fallback (fresh context, NOT independent) …` — a
#        completed but weaker audit, never an independent one.
#   124  Chain exhausted and the last slot's failure was a timeout.
#
# Note the exit codes: caller errors are 2, not 1, so
# "you called this wrong" and "the review did not happen" are distinguishable —
# the same split code-review.sh already used, now shared by both reviewers.
#
# CODEX_BIN / GROK_BIN / POLICY_CHAIN_SLOT_TIMEOUT_S are honored by
# policy-chain.sh, which holds the CLI invocation shapes; reviewers run
# read-only — an auditor reads and reports, it never writes.
#
# Enforces the spec-audit consensus gate (.agents/skills/spec-audit/SKILL.md).
# The named decision point in the plan-mode step graph between SPEC drafting and
# ExitPlanMode runs this script.
#
# Runs on: plan-mode (via Claude tool call), not pre-commit.

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 2 ]]; then
  err "Usage: $0 <spec-folder | spec-or-plan-file> <brief> [<pushback-file>]"
  exit 2
fi

SPEC_FILE="$1"
BRIEF="$2"
PUSHBACK_FILE="${3:-}"

if [[ ! -f "$SPEC_FILE" && ! -d "$SPEC_FILE" ]]; then
  err "Error: SPEC file not found: $SPEC_FILE"
  exit 2
fi

if [[ -n "$PUSHBACK_FILE" && ! -f "$PUSHBACK_FILE" ]]; then
  err "Error: pushback file not found: $PUSHBACK_FILE"
  exit 2
fi

if [[ -d "$SPEC_FILE" ]]; then
  # spec.md holds the behavior contract and plan.md the shape; a folder missing
  # either would be "audited" without the part the review exists to read.
  for _f in spec.md plan.md; do
    if [[ ! -f "$SPEC_FILE/$_f" ]]; then
      err "Error: spec folder has no $_f: $SPEC_FILE"
      exit 2
    fi
  done
  # Every design file spec-kit's plan can produce, in reading order. report.md
  # is not design and is left out.
  SPEC_CONTENTS=""
  _design=()
  for _f in spec.md plan.md tasks.md research.md data-model.md quickstart.md; do
    [[ -f "$SPEC_FILE/$_f" ]] && _design+=("$_f")
  done
  if [[ -d "$SPEC_FILE/contracts" ]]; then
    # Captured, not process-substituted, so a find that fails stops the audit
    # instead of quietly sending the design without its contracts.
    if ! _contracts=$(find "$SPEC_FILE/contracts" -type f); then
      err "Error: cannot list $SPEC_FILE/contracts"
      exit 2
    fi
    while IFS= read -r _c; do
      [[ -n "$_c" ]] && _design+=("${_c#"$SPEC_FILE"/}")
    done < <(printf '%s\n' "$_contracts" | sort)
  fi
  for _f in "${_design[@]}"; do
    if ! _body=$(cat "$SPEC_FILE/$_f"); then
      err "Error: cannot read $SPEC_FILE/$_f — refusing to audit a partial design"
      exit 2
    fi
    SPEC_CONTENTS+="=== ${_f} ==="$'\n'"$_body"$'\n\n'
  done
else
  SPEC_CONTENTS=$(cat "$SPEC_FILE")
fi

ROUND_INSTRUCTIONS=""
if [[ -n "$PUSHBACK_FILE" ]]; then
  PUSHBACK_CONTENTS=$(cat "$PUSHBACK_FILE")
  ROUND_INSTRUCTIONS=$(cat <<EOF

ROUND 2 — Claude has responded to your prior findings. For each item below,
either CONCEDE (Claude's pushback is valid; the finding should be dropped) or
DISAGREE (the finding stands; restate the rationale once, briefly).

Output format for round 2 — STRICT. Each verdict MUST appear on its own line,
with the literal bracket prefix at the very start of the line. No markdown
bold (no \`**[concede]**\`). No alternate prefixes like \`concede:\` or
\`-- concede --\`. Claude parses by line-anchored grep \`^\[concede\]\` and
\`^\[disagree\]\`; deviations are silently dropped.

  [concede] <finding-id-or-short-quote>
  [disagree] <finding-id-or-short-quote> <one-sentence restated rationale>

Every pushback above needs a verdict. Emit at least one [concede] or
[disagree] line — an empty response, or a bare NO_FINDINGS, is treated as a
FAILED audit rather than agreement, because a round with no verdicts is
indistinguishable from a crash and would otherwise read as consensus.

CLAUDE'S PUSHBACKS:
$PUSHBACK_CONTENTS
EOF
)
else
  ROUND_INSTRUCTIONS=$(cat <<'EOF'

ROUND 1 — Adversarial review of the SPEC below. Find design flaws BEFORE code
is written.

CRITICAL FRAMING — this SPEC exists where every caller is the owner's own code. Defense-in-depth
findings (per-caller credentials, allowlists, retry primitives, isolation
layers) MUST be weighed against the simplest mechanism that works, and nothing
is built for a failure mode that has not occurred. If a finding adds a
control surface against an unenumerated threat, downgrade it to [nit] or
omit. Defense-in-depth is over-engineering until a real threat is named.

Attack across these dimensions:

1. Behavior contract gaps — anything ambiguous, contradictory, or missing.
2. Input/output contract holes — params not typed, KV writes missing
   envelope/SLA, side effects not enumerated.
3. Boundary cases — 0 / 1 / empty / max / error rows missing or hand-waved.
4. Downstream consumers — does the SPEC name them or grep for them?
5. Peer/sibling-feature consistency — does the SPEC list parallel patterns
   in the same app and update them too?
6. Doc surface drift — which READMEs / SPECs / index files will go stale,
   and is the SPEC's "what changes" section accounting for them?
7. Failure modes — refuse-to-write conditions, partial-success behavior,
   retry-exhausted state.
8. Class-fix atomicity — if the SPEC describes a fix to a shared mechanism,
   does it sweep all peers in the same session, or quietly defer?
9. Shape proportionality — is the proposed shape (function / module / daemon /
   service / portal) proportionate to the user's verbatim ask? If the SPEC
   proposes a deployed service when a function would satisfy the ask,
   that's a [must-fix] finding: the shape exceeds the ask.
10. Control-surface budget — count auth layers, retry primitives, validation
    passes, isolation primitives in the SPEC. For each, is the surface paying
    its weight against a CONCRETE NAMED threat in the SPEC's threat model, or
    is it speculative? Speculative surfaces are [must-fix] cuts, not [must-fix]
    additions.

Required: every [must-fix] finding MUST name the concrete failure it causes
(the data it corrupts, the case it mishandles, the surface it adds for no
named threat). A finding that names no failure cannot be must-fix.

OUTPUT CAP: at most 8 findings total, ranked by severity. If you have more
than 8, the top 8 displace the rest. Forces you to prioritize instead of
flooding the channel.

If the SPEC is too vague to attack on any of the above, that's a [must-fix]
finding — say so explicitly. Don't invent praise.

Output format for round 1 — STRICT. Each finding MUST appear on its own line,
with the literal bracket prefix at the very start of the line. No markdown
bold (no `**[must-fix]**`). No alternate prefixes (no `must-fix:`,
`-- must-fix --`, etc.). Claude parses by line-anchored grep
`^[must-fix]`, `^[should-fix]`, `^[nit]`; deviations silently drop.

  [must-fix]   <target-file-or-section>: <issue> — <suggested fix> — <the failure it causes>
  [should-fix] <target-or-section>: <issue>
  [nit]        <issue>

IF YOU AUDITED THE SPEC AND FOUND NOTHING, emit exactly this one line and
nothing else:

NO_FINDINGS

That sentinel is REQUIRED for a clean audit. Emitting nothing at all is
indistinguishable from a crash, and the caller treats silence as a FAILED audit
rather than a pass. Never emit an empty response.

Be concise. No prose introduction. No summary at the end. Just findings.
EOF
)
fi

PROMPT=$(cat <<EOF
You are an adversarial reviewer of an app SPEC. You're reviewing a SPEC, not
code. The repo conventions you must hold the SPEC to are documented in
AGENTS.md, section Standards (data is fetched and judgment is prompted, read
before asserting, a class fix is atomic, no deferral, simplest mechanism that
works, plan the four before building, tests and evals).

BRIEF: $BRIEF
$ROUND_INSTRUCTIONS

SPEC CONTENTS:
$SPEC_CONTENTS
EOF
)

# ── Invoke ────────────────────────────────────────────────────────────

PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/spec-audit-prompt.XXXXXX")
RAW_OUT=""
# shellcheck disable=SC2329 # invoked indirectly by the trap on EXIT below
cleanup() { rm -f "$PROMPT_FILE" "$RAW_OUT"; }
trap cleanup EXIT

# Prompt as a FILE, piped on stdin — never argv. A long SPEC plus a pushback
# file is exactly the input that dies "Argument list too long" on argv, and the
# CLI hanging on an unfed stdin until killed is the
# other half the pipe closes: the vendor gets EOF when the file ends.
printf '%s\n' "$PROMPT" > "$PROMPT_FILE"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/policy-chain.sh"

# policy-chain.sh keeps its own diagnostics on stderr, so the captured stream is
# findings-only. It is captured rather than passed straight through because
# "exit 0" is not the same claim as "an audit happened" — see the sentinel check
# below.
RAW_OUT=$(mktemp "${TMPDIR:-/tmp}/spec-audit-out.XXXXXX")

# Same read-only allowlist as code-review.sh, for the same reason: under a
# denylist, grok's run was CANCELLED the first time it reaches for a
# denied tool, and the audit reports a healthy vendor as exhausted. Both
# agentic callers of this chain must scope it the same way.
export POLICY_CHAIN_GROK_TOOLS="read_file,list_dir,grep"

# The chain's shape test: is this output an AUDIT at all?
#
# ANCHORED (`^\[`), deliberately, and NOT the same as code-review.sh's. That
# script's `parse_review_output` SALVAGES a marker a vendor glued onto the end
# of a narration line, so an unanchored gate there matches what its parser will
# actually accept. This script has no salvage: it counts line-anchored prefixes
# only. An unanchored gate here would bank a prose answer that merely MENTIONS
# `[must-fix]`, skip the healthy backup, and then fail the audit as unparseable
# — the exact hole the gate was added to close. A shape test must match the
# parser it feeds, not the other gate's parser. Same cheap question
# the full parse below asks, moved to where a "no" still has a backup to fall
# through to — until now a vendor that answered with prose was banked, the walk
# stopped, and the untried slot never ran.
#
# It is ROUND-AWARE, and that is the whole reason it is set per-call rather than
# once at the top of the file. Round 2 adjudicates pushback and accepts ONLY
# [concede] / [disagree]; a round-2 reply carrying [must-fix] — or the
# NO_FINDINGS sentinel — is not an answer to what was asked, and the parse below
# would read "no disagreements" as CONSENSUS and approve the SPEC unread. A
# wrapper-level validator sharing one prefix set across both rounds would hand
# exactly that back as a pass.
if [[ -n "$PUSHBACK_FILE" ]]; then
  # shellcheck disable=SC2329 # invoked indirectly, by name, through POLICY_CHAIN_VALIDATOR
  _spec_audit_looks_like_an_audit() { grep -qE '^\[(concede|disagree)\]' "$1"; }
else
  # shellcheck disable=SC2329 # invoked indirectly, by name, through POLICY_CHAIN_VALIDATOR
  _spec_audit_looks_like_an_audit() { grep -qE '^\[(must-fix|should-fix|nit)\]|^NO_FINDINGS$' "$1"; }
fi

RC=0
# Set immediately before the call: policy_run_chain unsets it on return.
# shellcheck disable=SC2034 # read by policy-chain.sh, which this script sources
POLICY_CHAIN_VALIDATOR=_spec_audit_looks_like_an_audit
policy_run_chain adversarial-review "$PROMPT_FILE" > "$RAW_OUT" || RC=$?

case "$RC" in
  0) ;;
  125)
    # Every vendor was alive and answered; none produced an audit. This script
    # has no re-ask of its own, so there is nothing further to spend — but it
    # is named separately from a dead chain because the two need different
    # fixes, and "the chain is exhausted" would send the reader to check quotas
    # for vendors that were answering fine.
    err "Error: no vendor in the chain produced a parseable audit. The SPEC was NOT audited."
    err "Every slot answered; none in the shape this round accepts. Raw output (first 2KB):"
    head -c 2048 "$RAW_OUT" >&2 || true
    exit 1
    ;;
  3)
    err "[spec-audit] no independent reviewer answered the 'adversarial-review' row."
    err "Run this same audit with a fresh-context agent of your own, and record it as"
    err "  spec-audit: claude-fallback (fresh context, NOT independent) …"
    err "(format-trailer.sh <mode> claude-fallback …). A completed but weaker audit,"
    err "never an independent one."
    exit 3
    ;;
  124)
    err "Error: every vendor in the chain timed out. The SPEC was NOT audited."
    exit 124
    ;;
  2)
    err "Error: the audit could not be dispatched (see above). It did NOT run."
    exit 2
    ;;
  *)
    err "Error: the 'adversarial-review' chain is exhausted. The SPEC was NOT audited."
    exit 1
    ;;
esac

# A vendor answered — which is NOT the same as an audit having happened. Without
# this, a slot that exits 0 having said nothing produced a silent pass, and the
# caller would build an APPROVING `spec-audit:` trailer out of it: byte-identical
# to a clean audit, on a SPEC nothing read. code-review.sh has guarded this since
# it was written; spec-audit.sh once did not, and the peer script's
# own header calls it "the highest-severity failure the contract guards".
#
# The accepted prefix set is PER ROUND, which matters more than it looks. Round 2
# asks for verdicts on prior findings, and `parse-review-output.sh` counts only
# `[concede]` / `[disagree]`. A round-2 reply that came back as `[must-fix]`
# would satisfy a shared prefix set, exit 0, and then parse as zero disagreements
# — i.e. CONSENSUS — silently converting a held finding into an approving SPEC
# sign-off. Round 2 therefore accepts verdicts only.
FINDING_COUNT=0
SENTINEL=$(grep -c '^NO_FINDINGS$' "$RAW_OUT" || true)

if [[ -n "$PUSHBACK_FILE" ]]; then
  # ROUND 2 has no clean-pass shape. Every pushback needs a verdict, and
  # `parse-review-output.sh` reports `verdict: consensus` when it counts zero
  # `[disagree]` lines — so "the reviewer said nothing" and "the reviewer
  # conceded everything" are the SAME input to it, and the second is an
  # approving SPEC trailer. `NO_FINDINGS` is therefore REJECTED here even though
  # round 1 accepts it: an unadjudicated pushback must fail loud rather than
  # pass quietly.
  FINDING_COUNT=$(grep -cE '^\[(concede|disagree)\]' "$RAW_OUT" || true)
  if [[ "${FINDING_COUNT:-0}" -eq 0 ]]; then
    err "Error: ${POLICY_CHAIN_VENDOR:-the reviewer} returned no [concede] / [disagree] verdict for round 2."
    if [[ "${SENTINEL:-0}" -gt 0 ]]; then
      err "It emitted NO_FINDINGS, which round 2 does NOT accept — a pushback round"
      err "with no verdicts would parse as consensus and approve the SPEC unread."
    fi
    err "Treating as a FAILED audit, not a clean pass. Raw output (first 2KB):"
    head -c 2048 "$RAW_OUT" >&2 || true
    exit 1
  fi
else
  # ROUND 1 does have a clean-pass shape: a SPEC with nothing wrong is a real
  # outcome, and the sentinel is what distinguishes it from a crash.
  FINDING_COUNT=$(grep -cE '^\[(must-fix|should-fix|nit)\]' "$RAW_OUT" || true)
  if [[ "${FINDING_COUNT:-0}" -eq 0 && "${SENTINEL:-0}" -eq 0 ]]; then
    err "Error: ${POLICY_CHAIN_VENDOR:-the reviewer} produced no findings and no NO_FINDINGS sentinel."
    err "Treating as a FAILED audit, not a clean pass. Raw output (first 2KB):"
    head -c 2048 "$RAW_OUT" >&2 || true
    exit 1
  fi
fi

# STDOUT CARRIES TRIAGE LINES ONLY. Printing the reviewer's raw stdout let
# commentary, a restated prompt, or a stray banner into the stream Claude parses
# — the same contract code-review.sh has always enforced by filtering rather
# than by asking nicely. Anything dropped is echoed to stderr, so an unparseable
# audit stays diagnosable instead of silently thinning.
while IFS= read -r line; do
  case "$line" in
    "[must-fix]"*|"[should-fix]"*|"[nit]"*|"[concede]"*|"[disagree]"*) printf '%s\n' "$line" ;;
    NO_FINDINGS|"") ;;
    *) err "[spec-audit] dropped non-triage line: $line" ;;
  esac
done < "$RAW_OUT"

if [[ "${FINDING_COUNT:-0}" -gt 0 ]]; then
  err "[spec-audit] complete — ${FINDING_COUNT} finding(s) from ${POLICY_CHAIN_VENDOR:-unknown}."
else
  err "[spec-audit] complete — audited clean (NO_FINDINGS) by ${POLICY_CHAIN_VENDOR:-unknown}."
fi
exit 0
