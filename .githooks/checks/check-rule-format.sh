#!/usr/bin/env bash
# check-rule-format.sh — Validate the rule format in .agents/rules/*.md
#
# Usage:
#   check-rule-format.sh                  # check all .agents/rules/*.md files
#   check-rule-format.sh file1 file2 ...  # check only the given files
#
# Exit: 0 if all checks pass, 1 on format violations (stderr lists issues).
#
# Rule format requirements (see .agents/rules/meta/ai-layer-authoring.md):
#   - File has `---` frontmatter block (at minimum `topic:` or `paths:` field)
#   - Every `## <rule-id>` section ends with a line matching `[YYYY-MM-DD]`
#   - Evidence date is NOT "TBD", "none", "YYYY-MM-DD" (literal placeholder), or empty
#   - No duplicate rule-id headers within a single file
#
# Runs on: pre-commit (changed rule files only)

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist. A check that dies with
# "mapfile: command not found" takes every commit on that machine down with it.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

# Collect files to check
if [[ $# -gt 0 ]]; then
  files=("$@")
else
  files=()
  while IFS= read -r _f; do
    [ -n "$_f" ] && files+=("$_f")
  done < <(find .agents/rules templates/agents/rules -type f -name '*.md' ! -name 'README.md' 2>/dev/null)
fi

if [[ ${#files[@]} -eq 0 ]]; then
  exit 0
fi

issues=0
report() {
  echo "  RULE-FORMAT: $1" >&2
  issues=$((issues + 1))
}

# Strip the repo root off an absolute path so the scope patterns below can match.
# /author's verify.sh hands these checks an ABSOLUTE path, which matched no arm at
# all — so the file was skipped and the check reported success over a file nobody
# validated. Anything already relative, or outside the repo, is returned as-is.
# Args: $1=path
to_repo_relative() {
  local p="$1" root
  root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$root" && "$p" == "$root"/* ]]; then
    printf '%s' "${p#"$root"/}"
  else
    printf '%s' "$p"
  fi
}

for file in "${files[@]}"; do
  file="$(to_repo_relative "$file")"
  # Only audit files under .agents/rules/ (other markdown is out-of-scope).
  # Matches flat and nested rule files. The second pattern is for a repo that
  # AUTHORS the layer rather than installing it (contextium itself keeps it under
  # templates/agents/), so the same check guards both — otherwise the repo that
  # ships this check is the one repo it silently skips.
  case "$file" in
    .agents/rules/*.md) ;;
    */agents/rules/*.md) ;;
    *) continue ;;
  esac
  [[ "$(basename "$file")" == "README.md" ]] && continue
  [[ -f "$file" ]] || continue

  # Check frontmatter exists
  first_line=$(head -n 1 "$file")
  if [[ "$first_line" != "---" ]]; then
    report "$file: missing YAML frontmatter (file must start with \`---\`)"
    continue
  fi

  # Frontmatter must contain either `topic:` or `paths:` (or both)
  frontmatter_end=$(awk '/^---$/{c++; if(c==2){print NR; exit}}' "$file")
  if [[ -z "$frontmatter_end" ]]; then
    report "$file: unterminated frontmatter (no closing \`---\`)"
    continue
  fi
  frontmatter=$(sed -n "2,$((frontmatter_end - 1))p" "$file")
  if ! echo "$frontmatter" | grep -qE '^(topic|paths):'; then
    report "$file: frontmatter missing \`topic:\` or \`paths:\` field"
  fi

  # Collect rule IDs; check for duplicates. `|| true` so a path-scoped
  # reference/pointer file with no lowercase-kebab `## <id>` headers doesn't
  # crash the script under `set -e` when grep finds no match (exit 1).
  rule_ids=$(grep -E '^## [a-z][a-z0-9-]*$' "$file" | sed 's/^## //' | sort || true)
  if [[ -n "$rule_ids" ]]; then
    dupes=$(echo "$rule_ids" | uniq -d)
    if [[ -n "$dupes" ]]; then
      while IFS= read -r dup; do
        report "$file: duplicate rule-id \`$dup\`"
      done <<< "$dupes"
    fi
  fi

  # For each rule section, verify [YYYY-MM-DD] evidence date is present + valid
  awk -v file="$file" '
    /^## [a-z][a-z0-9-]*$/ {
      if (rule_id != "") {
        check_evidence(rule_id, buf)
      }
      rule_id = substr($0, 4)
      buf = ""
      next
    }
    rule_id != "" { buf = buf $0 "\n" }
    END {
      if (rule_id != "") check_evidence(rule_id, buf)
    }
    function check_evidence(id, body,   date_match) {
      if (match(body, /\[[0-9]{4}-[0-9]{2}-[0-9]{2}\]/)) {
        date_match = substr(body, RSTART + 1, RLENGTH - 2)
        # Reject placeholder/sentinel dates
        if (date_match == "YYYY-MM-DD" || date_match == "0000-00-00") {
          print file ": rule `" id "` has placeholder evidence date: " date_match > "/dev/stderr"
          exit_code = 1
        }
      } else if (match(body, /\[(TBD|tbd|none|N\/A|n\/a)\]/)) {
        print file ": rule `" id "` has non-date evidence marker (TBD/none/N/A forbidden)" > "/dev/stderr"
        exit_code = 1
      } else {
        print file ": rule `" id "` missing [YYYY-MM-DD] evidence date" > "/dev/stderr"
        exit_code = 1
      }
    }
  ' "$file" 2> /tmp/rule-format-awk-$$.txt
  if [[ -s /tmp/rule-format-awk-$$.txt ]]; then
    while IFS= read -r line; do
      report "${line#*: }"
    done < /tmp/rule-format-awk-$$.txt
  fi
  rm -f /tmp/rule-format-awk-$$.txt
done

# Additional: check no duplicate rule-ids ACROSS files (IDs must be globally unique)
if [[ ${#files[@]} -gt 1 ]] || [[ ${1:-} == "" ]]; then
  # Both layouts, for the same reason check-rule-refs.sh looks in both: in the
  # repo that AUTHORS the layer the rules live under templates/agents/rules/, and
  # scanning only .agents/rules/ there compares nothing against nothing.
  dup_dirs=()
  [[ -d .agents/rules ]] && dup_dirs+=(.agents/rules)
  [[ -d templates/agents/rules ]] && dup_dirs+=(templates/agents/rules)
  [[ ${#dup_dirs[@]} -gt 0 ]] || dup_dirs=(.agents/rules)

  all_ids=()
  while IFS= read -r _id; do
    [ -n "$_id" ] && all_ids+=("$_id")
  done < <(
    find "${dup_dirs[@]}" -type f -name '*.md' ! -name 'README.md' -print0 \
      | xargs -0 grep -H -E '^## [a-z][a-z0-9-]*$' 2>/dev/null \
      | sed -E 's|^(.+):## (.+)$|\2\t\1|' \
      | sort
  )
  if [[ ${#all_ids[@]} -gt 0 ]]; then
    cross_dupes=$(printf '%s\n' "${all_ids[@]}" | awk -F '\t' '{print $1}' | uniq -d)
    if [[ -n "$cross_dupes" ]]; then
      while IFS= read -r dup_id; do
        homes=$(printf '%s\n' "${all_ids[@]}" | awk -F '\t' -v id="$dup_id" '$1 == id {print $2}' | tr '\n' ' ')
        report "rule-id \`$dup_id\` defined in multiple files: $homes"
      done <<< "$cross_dupes"
    fi
  fi
fi

if [[ $issues -gt 0 ]]; then
  echo "" >&2
  echo "⚠ $issues rule-format violation(s)" >&2
  exit 1
fi

exit 0
