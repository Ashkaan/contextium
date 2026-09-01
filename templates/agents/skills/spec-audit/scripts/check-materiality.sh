#!/usr/bin/env bash
# check-materiality.sh — is this SPEC change worth a full audit?
#
# Deterministic, no AI judgment. A typo fix should not spend a reviewer call; a
# changed behavior contract always should. The caller reads stdout and either
# runs the audit or emits a skipped trailer.
#
# MATERIAL (any one fires):
#   - the SPEC is new (nothing to compare against)
#   - a section heading was added or removed
#   - the Behavior, Files, or Done section changed
#   - more than 5 substantive lines changed anywhere
#
# NOT MATERIAL: typo fixes, wording polish, link updates, formatting, reordering
# without content change.
#
# USAGE
#   check-materiality.sh <spec-path> [<git-ref>]
#
# <git-ref> defaults to HEAD, so this compares the working-tree/staged SPEC
# against the last committed version.
#
# OUTPUT (one line on stdout):
#   material:<reason>      → the caller MUST run the full audit
#   non-material:<reason>  → the caller MAY skip and emit the skipped trailer
#
# EXIT: 0 always. The caller parses stdout; a materiality check that can fail
# closed would block SPEC work over its own bugs.

set -euo pipefail

SPEC_PATH="${1:?spec path required}"
GIT_REF="${2:-HEAD}"

if [ ! -f "$SPEC_PATH" ]; then
  echo "non-material:spec-file-missing"
  exit 0
fi

# A SPEC with no committed version is new, and a new SPEC is always material —
# there is no "small change" to a document nobody has reviewed yet.
if ! git show "${GIT_REF}:${SPEC_PATH}" >/dev/null 2>&1; then
  echo "material:new-file"
  exit 0
fi

DIFF="$(git diff "$GIT_REF" -- "$SPEC_PATH" 2>/dev/null || true)"

if [ -z "$DIFF" ]; then
  echo "non-material:no-change"
  exit 0
fi

OLD="$(mktemp)"; NEW="$(mktemp)"
# shellcheck disable=SC2064 # expand the paths now, not at trap time
trap "rm -f '$OLD' '$NEW'" EXIT
git show "${GIT_REF}:${SPEC_PATH}" > "$OLD" 2>/dev/null || true
cp "$SPEC_PATH" "$NEW"

headings() { grep -E '^#{1,3} ' "$1" 2>/dev/null || true; }

# A heading added, removed, or renamed changes the SPEC's shape, not its wording.
if ! diff -q <(headings "$OLD") <(headings "$NEW") >/dev/null 2>&1; then
  echo "material:section-changed"
  exit 0
fi

# Compare the contract sections by CONTENT, not by reading the diff's hunk
# headers. Hunk headers only name the enclosing heading when git has a diff
# driver for the file type, and for plain markdown it usually does not — so a
# rewritten behavior contract reads as an ordinary few-line edit and slips
# through as non-material. Pulling each section out of both versions and
# comparing them cannot miss that.
section() {
  awk -v want="$2" '
    /^#{1,3} / { inside = ($0 ~ want) ? 1 : 0; next }
    inside { print }
  ' "$1"
}

for pair in "2.*Behavior:behavior" "3.*Files:files" "4.*Done:done"; do
  pattern="${pair%%:*}"
  label="${pair##*:}"
  if ! diff -q <(section "$OLD" "$pattern") <(section "$NEW" "$pattern") >/dev/null 2>&1; then
    echo "material:${label}-section-changed"
    exit 0
  fi
done

# Section 1 (Ask) is deliberately not in that list: it holds the human's own
# words, and fixing a typo in a quotation is not a design change. A genuine
# re-ask rewrites enough to trip the line-count trigger below.

# Catch-all. Below this line a change is polish; above it, something substantive
# moved even if no trigger above named it.
SUBSTANTIVE_CHANGES="$(grep -cE '^[+-][^+-]' <<<"$DIFF" || true)"
if [ "$SUBSTANTIVE_CHANGES" -gt 5 ]; then
  echo "material:substantive-changes-${SUBSTANTIVE_CHANGES}-lines"
  exit 0
fi

echo "non-material:minor-text-edit-${SUBSTANTIVE_CHANGES}-lines"
exit 0
