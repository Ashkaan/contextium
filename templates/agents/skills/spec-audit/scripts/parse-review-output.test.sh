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
# field <input> <key> → the value of one `key:` line
field() { printf '%s' "$1" | bash "$SUT" 2>/dev/null | sed -n "s/^$2: //p"; }
rc() { printf '%s' "$1" | bash "$SUT" >/dev/null 2>&1; echo $?; }

ALL_CONCEDE='[concede] 1
[concede] 2'
MIXED='[concede] 1
[disagree] 2 the caller does not validate the value'
NOISE='Here are my verdicts:
**[concede] 1**
[concede] 1
2 [disagree] trailing prefix does not count'

t "every pushback conceded is consensus" "consensus" "$(field "$ALL_CONCEDE" verdict)"
t "consensus counts" "2 0" "$(field "$ALL_CONCEDE" concede-count) $(field "$ALL_CONCEDE" disagree-count)"
t "a disagreement escalates" "escalate" "$(field "$MIXED" verdict)"
t "escalate counts" "1 1" "$(field "$MIXED" concede-count) $(field "$MIXED" disagree-count)"
t "only line-anchored prefixes count" "1 0" "$(field "$NOISE" concede-count) $(field "$NOISE" disagree-count)"
t "verbatim lines follow the summary, concedes first" "[concede] 1|[disagree] 2 the caller does not validate the value" \
  "$(printf '%s' "$MIXED" | bash "$SUT" | sed -n '5,$p' | tr '\n' '|' | sed 's/|$//')"
t "a blank line separates the summary from the lines" "" "$(printf '%s' "$MIXED" | bash "$SUT" | sed -n '4p')"

# The parser counts what is there; it cannot tell a partial answer, or prose
# with no verdict at all, from agreement. The caller reads the counts against
# the number of pushbacks it sent.
t "no verdict lines at all reads as consensus with zero counts" "consensus 0 0" \
  "$(field 'I could not review this.' verdict) $(field 'I could not review this.' concede-count) $(field 'I could not review this.' disagree-count)"

t "empty input fails" "1" "$(rc '')"
t "empty input says why" "error: empty input" "$(printf '' | bash "$SUT" 2>&1 >/dev/null)"

echo "parse-review-output.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
