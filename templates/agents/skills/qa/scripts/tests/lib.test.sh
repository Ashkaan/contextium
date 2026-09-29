#!/usr/bin/env bash
# lib.test.sh — pin the two pure helpers: route-slug + page
# resolution. Fixture-free, no server needed.
#
# peers: ../lib.sh

# shellcheck disable=SC2015,SC1091  # pass||fail assert idiom; ok() never fails
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=../lib.sh
source "$DIR/lib.sh"

pass=0; fail=0
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
eq() { [[ "$2" == "$3" ]] && ok "$1" || no "$1" "expected '$3' got '$2'"; }

# ── qa_slug_route ──
eq "slug root"        "$(qa_slug_route '/')"            "index"
eq "slug empty"       "$(qa_slug_route '')"             "index"
eq "slug plain"       "$(qa_slug_route 'projects')"     "projects"
eq "slug leading-sl"  "$(qa_slug_route '/apps')"        "apps"
eq "slug nested"      "$(qa_slug_route '/foo/bar')"     "foo_bar"
eq "slug query"       "$(qa_slug_route '/a?b=1')"       "a_b_1"
# distinct queries → distinct slugs (collision-free)
[[ "$(qa_slug_route '/a?b=1')" != "$(qa_slug_route '/a?b=2')" ]] \
  && ok "slug distinct-queries" || no "slug distinct-queries" "collided"

# length cap at 60
long="$(qa_slug_route "/$(printf 'x%.0s' {1..80})")"
[[ "${#long}" -le 60 ]] && ok "slug length-cap" || no "slug length-cap" "len=${#long}"

# ── qa_resolve_pages ──
eq "pages explicit"   "$(qa_resolve_pages 'a b' 'x y')" "a b"
eq "pages config"     "$(qa_resolve_pages '' 'x y')"    "x y"
eq "pages default"    "$(qa_resolve_pages '' '')"       "/"
eq "pages ws-only"    "$(qa_resolve_pages '   ' '')"    "/"

# ── qa_spawn_group: the child leads its own process group ──
# pgid_of_spawn [PATH] — spawn `sleep` through qa_spawn_group (under PATH when
# given) and print "<pid> <pgid>".
TMPL="$(mktemp -d)"
trap 'rm -rf "$TMPL"' EXIT
pgid_of_spawn() {
  local p pg
  p="$(PATH="${1:-$PATH}" bash -c 'source "$0"; qa_spawn_group sleep 5 >/dev/null 2>&1 & echo $!' "$DIR/lib.sh")"
  sleep 0.3
  pg="$(ps -o pgid= -p "$p" 2>/dev/null | tr -d ' ')"
  kill "$p" 2>/dev/null || true
  printf '%s %s' "$p" "$pg"
}
read -r sp sg <<<"$(pgid_of_spawn)"
eq "spawn-group leads its own group" "$sg" "$sp"
# macOS has no setsid: the perl path must do the same.
if command -v perl >/dev/null 2>&1; then
  mkdir -p "$TMPL/nosetsid"
  for t in bash perl sleep; do ln -s "$(command -v "$t")" "$TMPL/nosetsid/$t"; done
  read -r sp sg <<<"$(pgid_of_spawn "$TMPL/nosetsid")"
  eq "spawn-group without setsid (perl) leads its own group" "$sg" "$sp"
fi

# ── qa_playwright_node_modules: no copy on the machine → ensure-playwright.sh ──
# A PATH with node and no npm, a HOME with no npx cache, and a Playwright
# cache holding a fake module whose "browser" exists.
mkdir -p "$TMPL/pw/bin" "$TMPL/pw/home" "$TMPL/pw/cache/node_modules/playwright"
for t in bash node sed dirname mkdir tail cat git; do
  command -v "$t" >/dev/null 2>&1 && ln -s "$(command -v "$t")" "$TMPL/pw/bin/$t"
done
printf '{"name":"playwright","version":"0.0.0","main":"index.js"}\n' >"$TMPL/pw/cache/node_modules/playwright/package.json"
printf 'module.exports={chromium:{executablePath:()=>require("path").join(__dirname,"..",".browser")}};\n' \
  >"$TMPL/pw/cache/node_modules/playwright/index.js"
: >"$TMPL/pw/cache/node_modules/.browser"
got="$(PATH="$TMPL/pw/bin" HOME="$TMPL/pw/home" QA_PLAYWRIGHT_DIR="$TMPL/pw/cache" \
  bash -c 'source "$0"; qa_playwright_node_modules' "$DIR/lib.sh" 2>/dev/null)" || true
eq "playwright falls back to the first-use cache" "$got" "$TMPL/pw/cache/node_modules"
rc=0
err="$(PATH="$TMPL/pw/bin" HOME="$TMPL/pw/home" QA_PLAYWRIGHT_DIR="$TMPL/pw/empty" QA_NO_INSTALL=1 \
  bash -c 'source "$0"; qa_playwright_node_modules' "$DIR/lib.sh" 2>&1 >/dev/null)" || rc=$?
eq "no playwright and no install → returns 1" "$rc" "1"
[[ "$err" == *"qa: skipped — Playwright unavailable ("* ]] \
  && ok "no playwright → the skip line" || no "no playwright → the skip line" "got: $err"

# ── qa_playwright_node_modules APP: the app's own Playwright counts ──
# The machine has no Playwright anywhere (empty HOME, no npm, empty cache,
# installs forbidden); only the app does.
mkdir -p "$TMPL/app/repo/.git" "$TMPL/app/repo/apps/site/src" "$TMPL/app/browsers/chromium-9999"
# (a) a hoisted real-shaped copy at the repo root: browsers.json + an installed revision.
mkdir -p "$TMPL/app/repo/node_modules/playwright-core" "$TMPL/app/repo/node_modules/playwright"
printf '{"browsers":[{"name":"chromium","revision":"9999"}]}\n' >"$TMPL/app/repo/node_modules/playwright-core/browsers.json"
: >"$TMPL/app/browsers/chromium-9999/INSTALLATION_COMPLETE"
got="$(PATH="$TMPL/pw/bin" HOME="$TMPL/pw/home" QA_PLAYWRIGHT_DIR="$TMPL/pw/empty" QA_NO_INSTALL=1 \
  PLAYWRIGHT_BROWSERS_PATH="$TMPL/app/browsers" \
  bash -c 'source "$0"; qa_playwright_node_modules "$1"' "$DIR/lib.sh" "$TMPL/app/repo/apps/site" 2>/dev/null)" || true
eq "an app's own (hoisted) Playwright is found" "$got" "$TMPL/app/repo/node_modules"
got="$(PATH="$TMPL/pw/bin" HOME="$TMPL/pw/home" QA_PLAYWRIGHT_DIR="$TMPL/pw/empty" QA_NO_INSTALL=1 \
  PLAYWRIGHT_BROWSERS_PATH="$TMPL/app/browsers" \
  bash -c 'source "$0"; qa_playwright_node_modules' "$DIR/lib.sh" 2>/dev/null)" || true
eq "without the app, it is not looked at" "$got" ""
# (b) the app's module resolves only through ensure-playwright.sh --app (no browsers.json).
mkdir -p "$TMPL/app2/.git" "$TMPL/app2/node_modules/playwright"
cp "$TMPL/pw/cache/node_modules/playwright/package.json" "$TMPL/pw/cache/node_modules/playwright/index.js" "$TMPL/app2/node_modules/playwright/"
: >"$TMPL/app2/node_modules/.browser"
got="$(PATH="$TMPL/pw/bin" HOME="$TMPL/pw/home" QA_PLAYWRIGHT_DIR="$TMPL/pw/empty" QA_NO_INSTALL=1 \
  bash -c 'source "$0"; qa_playwright_node_modules "$1"' "$DIR/lib.sh" "$TMPL/app2" 2>/dev/null)" || true
eq "the app reaches ensure-playwright.sh as --app" "$got" "$TMPL/app2/node_modules"

echo
echo "lib.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
