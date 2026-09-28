#!/usr/bin/env bash
# check-rule-refs.sh — Validate @rule:<id> references across the repo
#
# Usage:
#   check-rule-refs.sh         # scan entire repo for @rule: references
#   check-rule-refs.sh file1 ... # check only the given files
#
# Exit: 0 if all ACTIVE-file references resolve, 1 on any dangling reference
#       in an ACTIVE file. Dangling references in HISTORICAL files (journal/
#       and projects/) are reported as an informational count and do NOT fail
#       the check — those are immutable records that correctly cited rules
#       that existed at the time, before a later rename.
#
# A dangling reference is any `@rule:<id>` whose `<id>` does NOT match a
# `## <id>` section header in a `.agents/rules/**/*.md` file.

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist. A check that dies with
# "mapfile: command not found" takes every commit on that machine down with it.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# The set of defined rule IDs: every `## <id>` header under .agents/rules/.
# Look in both layouts: .agents/rules/ in a project that INSTALLED the layer,
# templates/agents/rules/ in the repo that authors it. Without the second, the
# repo shipping this check finds zero defined ids and calls every citation in it
# dangling.
RULE_DIRS=()
[[ -d .agents/rules ]] && RULE_DIRS+=(.agents/rules)
[[ -d templates/agents/rules ]] && RULE_DIRS+=(templates/agents/rules)

if [[ ${#RULE_DIRS[@]} -eq 0 ]]; then
  echo "check-rule-refs: no rules directory found — nothing to check." >&2
  exit 0
fi

# `|| true` on the pipeline: with no matching files xargs exits 123, and under
# `set -e` that kills the check with no output at all — a commit refused for a
# reason nobody can see.
defined_ids=$(
  find "${RULE_DIRS[@]}" -type f -name '*.md' ! -name 'README.md' -print0 2>/dev/null \
    | xargs -0 grep -h -E '^## [a-z][a-z0-9-]*$' 2>/dev/null \
    | sed 's/^## //' \
    | sort -u || true
)

if [[ -z "$defined_ids" ]]; then
  echo "check-rule-refs: no rules defined yet — nothing to check." >&2
  exit 0
fi

if [[ -z "$defined_ids" ]]; then
  echo "  RULE-REFS: no rule IDs found in .agents/rules/ — skipping ref check" >&2
  exit 0
fi

# Build temp file for grep -f lookups
id_set=$(mktemp)
trap 'rm -f "$id_set"' EXIT
printf '%s\n' "$defined_ids" > "$id_set"

# Collect files to scan. With explicit args, scan exactly those. Otherwise
# scan every tracked text file — the active/historical split below (not a
# pre-filter) decides what blocks vs. what is informational.
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  files=()
  while IFS= read -r _f; do
    [ -n "$_f" ] && files+=("$_f")
  done < <(
    git ls-files | grep -E '\.(md|ts|tsx|sh|yaml|yml|json|astro)$'
  )
fi

active_issues=0
historical_count=0

is_historical() {
  # journal/ and projects/ are immutable records: they cited rules that existed
  # when they were written, and rewriting history to satisfy a later rename is
  # worse than a stale citation. Dangling refs there are counted, not blocked.
  [[ "$1" == journal/* || "$1" == projects/* ]]
}

for file in "${files[@]}"; do
  [[ -f "$file" ]] || continue

  while IFS= read -r line_and_match; do
    lineno="${line_and_match%%:*}"
    match="${line_and_match#*:}"
    id="${match#@rule:}"
    grep -Fxq "$id" "$id_set" && continue
    if is_historical "$file"; then
      historical_count=$((historical_count + 1))
    else
      echo "  RULE-REFS: $file:$lineno: dangling reference \`@rule:$id\` (no such rule defined)" >&2
      active_issues=$((active_issues + 1))
    fi
  done < <(
    # `grep -P` is GNU-only: BSD grep on macOS rejects it, and with the `|| true`
    # that made every scan return "no matches" — a gate reporting success over
    # citations nobody checked. So: match with portable -E, then drop the family
    # forms (`@rule:style-*`, `@rule:adversarial-`) in awk, which is where the
    # lookahead used to do it. A trailing `-` or `*` means the text is naming a
    # FAMILY of rules in prose rather than citing one.
    grep -noE '@rule:[a-z][a-z0-9-]*[-*]?' "$file" 2>/dev/null \
      | awk -F: '{
          line = $1
          match($0, /@rule:[a-z][a-z0-9-]*[-*]?/)
          ref = substr($0, RSTART, RLENGTH)
          last = substr(ref, length(ref), 1)
          if (last == "-" || last == "*") next
          print line ":" ref
        }' || true
  )
done

if [[ "$historical_count" -gt 0 ]]; then
  echo "  RULE-REFS: ℹ $historical_count dangling @rule ref(s) in historical journal/projects docs (informational — immutable records, not fixed)" >&2
fi

if [[ "$active_issues" -gt 0 ]]; then
  echo "" >&2
  echo "✗ $active_issues dangling @rule:<id> reference(s) in ACTIVE files — fix at the source or rename the citation" >&2
  exit 1
fi

exit 0
