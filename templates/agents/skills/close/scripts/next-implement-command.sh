#!/usr/bin/env bash
# next-implement-command.sh — emit the EXACT copy-paste next command(s) for a
# touched project, derived from project state. The next command is data, not
# judgment: /close prints this script's stdout verbatim, one fenced block per
# line, instead of composing a command by hand.
#
# The argument is ALWAYS the project slug (the folder name without its date),
# never a spec's name: /implement resolves by project slug, and a hand-written
# pointer naming the spec file sends the next session to a slug that does not
# exist.
#
# Usage: next-implement-command.sh <project-folder>
#   <project-folder> — path to projects/<domain>/<date>_<slug>/
# Output (stdout): zero or more lines, each a literal next command, e.g.
#   /implement checkout-flow r2          (ROADMAP.md → one per ready row with a spec)
#   /project checkout-flow               (a ready row needs a spec, or nothing is ready)
#   /implement checkout-flow             (a loose *.spec.md still owed work)
#   # checkout-flow R4 is blocked: vendor reply
# A `# ` line is a statement, not a command. For completed / monitor / blocked
# projects it REPLACES the command with what happened — `# <slug> — project
# complete: <## Outcome first line>`, `# <slug> — work complete, monitoring
# until <date>: <what is watched>` — so a project whose last piece just landed
# says so rather than pointing at work that does not exist.
#
# peers:
#   .agents/skills/close/scripts/next-implement-command.test.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/scripts/spec-state.sh
#   .agents/skills/close/scripts/open-clarifications.sh
#   .agents/skills/close/SKILL.md

set -euo pipefail

err() { echo "Error: $*" >&2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAB="$(printf '\t')"

[[ $# -eq 1 ]] || { err "usage: next-implement-command.sh <project-folder>"; exit 2; }

project_dir="${1%/}"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

readme="$project_dir/README.md"
[[ -f "$readme" ]] || { err "no README.md in $project_dir"; exit 2; }

# Slug = folder basename with the leading YYYY-MM-DD_ date prefix stripped.
base="$(basename "$project_dir")"
slug="$(printf '%s' "$base" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}_//')"

# Frontmatter status (first `status:` line in the README).
status="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$readme" | head -n1)"

trim() { printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# First non-empty line under a `## <heading>` section, stripped of a list
# marker — the project's own words, not a summary invented at close time.
first_line_under() {
  awk -v want="$1" '
    $0 ~ "^## +" want "([ \t]|$)" { in_section = 1; next }
    in_section && /^## / { exit }
    in_section && NF {
      sub(/^[ \t]*[-*][ \t]+/, "")
      print
      exit
    }
  ' "$readme"
}

case "$status" in
  completed)
    outcome="$(first_line_under Outcome)"
    if [[ -n "$outcome" ]]; then
      printf '# %s — project complete: %s\n' "$slug" "$outcome"
    else
      printf '# %s — project complete (no ## Outcome section written)\n' "$slug"
    fi
    exit 0
    ;;
  blocked)
    blocked_on="$(sed -nE 's/^blocked-on:[[:space:]]*(.+)/\1/p' "$readme" | head -n1)"
    printf '# %s is blocked — waiting on: %s\n' "$slug" "${blocked_on:-(blocked-on not set)}"
    exit 0
    ;;
  monitor)
    # `monitoring-until:` is a bare YYYY-MM-DD or `YYYY-MM-DD — reason`.
    watch="$(sed -nE 's/^monitoring-until:[[:space:]]*(.+)/\1/p' "$readme" | head -n1)"
    watch="${watch%\"}"
    watch="${watch#\"}"
    until_date="$watch"
    reason=""
    for sep in "—" " - "; do
      if [[ "$watch" == *"$sep"* ]]; then
        until_date="$(trim "${watch%%"$sep"*}")"
        reason="$(trim "${watch#*"$sep"}")"
        break
      fi
    done
    if [[ -z "$watch" ]]; then
      printf '# %s — work complete, monitor window open (monitoring-until not set)\n' "$slug"
    elif [[ -n "$reason" ]]; then
      printf '# %s — work complete, monitoring until %s: %s\n' "$slug" "$until_date" "$reason"
    else
      printf '# %s — work complete, monitoring until %s (no command — passive observation)\n' "$slug" "$until_date"
    fi
    exit 0
    ;;
esac

# active (or unrecognized → treat as active). spec-state.sh owns "finished":
# `none` has no report, `partial` has one that does not claim completion; both
# are still owed work.
states="$(bash "$SCRIPT_DIR/spec-state.sh" "$project_dir")"
state_of() { printf '%s\n' "$states" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }
unreported=(); partial_specs=()
while IFS="$TAB" read -r _name _state _evidence; do
  [[ -n "$_name" ]] || continue
  case "$_state" in
    none)    unreported+=("$_name") ;;
    partial) unreported+=("$_name"); partial_specs+=("$_name") ;;
  esac
done <<<"$states"

# ── ROADMAP.md: one command per ready row ────────────────────────────────
# Rows carry their own dependencies, so this can say which work may start now:
# every ready row (roadmap.sh --ready, in-progress before planned) whose spec is
# still owed work and has no open NEEDS CLARIFICATION is its own
# `/implement <slug> <id>` — the parallel set, each runnable in its own session.
# Ready rows with no spec yet, or with open clarifications, need planning: ONE
# `/project <slug>` covers them all, because /project picks the row. A loose
# spec that no row points at is work already in flight and prints first.
if [[ -f "$project_dir/ROADMAP.md" ]]; then
  rm_err="$(mktemp)"; rm_rc=0
  rows="$(bash "$SCRIPT_DIR/roadmap.sh" "$project_dir" 2>"$rm_err")" || rm_rc=$?
  if [[ "$rm_rc" -ne 0 ]]; then
    msg="$(sed -n 's/^roadmap: //p' "$rm_err" | tail -n1)"; rm -f "$rm_err"
    printf '# %s ROADMAP.md is malformed: %s\n' "$slug" "${msg:-roadmap.sh exited $rm_rc}"
    exit 0
  fi
  rm -f "$rm_err"
  ready_rows="$(bash "$SCRIPT_DIR/roadmap.sh" "$project_dir" --ready 2>/dev/null)"
  referenced="$(printf '%s\n' "$rows" | cut -f4)"
  out=()
  for _u in ${unreported[@]+"${unreported[@]}"}; do
    [[ "$_u" == specs/* ]] && continue
    printf '%s\n' "$referenced" | grep -qxF -- "$_u" && continue
    out+=("/implement $slug"); break
  done
  needs_planning=0; comments=()
  while IFS="$TAB" read -r id _st _ready sub _feat; do
    [[ -n "$id" ]] || continue
    if [[ "$sub" == "—" ]]; then needs_planning=1; continue; fi
    case "$(state_of "$sub")" in
      none|partial) ;;
      complete) comments+=("# $slug $id's spec is complete — run /close to flip the row to done"); continue ;;
      *) needs_planning=1; continue ;;   # the Sub-spec it names is not on disk
    esac
    if [[ "$sub" == specs/* ]] && ! bash "$SCRIPT_DIR/open-clarifications.sh" "$project_dir/$sub" >/dev/null 2>&1; then
      needs_planning=1; continue
    fi
    out+=("/implement $slug $(lower "$id")")
  done <<<"$ready_rows"
  [[ "$needs_planning" -eq 1 ]] && out+=("/project $slug")
  while IFS="$TAB" read -r id st ready _sub _feat; do
    [[ -n "$id" && "$ready" == no ]] || continue
    case "$(lower "$st")" in
      blocked:*) comments+=("# $slug $id is ${st}") ;;
      planned|in-progress|done|"absorbed by "*) ;;
      *) comments+=("# $slug $id has a Status outside the vocabulary: $st") ;;
    esac
  done <<<"$rows"
  [[ ${#out[@]} -gt 0 || ${#comments[@]} -gt 0 ]] || out+=("/project $slug")
  printf '%s\n' ${out[@]+"${out[@]}"} ${comments[@]+"${comments[@]}"}
  exit 0
fi

# ── No ROADMAP.md: loose *.spec.md files ────────────────────────────────
# Always the bare project slug — /implement picks the pending spec itself.
if [[ ${#unreported[@]} -gt 0 ]]; then
  printf '/implement %s\n' "$slug"
  for _p in ${partial_specs[@]+"${partial_specs[@]}"}; do
    printf '# %s %s is reported but not claimed complete — see its report Status line\n' "$slug" "$_p"
  done
  exit 0
fi

# Nothing pending and the project is active → the next piece needs planning.
printf '/project %s\n' "$slug"
