#!/usr/bin/env bash
# write-audit-line.test.sh — peer of write-audit-line.sh. Run: bash write-audit-line.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/write-audit-line.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/write-audit-line-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
TODAY=$(date +%Y-%m-%d)
plan() { # plan <audit item text> → a plan.md in $tmp/specs/001-a
  mkdir -p "$tmp/specs/001-a"
  printf '# Plan\n\n## Constitution Check\n\n- @rule:boundary-inputs: PASS\n- %s\n\n## Project Structure\n' "$1" >"$tmp/specs/001-a/plan.md"
}
line() { grep '^- spec-audit:' "$tmp/specs/001-a/plan.md"; }
PH="spec-audit: [written by /spec-audit through write-audit-line.sh — leave this item in place]"

plan "$PH"
bash "$SUT" "$tmp/specs/001-a" "spec-audit: codex round-1; spirit MATCH"
t "a verdict replaces the placeholder" "- spec-audit: codex round-1; spirit MATCH" "$(line)"
t "the rest of plan.md is untouched" "- @rule:boundary-inputs: PASS" "$(grep '^- @rule' "$tmp/specs/001-a/plan.md")"

bash "$SUT" "$tmp/specs/001-a/" "spec-audit: skipped — non-material (wording-polish)"
t "non-material keeps a real verdict and notes the re-check" "- spec-audit: codex round-1; spirit MATCH; re-check $TODAY non-material" "$(line)"

bash "$SUT" "$tmp/specs/001-a" "spec-audit: skipped — non-material (typo)"
t "a second re-check replaces the first, never stacks" "- spec-audit: codex round-1; spirit MATCH; re-check $TODAY non-material" "$(line)"

bash "$SUT" "$tmp/specs/001-a" "spec-audit: custom round-2 (1 conceded, 0 escalated); spirit MATCH"
t "a new verdict replaces the old one and its re-check" "- spec-audit: custom round-2 (1 conceded, 0 escalated); spirit MATCH" "$(line)"

plan "$PH"
bash "$SUT" "$tmp/specs/001-a" "spec-audit: skipped — non-material (typo)"
t "non-material over the placeholder writes the skip" "- spec-audit: skipped — non-material (typo)" "$(line)"
bash "$SUT" "$tmp/specs/001-a" "spec-audit: skipped — non-material (link)"
t "non-material over a skip replaces it" "- spec-audit: skipped — non-material (link)" "$(line)"

plan "spec-audit: codex round-1; spirit MATCH"
bash "$SUT" "$tmp/specs/001-a" 'spec-audit: skipped — user authorized "just write it"'
t "a user-authorized skip replaces a verdict" '- spec-audit: skipped — user authorized "just write it"' "$(line)"

t "a line without the prefix is refused" "2" "$(bash "$SUT" "$tmp/specs/001-a" "codex round-1" >/dev/null 2>&1; echo $?)"
t "a doubled prefix is refused" "2" "$(bash "$SUT" "$tmp/specs/001-a" "spec-audit: spec-audit: codex round-1" >/dev/null 2>&1; echo $?)"
t "a folder with no plan.md is refused" "2" "$(bash "$SUT" "$tmp/nothing" "spec-audit: codex round-1; spirit MATCH" >/dev/null 2>&1; echo $?)"
printf '# Plan\n' >"$tmp/specs/001-a/plan.md"
t "a plan.md with no spec-audit item fails" "1" "$(bash "$SUT" "$tmp/specs/001-a" "spec-audit: codex round-1; spirit MATCH" >/dev/null 2>&1; echo $?)"
t "the failure says what is missing" "write-audit-line: no '- spec-audit:' item in $tmp/specs/001-a/plan.md — restore it from the plan template" "$(bash "$SUT" "$tmp/specs/001-a" "spec-audit: codex round-1; spirit MATCH" 2>&1)"

echo "write-audit-line.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
