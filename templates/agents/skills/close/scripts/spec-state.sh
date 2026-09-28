#!/usr/bin/env bash
# spec-state.sh — for one project folder, say what state each spec is in.
# THE one place that answers "is this spec finished?"; next-implement-command.sh,
# project-remaining-work.sh and project/scripts/detect-stage.sh all call it
# instead of each re-deriving the rule from filenames.
#
# Completeness is a CLAIM somebody made, not a fact about which files exist, so
# a declaration always beats a filename.
#
# A spec folder, `specs/NNN-name/`, is named by its path and its state is its
# own `report.md` frontmatter `spec-status:` — no report.md → none, a report
# that does not claim completion → partial. Nothing else completes a folder.
#
# A loose `<name>.spec.md` (the layout before spec folders) is read the old
# way, most trusted first:
#   1. report frontmatter — `spec: <name>` + `spec-status: complete|partial`
#   2. report prose       — `**SPEC**: ...<name>.spec.md` + `**Status**: ...`
#   3. the filename       — exact `<name>-report.md` is complete; a qualified
#      `<name>-<rest>-report.md` is PARTIAL (a report named for one slice of
#      the spec does not prove the whole spec shipped)
#
# A status counts as complete only when it opens with COMPLETE, SHIPPED or DONE.
# `CODE COMPLETE`, `PARTIAL` and `NOT IMPLEMENTED` are all partial: this fails
# toward naming a loose end rather than hiding one.
#
# Usage: spec-state.sh <project-folder>
# Output: one line per spec, sorted, tab-separated —
#   <name>	complete|partial|none	<evidence>
# where <name> is a loose stem (`alpha`) or a spec folder (`specs/001-alpha`).
#
# peers:
#   .agents/skills/close/scripts/spec-state.test.sh

set -uo pipefail

err() { echo "Error: $*" >&2; }
[[ $# -eq 1 ]] || { err "usage: spec-state.sh <project-folder>"; exit 2; }
project_dir="$1"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

specs=(); reports=(); folder_specs=()
for f in "$project_dir"/*.spec.md; do
  [[ -f "$f" ]] || continue
  b="$(basename "$f")"; specs+=("${b%.spec.md}")
done
for f in "$project_dir"/*-report.md; do
  [[ -f "$f" ]] && reports+=("$f")
done
for f in "$project_dir"/specs/*/spec.md; do
  [[ -f "$f" ]] || continue
  folder_specs+=("specs/$(basename "$(dirname "$f")")")
done
[[ ${#specs[@]} -gt 0 || ${#folder_specs[@]} -gt 0 ]] || exit 0

# Is this status string a completion claim? Deliberately narrow.
is_complete_claim() {
  local v; v="$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]' | sed -E 's/^[[:space:]]+//')"
  case "$v" in
    COMPLETE|COMPLETE[^A-Z]*|SHIPPED|SHIPPED[^A-Z]*|DONE|DONE[^A-Z]*) return 0 ;;
    *) return 1 ;;
  esac
}

# The frontmatter value of <key> in the first 20 lines of <file>, unquoted.
fm_value() {
  [[ "$(head -n 1 "$2" 2>/dev/null)" == "---" ]] || return 0
  head -n 20 "$2" | sed -nE "s/^$1:[[:space:]]*\"?([^\"]+)\"?[[:space:]]*\$/\\1/p" | head -n1
}

# Which loose spec does this report belong to, and what does it claim?
# Echoes "<spec-name>|<claim>|<evidence>"; empty when it belongs to none.
classify() {
  local rf="$1" head decl status spec_name="" claim="" evidence=""
  head="$(head -n 20 "$rf" 2>/dev/null)"

  # 1. frontmatter
  decl="$(fm_value spec "$rf")"
  status="$(fm_value spec-status "$rf")"
  if [[ -n "$decl" ]]; then
    spec_name="$(basename "$decl")"; spec_name="${spec_name%.spec.md}"
    if [[ -n "$status" ]]; then
      if is_complete_claim "$status"; then claim=complete; else claim=partial; fi
      evidence="frontmatter"
    fi
  fi

  # 2. prose
  if [[ -z "$spec_name" || -z "$claim" ]]; then
    decl="$(grep -iE '^\*\*SPEC\*\*:' <<<"$head" | head -n1 | grep -oE '[A-Za-z0-9._-]+\.spec\.md' | head -n1)"
    status="$(grep -iE '\*\*Status\*\*:' <<<"$head" | head -n1 | sed -E 's/.*\*\*[Ss][Tt][Aa][Tt][Uu][Ss]\*\*:[[:space:]]*//')"
    if [[ -z "$spec_name" && -n "$decl" ]]; then
      spec_name="${decl%.spec.md}"
    fi
    if [[ -z "$claim" && -n "$status" ]]; then
      if is_complete_claim "$status"; then claim=complete; else claim=partial; fi
      evidence="declared-status"
    fi
  fi

  # 3. filename — the longest spec name the report stem starts with wins, so a
  # sibling `alpha-2.spec.md` keeps `alpha-2-report.md` away from `alpha`.
  local stem; stem="$(basename "$rf")"; stem="${stem%-report.md}"
  if [[ -z "$spec_name" ]]; then
    local best="" s
    for s in ${specs[@]+"${specs[@]}"}; do
      if [[ "$stem" == "$s" || "$stem" == "$s"-* ]]; then
        [[ ${#s} -gt ${#best} ]] && best="$s"
      fi
    done
    spec_name="$best"
    [[ -n "$spec_name" ]] || return 0
    if [[ -z "$claim" ]]; then
      if [[ "$stem" == "$spec_name" ]]; then claim=complete; evidence="exact-filename"
      else claim=partial; evidence="qualified-filename"; fi
    fi
  fi
  [[ -n "$spec_name" ]] || return 0
  [[ -n "$claim" ]] || { claim=partial; evidence="${evidence:-report-present}"; }
  printf '%s|%s|%s\n' "$spec_name" "$claim" "$evidence"
}

# Classify every report once: "<name>|<claim>|<evidence>|<report basename>".
classified=()
for rf in ${reports[@]+"${reports[@]}"}; do
  line="$(classify "$rf")"
  [[ -n "$line" ]] && classified+=("$line|$(basename "$rf")")
done

{
  # Loose specs: any complete claim wins; else any report makes it partial.
  for s in ${specs[@]+"${specs[@]}"}; do
    state=none; evid="no report"
    for c in ${classified[@]+"${classified[@]}"}; do
      name="${c%%|*}"; rest="${c#*|}"
      [[ "$name" == "$s" ]] || continue
      claim="${rest%%|*}"; rest="${rest#*|}"; ev="${rest%%|*}"; rep="${rest#*|}"
      if [[ "$claim" == complete ]]; then
        state=complete; evid="$ev: $rep"
      elif [[ "$state" != complete ]]; then
        state=partial; evid="$ev: $rep"
      fi
    done
    printf '%s\t%s\t%s\n' "$s" "$state" "$evid"
  done

  for fs in ${folder_specs[@]+"${folder_specs[@]}"}; do
    rf="$project_dir/$fs/report.md"
    if [[ ! -f "$rf" ]]; then printf '%s\tnone\tno report\n' "$fs"; continue; fi
    status="$(fm_value spec-status "$rf")"
    if [[ -n "$status" ]] && is_complete_claim "$status"; then
      printf '%s\tcomplete\tfrontmatter: %s/report.md\n' "$fs" "$fs"
    elif [[ -n "$status" ]]; then
      printf '%s\tpartial\tfrontmatter: %s/report.md\n' "$fs" "$fs"
    else
      printf '%s\tpartial\tno spec-status: %s/report.md\n' "$fs" "$fs"
    fi
  done
} | LC_ALL=C sort -t "$(printf '\t')" -k1,1 -u
