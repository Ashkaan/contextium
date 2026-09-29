#!/usr/bin/env bash
# spec-state.sh — for one project folder, say what state each SPEC is in.
# THE one place that answers "is this SPEC finished?"; next-implement-command.sh,
# project-remaining-work.sh and project/scripts/detect-stage.sh all call it
# instead of each re-deriving the rule from filenames.
#
# THE BUG THIS REPLACES. Three readers each asking the filesystem "does
# `<name>-report.md` exist?" read a SPEC reported under slice names
# (`phase-2-sync-freshness-report.md`) as pending forever, and /close would
# print an `/implement` for work already done. Widening the glob alone would be
# worse: a SPEC with one partial report would read as finished and drop out of
# the queue silently. So the widened match resolves to `partial`, never
# `complete`.
#
# WHERE THE ANSWER COMES FROM, most trusted first. Completeness is a CLAIM
# somebody made, not a fact about which files exist, so a declaration always
# beats the filename:
#   1. report frontmatter — `spec: <name>` + `spec-status: complete|partial`
#   2. report prose       — `**SPEC**: ...<name>.spec.md` + `**Status**: ...`
#      (the header /implement's report has always written)
#   3. the filename       — exact `<name>-report.md` is complete by the old
#      convention; a qualified `<name>-<rest>-report.md` is PARTIAL
#
# A status counts as complete only when it opens with COMPLETE, SHIPPED or DONE.
# `CODE COMPLETE`, `BUILD COMPLETE`, `PARTIAL` and `NOT IMPLEMENTED` are all
# partial — the tail of that vocabulary is a judgment call per report, so this
# fails toward naming a loose end rather than hiding one.
#
# Usage: spec-state.sh <project-folder>
# Output: one line per SPEC, tab-separated —
#   <name>	complete|partial|none	<evidence>
# where <name> is a legacy stem (`alpha`) or a spec folder (`specs/001-alpha`).
#
# peers:
#   .agents/skills/close/scripts/spec-state.test.sh

set -uo pipefail

err() { echo "Error: $*" >&2; }
[[ $# -eq 1 ]] || { err "usage: spec-state.sh <project-folder>"; exit 2; }
project_dir="$1"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

# Every SPEC in the folder. `*.plan.md` is the legacy spelling, still recognised.
specs=()
shopt -s nullglob
for f in "$project_dir"/*.spec.md "$project_dir"/*.plan.md; do
  b="$(basename "$f")"; b="${b%.spec.md}"; specs+=("${b%.plan.md}")
done
reports=("$project_dir"/*-report.md)
# The spec-kit layout: one folder per spec, `specs/NNN-name/`,
# holding its own `report.md`. A folder spec is NAMED BY ITS PATH, so it can
# never collide with a legacy stem (`001-x.spec.md` stays `001-x`), and its
# report is that folder's `report.md` alone — the top-level `*-report.md` glob
# above never reaches it, and no filename is matched.
folder_specs=()
for f in "$project_dir"/specs/*/spec.md; do
  d="$(dirname "$f")"; folder_specs+=("specs/$(basename "$d")")
done
shopt -u nullglob
[[ ${#specs[@]} -gt 0 || ${#folder_specs[@]} -gt 0 ]] || exit 0

# Is this status string a completion claim? Deliberately narrow.
is_complete_claim() {
  local v; v="$(printf '%s' "${1:-}" | tr '[:lower:]' '[:upper:]' | sed -E 's/^[[:space:]]+//')"
  case "$v" in
    COMPLETE|COMPLETE[^A-Z]*|SHIPPED|SHIPPED[^A-Z]*|DONE|DONE[^A-Z]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Which SPEC does this report belong to, and what does it claim?
# Echoes "<spec-name>|<claim>|<evidence>"; empty when it belongs to none.
classify() {
  local rf="$1" head decl status spec_name="" claim="" evidence=""
  head="$(head -n 20 "$rf" 2>/dev/null)"

  # 1. frontmatter
  if [[ "$(head -n 1 "$rf" 2>/dev/null)" == "---" ]]; then
    decl="$(sed -nE 's/^spec:[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/p' <<<"$head" | head -n1)"
    status="$(sed -nE 's/^spec-status:[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/p' <<<"$head" | head -n1)"
    if [[ -n "$decl" ]]; then
      spec_name="$(basename "$decl")"; spec_name="${spec_name%.spec.md}"; spec_name="${spec_name%.plan.md}"
      if [[ -n "$status" ]]; then
        is_complete_claim "$status" && claim=complete || claim=partial
        evidence="frontmatter"
      fi
    fi
  fi

  # 2. prose
  if [[ -z "$spec_name" || -z "$claim" ]]; then
    decl="$(grep -iE '^\*\*SPEC\*\*:' <<<"$head" | head -n1 | grep -oE '[A-Za-z0-9._-]+\.(spec|plan)\.md' | head -n1)"
    # Anywhere on the line: older reports put SPEC and Status on one line.
    status="$(grep -iE '\*\*Status\*\*:' <<<"$head" | head -n1 | sed -E 's/.*\*\*[Ss][Tt][Aa][Tt][Uu][Ss]\*\*:[[:space:]]*//')"
    if [[ -z "$spec_name" && -n "$decl" ]]; then
      spec_name="${decl%.spec.md}"; spec_name="${spec_name%.plan.md}"
    fi
    if [[ -z "$claim" && -n "$status" ]]; then
      is_complete_claim "$status" && claim=complete || claim=partial
      evidence="declared-status"
    fi
  fi

  # 3. filename — longest SPEC name that the report stem starts with wins, so a
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

# Name → state and evidence, as parallel indexed arrays: bash 3.2 (macOS) has
# no associative arrays.
NAMES=(); STATES=(); EVIDS=()
idx_of() {
  local i
  for ((i = 0; i < ${#NAMES[@]}; i++)); do
    [[ "${NAMES[i]}" == "$1" ]] && { echo "$i"; return 0; }
  done
  return 1
}
set_state() {  # set_state <name> <state> <evidence>
  local i
  if i="$(idx_of "$1")"; then STATES[i]="$2"; EVIDS[i]="$3"
  else NAMES+=("$1"); STATES+=("$2"); EVIDS+=("$3"); fi
}
for s in ${specs[@]+"${specs[@]}"}; do set_state "$s" none "no report"; done
for rf in ${reports[@]+"${reports[@]}"}; do
  line="$(classify "$rf")" || continue
  [[ -n "$line" ]] || continue
  name="${line%%|*}"; rest="${line#*|}"; claim="${rest%%|*}"; ev="${rest##*|}"
  i="$(idx_of "$name")" || continue          # declares a SPEC not in this folder
  if [[ "$claim" == complete ]]; then
    set_state "$name" complete "$ev: $(basename "$rf")"
  elif [[ "${STATES[i]}" != complete ]]; then
    set_state "$name" partial "$ev: $(basename "$rf")"
  fi
done

# A folder spec's state is its report.md's frontmatter `spec-status:`, read
# through the same narrow completion test: no report.md → none, a report that
# does not claim completion → partial.
for fs in ${folder_specs[@]+"${folder_specs[@]}"}; do
  rf="$project_dir/$fs/report.md"
  if [[ ! -f "$rf" ]]; then set_state "$fs" none "no report"; continue; fi
  status=""
  if [[ "$(head -n 1 "$rf")" == "---" ]]; then
    status="$(head -n 20 "$rf" | sed -nE 's/^spec-status:[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/p' | head -n1)"
  fi
  if [[ -n "$status" ]] && is_complete_claim "$status"; then
    set_state "$fs" complete "frontmatter: $fs/report.md"
  else
    if [[ -n "$status" ]]; then set_state "$fs" partial "frontmatter: $fs/report.md"
    else set_state "$fs" partial "no spec-status: $fs/report.md"; fi
  fi
done

for s in $(printf '%s\n' ${specs[@]+"${specs[@]}"} ${folder_specs[@]+"${folder_specs[@]}"} | sort -u); do
  i="$(idx_of "$s")"
  printf '%s\t%s\t%s\n' "$s" "${STATES[i]}" "${EVIDS[i]}"
done
