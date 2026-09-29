#!/usr/bin/env bash
# sight-check.test.sh — pin the one property the gate exists for: a review
# response that is well-formed but UNSEEN must not pass.
#
# The fixture is a real failure shape — correct severities, real
# pixel numbers, a confident "ALIGNED" verdict — computed by a reviewer whose
# image Read was dead. Everything the step-4 brief asks for is present; only
# the sight codes are missing.
#
# peers: ../sight-check.sh
#
# shellcheck disable=SC2015  # pass||fail assert idiom

set -euo pipefail

# Every expected-nonzero exit is captured in a guarded `if` so `set -e` stays on
# for the setup commands. `rc() CMD...` returns the
# command's status without tripping errexit.
status_of() { local s=0; "$@" >/dev/null 2>&1 || s=$?; printf '%s' "$s"; }
output_of() { "$@" 2>&1 || true; }

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SC="$DIR/sight-check.sh"
TMP="$(mktemp -d -t sight-check-test-XXXXXX)"   # outside the repo, always
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; out=""; lines=""; hits=""; inrun=""; dim=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
rc_is() { # rc_is NAME EXPECTED ACTUAL
  [[ "$2" == "$3" ]] && ok "$1" || no "$1" "expected exit $2, got $3"
}

if ! command -v magick >/dev/null 2>&1; then echo "sight-check: SKIP (no ImageMagick)"; exit 0; fi

mkdir -p "$TMP/run"
magick -size 800x600 xc:'#ffffff' -fill '#111111' -pointsize 32 -gravity north \
  -annotate +0+80 "The Next Three Years" "$TMP/run/roadmap-1440.png"
magick -size 390x844 xc:'#ffffff' -fill '#111111' -pointsize 18 -gravity north \
  -annotate +0+40 "The Next Three Years" "$TMP/run/roadmap-390.png"
CODES="$TMP/codes.tsv"

# ── the blind reviewer's answer: every brief requirement met, nothing seen ──
cat > "$TMP/blind.txt" <<'EOF'
roadmap-1440.png — three roadmap cards, widths 360/360/360, tops all y=300,
bottoms all y=700, bodies begin y=356, bottom gaps 200px each. ALIGNED.
Body #6b7280 on #ffffff = 4.83:1, passes AA. No collisions; nearest pair 100px clear.
P3 — gutters 80px vs 100px outer margin.
roadmap-390.png — single column, no overflow. No P0/P1. Ship gate: PASS.
EOF

# ── boundary: verify BEFORE stamp. Absence is never a pass. ──
: > "$CODES"
out="$(output_of "$SC" verify --codes "$CODES" --response "$TMP/blind.txt")"
rc_is "no-codes-file halts (5)" 5 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/blind.txt")"
grep -q "review/policy-review.sh" <<< "$out" && ok "no-codes names the review-chain fallback" \
  || no "no-codes names the review-chain fallback" "banner absent"

# ── boundary: 0 shots ──
mkdir -p "$TMP/empty"
rc_is "zero-shot dir halts (4)" 4 "$(status_of "$SC" stamp --dir "$TMP/empty" --codes "$TMP/empty.tsv")"

# ── stamp ──
rc_is "stamp succeeds (0)" 0 "$(status_of "$SC" stamp --dir "$TMP/run" --codes "$CODES")"
lines="$(wc -l < "$CODES")"
[[ "$lines" -eq 2 ]] && ok "one code per shot" || no "one code per shot" "$lines lines"

c1="$(awk -F'\t' '$1=="roadmap-1440.png"{print $2}' "$CODES")"
c2="$(awk -F'\t' '$1=="roadmap-390.png"{print $2}' "$CODES")"
[[ "$c1" != "$c2" ]] && ok "codes differ per shot" || no "codes differ per shot" "both $c1"

# The code must live in the PIXELS and nowhere a grep can reach.
hits="$(strings "$TMP/run/roadmap-1440.png" | grep -cF "$c1" || true)"
[[ "$hits" -eq 0 ]] && ok "code absent from the PNG's bytes as text" \
  || no "code absent from the PNG's bytes as text" "found by strings"
inrun="$(grep -rlF "$c1" "$TMP/run" 2>/dev/null | wc -l || true)"
[[ "$inrun" -eq 0 ]] && ok "codes file is not inside the run dir" \
  || no "codes file is not inside the run dir" "reviewer could read it"

# Geometry above the strip is untouched — the reviewer's y-coordinates stay valid.
dim="$(magick identify -format '%wx%h' "$TMP/run/roadmap-390.png")"
[[ "$dim" == "390x900" ]] && ok "stamp appends below, width unchanged" \
  || no "stamp appends below, width unchanged" "$dim"

# ── THE property: the same well-formed blind answer is now rejected ──
out="$(output_of "$SC" verify --codes "$CODES" --response "$TMP/blind.txt")"
rc_is "blind review rejected (6)" 6 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/blind.txt")"
grep -q "BLIND REVIEW REJECTED" <<< "$out" && ok "rejection is loud" \
  || no "rejection is loud" "no banner"
grep -q "review/policy-review.sh" <<< "$out" && ok "rejection names the review-chain fallback" \
  || no "rejection names the review-chain fallback" "banner absent"

# ── a sighted answer passes ──
{ echo "roadmap-1440.png = $c1"; echo "roadmap-390.png = $c2"; cat "$TMP/blind.txt"; } > "$TMP/sighted.txt"
rc_is "sighted review accepted (0)" 0 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/sighted.txt")"

# ── partial sight: opened one shot, computed the other ──
{ echo "roadmap-1440.png = $c1"; cat "$TMP/blind.txt"; } > "$TMP/partial.txt"
rc_is "partial sight rejected (6)" 6 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/partial.txt")"

# ── boundary: empty response ──
: > "$TMP/empty.txt"
rc_is "empty response rejected (6)" 6 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/empty.txt")"

# ── boundary: response file missing ──
rc_is "missing response file is usage (2)" 2 "$(status_of "$SC" verify --codes "$CODES" --response "$TMP/nope.txt")"

# A codes file that is non-empty but unreadable must HALT, never report 0/0.
printf 'garbage-with-no-tab\n' > "$TMP/bad.tsv"
rc_is "malformed codes file halts (5)" 5 "$(status_of "$SC" verify --codes "$TMP/bad.tsv" --response "$TMP/sighted.txt")"
printf '\n\n' > "$TMP/blank.tsv"
rc_is "codes file of blank lines halts (5)" 5 "$(status_of "$SC" verify --codes "$TMP/blank.tsv" --response "$TMP/sighted.txt")"

# No trailing newline: the LAST row must still count, or the denominator shrinks
# and a partial transcription verifies as complete.
printf 'roadmap-1440.png\t%s\nroadmap-390.png\t%s' "$c1" "$c2" > "$TMP/nonl.tsv"
{ echo "roadmap-1440.png = $c1"; cat "$TMP/blind.txt"; } > "$TMP/onlyfirst.txt"
rc_is "unterminated last row still counted (6)" 6 "$(status_of "$SC" verify --codes "$TMP/nonl.tsv" --response "$TMP/onlyfirst.txt")"
rc_is "unterminated codes file accepts a full transcription (0)" 0 "$(status_of "$SC" verify --codes "$TMP/nonl.tsv" --response "$TMP/sighted.txt")"

echo
echo "sight-check.sh: ${pass}/$((pass + fail)) passed"
[[ $fail -eq 0 ]]
