#!/usr/bin/env bash
# playwright-app.test.sh — screenshot.sh and interaction-check.sh hand the target
# app to the Playwright lookup, so an app that ships its own Playwright is used
# when the machine has none. The app's copy here is a stub with an "installed"
# browser revision: the capture then fails on the stub (any exit but 2 or 7),
# where a lookup that ignored the app reports `Playwright unavailable` (exit 7)
# and a caller without the flag refuses it (exit 2).
#
# Run: bash .agents/skills/qa/scripts/tests/playwright-app.test.sh
#
# peers:
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/screenshot.sh
#   .agents/skills/qa/scripts/interaction-check.sh

set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pw-app-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/home" "$TMP/browsers/chromium-9999"
for tool in bash node sed dirname mkdir tail cat cut tr cksum basename; do
  p="$(command -v "$tool" 2>/dev/null)" && ln -s "$p" "$TMP/bin/$tool"
done
APP="$TMP/repo/apps/site"
mkdir -p "$TMP/repo/.git" "$APP" "$TMP/repo/node_modules/playwright-core" "$TMP/repo/node_modules/playwright"
printf '{"browsers":[{"name":"chromium","revision":"9999"}]}\n' >"$TMP/repo/node_modules/playwright-core/browsers.json"
: >"$TMP/browsers/chromium-9999/INSTALLATION_COMPLETE"

env_run() {
  PATH="$TMP/bin" HOME="$TMP/home" QA_NO_INSTALL=1 QA_PLAYWRIGHT_DIR="$TMP/empty" \
    PLAYWRIGHT_BROWSERS_PATH="$TMP/browsers" QA_DONE_DIR="$TMP/done" "$@"
}
shot() { env_run bash "$DIR/screenshot.sh" --url http://127.0.0.1:9 --repo-slug s --run-id "r$$" --pages / --no-motion "$@" >"$TMP/out" 2>&1; echo $?; }
inter() { env_run bash "$DIR/interaction-check.sh" --url http://127.0.0.1:9 --pages / "$@" >"$TMP/out" 2>&1; echo $?; }

t "screenshot without --app: no Playwright is exit 7" "7" "$(shot)"
t "screenshot with --app: the app's copy is used (not exit 2 or 7)" "yes" "$(rc="$(shot --app "$APP")"; [[ "$rc" != 7 && "$rc" != 2 ]] && echo yes || echo "no (rc=$rc: $(head -3 "$TMP/out"))")"
t "interaction-check with --repo: the app's copy is used (not exit 2 or 7)" "yes" "$(rc="$(inter --repo "$APP")"; [[ "$rc" != 7 && "$rc" != 2 ]] && echo yes || echo "no (rc=$rc: $(head -3 "$TMP/out"))")"
rm -rf "/tmp/qa-shots/s/r$$"

echo "playwright-app.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
