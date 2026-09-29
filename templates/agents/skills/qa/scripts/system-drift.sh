#!/usr/bin/env bash
# system-drift.sh — count how far a repo's source has drifted from the design
# system the repo itself declares.
#
# WHY THIS EXISTS. `/qa` delegates the whole question of what an app should look
# like to that app's own `DESIGN.md`, and that delegation is right — every app
# gets a fresh design, so a globally prescribed look gets in the way. What was
# missing was any check that the source still MATCHES the delegated authority.
# So a portal with 467 raw palette literals, 148 hand-patched type sizes and
# eight OS-native select widgets reported a clean `/qa`, run after run.
#
# WHAT IT IS NOT. It holds no opinion about what a good design is. Every measure
# below is a fact about the source read against a scale the repo declared for
# itself. A repo that declares a one-entry ramp is
# measured against that one entry; a key it does not declare disarms its measure
# and never fails. Consistency is the floor this measures, not beauty — a design
# can be perfectly internally consistent and still be ugly, and that judgement
# belongs to `/qa`'s fresh-eyes pass.
#
# COUNTING UNIT: one finding per DISTINCT off-scale value, carrying how many
# times it occurs and up to five `file:line` examples. Not one finding per
# occurrence — 467 findings is a dump, not a review.
#
# SEVERITY, and the reasoning:
#   P1  a native platform widget. The user sees an unstyled OS control; no
#       design system survives that, so it blocks regardless of count.
#   P2  an off-scale value used 10 or more times. That is systemic drift.
#   P3  under 10. A one-off.
#   claim  a class recipe that maps to no declared variant. Reported for the
#       reviewer to adjudicate, never counted as a defect.
#   No measure emits P0. A scanner cannot know what blocks a task.
#
# Usage: system-drift.sh <repo-path>
# Exit: 0 clean (and silent) · 1 findings · 2 unparseable frontmatter or usage
#       · 3 no design authority, or a stub one · 4 no such directory
#
# peers:
#   .agents/skills/qa/scripts/design-authority.sh
#   .agents/skills/qa/scripts/design-frontmatter.mjs
#   .agents/skills/qa/scripts/tests/system-drift.test.sh
#   .agents/skills/qa/references/review-rubric.md

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${1:-}"
[ -n "$REPO" ] || { echo "usage: system-drift.sh <repo-path>" >&2; exit 2; }
[ -d "$REPO" ] || { echo "system-drift: no such directory: $REPO" >&2; exit 4; }
REPO="$(cd "$REPO" && pwd)"

# ── The authority has to exist, and have a design in it ───────────────────
# Exit 3 is DISTINCT from clean on purpose. A missing or stub authority means
# every measure below is unarmed, and "nothing to compare against" must never
# read as "nothing wrong".
authority="$(bash "$HERE/design-authority.sh" status "$REPO" 2>&1)"
case $? in
  0) ;;
  3)
    printf '%s\n' "$authority"
    echo "[P1] design-authority — this app has no design system. The design-system checks are running against an auto-extracted token list and cannot fail."
    echo "system-drift: P1=1 P2=0 P3=0 claims=0"
    exit 3
    ;;
  *)
    printf '%s\n' "$authority" >&2
    exit 2
    ;;
esac

declared="$(node "$HERE/design-frontmatter.mjs" "$REPO")" || exit 2

# NO `eval`. The values come out of a file somebody hand-edits, and an eval of
# `KEY="value"` lines is decided by whatever quotes and `$` that file happens to
# contain: a declared colour written `"#101010" # brand` silently truncated at
# the `#`, which looked like the parser working. `printf -v` assigns the string
# as a string, and the name is matched against a fixed list first so nothing in
# the file can choose which variable it writes.
while IFS='=' read -r _key _value; do
  case "$_key" in
    TYPE_SCALE | COLORS | SPACING_SCALE | RADIUS_SCALE | CONTROL_HEIGHTS | VARIANTS_[A-Z_0-9]*)
      printf -v "$_key" '%s' "$_value"
      ;;
    "") ;;
    *) echo "system-drift: unexpected declaration '$_key' from design-frontmatter.mjs" >&2; exit 2 ;;
  esac
done <<<"$declared"

# ── The files that ship ───────────────────────────────────────────────────
# Tests are excluded: a class asserted in a test is not a pixel a user sees, and
# including them makes every fixture a finding.
# A read loop, not `mapfile`: macOS bash 3.2 has no mapfile.
FILES=()
while IFS= read -r _f; do
  FILES+=("$_f")
done < <(
  find "$REPO" \
    \( -name node_modules -o -name .git -o -name dist -o -name build -o -name out \
       -o -name coverage -o -name .next -o -name .astro -o -name .wrangler \
       -o -name .open-next -o -name __tests__ \) -prune -o \
    -type f \( -name '*.tsx' -o -name '*.jsx' -o -name '*.ts' -o -name '*.js' \
       -o -name '*.vue' -o -name '*.svelte' -o -name '*.astro' -o -name '*.html' \
       -o -name '*.css' -o -name '*.scss' \) -print \
  | grep -v -E '\.(test|spec)\.' || true
)
[ "${#FILES[@]}" -gt 0 ] || { echo "system-drift: no source files under $REPO" >&2; exit 2; }

# is_comment LINE — a hit inside a source comment is not a pixel anybody sees.
# Line-level, deliberately: a token named in prose ("the old --border was
# #D8DDE6") is the common case, and a character-offset parser for four comment
# syntaxes would be more machinery than the problem is worth. A trailing comment
# after real code is the case this misses, and it under-reports rather than
# inventing findings.
is_comment() {
  case "$(printf '%s' "$1" | sed 's/^[[:space:]]*//')" in
    //*|\**|/\**|"#"*|"<!--"*) return 0 ;;
    *) return 1 ;;
  esac
}

# elements TAGS — every opening tag of those kinds in the scanned files, each
# flattened onto one line as `file<TAB>line<TAB>tag`. Attributes live on the
# lines BELOW the tag name in formatted JSX, so a line-based grep sees a
# fraction of them; element-scan.mjs is what makes an attribute scan honest.
elements() {
  # The file list is passed as ARGUMENTS, not through xargs. `xargs` splits on
  # whitespace, so a path containing a space became two unreadable fragments
  # that the scanner skipped in silence — and a control in that file then passed
  # by never having been looked at.
  node "$HERE/element-scan.mjs" "$1" ${FILES[@]+"${FILES[@]}"}
}

# rel PATH — the path as the reader will look for it.
rel() { printf '%s' "${1#"$REPO"/}"; }

TMP="$(mktemp -d -t system-drift-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
FINDINGS="$TMP/findings"
: >"$FINDINGS"
P1=0; P2=0; P3=0; CLAIMS=0

# to_px LENGTH — normalise a CSS length to whole pixels, or print nothing when
# it is not a length this can compare (em, %, calc).
to_px() {
  local v
  v="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"   # not ${1,,}: bash 3.2
  case "$v" in
    *px) printf '%s' "${v%px}" | awk '{printf "%d", $1 + 0.5}' ;;
    *rem) printf '%s' "${v%rem}" | awk '{printf "%d", $1 * 16 + 0.5}' ;;
    *) return 1 ;;
  esac
}

# set_of_px LIST — the declared scale, as a `|px|px|` lookup string.
set_of_px() {
  local out="|" v px
  IFS='|' read -ra _vals <<<"${1:-}"
  for v in ${_vals[@]+"${_vals[@]}"}; do
    px="$(to_px "$v")" && out+="${px}|"
  done
  printf '%s' "$out"
}

# report SEVERITY MEASURE VALUE NOTE EVIDENCE_FILE
report() {
  local sev="$1" measure="$2" value="$3" note="$4" evidence="$5"
  local n; n="$(wc -l <"$evidence")"
  {
    printf '[%s] %s  %s — %s occurrence(s); %s\n' "$sev" "$measure" "$value" "$n" "$note"
    head -5 "$evidence" | sed 's/^/       /'
    [ "$n" -gt 5 ] && printf '       …and %s more\n' "$((n - 5))"
  } >>"$FINDINGS"
  case "$sev" in
    P1) P1=$((P1 + 1)) ;;
    P2) P2=$((P2 + 1)) ;;
    P3) P3=$((P3 + 1)) ;;
    claim) CLAIMS=$((CLAIMS + 1)) ;;
  esac
}

# severity_for COUNT — the SPEC's own boundary: 10 or more occurrences of one
# off-scale value is systemic; fewer is a one-off.
severity_for() { [ "$1" -ge 10 ] && printf 'P2' || printf 'P3'; }

# group_and_report MEASURE NOTE PAIRS_FILE — PAIRS is `value<TAB>file:line`.
group_and_report() {
  local measure="$1" note="$2" pairs="$3" value
  [ -s "$pairs" ] || return 0
  cut -f1 "$pairs" | sort -u | while IFS= read -r value; do
    awk -F'\t' -v v="$value" '$1 == v { print $2 }' "$pairs" >"$TMP/ev"
    printf '%s\t%s\n' "$(wc -l <"$TMP/ev")" "$value"
  done | sort -rn >"$TMP/order"
  while IFS=$'\t' read -r count value; do
    awk -F'\t' -v v="$value" '$1 == v { print $2 }' "$pairs" >"$TMP/ev"
    report "$(severity_for "$count")" "$measure" "$value" "$note" "$TMP/ev"
  done <"$TMP/order"
}

# ── Measure 1 — type sizes not on the declared ramp ───────────────────────
# Only LENGTHS are measured: `text-[13px]` and a raw `font-size:`. A named
# utility is deliberately not compared, because `text-muted-foreground` and
# `text-center` are not sizes and a name-based scan reports them as drift.
if [ -n "${TYPE_SCALE:-}" ]; then
  RAMP="$(set_of_px "$TYPE_SCALE")"
  : >"$TMP/type"
  grep -Hn -E 'text-\[[0-9.]+(px|rem)\]|font-size:[[:space:]]*[0-9.]+(px|rem)' ${FILES[@]+"${FILES[@]}"} 2>/dev/null \
  | while IFS= read -r hit; do
      loc="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; raw="${rest#*:}"
      is_comment "$raw" && continue
      for len in $(printf '%s' "$raw" | grep -oE 'text-\[[0-9.]+(px|rem)\]|font-size:[[:space:]]*[0-9.]+(px|rem)' | grep -oE '[0-9.]+(px|rem)'); do
        px="$(to_px "$len")" || continue
        case "$RAMP" in *"|${px}|"*) continue ;; esac
        printf '%spx\t%s:%s\n' "$px" "$(rel "$loc")" "$line"
      done
    done >"$TMP/type"
  group_and_report "type-size" "not in the declared ramp ($TYPE_SCALE)" "$TMP/type"
fi

# ── Measure 2 — colours not in the declared palette ───────────────────────
# Two shapes. A raw Tailwind palette step can never be a declared token, so it
# is off-palette by construction. A raw hex/rgb/hsl literal is compared against
# the declared values, whitespace-insensitively. `var(--x)` is a token
# reference, not a literal, and is never a finding.
if [ -n "${COLORS:-}" ]; then
  norm_colors="|$(printf '%s' "$COLORS" | tr '[:upper:]' '[:lower:]' | tr -d ' ')|"
  : >"$TMP/color"
  PALETTE='\b(bg|text|border|ring|fill|stroke|from|via|to|decoration|outline|shadow|accent|caret|divide|placeholder)-(slate|gray|grey|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b'
  grep -Hn -E "$PALETTE" ${FILES[@]+"${FILES[@]}"} 2>/dev/null \
  | while IFS= read -r hit; do
      loc="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; raw="${rest#*:}"
      is_comment "$raw" && continue
      for tok in $(printf '%s' "$raw" | grep -oE "$PALETTE"); do
        printf '%s\t%s:%s\n' "$tok" "$(rel "$loc")" "$line"
      done
    done >>"$TMP/color"
  LITERAL='#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)'
  grep -Hn -E "$LITERAL" ${FILES[@]+"${FILES[@]}"} 2>/dev/null \
  | while IFS= read -r hit; do
      loc="${hit%%:*}"; rest="${hit#*:}"; line="${rest%%:*}"; raw="${rest#*:}"
      is_comment "$raw" && continue
      for tok in $(printf '%s' "$raw" | grep -oE "$LITERAL" | tr -d ' '); do
        case "$tok" in *var\(--*) continue ;; esac
        probe="|$(printf '%s' "$tok" | tr '[:upper:]' '[:lower:]')|"
        case "$norm_colors" in *"$probe"*) continue ;; esac
        printf '%s\t%s:%s\n' "$tok" "$(rel "$loc")" "$line"
      done
    done >>"$TMP/color"
  group_and_report "off-palette-colour" "not a declared colour token" "$TMP/color"
fi

# ── Measure 3 — control heights not in the declared set ───────────────────
# Scoped to lines that render an interactive element, so `h-4` on an icon is not
# reported as a control height. That is a fact about the line, not a threshold.
if [ -n "${CONTROL_HEIGHTS:-}" ]; then
  HEIGHTS="$(set_of_px "$CONTROL_HEIGHTS")"
  : >"$TMP/height"
  elements 'button,Button,input,Input,select,Select,SelectTrigger,textarea,Textarea,Checkbox' \
  | while IFS=$'\t' read -r loc line tag; do
      # No trailing \b: a word boundary cannot follow the `]` of `h-[41px]`,
      # so every arbitrary-value height walked straight past this scan.
      for tok in $(printf '%s' "$tag" | grep -oE '(^|[^a-z0-9-])(min-)?h-(\[[0-9.]+(px|rem)\]|[0-9]+(\.[0-9]+)?)' | grep -oE '(min-)?h-(\[[0-9.]+(px|rem)\]|[0-9]+(\.[0-9]+)?)'); do
        len="$(printf '%s' "$tok" | grep -oE '[0-9.]+(px|rem)' | head -1)"
        if [ -n "$len" ]; then
          px="$(to_px "$len")" || continue
        else
          # Tailwind's numeric spacing scale: one step is 4px.
          px="$(printf '%s' "$tok" | grep -oE '[0-9.]+$' | awk '{printf "%d", $1 * 4 + 0.5}')"
        fi
        case "$HEIGHTS" in *"|${px}|"*) continue ;; esac
        printf '%s (%spx)\t%s:%s\n' "$tok" "$px" "$(rel "$loc")" "$line"
      done
    done >"$TMP/height"
  group_and_report "control-height" "not one of the declared control heights ($CONTROL_HEIGHTS)" "$TMP/height"
fi

# ── Measure 4 — recipes that map to no declared variant ───────────────────
# NOT "how many distinct recipes exist" — the system itself permits several
# variants and three sizes, so a raw count would invent a threshold. What is
# reported is an element rendering the RAW html tag for a role the design system
# has a component for: it cannot map to any declared variant because it does not
# use the component at all. A claim for the reviewer, never a defect.
# ROLE:tag pairs in a plain list — macOS bash 3.2 has no associative arrays.
for pair in BUTTON:button INPUT:input SELECT:select TEXTAREA:textarea TABLE:table; do
  role="${pair%%:*}"
  var="VARIANTS_${role}"
  [ -n "${!var:-}" ] || continue
  tag="${pair#*:}"
  : >"$TMP/variant"
  elements "$tag" | while IFS=$'\t' read -r loc line _tag; do
      printf '%s:%s\n' "$(rel "$loc")" "$line"
    done >"$TMP/variant"
  if [ -s "$TMP/variant" ]; then
    report claim "unmapped-recipe" "raw <$tag>" \
      "renders the platform element rather than a declared '${tag}' variant (${!var}) — adjudicate, not a defect" \
      "$TMP/variant"
  fi
done

# ── Measure 5 — native platform widgets (always armed) ────────────────────
# The one measure that needs no declaration: whatever the design says, an OS
# picker is not it.
: >"$TMP/native"
# Three spellings of one attribute — `type="date"`, `type='date'` and JSX's
# `type={"date"}`. A regex that knows only the first reports a different answer
# for markup that renders identically.
# The value must be a QUOTED literal, or a bare HTML attribute that ends at a
# delimiter. `type={fileType}` is a variable whose value is unknown at scan
# time, and matching it on the prefix `file` reported a blocking P1 about a
# control that may well be a text box.
NATIVE_TYPE='type=\{?["'"'"'](date|datetime-local|month|week|time|color|file|range|number)["'"'"']|type=(date|datetime-local|month|week|time|color|file|range|number)([[:space:]>/]|$)'
elements 'select' | while IFS=$'\t' read -r loc line tag; do
    case "$tag" in *appearance-none*) continue ;; esac
    printf 'native <select>\t%s:%s\n' "$(rel "$loc")" "$line"
  done >>"$TMP/native"
# `<Input type="date">` counts too: a themed wrapper does not change which
# widget the browser opens, and the OS date picker is the OS date picker.
elements 'input,Input' | while IFS=$'\t' read -r loc line tag; do
    case "$tag" in *appearance-none*) continue ;; esac
    t="$(printf '%s' "$tag" | grep -oE "$NATIVE_TYPE" | head -1 | grep -oE '(date|datetime-local|month|week|time|color|file|range|number)' | head -1)"
    [ -n "$t" ] || continue
    printf 'native <input type=%s>\t%s:%s\n' "$t" "$(rel "$loc")" "$line"
  done >>"$TMP/native"
if [ -s "$TMP/native" ]; then
  cut -f1 "$TMP/native" | sort -u | while IFS= read -r value; do
    awk -F'\t' -v v="$value" '$1 == v { print $2 }' "$TMP/native" >"$TMP/ev-native"
    report P1 "native-widget" "$value" "renders the operating system's own control, which no design system can style" "$TMP/ev-native"
  done
fi

# ── Result ────────────────────────────────────────────────────────────────
# Zero divergences prints NOTHING. No congratulation: a scanner finding nothing
# is a floor, not a verdict, and a cheerful "clean!" is exactly what let a
# stub DESIGN.md pass for months.
# The counters are re-derived from the file because every `report` above ran
# inside a `while` in a pipeline, which bash runs in a subshell.
if [ ! -s "$FINDINGS" ]; then
  exit 0
fi
cat "$FINDINGS"
p1="$(grep -c '^\[P1\]' "$FINDINGS")"
p2="$(grep -c '^\[P2\]' "$FINDINGS")"
p3="$(grep -c '^\[P3\]' "$FINDINGS")"
cl="$(grep -c '^\[claim\]' "$FINDINGS")"
echo "system-drift: P1=$p1 P2=$p2 P3=$p3 claims=$cl"
exit 1
