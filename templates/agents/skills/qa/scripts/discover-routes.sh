#!/usr/bin/env bash
# discover-routes.sh — enumerate a repo's static routes by walking its
# file-based routing directories, so /qa never carries a tracked page list (the
# user's point: "the number of pages will change, why track it?"). File-based
# routing IS the route SSOT for both frameworks /qa serves, so a filesystem walk
# is data, not judgment, and it can never drift the
# way a hand-maintained list does.
#
# Two routing dialects, both walked (a repo may have either or both):
#   pages-router  src/pages/ (Astro) and pages/ (Next Pages Router, only when the
#                 repo is Next — a bare pages/ of markdown in a non-Next repo is
#                 not a route tree). The FILE is the route.
#   app-router    app/ and src/app/ (Next App Router). The DIRECTORY containing a
#                 `page.*` file is the route; `(group)` segments are organisational
#                 and do NOT appear in the URL; `@slot` segments are parallel
#                 routes, not standalone URLs.
#
# This NEVER synthesizes a route: `/` is emitted only when a
# real root page file exists, and a repo with no static routes HALTs rather than
# inventing one. Dynamic segments (`[id]`, `[...slug]`) are skipped rather than
# emitted as a literal bracket path — there is no param value to pick.
#
# peers:
#   .agents/skills/qa/scripts/detect-app.sh
#   .agents/skills/qa/scripts/tests/discover-routes.test.sh
#
# Usage:   discover-routes.sh <repo-dir>
# Output:  one route per line on stdout, sorted + de-duplicated, no trailing
#          slash (`/`, `/blog`, `/blog/post`). Diagnostic `skipped-*:` lines on
#          stderr for files the framework's semantics exclude.
# Exit:    0 routes emitted; 2 usage; 3 no routing dir at all (no-src-pages on
#          stderr); 4 routing dir(s) present but zero static routes
#          (no-static-routes).

set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" || ! -d "$REPO" ]]; then
  echo "usage: discover-routes.sh <repo-dir>" >&2
  exit 2
fi

routes=()
roots_found=()

# is_next_repo — a bare top-level `pages/` is only a route tree in a Next repo;
# elsewhere it is just a directory of files. next.config.* or a `next` dependency
# is the evidence (same signal detect-app.sh uses).
is_next_repo() {
  local f
  for f in "$REPO"/next.config.*; do
    [[ -e "$f" ]] && return 0
  done
  [[ -f "$REPO/package.json" ]] || return 1
  node -e '
    const fs = require("fs");
    let hit = "";
    try {
      const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const all = Object.assign({}, p.dependencies, p.devDependencies);
      if (all.next) hit = "yes";
    } catch {}
    process.stdout.write(hit);
  ' "$REPO/package.json" 2>/dev/null | grep -q yes
}

# walk_pages_router ROOT LABEL — the file IS the route (Astro, Next Pages Router).
walk_pages_router() {
  local root="$1" label="$2" f rel base name dir
  while IFS= read -r -d '' f; do
    rel="${f#"$root/"}"
    base="$(basename "$rel")"
    name="${base%.*}"          # strip the extension
    dir="$(dirname "$rel")"    # "." for a top-level file

    # ── exclusions (diagnosed on stderr, never emitted) ──
    # Private: any path segment starting with `_` (component/partial, and Next's
    # _app / _document).
    case "/$rel" in
      */_*) echo "skipped-private: $label/$rel" >&2; continue ;;
    esac
    # Dynamic: any `[param]` / `[...slug]` segment — no param value to pick.
    case "$rel" in
      *"["*) echo "skipped-dynamic: $label/$rel" >&2; continue ;;
    esac
    # API endpoints are not pages.
    case "$rel" in
      api/*) echo "skipped-api: $label/$rel" >&2; continue ;;
    esac
    # Error pages render only on a real 404/500, not as a shootable route.
    if [[ "$name" == "404" || "$name" == "500" ]]; then
      echo "skipped-error: $label/$rel" >&2
      continue
    fi
    # Unreadable file: skip loudly, keep walking.
    if [[ ! -r "$f" ]]; then
      echo "skipped-unreadable: $label/$rel" >&2
      continue
    fi

    # ── route mapping ──
    if [[ "$name" == "index" ]]; then
      # index.* maps to its parent route; top-level index.* IS the root `/`.
      if [[ "$dir" == "." ]]; then
        routes+=("/")
      else
        routes+=("/$dir")
      fi
    else
      if [[ "$dir" == "." ]]; then
        routes+=("/$name")
      else
        routes+=("/$dir/$name")
      fi
    fi
  done < <(find "$root" -type f \
    \( -name '*.astro' -o -name '*.md' -o -name '*.mdx' -o -name '*.html' \
       -o -name '*.tsx' -o -name '*.jsx' \) -print0)
}

# walk_app_router ROOT LABEL — the DIRECTORY holding a `page.*` file is the route
# (Next App Router). `(group)` segments are stripped from the URL; `@slot`
# (parallel route) and `_private` segments are not standalone URLs.
walk_app_router() {
  local root="$1" label="$2" f rel dir seg url skip
  while IFS= read -r -d '' f; do
    rel="${f#"$root/"}"
    dir="$(dirname "$rel")"

    if [[ ! -r "$f" ]]; then
      echo "skipped-unreadable: $label/$rel" >&2
      continue
    fi

    url=""
    skip=""
    if [[ "$dir" != "." ]]; then
      local IFS_SAVE="$IFS"
      IFS='/'
      # shellcheck disable=SC2206  # deliberate word-split on the path separator
      local segs=($dir)
      IFS="$IFS_SAVE"
      for seg in ${segs[@]+"${segs[@]}"}; do
        case "$seg" in
          # Dynamic: no param value to pick — never emit a literal `[id]` path.
          *"["*) skip="dynamic"; break ;;
          # Parallel-route slot: rendered INTO another route, not its own URL.
          @*) skip="parallel"; break ;;
          # Private folder: excluded from routing by Next.
          _*) skip="private"; break ;;
          # Route group: organisational only, absent from the URL.
          "("*")") ;;
          *) url="$url/$seg" ;;
        esac
      done
    fi

    if [[ -n "$skip" ]]; then
      echo "skipped-$skip: $label/$rel" >&2
      continue
    fi
    routes+=("${url:-/}")
  done < <(find "$root" -type f \
    \( -name 'page.tsx' -o -name 'page.jsx' -o -name 'page.ts' \
       -o -name 'page.js' -o -name 'page.mdx' -o -name 'page.md' \) -print0)
}

# ── walk every routing dir this repo actually has ────────────────────
if [[ -d "$REPO/src/pages" ]]; then
  roots_found+=("src/pages")
  walk_pages_router "$REPO/src/pages" "src/pages"
fi
if [[ -d "$REPO/pages" ]] && is_next_repo; then
  roots_found+=("pages")
  walk_pages_router "$REPO/pages" "pages"
fi
if [[ -d "$REPO/src/app" ]]; then
  roots_found+=("src/app")
  walk_app_router "$REPO/src/app" "src/app"
fi
if [[ -d "$REPO/app" ]]; then
  roots_found+=("app")
  walk_app_router "$REPO/app" "app"
fi

# No routing directory at all — the repo has no file-based route tree /qa can read.
if [[ ${#roots_found[@]} -eq 0 ]]; then
  echo "no-src-pages: $REPO (looked for src/pages, pages, src/app, app)" >&2
  exit 3
fi

# Routing dir(s) exist but yielded no static route (only dynamic/private/error/
# non-page files) — a real HALT, never a fabricated `/` (no guessing).
if [[ ${#routes[@]} -eq 0 ]]; then
  echo "no-static-routes: $REPO (${roots_found[*]})" >&2
  exit 4
fi

printf '%s\n' ${routes[@]+"${routes[@]}"} | sort -u
