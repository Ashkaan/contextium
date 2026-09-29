#!/usr/bin/env bash
# design-frontmatter.test.sh — pin what design-frontmatter.mjs reads out of a
# DESIGN.md frontmatter (`TYPE_SCALE=`, `COLORS=`, `SPACING_SCALE=`,
# `RADIUS_SCALE=`, `CONTROL_HEIGHTS=`, `VARIANTS_<ROLE>=` lines), the aliases
# and fallbacks it accepts, and the shapes it refuses with exit 2 rather than
# guessing at. The script is run as a subprocess, never sourced.
#
# peers: ../design-frontmatter.mjs

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/design-frontmatter.mjs"
TMP="$(mktemp -d -t design-frontmatter-test-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; rc=0; out=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }
line() { grep -E "^$1=" <<<"$out" || true; } # the one KEY=... line
mk() { mkdir -p "$TMP/$1"; cat > "$TMP/$1/DESIGN.md"; }

# ── usage / missing ──
run node "$SCRIPT"
[[ "$rc" == 2 && "$out" == *"usage:"* ]] && ok "no repo → 2" || no "no repo" "rc=$rc $out"
mkdir -p "$TMP/none"
run node "$SCRIPT" "$TMP/none"
[[ "$rc" == 3 && "$out" == *"no $TMP/none/DESIGN.md"* ]] && ok "no DESIGN.md → 3" || no "no DESIGN.md" "rc=$rc $out"

# no frontmatter: unarmed, silent, exit 0
mk plain <<'MD'
# Design
## Typography
MD
run node "$SCRIPT" "$TMP/plain"
[[ "$rc" == 0 && -z "$out" ]] && ok "no frontmatter → 0, prints nothing" || no "no frontmatter" "rc=$rc $out"

# ── the published shape: nested maps, inline arrays, comments, hex colours ──
mk full <<'MD'
---
version: 1
typography:
  scale: [12px, 14px, "16px", 20px]   # the ramp
colors:
  ink: "#101010" # brand — the # inside quotes is a colour, not a comment
  paper: '#fafafa'
  accent: "rgb(0, 0, 0)"
spacing: [4px, 8px, 16px]
rounded:
  sm: 4px
  lg: 12px
components:
  control-sm:
    height: 32px
  control-md:
    height: 40px
  person-row:
    height: 64px
  button-primary:
    background: ink
  button-ghost:
    background: transparent
  status-pill-success:
    background: green
---
## Typography
MD
run node "$SCRIPT" "$TMP/full"
[[ "$rc" == 0 ]] && ok "full file → 0" || no "full file rc" "rc=$rc $out"
[[ "$(line TYPE_SCALE)" == "TYPE_SCALE=12px|14px|16px|20px" ]] && ok "TYPE_SCALE from typography.scale, quotes and comment stripped" \
  || no "TYPE_SCALE" "$(line TYPE_SCALE)"
[[ "$(line COLORS)" == "COLORS=#101010|#fafafa|rgb(0, 0, 0)" ]] && ok "COLORS keeps quoted # and inner comma" \
  || no "COLORS" "$(line COLORS)"
[[ "$(line SPACING_SCALE)" == "SPACING_SCALE=4px|8px|16px" ]] && ok "SPACING_SCALE from spacing" || no "SPACING_SCALE" "$(line SPACING_SCALE)"
[[ "$(line RADIUS_SCALE)" == "RADIUS_SCALE=4px|12px" ]] && ok "RADIUS_SCALE from rounded map" || no "RADIUS_SCALE" "$(line RADIUS_SCALE)"
[[ "$(line CONTROL_HEIGHTS)" == "CONTROL_HEIGHTS=32px|40px" ]] && ok "CONTROL_HEIGHTS from control-* only (person-row excluded)" \
  || no "CONTROL_HEIGHTS" "$(line CONTROL_HEIGHTS)"
[[ "$(line VARIANTS_BUTTON)" == "VARIANTS_BUTTON=primary|ghost" ]] && ok "VARIANTS_BUTTON from button-* entries" \
  || no "VARIANTS_BUTTON" "$(line VARIANTS_BUTTON)"
[[ "$(line VARIANTS_STATUS)" == "VARIANTS_STATUS=pill-success" ]] && ok "two-word role groups under its first word" \
  || no "VARIANTS_STATUS" "$(line VARIANTS_STATUS)"

# ── aliases: the older keys win when present; block lists count ──
mk alias <<'MD'
---
typeScale:
  - 1rem
  - "2rem" # display
spacingScale: [1, 2]
radiusScale: [0, 999px]
controlHeights: [36px]
componentVariants:
  input:
    - default
    - error
---
MD
run node "$SCRIPT" "$TMP/alias"
[[ "$rc" == 0 ]] && ok "alias file → 0" || no "alias rc" "rc=$rc $out"
[[ "$(line TYPE_SCALE)" == "TYPE_SCALE=1rem|2rem" ]] && ok "typeScale block list (last-key flush included)" || no "typeScale" "$(line TYPE_SCALE)"
[[ "$(line SPACING_SCALE)" == "SPACING_SCALE=1|2" ]] && ok "spacingScale alias" || no "spacingScale" "$(line SPACING_SCALE)"
[[ "$(line RADIUS_SCALE)" == "RADIUS_SCALE=0|999px" ]] && ok "radiusScale alias" || no "radiusScale" "$(line RADIUS_SCALE)"
[[ "$(line CONTROL_HEIGHTS)" == "CONTROL_HEIGHTS=36px" ]] && ok "controlHeights alias" || no "controlHeights" "$(line CONTROL_HEIGHTS)"
[[ "$(line VARIANTS_INPUT)" == "VARIANTS_INPUT=default|error" ]] && ok "componentVariants block list" || no "componentVariants" "$(line VARIANTS_INPUT)"

# typography entries' fontSize is the last fallback for TYPE_SCALE
mk entries <<'MD'
---
typography:
  body:
    fontSize: 16px
  display:
    fontSize: 48px
    lineHeight: 1.1
---
MD
run node "$SCRIPT" "$TMP/entries"
[[ "$rc" == 0 && "$(line TYPE_SCALE)" == "TYPE_SCALE=16px|48px" ]] && ok "TYPE_SCALE falls back to entry fontSizes" \
  || no "entry fontSizes" "rc=$rc $(line TYPE_SCALE)"

# a `scale: # comment` opens a container, it is not the scalar "# comment"
mk commentkey <<'MD'
---
typography:
  scale: # the ramp
    - 12px
---
MD
run node "$SCRIPT" "$TMP/commentkey"
[[ "$(line TYPE_SCALE)" == "TYPE_SCALE=12px" ]] && ok "comment after empty key still opens the list" || no "comment key" "rc=$rc $out"

# absent keys print nothing (disarmed, not empty)
mk sparse <<'MD'
---
colors: [red]
---
MD
run node "$SCRIPT" "$TMP/sparse"
[[ "$rc" == 0 && "$out" == "COLORS=red" ]] && ok "absent keys print no line" || no "sparse" "rc=$rc $out"

# ── refusals: exit 2 with a line number, never a partial pass ──
refuse() { # refuse NAME LINE-NO PATTERN
  run node "$SCRIPT" "$TMP/$1"
  [[ "$rc" == 2 && "$out" == *"DESIGN.md:$2 "* && "$out" == *"$3"* ]] && ok "$1 → 2 at line $2" \
    || no "$1" "rc=$rc $out"
}
mk unterminated <<'MD'
---
colors: [red]
## Body
MD
refuse unterminated 1 "never closed"
mk tabbed <<'MD'
---
colors:
	ink: red
---
MD
refuse tabbed 3 "tab indentation"
mk orphanitem <<'MD'
---
- 12px
---
MD
refuse orphanitem 2 "no key above it"
mk listofmaps <<'MD'
---
typography:
  scale:
    - name: xs
      size: 12px
---
MD
refuse listofmaps 4 "list of maps is not supported"
mk quotedmapitem <<'MD'
---
typography:
  scale:
    - "name": xs
---
MD
refuse quotedmapitem 4 "list of maps is not supported"
mk nocolon <<'MD'
---
colors:
  ink red
---
MD
refuse nocolon 3 "cannot parse"

echo
echo "design-frontmatter.mjs: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
