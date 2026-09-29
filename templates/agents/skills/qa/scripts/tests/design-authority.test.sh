#!/usr/bin/env bash
# design-authority.test.sh — pin the two-limb stub rule design-authority.sh
# owns: the `design-authority: generated-stub` marker in any quoting, and a
# body with no contract heading, are both stubs; a real DESIGN.md is not; a
# missing file and an unterminated frontmatter block have their own exits.
# The script is run as a subprocess, never sourced.
#
# peers: ../design-authority.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/design-authority.sh"
TMP="$(mktemp -d -t design-authority-test-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; rc=0; out=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }
expect() { # expect NAME RC PATTERN
  [[ "$rc" == "$2" && "$out" == *"$3"* ]] && ok "$1" || no "$1" "rc=$rc out=$out"
}

# ── usage ──
run bash "$SCRIPT";                 expect "no args → 2" 2 "usage:"
run bash "$SCRIPT" sideways;        expect "unknown verb → 2" 2 "usage:"
run bash "$SCRIPT" status;          expect "status without repo → 2" 2 "usage:"
run bash "$SCRIPT" status "$TMP/nope"; expect "status on no dir → 4" 4 "no such directory"

# ── headings vocabulary ──
run bash "$SCRIPT" headings
[[ "$rc" == 0 && "$out" == *"typography"* && "$out" == *"|"* ]] \
  && ok "headings prints the vocabulary" || no "headings" "rc=$rc out=$out"
[[ "$out" != *"colour"* ]] && ok "headings omits colour on purpose" || no "headings colour" "$out"

# ── missing DESIGN.md ──
mkdir -p "$TMP/empty"
run bash "$SCRIPT" status "$TMP/empty"; expect "no DESIGN.md → missing/3" 3 "AUTHORITY=missing"

# ── limb one: the marker, in every spelling ──
mk() { mkdir -p "$TMP/$1"; cat > "$TMP/$1/DESIGN.md"; }
mk bare   <<'MD'
---
design-authority: generated-stub
---
## Typography
MD
mk quoted <<'MD'
---
design-authority: "generated-stub"
---
## Typography
MD
mk single <<'MD'
---
design-authority: 'generated-stub'
---
## Typography
MD
mk commented <<'MD'
---
design-authority: generated-stub  # written by /qa
---
## Typography
MD
for c in bare quoted single commented; do
  run bash "$SCRIPT" status "$TMP/$c"; expect "marker ($c) → stub/3" 3 "AUTHORITY=stub"
  [[ "$out" == *"generated-stub"* ]] && ok "marker ($c) reason names the marker" \
    || no "marker ($c) reason" "$out"
done

# ── limb two: a body with no contract heading ──
mk tokens <<'MD'
---
colors:
  ink: "#101010"
---
# Design
## Colors
- ink #101010
## Brand
MD
run bash "$SCRIPT" status "$TMP/tokens"; expect "no contract heading → stub/3" 3 "AUTHORITY=stub"
[[ "$out" == *"declares no design contract"* ]] && ok "heading-limb reason" || no "heading-limb reason" "$out"

# a `state:` frontmatter KEY is not a heading about state
mk fmkey <<'MD'
---
state: draft
---
## Palette
MD
run bash "$SCRIPT" status "$TMP/fmkey"; expect "frontmatter key is not a heading → stub/3" 3 "AUTHORITY=stub"

# ── real: one contract heading, any case, any depth ──
mk real <<'MD'
---
version: 1
---
# Design
#### FOCUS rings
Every control shows a 2px ring.
MD
run bash "$SCRIPT" status "$TMP/real"; expect "contract heading → real/0" 0 "AUTHORITY=real"
[[ "$out" == *"declares 1 design contract heading"* ]] && ok "real counts headings" || no "real count" "$out"

# no frontmatter at all, real body
mk nofm <<'MD'
# App
## Spacing
4px grid.
## Motion
MD
run bash "$SCRIPT" status "$TMP/nofm"; expect "no frontmatter, real body → 0" 0 "declares 2 design contract"

# ── malformed: an unterminated frontmatter block is a parse failure ──
mk broken <<'MD'
---
design-authority: real
## Typography
MD
run bash "$SCRIPT" status "$TMP/broken"; expect "unterminated frontmatter → 2" 2 "AUTHORITY=malformed"

echo
echo "design-authority.sh: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
