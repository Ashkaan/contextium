#!/usr/bin/env bash
# sight-check.sh — prove the visual reviewer actually LOOKED at the screenshots.
#
# Why this exists: when image `Read` breaks mid-session (a harness hook timing
# out is enough), the /qa step-4 reviewer subagent keeps returning confident,
# correctly-shaped findings computed from pixel arithmetic it ran in Bash
# instead of from looking, and the orchestrator reads them as a visual pass
# that never happened. The numbers are not wrong — they answer a narrower
# question: three cards measured "aligned" (equal heights, equal bottom gaps,
# bodies at the same y — all true) while visibly ragged, because their closing
# lines wrapped to different LINE COUNTS and nothing measured that. A brief that
# asks for measurements is exactly what a blind agent can satisfy.
#
# So the brief stops being the gate. `stamp` burns a random code into the pixels
# of every shot — a code that exists NOWHERE else: not in the DOM, not in the
# served HTML, not in the brief, not in the run dir. `verify` refuses the review
# unless the reviewer transcribed every code back. Reading rendered glyphs is
# sight; there is no arithmetic that recovers them (and an OCR pass would still
# be a reading of the picture).
#
# Both modes are pure string/pixel work outside the model, so this gate still
# fires when the ORCHESTRATOR's own image Read is dead — which is the exact
# condition it exists for.
#
# The stamper is ImageMagick (`magick`) when installed, and otherwise Playwright
# (sight-stamp.mjs, the same strip drawn by a headless browser), so the gate
# runs on a stock Mac or Linux box. With neither, stamp halts.
#
# peers:
#   .agents/skills/qa/SKILL.md            (step-4-fresh-review, step-4.5-fix-reverify)
#   .agents/skills/qa/scripts/screenshot.sh
#   .agents/skills/qa/scripts/sight-stamp.mjs
#   .agents/skills/qa/scripts/lib.sh
#   .agents/skills/qa/scripts/tests/sight-check.test.sh
#   .agents/skills/qa/scripts/tests/sight-check-playwright.test.sh
#   .agents/skills/review/policy-review.sh  (the documented blind fallback: a
#                                            reviewer on another vendor)
#
# Usage:
#   sight-check.sh stamp  --dir <run-dir> [--codes <path>]
#   sight-check.sh verify --codes <path> --response <file>
#
# Exit: 0 ok | 2 usage | 3 missing dependency | 4 nothing stamped
#       5 no codes file (stamp never ran — absence is NEVER a pass)
#       6 BLIND REVIEW — codes missing from the response

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091  # sibling source, resolved at runtime
source "$SCRIPT_DIR/lib.sh"

err() { echo "$@" >&2; }

# Unambiguous alphabet: no 0/O/1/I/L/5/S — a transcription slip must not read as
# a blind reviewer.
ALPHABET="23467894ABCDEFGHJKMNPQRTUVWXYZ"
CODE_LEN=6

# The fallback reviewer is handed at most 8 images per call: past that, vision
# models start skimming. Larger runs are batched.
ROUTER_IMAGE_MAX=8

new_code() {
  local out="" i
  for ((i = 0; i < CODE_LEN; i++)); do
    out+="${ALPHABET:$((RANDOM % ${#ALPHABET})):1}"
  done
  printf '%s' "$out"
}

# Codes live OUTSIDE the run dir on purpose: the reviewer is handed the run dir,
# and a codes file sitting next to the PNGs is a text answer to a picture
# question.
default_codes_path() {
  local dir="$1" cache
  cache="${QA_SIGHT_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/qa-sight}"
  mkdir -p "$cache"
  printf '%s/%s.codes' "$cache" "$(printf '%s' "$dir" | cksum | tr -d ' \n')"
}

fallback_banner() {
  # Named here, not left for the operator to rediscover. The review chain puts
  # the review on a different vendor from the author — the independence the
  # review gate wants anyway. A vendor in the chain that cannot open images
  # cannot return the codes, so this same gate catches it.
  cat >&2 <<BANNER

  ROUTE AROUND IT — run the review through the review chain instead of a
  subagent whose image Read is dead. The brief names the PNG paths to open:

    bash .agents/skills/review/policy-review.sh adversarial-review \\
      <run-dir>/manifest.json <brief.txt>   > <response>.txt

  Then verify THAT response with this same gate. Max $ROUTER_IMAGE_MAX images per
  call — batch larger runs. The brief must still carry the rubric and the
  "transcribe the QA SIGHT CODE" instruction, and it must NEVER carry the codes.
BANNER
}

# ── stamp ──────────────────────────────────────────────────────────────────
cmd_stamp() {
  local dir="" codes=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) dir="${2:-}"; shift 2 ;;
      --codes) codes="${2:-}"; shift 2 ;;
      *) err "sight-check.sh stamp: unknown arg '$1'"; exit 2 ;;
    esac
  done
  [[ -n "$dir" && -d "$dir" ]] || { err "usage: sight-check.sh stamp --dir <run-dir> [--codes <path>]"; exit 2; }
  dir="$(cd "$dir" && pwd)"
  local stamper="magick" pw_nm=""
  if ! command -v magick >/dev/null 2>&1; then
    if pw_nm="$(qa_playwright_node_modules 2>/dev/null)" && [[ -n "$pw_nm" ]]; then
      stamper="playwright"
      err "sight-check.sh: no ImageMagick — stamping with Playwright"
    else
      err "sight-check.sh: neither ImageMagick nor Playwright is available — cannot stamp, so sight cannot be proven."
      err "sight-check.sh: HALT rather than dispatch an unverifiable review."
      exit 3
    fi
  fi
  [[ -n "$codes" ]] || codes="$(default_codes_path "$dir")"

  local shots=() png
  while IFS= read -r png; do shots+=("$png"); done < <(find "$dir" -maxdepth 1 -type f -name '*.png' | sort)
  if [[ ${#shots[@]} -eq 0 ]]; then
    err "sight-check.sh: no PNGs at $dir — nothing to review, nothing to stamp."
    exit 4
  fi

  : > "$codes"
  for png in "${shots[@]}"; do
    local code w h ink rc
    code="$(new_code)"
    if [[ "$stamper" == "playwright" ]]; then
      rc=0
      node "$SCRIPT_DIR/sight-stamp.mjs" "$(dirname "$pw_nm")" "$png" "$code" || rc=$?
      if [[ $rc -eq 0 ]]; then
        mv "$png.stamped" "$png"
        printf '%s\t%s\n' "$(basename "$png")" "$code" >> "$codes"
        continue
      fi
      rm -f "$png.stamped" "$codes"
      if [[ $rc -eq 4 ]]; then
        err "sight-check.sh: the stamp rendered blank on $(basename "$png") (no font?) — a code nobody can read is an unpassable gate."
      else
        err "sight-check.sh: the Playwright stamper failed on $(basename "$png") (exit $rc)."
      fi
      exit 4
    fi
    w="$(magick identify -format '%w' "$png")"
    h="$(magick identify -format '%h' "$png")"
    # Appended BELOW the shot, so every y-coordinate in the page is unchanged
    # and the reviewer's geometry stays valid.
    magick "$png" \
      \( -size "${w}x56" xc:'#101010' -fill '#f5f5f5' -pointsize 30 -gravity center \
         -annotate 0 "QA SIGHT CODE  $code" \) \
      -append "$png.stamped"
    ink="$(magick "$png.stamped" -crop "${w}x56+0+${h}" +repage -format '%[fx:standard_deviation]' info:)"
    if awk -v v="$ink" 'BEGIN { exit (v > 0.01) ? 0 : 1 }'; then
      mv "$png.stamped" "$png"
      printf '%s\t%s\n' "$(basename "$png")" "$code" >> "$codes"
    else
      rm -f "$png.stamped"
      err "sight-check.sh: the stamp rendered blank on $(basename "$png") (no font?) — a code nobody can read is an unpassable gate."
      rm -f "$codes"
      exit 4
    fi
  done

  echo "QA_SIGHT_CODES=$codes"
  echo "QA_SIGHT_COUNT=${#shots[@]}"
  if [[ ${#shots[@]} -gt $ROUTER_IMAGE_MAX ]]; then
    err "sight-check.sh: ${#shots[@]} shots > $ROUTER_IMAGE_MAX — the router fallback needs batching."
  fi
  return 0
}

# ── verify ─────────────────────────────────────────────────────────────────
cmd_verify() {
  local codes="" response=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --codes) codes="${2:-}"; shift 2 ;;
      --response) response="${2:-}"; shift 2 ;;
      *) err "sight-check.sh verify: unknown arg '$1'"; exit 2 ;;
    esac
  done
  [[ -n "$codes" && -n "$response" ]] || { err "usage: sight-check.sh verify --codes <path> --response <file>"; exit 2; }
  [[ -f "$response" ]] || { err "sight-check.sh: no response file at $response"; exit 2; }
  if [[ ! -s "$codes" ]]; then
    err "sight-check.sh: no codes at $codes — stamp never ran, so nothing about this review is proven."
    err "sight-check.sh: HALT. An unstamped run can never PASS this gate; re-shoot and stamp."
    fallback_banner
    exit 5
  fi

  # A codes file that is non-empty but says nothing usable (truncated write,
  # wrong --codes path, a stale file from another harness) would otherwise fall
  # straight through the loop and report `SIGHTED — 0/0` — a pass that proves
  # nothing, which is the exact shape this gate exists to refuse. Every row is
  # validated, and zero valid rows is a halt, not a success.
  local total=0 seen=0 missing=() shot code line
  # `|| [[ -n "$line" ]]` keeps the LAST row when the file has no trailing
  # newline (a truncated write, a hand-made file): plain `read` returns 1 there
  # and the row is silently dropped, which would shrink the denominator and let
  # a partial transcription verify as complete.
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    if [[ ! "$line" =~ ^[^$'\t']+$'\t'[A-Z0-9]{6}$ ]]; then
      err "sight-check.sh: malformed row in $codes: '$line'"
      err "sight-check.sh: HALT — a codes file that cannot be read cannot prove anything."
      fallback_banner
      exit 5
    fi
    shot="${line%%$'\t'*}"
    code="${line##*$'\t'}"
    total=$((total + 1))
    if grep -qiwF -- "$code" "$response"; then
      seen=$((seen + 1))
    else
      missing+=("$shot")
    fi
  done < "$codes"

  if [[ $total -eq 0 ]]; then
    err "sight-check.sh: $codes holds no codes — nothing about this review is proven."
    err "sight-check.sh: HALT. 0/0 is never a pass."
    fallback_banner
    exit 5
  fi

  if [[ ${#missing[@]} -eq 0 ]]; then
    echo "sight-check: SIGHTED — $seen/$total codes transcribed."
    return 0
  fi

  err ""
  err "  ================================================================"
  err "  BLIND REVIEW REJECTED — this is not a visual pass. Do not report it as one."
  err "  ================================================================"
  err "  $seen/$total sight codes came back. Missing for: ${missing[*]}"
  err ""
  err "  A reviewer that cannot open the picture still returns well-formed"
  err "  findings with real pixel numbers — computed, not seen. Those numbers"
  err "  answer a narrower question than the one asked."
  fallback_banner
  exit 6
}

case "${1:-}" in
  stamp) shift; cmd_stamp "$@" ;;
  verify) shift; cmd_verify "$@" ;;
  *) err "usage: sight-check.sh {stamp|verify} ..."; exit 2 ;;
esac
