#!/usr/bin/env bash
# run-tests.sh — every `*.test.sh` in this folder, for a hand run. The close's
# verify.sh collects the same suites on its own, as it does for every folder
# under .agents/skills/, so this is not the only runner — it is the one a person
# types.
#
# Every suite runs in full even when an earlier one fails: a run that stops at
# the first red tells you about one suite, and the question at close time is
# how many are broken.
#
# Usage:
#   bash .agents/skills/review/run-tests.sh            # this folder
#   bash .agents/skills/review/run-tests.sh <dir>      # another folder (the test uses it)
#
# peers:
#   .agents/skills/review/run-tests.test.sh
#   .agents/skills/close/scripts/verify.sh
#
# Exit: 0 every suite passed · 1 one or more failed, or no suite found · 2 no such folder

set -uo pipefail

DIR="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
cd "$DIR" 2>/dev/null || { echo "run-tests: no such folder: $DIR" >&2; exit 2; }

failed=()
ran=0
for suite in ./*.test.sh; do
  [[ -f "$suite" ]] || continue
  ran=$((ran + 1))
  printf '── %s\n' "${suite#./}"
  bash "$suite" || failed+=("${suite#./}")
done

# A folder with no suites is a runner pointed at the wrong place, never a pass.
if [[ "$ran" -eq 0 ]]; then
  echo "run-tests: no *.test.sh in $DIR" >&2
  exit 1
fi
if [[ ${#failed[@]} -gt 0 ]]; then
  printf '\nFAILED (%d): %s\n' "${#failed[@]}" "${failed[*]}" >&2
  exit 1
fi
printf '\nreview: all %d suites passed\n' "$ran"
