#!/usr/bin/env bash
# parse-arg-mode.test.sh — peer of parse-arg-mode.sh. Run: bash parse-arg-mode.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/parse-arg-mode.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
run() { bash "$SUT" "$@" | tr '\n' '|'; }

t "no argument is blank"             "mode: blank|payload:|"                        "$(run)"
t "empty string is blank"            "mode: blank|payload:|"                        "$(run '')"
t "whitespace only is blank"         "mode: blank|payload:|"                        "$(run '   ')"
t "kebab slug is existing"           "mode: existing-slug|payload: checkout-flow|"  "$(run checkout-flow)"
t "padded slug is trimmed"           "mode: existing-slug|payload: checkout-flow|"  "$(run '  checkout-flow ')"
t "domain/slug is existing"          "mode: existing-slug|payload: web/checkout|"   "$(run web/checkout)"
t "one-word slug reads as create"    "mode: create|payload: billing|"               "$(run billing)"
t "freeform text is create"          "mode: create|payload: add a checkout retry|"  "$(run 'add a checkout retry')"
t "create verb"                      "mode: create|payload: a sync engine|"         "$(run 'create a sync engine')"
t "complete verb"                    "mode: complete|payload: sync-engine|"         "$(run 'complete sync-engine')"
t "update verb"                      "mode: update|payload: sync-engine|"           "$(run 'update sync-engine')"
t "a verb alone is not a verb"       "mode: create|payload: complete|"              "$(run complete)"
t "uppercase slug is not a slug"     "mode: create|payload: Checkout-Flow|"         "$(run Checkout-Flow)"
t "a slash with spaces is create"    "mode: create|payload: fix a/b split|"         "$(run 'fix a/b split')"

echo "parse-arg-mode.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
