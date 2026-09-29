#!/usr/bin/env bash
# find-project.test.sh — peer of find-project.sh. Run: bash find-project.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/find-project.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/find-project-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"
# find-project.sh reads projects/ relative to the write root, which it asks
# session-write-root.sh for; CONTEXT_WRITE_ROOT points that at the fixture.
export CONTEXT_WRITE_ROOT="$tmp"
unset CLAUDE_SESSION_ID CLAUDE_CODE_SESSION_ID
cd "$tmp" || exit 1
run() { bash "$SUT" "$@" 2>&1; }

# With no projects/ folder there is no project to find: NOT_FOUND, exit 0,
# like any other miss (the caller parses stdout), and nothing on stderr.
t "no projects folder at all: NOT_FOUND, exit 0" "NOT_FOUND|rc=0" "$(bash "$SUT" checkout-flow 2>/dev/null | tr -d '\n'; printf '|rc=%s' "${PIPESTATUS[0]}")"
t "no projects folder at all: quiet on stderr" "" "$(bash "$SUT" checkout-flow 2>&1 >/dev/null)"

mkdir -p projects/web/2026-01-10_checkout-flow projects/web/2026-02-01_checkout-retries \
  projects/data/2026-01-05_sync-engine projects/web/2026-03-01_sync-engine

t "bare slug resolves" "PATH:projects/web/2026-01-10_checkout-flow" "$(run checkout-flow)"
t "qualified slug resolves" "PATH:projects/data/2026-01-05_sync-engine" "$(run data/sync-engine)"
# Which one is filesystem order (find is not sorted); the qualified form is how
# to pick.
two="$(run sync-engine)"
t "a slug in two domains resolves to one of them" "yes" "$([[ "$two" == "PATH:projects/data/2026-01-05_sync-engine" || "$two" == "PATH:projects/web/2026-03-01_sync-engine" ]] && echo yes)"
t "qualified form picks the other domain" "PATH:projects/web/2026-03-01_sync-engine" "$(run web/sync-engine)"
t "qualified form in the wrong domain" "NOT_FOUND" "$(run data/checkout-flow)"
t "partial slug suggests the slugs containing it" "NOT_FOUND:nearest: checkout-flow,checkout-retries" "$(run checkout)"
t "suggestions ignore case" "NOT_FOUND:nearest: checkout-flow,checkout-retries" "$(run CHECKOUT)"
t "a suffix of a slug is not a match" "NOT_FOUND:nearest: checkout-flow" "$(run flow)"
t "nothing close" "NOT_FOUND" "$(run billing)"
t "the input is a regex for suggestions" "NOT_FOUND:nearest: checkout-flow,checkout-retries" "$(run 'check.*')"
t "a domain name is not a project" "NOT_FOUND" "$(run web)"
t "missing argument exits non-zero" "1" "$(bash "$SUT" >/dev/null 2>&1; echo $?)"

mkdir -p projects/web/2026-04-01_a projects/web/2026-04-02_ab projects/web/2026-04-03_abc \
  projects/web/2026-04-04_abcd projects/web/2026-04-05_abcde projects/web/2026-04-06_abcdef
t "at most five suggestions" "5" "$(run 'b' | sed 's/^NOT_FOUND:nearest: //' | tr ',' '\n' | grep -c .)"

echo "find-project.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
