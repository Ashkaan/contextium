#!/usr/bin/env bash
# check-materiality.sh
#
# Determine whether a SPEC change is material (triggers /spec-audit) or
# non-material (skip with non-material trailer). Deterministic — no AI judgment.
#
# Material triggers (any one fires):
#   - New section added or removed
#   - § 1 Behavior contract changed
#   - § 2 Input contract changed (trigger, params, credentials)
#   - § 3 Output contract changed (KV keys, file paths, SLAs)
#   - § 4 Boundary cases added/removed/changed
#   - § 5 Acceptance command changed
#   - § 7 Data-reliability checklist changed
#   - § 8 Failure modes added/removed/changed
#   - § 9 AI Eval Plan added/removed/changed
#   - ai_judgment_features: frontmatter changed
#
# NOT material: typo fixes, wording polish, link updates, formatting,
# section reorder without content change, clarification edits.
#
# A SPEC FOLDER (`specs/NNN-name/`, the spec-kit layout) is
# accepted wherever a file is. Its triggers are the spec-kit heading names, found
# by walking each changed line back to the heading above it in that version of
# the file — hunk-header context cannot be used, because git's default funcname
# never matches a `#` heading:
#   - a heading added or removed in any file
#   - spec.md: the `**Input**` line, or anything under Clarifications (the
#     grill's decision ledger — a changed decision changes the design), User
#     Scenarios & Testing, User Story, Edge Cases, Requirements, Functional
#     Requirements, Key Entities, Success Criteria, Measurable Outcomes,
#     Acceptance
#   - plan.md: Simplest shape, Technical Context, Data sourcing, Failure modes,
#     Validation Commands
#   - tasks.md: a task line (`- [ ] T…`) added or removed
#   - a file in the folder that git-ref does not have (new or untracked)
#   - more than 5 substantive changed lines in total
# Assumptions, research.md and prose elsewhere are not triggers.
#
# Usage:
#   check-materiality.sh <spec-path | spec-folder> [<git-ref>]
#
# <git-ref> defaults to HEAD (compares staged or working-tree state vs HEAD).
# For a new file not in HEAD, the result is always "material:new-file".
#
# Output (one line to stdout):
#   material:<reason>      → caller MUST run the full /spec-audit protocol
#   non-material:<reason>  → caller MAY skip; emits skipped trailer
#
# Exit code: 0 — caller parses stdout; 1 only when a git read failed, with
# `material:git-read-failed` on stdout so the audit still runs.
#
# peers:
#   .agents/skills/spec-audit/scripts/check-materiality.test.sh
#   .agents/skills/spec/references/templates/  (the headings named above)

set -euo pipefail

SPEC_PATH="${1:?spec path required}"
GIT_REF="${2:-HEAD}"

# A git read that FAILS is not an empty one. Swallowed, a failed diff reads as
# "no-change" and a failed ls-tree as "new-file" or "nothing removed" — each a
# verdict about a spec nobody compared. So a failed read is said on stderr and
# answered `material:git-read-failed` with exit 1: the audit runs rather than
# being skipped on a read that never happened. "Did git-ref have this file?"
# is asked of `git ls-tree` (empty output = absent, a real answer), never of a
# failing `git show`, so a git error can no longer pose as "new file".
git_read_failed() { # git_read_failed <subcommand> <exit>
  echo "check-materiality: git $1 failed (exit $2) — auditing rather than trusting an empty read" >&2
  echo "material:git-read-failed"
  exit 1
}

# The ref itself resolves, or the repo has no commits yet (an unborn HEAD, where
# every file is new). Anything else is a failed read.
UNBORN=0
if ! git rev-parse --verify --quiet "${GIT_REF}^{tree}" >/dev/null; then
  if [ "$GIT_REF" = HEAD ] && git symbolic-ref -q HEAD >/dev/null && ! git rev-parse --verify --quiet HEAD >/dev/null; then
    UNBORN=1
  else
    git_read_failed rev-parse 128
  fi
fi
# at_ref <path>: 0 when git-ref has it, 1 when it does not; a git error stops.
at_ref() {
  local out
  [ "$UNBORN" -eq 0 ] || return 1
  out=$(git ls-tree --name-only "$GIT_REF" -- "$1") || git_read_failed ls-tree $?
  [ -n "$out" ]
}
# show_at_ref <path> <outfile>: the version git-ref has; a failure stops.
show_at_ref() {
  git show "${GIT_REF}:$1" >"$2" || git_read_failed show $?
}

# A spec folder git-ref has and the working tree does not: the whole spec was
# deleted, which is the most material change there is.
if [ ! -e "$SPEC_PATH" ]; then
  _gone=""
  if [ "$UNBORN" -eq 0 ]; then
    _gone=$(git ls-tree -r --name-only "$GIT_REF" -- "${SPEC_PATH%/}/") || git_read_failed ls-tree $?
  fi
fi
if [ ! -e "$SPEC_PATH" ] && [ -n "$_gone" ]; then
  echo "material:file-removed"
  exit 0
fi

if [ -d "$SPEC_PATH" ]; then
  FOLDER="${SPEC_PATH%/}"
  # Anything git-ref lacks — a new folder, or a new file in an old one.
  TREE_FILES=""
  if [ "$UNBORN" -eq 0 ]; then
    TREE_FILES=$(git ls-tree -r --name-only "$GIT_REF" -- "$FOLDER") || git_read_failed ls-tree $?
  fi
  UNTRACKED=$(git ls-files --others --exclude-standard -- "$FOLDER") || git_read_failed ls-files $?
  if [ -z "$TREE_FILES" ] || [ -n "$UNTRACKED" ]; then
    echo "material:new-file"
    exit 0
  fi
  for f in "$FOLDER"/*.md; do
    [ -f "$f" ] || continue
    at_ref "$f" || { echo "material:new-file"; exit 0; }
  done
  # A file git-ref has and the folder no longer does — deleting spec.md must
  # not read as no change.
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -e "$f" ] || { echo "material:file-removed"; exit 0; }
  done <<<"$TREE_FILES"
  MATERIAL_SPEC='^(Clarifications|User Scenarios & Testing|User Story|Edge Cases|Requirements|Functional Requirements|Key Entities|Success Criteria|Measurable Outcomes|Acceptance)'
  MATERIAL_PLAN='^(Simplest shape|Technical Context|Data sourcing|Failure modes|Validation Commands)'
  TOTAL=0; ANY=0
  for f in "$FOLDER"/*.md; do
    [ -f "$f" ] || continue
    D=$(git diff -U0 "$GIT_REF" -- "$f") || git_read_failed diff $?
    [ -n "$D" ] || continue
    ANY=1
    if grep -qE '^[+-]#{1,6} ' <<<"$D"; then echo "material:section-changed"; exit 0; fi
    n=$(grep -E '^[+-]' <<<"$D" | grep -vE '^(\+\+\+|---)' | grep -cE '^[+-][[:space:]]*[^[:space:]]' || true)
    TOTAL=$((TOTAL + n))
    base="$(basename "$f")"
    if [ "$base" = tasks.md ] && grep -qE '^[+-][[:space:]]*- \[[ xX]\] T[0-9]' <<<"$D"; then
      echo "material:task-lines-changed"; exit 0
    fi
    if [ "$base" = spec.md ] && grep -qE '^[+-]\*\*Input\*\*' <<<"$D"; then
      echo "material:input-changed"; exit 0
    fi
    case "$base" in spec.md) want="$MATERIAL_SPEC" ;; plan.md) want="$MATERIAL_PLAN" ;; *) continue ;; esac
    # The headings above each changed line, in the version the line lives in:
    # the working file for an added line, git-ref's for a removed one. BOTH the
    # nearest heading and its enclosing `##` section are printed, so a change
    # under any sub-heading of Requirements or User Scenarios counts.
    OLD_TMP=$(mktemp "${TMPDIR:-/tmp}/check-materiality.XXXXXX"); show_at_ref "$f" "$OLD_TMP"
    HEADS=$(awk -v oldf="$OLD_TMP" -v newf="$f" '
      function heads(file, arr,    l, n, h) {
        n = 0; h = ""
        h2 = ""
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

if [ ! -f "$SPEC_PATH" ]; then
  echo "non-material:spec-file-missing"
  exit 0
fi

# New file (no version in git-ref) → always material
if ! at_ref "$SPEC_PATH"; then
  echo "material:new-file"
  exit 0
fi

# Compute the diff (staged or working-tree vs git-ref)
DIFF=$(git diff "$GIT_REF" -- "$SPEC_PATH") || git_read_failed diff $?

if [ -z "$DIFF" ]; then
  echo "non-material:no-change"
  exit 0
fi

# Material trigger 1: new section added or removed (# ## ### headings)
if grep -qE '^[+-]##? ' <<<"$DIFF" ; then
  echo "material:section-changed"
  exit 0
fi

# Material trigger 2-9: changes within numbered sections (§ 1 - § 9)
# Heuristic: look at +/- lines and find the nearest preceding section header
# in the spec file. If the header is "## 1 ..." or "§ 1" etc., fire.
#
# Simpler approach: just scan for changed lines that fall under section
# headers in the SPEC file. We look at the unified-diff hunk headers
# (@@ ... @@) which often include the surrounding context.
if grep -qE '@@.*##? (1\.|1 |Behavior|2\.|2 |Input|3\.|3 |Output|4\.|4 |Boundary|5\.|5 |Acceptance|7\.|7 |Data.reliability|8\.|8 |Failure|9\.|9 |AI Eval)' <<<"$DIFF" ; then
  echo "material:numbered-section-changed"
  exit 0
fi

# The same triggers, found the way the folder branch finds them: hunk headers
# never name a `#` heading for markdown (git has no funcname rule for it), so
# the check above almost never fires. Walk each changed line back to its `##`
# section, in the version the line lives in (git-ref's for a removed line, the
# working file's for an added one). Fenced code is skipped, so a `# comment`
# inside an acceptance command cannot pose as a heading.
# Contextium adds the lean spec's Files and Done sections.
LEGACY_MATERIAL='(Behavior|Input|Output|Boundar|Acceptance|Data.reliability|Failure|AI eval|Files|Done)'
OLD_TMP=$(mktemp "${TMPDIR:-/tmp}/check-materiality.XXXXXX")
show_at_ref "$SPEC_PATH" "$OLD_TMP"
LEGACY_DIFF=$(git diff -U0 "$GIT_REF" -- "$SPEC_PATH") || git_read_failed diff $?
LEGACY_HEADS=$(printf '%s\n' "$LEGACY_DIFF" | awk -v oldf="$OLD_TMP" -v newf="$SPEC_PATH" '
  function heads(file, arr,    l, n, h2, fence) {
    n = 0; h2 = ""; fence = 0
    while ((getline l < file) > 0) {
      n++
      if (l ~ /^```/) fence = !fence
      else if (!fence && l ~ /^## /) h2 = l
      arr[n] = h2
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
' || true)
rm -f "$OLD_TMP"
# Case-insensitive: legacy SPECs write `§ 10 — AI eval plan` as often as
# `9. AI Eval Plan`, and `Data-reliability` in either case.
if grep -qiE "$LEGACY_MATERIAL" <<<"$LEGACY_HEADS"; then
  echo "material:numbered-section-changed"
  exit 0
fi

# Material trigger 10: ai_judgment_features: frontmatter changed
if grep -qE '^[+-].*ai_judgment_features:' <<<"$DIFF" ; then
  echo "material:ai-judgment-features-changed"
  exit 0
fi

# Material trigger 11 (catch-all): substantive content lines (not whitespace, not comments)
# changed but no specific trigger matched. Defer to author judgment.
#
# The marker is the FIRST character and only the first. This used to be
# `^[+-][^+-]`, which silently dropped every added Markdown BULLET — an added
# "- A row is retired only when…" reaches the diff as "+- A row is…", the second
# character is a "-", and the line was not counted. SPEC section 1 is written
# almost entirely in bullets, so a six-bullet behavior-contract amendment counted
# as one changed line and the gate returned non-material — a real narrowing of
# the behavior contract would have skipped review entirely. File headers (+++ / ---) are excluded by
# name rather than by shape, and whitespace-only changes still do not count.
SUBSTANTIVE_CHANGES=$(grep -E '^[+-]' <<<"$DIFF" \
  | grep -vE '^(\+\+\+|---)' \
  | grep -cE '^[+-][[:space:]]*[^[:space:]]' || true)
if [ "$SUBSTANTIVE_CHANGES" -gt 5 ]; then
  echo "material:substantive-changes-${SUBSTANTIVE_CHANGES}-lines"
  exit 0
fi

# Default: small textual change, no specific trigger → non-material
echo "non-material:minor-text-edit-${SUBSTANTIVE_CHANGES}-lines"
exit 0
