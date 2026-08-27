#!/usr/bin/env bash
# next-implement-command.sh — emit the EXACT copy-paste next command(s) for a
# touched project, derived deterministically from project state (the next command
# is DATA, not judgment — @rule:deterministic-over-ai). /close step-5 calls this
# and emits its stdout VERBATIM instead of hand-composing the `/implement`
# argument, which is where the SPEC-name-vs-slug bug lives.
#
# THE BUG THIS PREVENTS (2026-06-17): /close emitted `/implement
# sourced-through-form` (the SPEC basename) instead of `/implement
# direct-hire-recruiting` (the project slug). `/implement` resolves by PROJECT
# slug and HALTs on a sub-SPEC name. The argument is ALWAYS the project slug;
# Phase 1 auto-resolves the un-reported SPEC itself.
#
# Usage: next-implement-command.sh <project-folder>
#   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
# Output (stdout): zero or more lines, each a literal next command, e.g.
#   /implement direct-hire-recruiting
#   /implement trigger-dev-migration oauth-refresher     (sharded → one per shard)
#   /project some-slug                                   (active, no pending SPEC)
# Emits a leading `# ` comment line instead of a command for blocked/monitor/
# completed. For the two finished states that line REPLACES the next-phase
# pointer with the finish itself — `# <slug> — project complete: <## Outcome
# first line>`, or `# <slug> — work complete, monitoring until <date>: <what is
# being watched>` — so a project whose last piece just landed says so rather
# than pointing at a phase that does not exist.
#
# peers:
#   .claude/skills/close/scripts/next-implement-command.test.sh
#   .claude/skills/close/SKILL.md (step-5-reiterate-implement)

set -euo pipefail

err() { echo "Error: $*" >&2; }

[[ $# -eq 1 ]] || { err "usage: next-implement-command.sh <project-folder>"; exit 2; }

project_dir="$1"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

readme="$project_dir/README.md"
[[ -f "$readme" ]] || { err "no README.md in $project_dir"; exit 2; }

# Slug = folder basename with the leading YYYY-MM-DD_ date prefix stripped.
base="$(basename "$project_dir")"
slug="$(printf '%s' "$base" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}_//')"

# Frontmatter status (first `status:` line in the README).
status="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$readme" | head -n1)"

trim() { printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'; }

# First non-empty line under a `## <heading>` section, stripped of list markers.
# Used to carry the project's own words into the finished-project lines below
# rather than inventing a summary at close time.
first_line_under() {
  awk -v want="$1" '
    $0 ~ "^## +" want "([[:space:]]|$)" { in_section = 1; next }
    in_section && /^## / { exit }
    in_section && NF {
      sub(/^[[:space:]]*[-*][[:space:]]+/, "")
      print
      exit
    }
  ' "$readme"
}

case "$status" in
  completed)
    # Finished project — no command, but SAY it finished. Emitting nothing here
    # left the close silent about the one outcome the user most wants stated,
    # and silence is indistinguishable from "the generator did not run".
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
    # `monitoring-until:` is either a bare YYYY-MM-DD or `YYYY-MM-DD — reason`;
    # split so the reason (what is being watched) is stated, not just the date.
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

# active (or unrecognized → treat as active): collect un-reported SPECs.
# An un-reported SPEC is a <name>.spec.md with NO sibling <name>-report.md.
unreported=()
shopt -s nullglob
for spec in "$project_dir"/*.spec.md; do
  name="$(basename "$spec" .spec.md)"
  [[ -f "$project_dir/${name}-report.md" ]] || unreported+=("$name")
done
shopt -u nullglob

# Sharded project? The opt-in signal is a `## Shard Status` table (per
# the sharded project layout). When present, each <shard>.spec.md is a shard and
# the command is `/implement <slug> <shard>`; otherwise the command is the bare
# `/implement <slug>` (Phase 1 auto-resolves the single un-reported SPEC, or
# AskUserQuestion-disambiguates if several — the argument stays the slug).
is_sharded=0
grep -qE '^## +Shard Status' "$readme" && is_sharded=1

if [[ ${#unreported[@]} -gt 0 ]]; then
  if [[ "$is_sharded" -eq 1 ]]; then
    # One line per pending shard (sorted for stable output).
    printf '%s\n' "${unreported[@]}" | sort | while IFS= read -r shard; do
      printf '/implement %s %s\n' "$slug" "$shard"
    done
  else
    # Non-sharded: ALWAYS the bare project slug, never the SPEC basename.
    printf '/implement %s\n' "$slug"
  fi
  exit 0
fi

# No pending SPEC but the project is active → the next phase needs a SPEC; the
# /project router stage-detects and runs the next-phase think flow.
printf '/project %s\n' "$slug"
