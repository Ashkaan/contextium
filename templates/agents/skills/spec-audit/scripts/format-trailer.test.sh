#!/usr/bin/env bash
# format-trailer.test.sh — peer of format-trailer.sh. Run: bash format-trailer.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/format-trailer.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
run() { bash "$SUT" "$@" 2>/dev/null; }
rc() { bash "$SUT" "$@" >/dev/null 2>&1; echo $?; }

t "round-1"  "spec-audit: codex round-1; spirit MATCH" "$(run round-1 codex MATCH)"
t "round-2"  "spec-audit: codex round-2 (2 conceded, 1 escalated); spirit DRIFT" "$(run round-2 codex 2 1 DRIFT)"
t "fallback reviewer name" "spec-audit: claude-fallback round-1; spirit AMBIGUOUS" "$(run round-1 claude-fallback AMBIGUOUS)"
t "user skip keeps the quote verbatim" 'spec-audit: skipped — user authorized "just write it, I will review it"' "$(run skipped-user 'just write it, I will review it')"
t "a multi-line quote stays one line" 'spec-audit: skipped — user authorized "skip it for now"' "$(run skipped-user 'skip it
for now')"
t "non-material skip" "spec-audit: skipped — non-material (typo)" "$(run skipped-non-material typo)"

t "reviewer with a space is refused"   "1" "$(rc round-1 'co dex' MATCH)"
t "reviewer with a shell tail is refused" "1" "$(rc round-1 'codex; rm -rf' MATCH)"
t "uppercase reviewer is refused"     "1" "$(rc round-1 Codex MATCH)"
t "unknown spirit verdict is refused" "1" "$(rc round-1 codex PASS)"
t "unknown skip reason is refused"    "1" "$(rc skipped-non-material because)"
t "unknown mode is refused"           "1" "$(rc round-3 codex MATCH)"
t "round-2 without counts is refused" "1" "$(rc round-2 codex MATCH)"
t "no mode is refused"                "1" "$(rc)"
t "a refusal names the bad value" "error: invalid reviewer 'co dex' — expected the slot that answered, e.g. codex | custom | claude-fallback" "$(bash "$SUT" round-1 'co dex' MATCH 2>&1)"

echo "format-trailer.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
