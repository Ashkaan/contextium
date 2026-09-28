#!/usr/bin/env bash
# parse-review-output.sh — read round-2 verdicts and decide consensus vs escalate.
#
# Round 2 fires only when the author pushed back on round-1 findings. The
# reviewer returns one verdict per finding; this counts them so the decision is
# arithmetic rather than a judgment call about "did we mostly agree".
#
# USAGE
#   spec-review.sh <spec> <brief> <pushback> | parse-review-output.sh --expected <N>
#
# <N> is how many findings you pushed back on. Every one of them needs a verdict.
# Without the count, a reviewer that concedes one pushback and silently ignores a
# second reads as full consensus, and the unresolved disagreement disappears —
# which is the opposite of what this round exists to surface.
#
# OUTPUT (stdout)
#   concede-count: <N>
#   disagree-count: <N>
#   expected-count: <N>
#   distinct-ids-answered: <N>
#   unadjudicated: <ids with no verdict>   (only when some are missing)
#   verdict: consensus | escalate | incomplete
#   <blank line>
#   [concede] ...
#   [disagree] ...
#
# The caller uses:
#   verdict: consensus  → every pushback conceded; write the round-2 line
#   verdict: escalate   → ask the user about each [disagree] line
#   verdict: incomplete → fewer verdicts than pushbacks. Do NOT treat as
#                         agreement; re-run the round, and escalate what is still
#                         unadjudicated if it fails again.
#
# EXIT: 0 if the input parsed; 1 if the input was empty or held no verdicts (a
# crashed reviewer round must not read as agreement); 2 on a usage error.
#
# peers:
#   .agents/skills/spec-audit/scripts/parse-review-output.test.sh
#   .agents/scripts/spec-review.sh  (the round-2 output format)

set -euo pipefail

EXPECTED=""
while [ $# -gt 0 ]; do
  case "$1" in
    --expected) EXPECTED="${2:-}"; shift 2 ;;
    *) echo "usage: parse-review-output.sh [--expected <N>]" >&2; exit 2 ;;
  esac
done

if [ -n "$EXPECTED" ] && ! printf '%s' "$EXPECTED" | grep -qE '^[0-9]+$'; then
  echo "error: --expected takes a number, got '${EXPECTED}'" >&2
  exit 2
fi

INPUT="$(cat)"

if [ -z "$INPUT" ]; then
  echo "error: empty input — a round with no verdicts is a failed round, not consensus" >&2
  exit 1
fi

CONCEDE_LINES="$(grep -E '^\[concede\]' <<<"$INPUT" || true)"
DISAGREE_LINES="$(grep -E '^\[disagree\]' <<<"$INPUT" || true)"

if [ -z "$CONCEDE_LINES" ]; then
  CONCEDE_COUNT=0
else
  CONCEDE_COUNT="$(grep -c . <<<"$CONCEDE_LINES")"
fi

if [ -z "$DISAGREE_LINES" ]; then
  DISAGREE_COUNT=0
else
  DISAGREE_COUNT="$(grep -c . <<<"$DISAGREE_LINES")"
fi

if [ "$CONCEDE_COUNT" -eq 0 ] && [ "$DISAGREE_COUNT" -eq 0 ]; then
  echo "error: the round produced no [concede] or [disagree] lines — treat as a failed round" >&2
  exit 1
fi

TOTAL=$((CONCEDE_COUNT + DISAGREE_COUNT))

# Counting lines is not enough. Two verdicts both labelled `1` satisfy a count of
# two while pushback 2 was never adjudicated, which is the same false consensus
# the count was added to prevent — so match the IDS, not the total. Each of
# 1..EXPECTED needs exactly one verdict, and an id outside that range means the
# reviewer answered something nobody asked about.
ANSWERED_IDS="$(printf '%s\n%s\n' "$CONCEDE_LINES" "$DISAGREE_LINES" \
  | sed -nE 's/^\[(concede|disagree)\][[:space:]]+([0-9]+).*/\2/p' | sort -n)"
UNIQUE_IDS="$(printf '%s' "$ANSWERED_IDS" | grep -c . || true)"
[ -n "$ANSWERED_IDS" ] && UNIQUE_IDS="$(printf '%s\n' "$ANSWERED_IDS" | sort -nu | grep -c . || true)"

MISSING=""
if [ -n "$EXPECTED" ]; then
  i=1
  while [ "$i" -le "$EXPECTED" ]; do
    printf '%s\n' "$ANSWERED_IDS" | grep -qx "$i" || MISSING="${MISSING}${i} "
    i=$((i + 1))
  done
fi

if [ -n "$EXPECTED" ] && { [ -n "$MISSING" ] || [ "$TOTAL" -lt "$EXPECTED" ]; }; then
  # Partial adjudication. Reporting this as consensus would drop whichever
  # pushbacks the reviewer never answered, and those are exactly the ones still
  # in dispute.
  VERDICT="incomplete"
elif [ "$DISAGREE_COUNT" -eq 0 ]; then
  VERDICT="consensus"
else
  VERDICT="escalate"
fi

echo "concede-count: $CONCEDE_COUNT"
echo "disagree-count: $DISAGREE_COUNT"
if [ -n "$EXPECTED" ]; then
  echo "expected-count: $EXPECTED"
  echo "distinct-ids-answered: $UNIQUE_IDS"
  if [ -n "$MISSING" ]; then echo "unadjudicated: ${MISSING% }"; fi
fi
echo "verdict: $VERDICT"
echo

# `[ -n "$x" ] && printf ...` looks equivalent and is not: under `set -e` the
# whole line returns 1 when the test is false, and as the last statement before
# `exit 0` that kills the script with status 1 on the ordinary case where one of
# the two lists is empty.
if [ -n "$CONCEDE_LINES" ]; then printf '%s\n' "$CONCEDE_LINES"; fi
if [ -n "$DISAGREE_LINES" ]; then printf '%s\n' "$DISAGREE_LINES"; fi

exit 0
