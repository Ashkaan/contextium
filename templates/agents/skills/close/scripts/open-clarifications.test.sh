#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# open-clarifications.test.sh — peer of open-clarifications.sh.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/open-clarifications.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
run() { bash "$SUT" "$1" 2>&1; }
rc() { bash "$SUT" "$1" >/dev/null 2>&1; echo $?; }

# Empty folder: nothing open
mkdir -p "$tmp/empty"
t "empty folder prints nothing" "" "$(run "$tmp/empty")"
t "empty folder exits 0" "0" "$(rc "$tmp/empty")"

# A marker inside a one-line and a multi-line comment is ignored
mkdir -p "$tmp/comments"
printf '# Spec\n<!-- mark it [NEEDS CLARIFICATION: like this] -->\n<!--\n  Use [NEEDS CLARIFICATION: x] for open items\n-->\nBody.\n' >"$tmp/comments/spec.md"
t "comment markers ignored" "" "$(run "$tmp/comments")"
t "comment markers exit 0" "0" "$(rc "$tmp/comments")"

# Text after a comment closes on the same line IS read
mkdir -p "$tmp/after"
printf 'a <!-- note --> [NEEDS CLARIFICATION: after the comment]\n' >"$tmp/after/spec.md"
t "text after a closed comment is read" "spec.md:1: a  [NEEDS CLARIFICATION: after the comment]" "$(run "$tmp/after")"

# Markers in spec.md, plan.md, tasks.md with their own line numbers
mkdir -p "$tmp/all"
printf 'one\ntwo\n- FR-3: [NEEDS CLARIFICATION: auth method?]\n' >"$tmp/all/spec.md"
printf '**Testing**: NEEDS CLARIFICATION\n' >"$tmp/all/plan.md"
printf '<!--\nmulti\n-->\n\n- [ ] T001 [NEEDS CLARIFICATION: which file]\n' >"$tmp/all/tasks.md"
printf 'Decision: NEEDS CLARIFICATION resolved below\n' >"$tmp/all/research.md"
t "all three files, right lines" "spec.md:3: - FR-3: [NEEDS CLARIFICATION: auth method?]
plan.md:1: **Testing**: NEEDS CLARIFICATION
tasks.md:5: - [ ] T001 [NEEDS CLARIFICATION: which file]" "$(run "$tmp/all")"
t "markers exit 1" "1" "$(rc "$tmp/all")"

# research.md alone is never counted
mkdir -p "$tmp/research"
printf 'NEEDS CLARIFICATION\n' >"$tmp/research/research.md"
t "research.md not counted" "0" "$(rc "$tmp/research")"

# Usage
t "no argument is usage" "2" "$(bash "$SUT" >/dev/null 2>&1; echo $?)"
t "missing folder is usage" "2" "$(rc "$tmp/nope")"


# An unreadable file is an error, never "no markers"
mkdir -p "$tmp/unreadable"
printf '[NEEDS CLARIFICATION: hidden]\n' >"$tmp/unreadable/spec.md"
chmod 000 "$tmp/unreadable/spec.md"
if [[ -r "$tmp/unreadable/spec.md" ]]; then
  echo "SKIP: running as a user who can read mode-000 files"
else
  t "unreadable spec.md exits 2" "2" "$(rc "$tmp/unreadable")"
  case "$(run "$tmp/unreadable")" in *"cannot read"*) t "…and says so" ok ok ;; *) t "…and says so" "cannot read" "$(run "$tmp/unreadable")" ;; esac
fi
chmod 644 "$tmp/unreadable/spec.md"
mkdir -p "$tmp/dirnamed/spec.md"
t "a directory named spec.md exits 2" "2" "$(rc "$tmp/dirnamed")"

echo "open-clarifications.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
