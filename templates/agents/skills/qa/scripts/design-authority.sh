#!/usr/bin/env bash
# design-authority.sh — is this repo's DESIGN.md a real design system, or a stub?
#
# WHY THIS EXISTS. `/qa` delegates the entire question of what an app should
# look like to that app's own `DESIGN.md`, and that reasoning is sound — every
# app gets a fresh design, so a globally prescribed look gets in the way. What
# was missing is a check that the delegated authority contains a design at all.
# `gen-design-md.ts` auto-writes the file on a repo's first run as a token
# inventory whose creative direction is, in its own words, "intentionally
# omitted". So the four design-system checks ran against nothing and the run
# reported clean forever: a clean `/qa` on a portal its owner found plainly bad.
#
# THE RULE, in one place because three callers need it (`/qa` step-2.5,
# `system-drift.sh`, and anyone auditing a repo by hand):
#
#   A DESIGN.md is a STUB iff it carries `design-authority: generated-stub`
#   in its frontmatter, OR its body declares none of the contract headings.
#
# Both limbs, one rule. A marker alone would exempt every DESIGN.md generated
# before the marker existed — which is the whole population that has the
# problem. A heading scan alone would pass a hand-written file that lists tokens
# under a "## Colors" heading and calls it a system.
#
# Usage:
#   design-authority.sh status <repo>   AUTHORITY=real|stub|missing on stdout
#   design-authority.sh headings        the contract-heading vocabulary, one per line
#
# Exit: 0 real · 2 usage or unparseable frontmatter · 3 stub or missing · 4 no repo
#
# peers:
#   .agents/skills/qa/scripts/gen-design-md.ts
#   .agents/skills/qa/scripts/system-drift.sh
#   .agents/skills/qa/scripts/tests/design-authority.test.sh

set -uo pipefail

# The vocabulary. A design SYSTEM says something about at least one of these; a
# token inventory says nothing about any of them. Matched against markdown
# heading TEXT only, case-insensitively, so a `colors:` frontmatter key does not
# count as a heading about colour.
# DELIBERATELY NO `colour`. A generated token inventory is exactly a list of
# colours under a colour heading, and accepting that word would let the second
# limb pass the whole population this rule exists to catch.
HEADING_VOCAB='type|typography|weight|spacing|radius|radii|control|field|form|focus|status|semantic|empty|loading|error|state|elevation|shadow|motion|anatomy'

usage() {
  echo "usage: design-authority.sh status <repo> | design-authority.sh headings" >&2
  exit 2
}

case "${1:-}" in
  headings)
    printf '%s\n' "$HEADING_VOCAB"
    exit 0
    ;;
  status) ;;
  *) usage ;;
esac

REPO="${2:-}"
[ -n "$REPO" ] || usage
[ -d "$REPO" ] || { echo "design-authority: no such directory: $REPO" >&2; exit 4; }

FILE="$REPO/DESIGN.md"
if [ ! -f "$FILE" ]; then
  echo "AUTHORITY=missing"
  echo "REASON=no DESIGN.md in $REPO — /qa has no design to check this app against"
  exit 3
fi

# ── Split frontmatter from body ───────────────────────────────────────────
# A file that opens with `---` must close it. An unterminated block is a parse
# failure, not an empty frontmatter: reading it as empty would silently scan a
# partial file and report a clean result.
if [ "$(head -n1 "$FILE")" = "---" ]; then
  fm_end="$(awk 'NR>1 && $0=="---" { print NR; exit }' "$FILE")"
  if [ -z "$fm_end" ]; then
    echo "AUTHORITY=malformed" >&2
    echo "REASON=$FILE opens a --- frontmatter block that is never closed" >&2
    exit 2
  fi
  frontmatter="$(sed -n "2,$((fm_end - 1))p" "$FILE")"
  body="$(sed -n "$((fm_end + 1)),\$p" "$FILE")"
else
  frontmatter=""
  body="$(cat "$FILE")"
fi

# ── Limb one: the generator's own marker ──────────────────────────────────
# The SCALAR, not the line. `design-authority: "generated-stub"` and
# `design-authority: generated-stub  # written by /qa` are the same declaration
# as the bare form, and an anchored line match let both of them through.
marker="$(printf '%s\n' "$frontmatter" \
  | sed -n 's/^[[:space:]]*design-authority:[[:space:]]*//p' \
  | head -1 \
  | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//; s/^["'"'"']//; s/["'"'"']$//; s/[[:space:]]*$//')"
if [ "$marker" = "generated-stub" ]; then
  echo "AUTHORITY=stub"
  echo "REASON=$FILE declares design-authority: generated-stub — it is an auto-extracted token list, not a design system"
  exit 3
fi

# ── Limb two: a body that declares no contract ────────────────────────────
declared="$(printf '%s\n' "$body" \
  | grep -E '^#{1,4}[[:space:]]+' \
  | grep -iEc "^#{1,4}[[:space:]]+.*($HEADING_VOCAB)" || true)"
if [ "${declared:-0}" -eq 0 ]; then
  echo "AUTHORITY=stub"
  echo "REASON=$FILE declares no design contract — no heading about $(printf '%s' "$HEADING_VOCAB" | tr '|' ' ')"
  exit 3
fi

echo "AUTHORITY=real"
echo "REASON=$FILE declares $declared design contract heading(s)"
exit 0
