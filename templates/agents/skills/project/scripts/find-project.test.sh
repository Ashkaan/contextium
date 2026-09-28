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
cd "$tmp" || exit 1
run() { bash "$SUT" "$@" 2>&1; }

t "no projects folder at all" "NOT_FOUND" "$(run checkout-flow)"

mkdir -p projects/web/2026-01-10_checkout-flow projects/web/2026-02-01_checkout-retries \
  projects/data/2026-01-05_sync-engine projects/web/2026-03-01_sync-engine

t "bare slug resolves" "PATH:projects/web/2026-01-10_checkout-flow" "$(run checkout-flow)"
t "qualified slug resolves" "PATH:projects/data/2026-01-05_sync-engine" "$(run data/sync-engine)"
t "a slug in two domains takes the first in path order" "PATH:projects/data/2026-01-05_sync-engine" "$(run sync-engine)"
t "qualified form picks the other domain" "PATH:projects/web/2026-03-01_sync-engine" "$(run web/sync-engine)"
t "qualified form in the wrong domain" "NOT_FOUND" "$(run data/checkout-flow)"
t "partial slug suggests the slugs containing it" "NOT_FOUND:nearest: checkout-flow,checkout-retries" "$(run checkout)"
t "suggestions ignore case" "NOT_FOUND:nearest: checkout-flow,checkout-retries" "$(run CHECKOUT)"
t "a suffix of a slug is not a match" "NOT_FOUND:nearest: checkout-flow" "$(run flow)"
t "nothing close" "NOT_FOUND" "$(run billing)"
t "regex characters are literal" "NOT_FOUND" "$(run 'check.*')"
t "a domain name is not a project" "NOT_FOUND" "$(run web)"
t "missing argument exits non-zero" "1" "$(bash "$SUT" >/dev/null 2>&1; echo $?)"

mkdir -p projects/web/2026-04-01_a projects/web/2026-04-02_ab projects/web/2026-04-03_abc \
  projects/web/2026-04-04_abcd projects/web/2026-04-05_abcde projects/web/2026-04-06_abcdef
t "at most five suggestions" "5" "$(run 'b' | sed 's/^NOT_FOUND:nearest: //' | tr ',' '\n' | grep -c .)"

echo "find-project.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
