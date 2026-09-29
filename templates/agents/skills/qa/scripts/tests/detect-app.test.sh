#!/usr/bin/env bash
# detect-app.test.sh — fixture-driven tests for detect-app.sh covering the
# detection table + the boundary rows (unknown type, Node/CLI
# without a qa:* script → exit 3, package.json qa:* script wins over convention).
#
# peers: ../detect-app.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/detect-app.sh"

pass=0; fail=0
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

mkrepo() { mktemp -d; }
pkg() { printf '%s' "$2" > "$1/package.json"; }

# returns "TYPE|RC"
run() {
  local repo="$1" out rc=0
  out="$("$SCRIPT" "$repo" 2>/dev/null)" || rc=$?
  local type
  type="$(printf '%s\n' "$out" | sed -n 's/^TYPE=//p')"
  printf '%s|%s' "$type" "$rc"
}

assert() { # name repo expected-type expected-rc
  local got; got="$(run "$2")"
  [[ "$got" == "$3|$4" ]] && ok "$1" || no "$1" "expected $3|$4 got $got"
}

# astro + wrangler dep → astro-cf
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"astro":"5","wrangler":"3"}}'
assert "astro-cf via dep" "$r" "astro-cf" "0"

# astro + wrangler.toml on disk → astro-cf
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"astro":"5"}}'; : > "$r/wrangler.toml"
assert "astro-cf via wrangler.toml" "$r" "astro-cf" "0"

# astro only → astro
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"astro":"5"}}'
assert "astro plain" "$r" "astro" "0"

# vite → vite
r="$(mkrepo)"; pkg "$r" '{"devDependencies":{"vite":"5"}}'
assert "vite" "$r" "vite" "0"

# static: dist dir, no toolchain
r="$(mkrepo)"; mkdir "$r/dist"
assert "static dist" "$r" "static" "0"

# unknown: empty repo → exit 3
r="$(mkrepo)"
assert "unknown empty" "$r" "unknown" "3"

# CLI (bin field) without a qa:* script → exit 3 (no guessed command)
r="$(mkrepo)"; pkg "$r" '{"bin":{"foo":"cli.js"}}'
assert "cli no-script exit3" "$r" "unknown" "3"

# package.json qa:cmd wins → cli, exit 0
r="$(mkrepo)"; pkg "$r" '{"bin":{"foo":"cli.js"},"scripts":{"qa:cmd":"node cli.js --help"}}'
assert "qa:cmd → cli" "$r" "cli" "0"

# package.json qa:serve wins → node-server, exit 0
r="$(mkrepo)"; pkg "$r" '{"scripts":{"start":"node server.js","qa:serve":"node server.js"}}'
assert "qa:serve → node-server" "$r" "node-server" "0"

# package.json qa:render wins (over astro detection) → render, exit 0
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"astro":"5"},"scripts":{"qa:render":"make qa-png"}}'
assert "qa:render → render" "$r" "render" "0"

# Next via a `next` dependency → next
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"next":"16"}}'
assert "next via dep" "$r" "next" "0"

# Next via next.config.* on disk, with a public/ dir that would otherwise have
# fallen through to `static` and served prebuilt bytes instead of the app
r="$(mkrepo)"; : > "$r/next.config.ts"; mkdir "$r/public"
assert "next.config beats static fallback" "$r" "next" "0"

# `next-auth` is not `next` — the dep match must be word-exact
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"next-auth":"5"}}'; mkdir "$r/dist"
assert "next-auth is not next" "$r" "static" "0"

# a package.json qa:serve script still wins over Next convention detection
r="$(mkrepo)"; pkg "$r" '{"dependencies":{"next":"16"},"scripts":{"qa:serve":"next dev"}}'
assert "qa:serve beats next" "$r" "node-server" "0"

echo
echo "detect-app.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
