#!/usr/bin/env bash
# ensure-playwright.test.sh — peer of ensure-playwright.sh. Offline: every
# Playwright here is a fake module, and npm is a stub on PATH.
# Run: bash .agents/skills/qa/scripts/tests/ensure-playwright.test.sh
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/ensure-playwright.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/ensure-pw-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
tmp="$(cd "$tmp" && pwd -P)"

# fake_pw <node_modules dir> — a playwright whose chromium lives at
# <node_modules>/.browser, and whose cli.js "installs" it by touching that file.
fake_pw() {
  mkdir -p "$1/playwright"
  printf '{"name":"playwright","version":"0.0.0","main":"index.js"}\n' >"$1/playwright/package.json"
  printf 'module.exports={chromium:{executablePath:()=>require("path").join(__dirname,"..",".browser")}};\n' >"$1/playwright/index.js"
  printf 'require("fs").appendFileSync(__dirname+"/../cli-calls",process.argv.slice(2).join(" ")+"\\n");require("fs").writeFileSync(__dirname+"/../.browser","");\n' >"$1/playwright/cli.js"
}

# A PATH holding node, the core tools, and a stub npm.
mkdir -p "$tmp/bin"
for tool in bash dirname mkdir tail cat rm; do ln -sf "$(command -v "$tool")" "$tmp/bin/$tool"; done
ln -sf "$(command -v node)" "$tmp/bin/node"
stub_npm() { printf '#!/usr/bin/env bash\n%s\n' "$1" >"$tmp/bin/npm"; chmod +x "$tmp/bin/npm"; }
run() { PATH="$tmp/bin" bash "$SUT" "$@" 2>&1; echo "rc=$?"; }

# 1. The app already has Playwright and its browser.
mkdir -p "$tmp/app1/node_modules"; fake_pw "$tmp/app1/node_modules"; : >"$tmp/app1/node_modules/.browser"
t "the app's own Playwright is used" "$(printf 'PLAYWRIGHT_MODULE=%s\nrc=0' "$tmp/app1/node_modules/playwright")" \
  "$(QA_PLAYWRIGHT_DIR="$tmp/cache1" run --app "$tmp/app1")"

# 2. The module is there, the browser is not: install chromium with THAT module's cli.
mkdir -p "$tmp/app2/node_modules"; fake_pw "$tmp/app2/node_modules"
t "a missing browser is installed by the same module" "$(printf 'PLAYWRIGHT_MODULE=%s\nrc=0' "$tmp/app2/node_modules/playwright")" \
  "$(QA_PLAYWRIGHT_DIR="$tmp/cache2" run --app "$tmp/app2" | grep -v '^qa: ')"
t "the cli was asked for chromium" "install chromium" "$(cat "$tmp/app2/node_modules/cli-calls" 2>/dev/null)"

# 3. Nothing anywhere and installing is switched off.
mkdir -p "$tmp/app3"
out="$(QA_NO_INSTALL=1 QA_PLAYWRIGHT_DIR="$tmp/cache3" run --app "$tmp/app3")"
t "QA_NO_INSTALL exits 4" "rc=4" "$(tail -1 <<<"$out")"
t "and says it plainly" "1" "$(grep -c '^qa: skipped — Playwright unavailable (' <<<"$out")"

# 3b. A Playwright above the app's root is somebody else's and is ignored.
mkdir -p "$tmp/outer/node_modules" "$tmp/outer/app"; fake_pw "$tmp/outer/node_modules"; : >"$tmp/outer/node_modules/.browser"
t "a module outside the app's root is not used" "rc=4" \
  "$(QA_NO_INSTALL=1 QA_PLAYWRIGHT_DIR="$tmp/cache3" run --app "$tmp/outer/app" | tail -1)"

# 4. Nothing anywhere and npm fails (offline).
stub_npm 'echo "npm ERR! network unreachable" >&2; exit 1'
out="$(QA_PLAYWRIGHT_DIR="$tmp/cache4" run --app "$tmp/app3")"
t "a failed npm install exits 4" "rc=4" "$(tail -1 <<<"$out")"
t "the skip line carries npm's reason" "1" "$(grep -c '^qa: skipped — Playwright unavailable (.*network unreachable' <<<"$out")"

# 5. Nothing anywhere; npm installs into the cache, then chromium is installed.
stub_npm "$(declare -f fake_pw); prefix=\"\"; while [[ \$# -gt 0 ]]; do [[ \$1 == --prefix ]] && prefix=\$2; shift; done; mkdir -p \"\$prefix/node_modules\"; fake_pw \"\$prefix/node_modules\""
t "first use installs into the cache" "$(printf 'PLAYWRIGHT_MODULE=%s\nrc=0' "$tmp/cache5/node_modules/playwright")" \
  "$(QA_PLAYWRIGHT_DIR="$tmp/cache5" run --app "$tmp/app3" | grep -v '^qa: ')"
t "the second use finds the cache without npm" "$(printf 'PLAYWRIGHT_MODULE=%s\nrc=0' "$tmp/cache5/node_modules/playwright")" \
  "$(stub_npm 'exit 1'; QA_PLAYWRIGHT_DIR="$tmp/cache5" run --app "$tmp/app3")"

# 6. No node at all.
mkdir -p "$tmp/nonode"; ln -sf "$(command -v bash)" "$tmp/nonode/bash"
t "no node exits 4" "4" "$(PATH="$tmp/nonode" bash "$SUT" --app "$tmp/app3" >/dev/null 2>&1; echo $?)"
t "an unknown flag is exit 2" "2" "$(bash "$SUT" --wat >/dev/null 2>&1; echo $?)"

echo "ensure-playwright.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
