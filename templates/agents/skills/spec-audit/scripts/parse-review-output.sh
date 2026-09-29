#!/usr/bin/env bash
# parse-review-output.sh
#
# Parse review round-2 output for line-anchored [concede] and [disagree]
# verdicts. Round 2 fires only when the authoring agent pushed back on round-1
# findings; the reviewer returns one verdict per finding.
#
# Deterministic — grep + count + emit JSON-ish summary.
#
# Usage:
#   parse-review-output.sh < round-2-output.txt
#   cat round-2-output.txt | parse-review-output.sh
#
# Output (multi-line to stdout):
#   concede-count: <N>
#   disagree-count: <N>
#   verdict: consensus | escalate
#   <blank line>
#   [concede] <line 1>
#   [concede] <line 2>
#   [disagree] <line 1>
#   [disagree] <line 2>
#
# Caller uses:
#   - verdict=consensus → all disagreements resolved; emit round-2 trailer
#   - verdict=escalate  → ask the user about each [disagree] line
#
# Exit code: 0 if input parsed OK; 1 if input is empty.
#
# peers:
#   .agents/skills/spec-audit/scripts/parse-review-output.test.sh

set -euo pipefail

INPUT=$(cat)

if [ -z "$INPUT" ]; then
  echo "error: empty input" >&2
  exit 1
fi

CONCEDE_LINES=$(echo "$INPUT" | grep -E '^\[concede\]' || true)
DISAGREE_LINES=$(echo "$INPUT" | grep -E '^\[disagree\]' || true)

if [ -z "$CONCEDE_LINES" ]; then
  CONCEDE_COUNT=0
else
  CONCEDE_COUNT=$(echo "$CONCEDE_LINES" | wc -l | tr -d ' ')
fi

if [ -z "$DISAGREE_LINES" ]; then
  DISAGREE_COUNT=0
else
  DISAGREE_COUNT=$(echo "$DISAGREE_LINES" | wc -l | tr -d ' ')
fi

if [ "$DISAGREE_COUNT" -eq 0 ]; then
  VERDICT="consensus"
else
  VERDICT="escalate"
fi

echo "concede-count: $CONCEDE_COUNT"
echo "disagree-count: $DISAGREE_COUNT"
echo "verdict: $VERDICT"
echo

if [ -n "$CONCEDE_LINES" ]; then
  echo "$CONCEDE_LINES"
fi

if [ -n "$DISAGREE_LINES" ]; then
  echo "$DISAGREE_LINES"
fi

exit 0
