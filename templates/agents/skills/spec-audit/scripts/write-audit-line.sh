#!/usr/bin/env bash
# write-audit-line.sh — write format-trailer.sh's `spec-audit:` line into a spec
# folder's plan.md, replacing the Constitution Check's `- spec-audit:` item.
#
# The one rule this adds: a NON-MATERIAL skip never erases a real verdict. When
# the item already holds a review result and the new line is
# `spec-audit: skipped — non-material (…)`, the verdict and its reviewer name
# stay, with `; re-check <YYYY-MM-DD> non-material` appended (a previous
# re-check note is replaced, not stacked). Otherwise — the placeholder, an
# earlier skip, a new verdict, a user-authorized skip — the new line replaces
# the item whole.
#
# Usage:
#   write-audit-line.sh <spec-folder> "<line from format-trailer.sh>"
#
# Exit: 0 written · 1 plan.md has no `- spec-audit:` item · 2 usage (no
# plan.md, or a line that does not start with exactly one `spec-audit: `).
#
# peers:
#   .agents/skills/spec-audit/scripts/write-audit-line.test.sh
#   .agents/skills/spec-audit/scripts/format-trailer.sh
#   .agents/skills/spec/references/templates/plan.md  (the placeholder item)

set -euo pipefail

err() { echo "write-audit-line: $*" >&2; }
[ $# -eq 2 ] || { err "usage: write-audit-line.sh <spec-folder> \"<spec-audit: line>\""; exit 2; }
PLAN="${1%/}/plan.md"
NEW="$2"
[ -f "$PLAN" ] || { err "no plan.md in ${1%/}"; exit 2; }
case "$NEW" in
  "spec-audit: spec-audit:"*) err "doubled prefix — pass format-trailer.sh's output as it is"; exit 2 ;;
  "spec-audit: "?*) ;;
  *) err "not a spec-audit: line: $NEW"; exit 2 ;;
esac
grep -q '^- spec-audit:' "$PLAN" || {
  err "no '- spec-audit:' item in $PLAN — restore it from the plan template"; exit 1; }

OLD=$(grep -m1 '^- spec-audit:' "$PLAN" | sed 's/^- spec-audit: *//')
case "$NEW" in
  "spec-audit: skipped — non-material"*)
    case "$OLD" in
      "["*|skipped*) ;;   # placeholder or an earlier skip: nothing worth keeping
      *) NEW="spec-audit: ${OLD%%; re-check *}; re-check $(date +%Y-%m-%d) non-material" ;;
    esac ;;
esac

TMP=$(mktemp "${TMPDIR:-/tmp}/write-audit-line.XXXXXX")
# awk -v would read backslashes in the line as escapes; the environment does not.
AUDIT_LINE="- $NEW" awk '/^- spec-audit:/ && !done { print ENVIRON["AUDIT_LINE"]; done = 1; next } { print }' "$PLAN" >"$TMP"
cat "$TMP" >"$PLAN"
rm -f "$TMP"
