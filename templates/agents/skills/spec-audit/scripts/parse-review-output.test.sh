#!/usr/bin/env bash
# parse-review-output.test.sh — peer of parse-review-output.sh.
# Run: bash parse-review-output.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/parse-review-output.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
# field <input> <key> [args...] → the value of one `key:` line
field() { local in="$1" key="$2"; shift 2; printf '%s' "$in" | bash "$SUT" "$@" 2>/dev/null | sed -n "s/^$key: //p"; }
rc() { local in="$1"; shift; printf '%s' "$in" | bash "$SUT" "$@" >/dev/null 2>&1; echo $?; }

ALL_CONCEDE='[concede] 1
[concede] 2'
MIXED='[concede] 1
[disagree] 2 the caller does not validate the value'
ONE_OF_TWO='[concede] 1'
DUP='[concede] 1
[concede] 1'
NOISE='Here are my verdicts:
**[concede] 1**
[concede] 1
2 [disagree] trailing prefix does not count'

t "every pushback conceded is consensus" "consensus" "$(field "$ALL_CONCEDE" verdict --expected 2)"
t "a disagreement escalates" "escalate" "$(field "$MIXED" verdict --expected 2)"
t "escalate counts" "1 1" "$(field "$MIXED" concede-count --expected 2) $(field "$MIXED" disagree-count --expected 2)"
t "fewer verdicts than pushbacks is incomplete" "incomplete" "$(field "$ONE_OF_TWO" verdict --expected 2)"
t "incomplete names the missing pushback" "2" "$(field "$ONE_OF_TWO" unadjudicated --expected 2)"
t "two verdicts for one id are not two answers" "incomplete" "$(field "$DUP" verdict --expected 2)"
t "duplicate ids count once" "1" "$(field "$DUP" distinct-ids-answered --expected 2)"
t "without --expected, a partial answer reads as consensus" "consensus" "$(field "$ONE_OF_TWO" verdict)"
t "only line-anchored prefixes count" "1 0" "$(field "$NOISE" concede-count) $(field "$NOISE" disagree-count)"
t "verbatim lines follow the summary" "[disagree] 2 the caller does not validate the value" "$(printf '%s' "$MIXED" | bash "$SUT" --expected 2 | tail -1)"

t "empty input fails" "1" "$(rc '' --expected 1)"
t "input with no verdicts fails" "1" "$(rc 'I could not review this.' --expected 1)"
t "a non-number --expected is a usage error" "2" "$(rc "$ALL_CONCEDE" --expected two)"
t "an unknown flag is a usage error" "2" "$(rc "$ALL_CONCEDE" --strict)"

echo "parse-review-output.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
