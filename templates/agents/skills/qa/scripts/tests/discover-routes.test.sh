#!/usr/bin/env bash
# discover-routes.test.sh — fixture-driven tests for discover-routes.sh covering
# the route-mapping rows: index→/, nested index, dynamic/private/error
# exclusions, no-src-pages (exit 3), no-static-routes (exit 4), and the
# no-fabricated-root case (real about.astro, no index → /about, never /).
# Fixtures are temp src/pages/ trees — no network, no real repo.
#
# peers: ../discover-routes.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/discover-routes.sh"

pass=0; fail=0
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

mkrepo() { mktemp -d; }
touchp() { mkdir -p "$(dirname "$1")"; : > "$1"; }
# A bare top-level pages/ only counts as a route tree in a Next repo.
pkgnext() { printf '{"dependencies":{"next":"16"}}' > "$1/package.json"; }

# run → "RC|stdout|stderr"
run() {
  local repo="$1" out err rc=0
  err="$("$SCRIPT" "$repo" 2>&1 1>/tmp/dr-out.$$)" || rc=$?
  out="$(cat /tmp/dr-out.$$)"; rm -f /tmp/dr-out.$$
  printf '%s|%s|%s' "$rc" "$out" "$err"
}

# index.astro only → exactly "/"
r="$(mkrepo)"; touchp "$r/src/pages/index.astro"
got="$(run "$r")"
[[ "$got" == "0|/|"* ]] && ok "index → /" || no "index → /" "got: $got"

# nested blog/index.astro + blog/post.astro → /blog and /blog/post, sorted+deduped
r="$(mkrepo)"; touchp "$r/src/pages/blog/index.astro"; touchp "$r/src/pages/blog/post.astro"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == $'/blog\n/blog/post' ]] && ok "nested sorted" || no "nested sorted" "got: [$out]"

# dynamic [slug].astro → not emitted; stderr skipped-dynamic
r="$(mkrepo)"; touchp "$r/src/pages/index.astro"; touchp "$r/src/pages/[slug].astro"
got="$(run "$r")"
[[ "$got" == "0|/|"*"skipped-dynamic: src/pages/[slug].astro"* ]] \
  && ok "dynamic skipped" || no "dynamic skipped" "got: $got"

# private _partial.astro → not emitted; stderr skipped-private
r="$(mkrepo)"; touchp "$r/src/pages/index.astro"; touchp "$r/src/pages/_partial.astro"
got="$(run "$r")"
[[ "$got" == "0|/|"*"skipped-private: src/pages/_partial.astro"* ]] \
  && ok "private skipped" || no "private skipped" "got: $got"

# 404.astro → not emitted; stderr skipped-error
r="$(mkrepo)"; touchp "$r/src/pages/index.astro"; touchp "$r/src/pages/404.astro"
got="$(run "$r")"
[[ "$got" == "0|/|"*"skipped-error: src/pages/404.astro"* ]] \
  && ok "error skipped" || no "error skipped" "got: $got"

# no src/pages → exit 3, empty stdout, stderr no-src-pages
r="$(mkrepo)"
got="$(run "$r")"
[[ "$got" == "3||"*"no-src-pages"* ]] && ok "no-src-pages exit 3" || no "no-src-pages exit 3" "got: $got"

# src/pages with only [slug].astro → exit 4, empty stdout, stderr no-static-routes
r="$(mkrepo)"; touchp "$r/src/pages/[slug].astro"
got="$(run "$r")"
[[ "$got" == "4||"*"no-static-routes"* ]] && ok "no-static-routes exit 4" || no "no-static-routes exit 4" "got: $got"

# no index but real about.astro → emits /about, does NOT emit /
r="$(mkrepo)"; touchp "$r/src/pages/about.astro"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == "/about" ]] && ok "about no-root" || no "about no-root" "got: [$out]"

# ── Next App Router: app/ and src/app/, the DIRECTORY is the route ──

# app/page.tsx → /
r="$(mkrepo)"; touchp "$r/app/page.tsx"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == "/" ]] && ok "app-router root" || no "app-router root" "got: [$out]"

# route groups are organisational: (marketing)/page.tsx → /, (onboarding)/order → /order
r="$(mkrepo)"; touchp "$r/app/(marketing)/page.tsx"; touchp "$r/app/(onboarding)/order/page.tsx"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == $'/\n/order' ]] && ok "route groups stripped" || no "route groups stripped" "got: [$out]"

# dynamic [id] → skipped, never emitted as a literal bracket path
r="$(mkrepo)"; touchp "$r/app/page.tsx"; touchp "$r/app/post/[id]/page.tsx"
got="$(run "$r")"
[[ "$got" == "0|/|"*"skipped-dynamic: app/post/[id]/page.tsx"* ]] \
  && ok "app-router dynamic skipped" || no "app-router dynamic skipped" "got: $got"

# @slot parallel routes and _private folders are not standalone URLs
r="$(mkrepo)"; touchp "$r/app/page.tsx"; touchp "$r/app/@modal/page.tsx"
touchp "$r/app/_lib/page.tsx"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == "/" ]] && ok "app-router @slot + _private skipped" \
  || no "app-router @slot + _private skipped" "got: [$out]"

# src/app/ is walked too
r="$(mkrepo)"; touchp "$r/src/app/about/page.tsx"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == "/about" ]] && ok "src/app walked" || no "src/app walked" "got: [$out]"

# ── Next Pages Router: pages/, only when the repo IS Next ───────────

r="$(mkrepo)"; pkgnext "$r"; touchp "$r/pages/index.tsx"; touchp "$r/pages/about.tsx"
out="$("$SCRIPT" "$r" 2>/dev/null)"
[[ "$out" == $'/\n/about' ]] && ok "pages-router (next repo)" \
  || no "pages-router (next repo)" "got: [$out]"

# a bare pages/ in a NON-Next repo is a directory, not a route tree → exit 3
r="$(mkrepo)"; touchp "$r/pages/notes.md"
got="$(run "$r")"
[[ "$got" == "3||"*"no-src-pages"* ]] && ok "bare pages/ in non-next ignored" \
  || no "bare pages/ in non-next ignored" "got: $got"

# pages/api/* is an endpoint, not a page route
r="$(mkrepo)"; pkgnext "$r"; touchp "$r/pages/index.tsx"; touchp "$r/pages/api/hello.tsx"
got="$(run "$r")"
[[ "$got" == "0|/|"*"skipped-api: pages/api/hello.tsx"* ]] && ok "pages/api skipped" \
  || no "pages/api skipped" "got: $got"

echo
echo "discover-routes.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
