#!/usr/bin/env bash
# check-materiality.sh — is this spec change worth a full audit?
#
# Deterministic, no AI judgment. A typo fix should not spend a reviewer call; a
# changed behavior contract always should. The caller reads stdout and either
# runs the audit or writes the skipped line.
#
# A SPEC FOLDER (`specs/NNN-name/`, spec-kit's layout) is material when:
#   - git-ref lacks the folder or any file in it (new or untracked)
#   - a file git-ref has is gone, or the whole folder is gone
#   - a heading is added or removed in any file
#   - spec.md: the `**Input**` line changes, or anything under Clarifications
#     (the decision ledger), User Scenarios & Testing, User Story, Edge Cases,
#     Requirements, Functional Requirements, Key Entities, Success Criteria,
#     Measurable Outcomes or Acceptance
#   - plan.md: anything under Simplest shape, Technical Context, Data sourcing,
#     Failure modes or Validation Commands
#   - tasks.md: a task line (`- [ ] T…`) is added or removed
#   - more than 5 substantive lines change in total
# Assumptions, research.md and prose elsewhere are not triggers.
# Each changed line is walked back to the heading above it in the version the
# line lives in (git-ref's for a removed line, the working file's for an added
# one) — diff hunk headers cannot be used, because git names no `#` heading in
# them for plain markdown.
#
# A SINGLE FILE (the older lean spec, `*.spec.md`, or an app's `SPEC.md`) is
# material when it is new, a heading changes, the Behavior, Files or Done
# section's content changes, or more than 5 substantive lines change. The Ask
# section is not a trigger by itself: it quotes the user, and fixing a typo in a
# quotation is not a design change.
#
# NOT MATERIAL: typo fixes, wording polish, link updates, formatting.
#
# Usage:
#   check-materiality.sh <spec-folder | spec-file> [<git-ref>]
#
# <git-ref> defaults to HEAD: the working tree is compared with the last commit.
#
# Output (one line on stdout):
#   material:<reason>      → the caller MUST run the full audit
#   non-material:<reason>  → the caller MAY skip and write the skipped line
#
# Exit: 0 always. The caller parses stdout; a materiality check that can fail
# closed would block spec work over its own bugs.
#
# peers:
#   .agents/skills/spec-audit/scripts/check-materiality.test.sh
#   .agents/skills/spec/references/templates/  (the headings named above)

set -euo pipefail

SPEC_PATH="${1:?spec path required}"
GIT_REF="${2:-HEAD}"

# A substantive changed line: a +/- line with something other than whitespace
# after the marker. The marker is the FIRST character only — an added bullet
# reaches the diff as `+- item`, and a `^[+-][^+-]` pattern would drop it, so a
# contract written in bullets would never count. File headers are excluded by
# name.
substantive() {
  grep -E '^[+-]' <<<"$1" | grep -vE '^(\+\+\+|---)' | grep -cE '^[+-][[:space:]]*[^[:space:]]' || true
}

# ── A spec folder ─────────────────────────────────────────────────────────
# The folder is gone from the working tree but git-ref has it: the whole spec
# was deleted, which is the most material change there is.
if [ ! -e "$SPEC_PATH" ] && [ -n "$(git ls-tree -r --name-only "$GIT_REF" -- "${SPEC_PATH%/}/" 2>/dev/null)" ]; then
  echo "material:file-removed"
  exit 0
fi

if [ -d "$SPEC_PATH" ]; then
  FOLDER="${SPEC_PATH%/}"
  if [ -z "$(git ls-tree -r --name-only "$GIT_REF" -- "$FOLDER" 2>/dev/null)" ] \
     || [ -n "$(git ls-files --others --exclude-standard -- "$FOLDER" 2>/dev/null)" ]; then
    echo "material:new-file"
    exit 0
  fi
  for f in "$FOLDER"/*.md; do
    [ -f "$f" ] || continue
    git show "${GIT_REF}:${f}" >/dev/null 2>&1 || { echo "material:new-file"; exit 0; }
  done
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -e "$f" ] || { echo "material:file-removed"; exit 0; }
  done < <(git ls-tree -r --name-only "$GIT_REF" -- "$FOLDER" 2>/dev/null)

  MATERIAL_SPEC='^(Clarifications|User Scenarios & Testing|User Story|Edge Cases|Requirements|Functional Requirements|Key Entities|Success Criteria|Measurable Outcomes|Acceptance)'
  MATERIAL_PLAN='^(Simplest shape|Technical Context|Data sourcing|Failure modes|Validation Commands)'
  TOTAL=0; ANY=0
  for f in "$FOLDER"/*.md; do
    [ -f "$f" ] || continue
    D=$(git diff -U0 "$GIT_REF" -- "$f" 2>/dev/null || true)
    [ -n "$D" ] || continue
    ANY=1
    if grep -qE '^[+-]#{1,6} ' <<<"$D"; then echo "material:section-changed"; exit 0; fi
    TOTAL=$((TOTAL + $(substantive "$D")))
    base="$(basename "$f")"
    if [ "$base" = tasks.md ] && grep -qE '^[+-][[:space:]]*- \[[ xX]\] T[0-9]' <<<"$D"; then
      echo "material:task-lines-changed"; exit 0
    fi
    if [ "$base" = spec.md ] && grep -qE '^[+-]\*\*Input\*\*' <<<"$D"; then
      echo "material:input-changed"; exit 0
    fi
    case "$base" in spec.md) want="$MATERIAL_SPEC" ;; plan.md) want="$MATERIAL_PLAN" ;; *) continue ;; esac
    # For each changed line, the nearest heading above it AND its enclosing `##`
    # section, so a change under any sub-heading of Requirements counts.
    OLD_TMP=$(mktemp "${TMPDIR:-/tmp}/check-materiality.XXXXXX")
    git show "${GIT_REF}:${f}" >"$OLD_TMP" 2>/dev/null || true
    HEADS=$(awk -v oldf="$OLD_TMP" -v newf="$f" '
      function heads(file, arr,    l, n, h, h2) {
        n = 0; h = ""; h2 = ""
        while ((getline l < file) > 0) {
          n++
          if (l ~ /^#+ /) { h = l; sub(/^#+ +/, "", h); if (l ~ /^## /) h2 = h }
          arr[n] = h "\n" h2
        }
        close(file)
      }
      BEGIN { heads(oldf, OH); heads(newf, NH) }
      /^@@/ {
        split($2, o, ","); split($3, nw, ",")
        ol = substr(o[1], 2) + 0; nl = substr(nw[1], 2) + 0
        next
      }
      /^(\+\+\+|---)/ { next }
      /^-/ { print OH[ol]; ol++; next }
      /^\+/ { print NH[nl]; nl++; next }
    ' <<<"$D")
    rm -f "$OLD_TMP"
    if grep -qE "$want" <<<"$HEADS"; then
      echo "material:numbered-section-changed"; exit 0
    fi
  done
  [ "$ANY" -eq 1 ] || { echo "non-material:no-change"; exit 0; }
  if [ "$TOTAL" -gt 5 ]; then echo "material:substantive-changes-${TOTAL}-lines"; exit 0; fi
  echo "non-material:minor-text-edit-${TOTAL}-lines"
  exit 0
fi

# ── A single file ─────────────────────────────────────────────────────────
if [ ! -f "$SPEC_PATH" ]; then
  echo "non-material:spec-file-missing"
  exit 0
fi

# No committed version: new, and a spec nobody has reviewed has no "small change".
if ! git show "${GIT_REF}:${SPEC_PATH}" >/dev/null 2>&1; then
  echo "material:new-file"
  exit 0
fi

DIFF="$(git diff "$GIT_REF" -- "$SPEC_PATH" 2>/dev/null || true)"
if [ -z "$DIFF" ]; then
  echo "non-material:no-change"
  exit 0
fi

OLD="$(mktemp "${TMPDIR:-/tmp}/check-materiality.XXXXXX")"
# shellcheck disable=SC2064 # expand the path now, not at trap time
trap "rm -f '$OLD'" EXIT
git show "${GIT_REF}:${SPEC_PATH}" > "$OLD" 2>/dev/null || true

headings() { grep -E '^#{1,3} ' "$1" 2>/dev/null || true; }
if ! diff -q <(headings "$OLD") <(headings "$SPEC_PATH") >/dev/null 2>&1; then
  echo "material:section-changed"
  exit 0
fi

# The contract sections, compared by CONTENT in both versions.
section() {
  awk -v want="$2" '
    /^#{1,3} / { inside = ($0 ~ want) ? 1 : 0; next }
    inside { print }
  ' "$1"
}
for pair in "Behavior:behavior" "Files:files" "Done:done"; do
  pattern="${pair%%:*}"
  label="${pair##*:}"
  if ! diff -q <(section "$OLD" "$pattern") <(section "$SPEC_PATH" "$pattern") >/dev/null 2>&1; then
    echo "material:${label}-section-changed"
    exit 0
  fi
done

N="$(substantive "$DIFF")"
if [ "$N" -gt 5 ]; then
  echo "material:substantive-changes-${N}-lines"
  exit 0
fi
echo "non-material:minor-text-edit-${N}-lines"
exit 0
