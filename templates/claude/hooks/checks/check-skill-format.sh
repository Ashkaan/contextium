#!/usr/bin/env bash
# check-skill-format.sh — Validate skill frontmatter format in .claude/skills/*/SKILL.md
#
# Usage:
#   check-skill-format.sh                  # check all SKILL.md files
#   check-skill-format.sh file1 file2 ...  # check only the given files
#
# Exit: 0 if all checks pass, 1 on format violations (stderr lists issues).
#
# Skill format requirements (see @rule:skill-required-frontmatter and
# @rule:skill-step-graph in .claude/rules/meta/ai-layer-authoring.md):
#   - File has `---` frontmatter block
#   - Frontmatter has: name, description, disable-model-invocation, enforces
#   - enforces: is a list (may be empty []) of `@rule:<slug>` references
#   - Every @rule:<slug> in enforces: resolves to a section in .claude/rules/
#   - When steps: is present, each step has id, kind (action|gate),
#     and either action: (for action) or gate: with tool+on_fail (for gate)
#   - When handoffs_to: is present, every entry matches a handoffs_from:
#     in the consumer skill
#
# Runs on: pre-commit (changed SKILL.md files only)

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
  # Both layouts: installed (.claude/skills) and authored (templates/claude/
  # skills). Searching only the first means running this with no arguments in the
  # repo that ships the skills checks none of them and exits 0.
  skill_dirs=()
  [[ -d .claude/skills ]] && skill_dirs+=(.claude/skills)
  [[ -d templates/claude/skills ]] && skill_dirs+=(templates/claude/skills)
  files=()
  if [[ ${#skill_dirs[@]} -gt 0 ]]; then
    while IFS= read -r _f; do
      [ -n "$_f" ] && files+=("$_f")
    done < <(find "${skill_dirs[@]}" -type f -name 'SKILL.md' 2>/dev/null)
  fi
fi

if [[ ${#files[@]} -eq 0 ]]; then
  exit 0
fi

issues=0
report() {
  echo "  SKILL-FORMAT: $1" >&2
  issues=$((issues + 1))
}

# Build the set of defined rule IDs for enforces: validation
# Both layouts: .claude/rules/ where the layer is installed, templates/claude/
# rules/ where it is authored. Without the second, the repo that ships this check
# resolves zero rule ids and flags every `enforces:` entry as dangling.
RULE_DIRS=()
[[ -d .claude/rules ]] && RULE_DIRS+=(.claude/rules)
[[ -d templates/claude/rules ]] && RULE_DIRS+=(templates/claude/rules)
[[ ${#RULE_DIRS[@]} -gt 0 ]] || RULE_DIRS=(.claude/rules)

defined_ids=$(
  find "${RULE_DIRS[@]}" -type f -name '*.md' ! -name 'README.md' -print0 2>/dev/null \
    | xargs -0 grep -h -E '^## [a-z][a-z0-9-]*$' 2>/dev/null \
    | sed 's/^## //' \
    | sort -u || true
)

rule_id_set=$(mktemp)
trap 'rm -f "$rule_id_set"' EXIT
printf '%s\n' "$defined_ids" > "$rule_id_set"

# Collect handoffs_to and handoffs_from across all skills for symmetry check
handoffs_to_tmp=$(mktemp)
handoffs_from_tmp=$(mktemp)
trap 'rm -f "$rule_id_set" "$handoffs_to_tmp" "$handoffs_from_tmp"' EXIT

for file in "${files[@]}"; do
  # The second form is for a repo that AUTHORS the layer instead of installing it
  # (contextium keeps it under templates/claude/). Without it, the repo shipping
  # this check is the one repo it never checks.
  case "$file" in
    .claude/skills/*/SKILL.md|*/claude/skills/*/SKILL.md) ;;
    *) continue ;;
  esac
  [[ -f "$file" ]] || continue

  # Check frontmatter exists
  first_line=$(head -n 1 "$file")
  if [[ "$first_line" != "---" ]]; then
    report "$file: missing YAML frontmatter (file must start with \`---\`)"
    continue
  fi

  # Extract frontmatter block
  frontmatter_end=$(awk '/^---$/{c++; if(c==2){print NR; exit}}' "$file")
  if [[ -z "$frontmatter_end" ]]; then
    report "$file: unterminated frontmatter (no closing \`---\`)"
    continue
  fi
  frontmatter=$(sed -n "2,$((frontmatter_end - 1))p" "$file")

  # Required fields per @rule:skill-required-frontmatter
  for field in name description disable-model-invocation; do
    if ! echo "$frontmatter" | grep -qE "^${field}:"; then
      report "$file: frontmatter missing required field \`${field}:\`"
    fi
  done

  # enforces: MUST be declared (may be empty list)
  if ! echo "$frontmatter" | grep -qE '^enforces:'; then
    report "$file: frontmatter missing required field \`enforces:\` (use \`enforces: []\` if none)"
  fi

  # Validate every rule-reference in enforces: resolves to a known rule.
  # Captures entries like: `- "@rule:<id>"` or `- @rule:<id>`.
  while IFS= read -r rule_ref; do
    id="${rule_ref#@rule:}"
    if ! grep -Fxq "$id" "$rule_id_set"; then
      report "$file: enforces reference \`@rule:${id}\` does not resolve (no such rule in .claude/rules/)"
    fi
  done < <(
    echo "$frontmatter" | awk '/^enforces:/{in_list=1; next} in_list && /^[a-zA-Z]/{in_list=0} in_list' \
      | grep -oE '@rule:[a-z][a-z0-9-]*' || true
  )

  # If steps: is present, validate structure (@rule:skill-step-graph +
  # @rule:skill-step-graph)
  if echo "$frontmatter" | grep -qE '^steps:'; then
    step_block=$(echo "$frontmatter" | awk '/^steps:/{in_block=1; next} in_block && /^[a-zA-Z]/{in_block=0} in_block')
    if [[ -n "$step_block" ]]; then
      # Every step entry MUST have id + kind (skill-step-graph)
      step_count=$(echo "$step_block" | grep -cE '^\s+- id:' || true)
      kind_count=$(echo "$step_block" | grep -cE '^\s+kind:' || true)
      if [[ "$step_count" -ne "$kind_count" ]]; then
        report "$file: steps: block has $step_count id(s) but $kind_count kind(s) — every step MUST have kind (action|gate)"
      fi

      # Every kind: action step MUST carry an `action:` saying what it does.
      # Without it the step graph declares a step and specifies nothing, which is
      # the same as not having declared it.
      action_issues=$(echo "$step_block" | awk '
        /^[[:space:]]+- id:/ {
          if (in_action && !seen_action) print "step `" last_id "` kind: action missing action:"
          in_action = 0; seen_action = 0
          last_id = $0; sub(/^[[:space:]]+- id:[[:space:]]*/, "", last_id)
          next
        }
        /^[[:space:]]+kind:[[:space:]]*action/ { in_action = 1; next }
        /^[[:space:]]+kind:/ { in_action = 0; next }
        in_action && /^[[:space:]]+action:/ { seen_action = 1 }
        END {
          if (in_action && !seen_action) print "step `" last_id "` kind: action missing action:"
        }
      ')
      if [[ -n "$action_issues" ]]; then
        while IFS= read -r line; do
          [[ -n "$line" ]] && report "$file: $line"
        done <<< "$action_issues"
      fi

      # Every kind: gate step MUST have tool + on_fail (skill-gate-specification).
      # Walk the step block; when we see a step whose kind is `gate`, verify
      # its child lines (before the next `- id:`) include both tool: and on_fail:.
      gate_issues=$(echo "$step_block" | awk '
        /^\s+- id:/ {
          if (in_gate && (!seen_tool || !seen_on_fail)) {
            missing = ""
            if (!seen_tool) missing = missing "tool "
            if (!seen_on_fail) missing = missing "on_fail"
            print "step `" last_id "` kind: gate missing " missing
          }
          in_gate = 0; seen_tool = 0; seen_on_fail = 0
          last_id = $0; sub(/^\s+- id:\s*/, "", last_id)
          next
        }
        /^\s+kind:\s*gate/ { in_gate = 1; next }
        /^\s+kind:/ { in_gate = 0; next }
        in_gate && /^\s+tool:/ { seen_tool = 1 }
        in_gate && /^\s+on_fail:/ { seen_on_fail = 1 }
        END {
          if (in_gate && (!seen_tool || !seen_on_fail)) {
            missing = ""
            if (!seen_tool) missing = missing "tool "
            if (!seen_on_fail) missing = missing "on_fail"
            print "step `" last_id "` kind: gate missing " missing
          }
        }
      ')
      if [[ -n "$gate_issues" ]]; then
        while IFS= read -r gi; do
          report "$file: $gi"
        done <<< "$gate_issues"
      fi

      # Body-step parity (skill-body-step-parity): every declared step id
      # MUST appear in the markdown body as a heading or bullet referencing
      # it, and every `## N.` body heading with a step-id tag MUST match a
      # declared id. Pragmatic check: collect declared step ids, then grep
      # the body (post-frontmatter) for each id as a token.
      declared_ids=$(echo "$step_block" | awk '/^\s+- id:/{sub(/^\s+- id:\s*/, ""); print}')
      body=$(sed -n "$((frontmatter_end + 1)),\$p" "$file")
      if [[ -n "$declared_ids" ]] && [[ -n "$body" ]]; then
        while IFS= read -r step_id; do
          [[ -z "$step_id" ]] && continue
          if ! grep -qFw "$step_id" <<<"$body" ; then
            report "$file: frontmatter step \`$step_id\` not referenced in skill body (body-step parity violation)"
          fi
        done <<< "$declared_ids"
      fi
    fi
  fi

  # Collect handoffs for symmetry check (processed after the loop)
  skill_name=$(echo "$frontmatter" | awk '/^name:/{sub(/^name:[ \t]*/, ""); print; exit}' | tr -d '"')
  # Both handoff lists extract the SKILL NAME. A bare word-grep here split
  # `- .claude/skills/close/SKILL.md` into five targets (claude, skills, close,
  # SKILL, md), so the symmetry check below reported 53 phantom violations and
  # its real signal was buried — the check was dead until 2026-07-26.
  #
  # TWO entry shapes are in use and both must be recognized: a full
  # `.claude/skills/<name>/SKILL.md` path, and a bare kebab name (`budget`,
  # `explain`, `reconcile-monarch`). Matching only the path shape silently
  # DROPPED every bare-name relationship instead of validating it — trading 53
  # false positives for a quieter set of false negatives. Anything else in these
  # lists (rule ids, `apps/{name}/SPEC.md`) is deliberately not a skill and is
  # skipped. Keep the two extractions identical or the comparison is meaningless.
  if echo "$frontmatter" | grep -qE '^handoffs_to:'; then
    echo "$frontmatter" | awk '/^handoffs_to:/{in_list=1; next} in_list && /^[a-zA-Z]/{in_list=0} in_list' \
      | sed -n -e 's#^[[:space:]]*-[[:space:]]*.*/skills/\([^/]*\)/SKILL\.md[[:space:]]*$#\1#p' \
               -e 's#^[[:space:]]*-[[:space:]]*\([a-z][a-z0-9-]*\)[[:space:]]*$#\1#p' \
      | while IFS= read -r target; do
        echo "$skill_name -> $target" >> "$handoffs_to_tmp"
      done
  fi
  if echo "$frontmatter" | grep -qE '^handoffs_from:'; then
    echo "$frontmatter" | awk '/^handoffs_from:/{in_list=1; next} in_list && /^[a-zA-Z]/{in_list=0} in_list' \
      | sed -n -e 's#^[[:space:]]*-[[:space:]]*.*/skills/\([^/]*\)/SKILL\.md[[:space:]]*$#\1#p' \
               -e 's#^[[:space:]]*-[[:space:]]*\([a-z][a-z0-9-]*\)[[:space:]]*$#\1#p' \
      | while IFS= read -r source; do
        echo "$source -> $skill_name" >> "$handoffs_from_tmp"
      done
  fi
done

# Cross-skill handoff symmetry: every `A -> B` in handoffs_to must have a
# matching `A -> B` in handoffs_from.
#
# This used to run ONLY with no arguments. The commit hook always passes the
# changed SKILL.md files, so in practice it never ran: a new handoffs_to: with no
# matching handoffs_from: on the other side sailed through every commit. When
# args ARE given, the producers come from those files and the consumers are
# collected from every skill in the repo — otherwise the other half of the pair
# is invisible and every handoff looks broken.
if [[ -s "$handoffs_to_tmp" ]]; then
  if [[ -n "${1:-}" ]]; then
    consumer_dirs=()
    [[ -d .claude/skills ]] && consumer_dirs+=(.claude/skills)
    [[ -d templates/claude/skills ]] && consumer_dirs+=(templates/claude/skills)
    if [[ ${#consumer_dirs[@]} -gt 0 ]]; then
      while IFS= read -r other; do
        [[ -n "$other" ]] || continue
        other_name="$(basename "$(dirname "$other")")"
        awk '/^---$/{n++; next} n==1' "$other" \
          | awk '/^handoffs_from:/{f=1; next} /^[a-z_-]+:/{f=0} f' \
          | sed -n -e 's#^[[:space:]]*-[[:space:]]*.*/skills/\([^/]*\)/SKILL\.md[[:space:]]*$#\1#p' \
                   -e 's#^[[:space:]]*-[[:space:]]*\([a-z][a-z0-9-]*\)[[:space:]]*$#\1#p' \
          | while IFS= read -r source; do
              echo "$source -> $other_name" >> "$handoffs_from_tmp"
            done
      done < <(find "${consumer_dirs[@]}" -type f -name 'SKILL.md' 2>/dev/null)
    fi
  fi
  while IFS= read -r handoff; do
    if ! grep -Fxq "$handoff" "$handoffs_from_tmp"; then
      report "handoff \`$handoff\` declared in producer's handoffs_to: but not in consumer's handoffs_from:"
    fi
  done < "$handoffs_to_tmp"
fi

if [[ $issues -gt 0 ]]; then
  echo "" >&2
  echo "⚠ $issues skill-format violation(s)" >&2
  exit 1
fi

exit 0
