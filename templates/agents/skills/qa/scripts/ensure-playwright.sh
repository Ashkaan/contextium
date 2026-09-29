#!/usr/bin/env bash
# ensure-playwright.sh — find a Playwright with an installed Chromium, installing
# one on first use. Nothing installs Playwright ahead of time: a repo with no
# web app never pays for it.
#
# Usage:  ensure-playwright.sh [--app <dir>]
# Output: PLAYWRIGHT_MODULE=<absolute path of the playwright package>
# Exit:   0 ready · 4 unavailable — stderr carries one line,
#           `qa: skipped — Playwright unavailable (<reason>)`, which the caller
#           repeats to the user word for word · 2 usage error
#
# Order: the app's own `playwright` (resolved from --app, and only if it lives
# inside the app's repo), then the cache at $QA_PLAYWRIGHT_DIR (default
# ${XDG_CACHE_HOME:-~/.cache}/agents-qa/playwright). A module that resolves from
# outside those roots (a stray node_modules higher up the disk, NODE_PATH) is
# ignored: its version and browser are nobody's choice.
# A module without its browser gets `playwright install chromium` run through
# that same module's cli.js, because each Playwright version pins its own
# Chromium build. With neither, `npm install playwright` into the cache first.
# QA_NO_INSTALL=1 forbids every install (offline machines, CI).
#
# bash 3.2 compatible.
set -euo pipefail

APP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) [[ $# -gt 1 ]] || { echo "ensure-playwright: --app needs a directory" >&2; exit 2; }; APP="$2"; shift 2 ;;
    *) echo "ensure-playwright: unknown argument: $1" >&2; exit 2 ;;
  esac
done

CACHE="${QA_PLAYWRIGHT_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/agents-qa/playwright}"

skip() { echo "qa: skipped — Playwright unavailable ($1)" >&2; exit 4; }

command -v node >/dev/null 2>&1 || skip "node is not installed"

# probe <dir> <root> — prints "<module dir><TAB><ok|nobrowser>", or nothing when
# no playwright resolves from <dir> to a path inside <root>.
probe() {
  node -e '
    const path = require("path"), fs = require("fs");
    let pj;
    try { pj = fs.realpathSync(require.resolve("playwright/package.json", { paths: [process.argv[1]] })); }
    catch { process.exit(0); }
    const root = fs.realpathSync(process.argv[2]) + path.sep;
    if (!pj.startsWith(root)) process.exit(0);
    const dir = path.dirname(pj);
    let exe = "";
    try { exe = require(dir).chromium.executablePath(); } catch {}
    process.stdout.write(dir + "\t" + (exe && fs.existsSync(exe) ? "ok" : "nobrowser"));
  ' "$1" "$2" 2>/dev/null || true
}

# ready <probe output> — print the module line and exit 0 when the browser is
# there; install it when only the module is; return 1 when there is no module.
ready() {
  local line="$1" dir state
  [[ -n "$line" ]] || return 1
  dir="${line%%$'\t'*}"; state="${line#*$'\t'}"
  if [[ "$state" != "ok" ]]; then
    [[ "${QA_NO_INSTALL:-}" != "1" ]] || skip "Chromium is not installed and QA_NO_INSTALL=1"
    echo "qa: installing Chromium for Playwright (first use)…" >&2
    mkdir -p "$CACHE"
    node "$dir/cli.js" install chromium >"$CACHE/install.log" 2>&1 \
      || skip "playwright install chromium failed: $(tail -1 "$CACHE/install.log")"
    [[ "$(probe "$(dirname "$(dirname "$dir")")" "$dir")" == *$'\t'ok ]] \
      || skip "Chromium still missing after install"
  fi
  printf 'PLAYWRIGHT_MODULE=%s\n' "$dir"
  exit 0
}

if [[ -n "$APP" && -d "$APP" ]]; then
  APP_ROOT="$(git -C "$APP" rev-parse --show-toplevel 2>/dev/null || (cd "$APP" && pwd -P))"
  ready "$(probe "$APP" "$APP_ROOT")" || true
fi
[[ -d "$CACHE" ]] && { ready "$(probe "$CACHE" "$CACHE")" || true; }

[[ "${QA_NO_INSTALL:-}" != "1" ]] || skip "not installed and QA_NO_INSTALL=1"
command -v npm >/dev/null 2>&1 || skip "npm is not installed"
echo "qa: installing Playwright into $CACHE (first use)…" >&2
mkdir -p "$CACHE"
npm install --prefix "$CACHE" --no-audit --no-fund playwright >"$CACHE/install.log" 2>&1 \
  || skip "npm install playwright failed: $(tail -1 "$CACHE/install.log")"
ready "$(probe "$CACHE" "$CACHE")" || skip "npm install playwright left no module in $CACHE"
