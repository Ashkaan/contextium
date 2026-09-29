#!/usr/bin/env bash
# a11y.test.sh — the first-use install of a11y.sh and its lock, on a machine
# with no `flock` (macOS). npm is a stub; nothing is downloaded, and the axe run
# itself is not exercised (it needs a real browser).
#
# Run: bash .agents/skills/qa/scripts/tests/a11y.test.sh
#
# peers:
#   .agents/skills/qa/scripts/a11y.sh

set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/a11y.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/a11y-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home"
for tool in bash sed tr cksum cut mkdir rmdir sleep dirname; do
  ln -s "$(command -v "$tool")" "$TMP/bin/$tool"
done
# node fails on purpose: the install is what is under test, not the axe run.
printf '#!/usr/bin/env bash\nexit 1\n' >"$TMP/bin/node"; chmod +x "$TMP/bin/node"
CACHE="$TMP/home/.local/lib/qa-a11y"

stub_npm() { printf '#!/usr/bin/env bash\n%s\n' "$1" >"$TMP/bin/npm"; chmod +x "$TMP/bin/npm"; }
run() { PATH="$TMP/bin" HOME="$TMP/home" bash "$SUT" --url http://localhost:1 --pages / >/dev/null 2>"$TMP/err"; echo $?; }

# 1. npm fails: exit 8, and the lock is released.
stub_npm 'exit 1'
t "a failed install is exit 8" "8" "$(run)"
t "the failed install says so" "1" "$(grep -c 'could not install @axe-core/playwright' "$TMP/err")"
t "the lock is released after a failure" "no" "$([[ -d "$CACHE.lockdir" ]] && echo yes || echo no)"

# 1b. QA_NO_INSTALL=1: no npm call at all, exit 8, said plainly.
# shellcheck disable=SC2016  # expands inside the stub, not here
stub_npm 'echo "$*" >>"$HOME/npm-called"; exit 1'
t "QA_NO_INSTALL=1 is exit 8" "8" "$(PATH="$TMP/bin" HOME="$TMP/home" QA_NO_INSTALL=1 bash "$SUT" --url http://localhost:1 --pages / >/dev/null 2>"$TMP/err"; echo $?)"
t "QA_NO_INSTALL=1 never calls npm" "no" "$([[ -f "$TMP/home/npm-called" ]] && echo yes || echo no)"
t "QA_NO_INSTALL=1 says why" "1" "$(grep -c 'QA_NO_INSTALL=1' "$TMP/err")"

# 2. npm succeeds: the packages land in the cache, and the lock is released.
stub_npm 'mkdir -p node_modules/@axe-core/playwright; echo "$*" >>../npm-calls'
run >/dev/null
t "the install lands in the cache" "yes" "$([[ -d "$CACHE/node_modules/@axe-core/playwright" ]] && echo yes || echo no)"
t "npm was asked for axe and playwright" "install --no-save --silent @axe-core/playwright playwright" "$(cat "$TMP/home/.local/lib/npm-calls" 2>/dev/null)"
t "the lock is released after success" "no" "$([[ -d "$CACHE.lockdir" ]] && echo yes || echo no)"

# 3. Installed already: npm is not called again.
: >"$TMP/home/.local/lib/npm-calls"
run >/dev/null
t "a second run does not reinstall" "" "$(cat "$TMP/home/.local/lib/npm-calls")"

echo "a11y.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
