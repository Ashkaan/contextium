#!/usr/bin/env bash
# next-implement-command.sh — emit the EXACT copy-paste next command(s) for a
# touched project, derived deterministically from project state (the next command
# is DATA, not judgment — deterministic over AI). /close step-5 calls this
# and emits its stdout VERBATIM instead of hand-composing the `/implement`
# argument, which is where the SPEC-name-vs-slug bug lives.
#
# THE BUG THIS PREVENTS: a close emitting `/implement guest-checkout` (the SPEC
# basename) instead of `/implement checkout-flow` (the project slug). `/implement` resolves by PROJECT
# slug and HALTs on a sub-SPEC name. The argument is ALWAYS the project slug;
# Phase 1 auto-resolves the un-reported SPEC itself.
#
# Usage: next-implement-command.sh <project-folder>
#   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
# Output (stdout): zero or more lines, each a literal next command, e.g.
#   /implement checkout-flow
#   /implement data-move token-refresher                 (sharded → one per shard)
#   /project some-slug                                   (active, no pending SPEC)
#   /implement some-slug r4                              (ROADMAP.md → one per ready row)
# Emits a leading `# ` comment line instead of a command for blocked/monitor/
# completed. For the two finished states that line REPLACES the next-phase
# pointer with the finish itself — `# <slug> — project complete: <## Outcome
# first line>`, or `# <slug> — work complete, monitoring until <date>: <what is
# being watched>` — so a project whose last piece just landed says so rather
# than pointing at a phase that does not exist.
#
# peers:
#   .agents/skills/close/scripts/next-implement-command.test.sh
#   .agents/skills/close/SKILL.md (step-5-reiterate-implement)

set -euo pipefail

err() { echo "Error: $*" >&2; }

[[ $# -eq 1 ]] || { err "usage: next-implement-command.sh <project-folder>"; exit 2; }

project_dir="$1"

# A REPO-RELATIVE `projects/...` argument is resolved against the session's
# write root — the thread's worktree, where this session's own status flips are
# — not against whichever tree the caller happened to be standing in, which is
# how this once returned a shard another tree already had marked closed. An
# absolute path is honoured as given.
if [[ "$project_dir" != /* && "$project_dir" == projects/* ]]; then
  _swr="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../implement/scripts/session-write-root.sh"
  _root="$(bash "$_swr" 2>/dev/null || true)"
  [[ -n "$_root" && -d "$_root/$project_dir" ]] && project_dir="$_root/$project_dir"
fi
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

# active (or unrecognized → treat as active): collect SPECs still owed work.
# WHICH SPECS ARE DONE IS NOT A FILENAME QUESTION — see spec-state.sh, which owns
# the rule for all three readers. `partial` means a report exists but nobody
# claimed the SPEC finished, so the work is still owed and saying so is the whole
# point; `none` means no report at all. Both are pending here.
unreported=(); partial_specs=()
while IFS=$'\t' read -r _name _state _evidence; do
  [[ -n "$_name" ]] || continue
  case "$_state" in
    none)    unreported+=("$_name") ;;
    partial) unreported+=("$_name"); partial_specs+=("$_name") ;;
  esac
done < <(bash "$(dirname "${BASH_SOURCE[0]}")/spec-state.sh" "$project_dir")

# ── ROADMAP.md: one command per ready row ────────────────────────────────
#
# A spec-kit project's rows carry their own dependencies, so unlike the shard
# table below this CAN say which work may start now: every ready row (the README
# template's Ready rule, applied by roadmap.sh — never re-derived here) whose
# spec is still owed work is its own `/implement <slug> <id>`, and those lines
# are the parallel set the close prints as separate copyable blocks. Ready rows
# with no spec yet, or a spec with open NEEDS CLARIFICATION markers, need a
# planning session: ONE `/project <slug>` covers them all, because /project picks
# the row. A legacy loose SPEC that no row points at is work already in flight
# and prints first, as the bare `/implement <slug>` it always was.
if [[ -f "$project_dir/ROADMAP.md" ]]; then
  rm_err="$(mktemp)"; rm_rc=0
  rows="$(bash "$(dirname "${BASH_SOURCE[0]}")/roadmap.sh" "$project_dir" 2>"$rm_err")" || rm_rc=$?
  if [[ "$rm_rc" -ne 0 ]]; then
    msg="$(sed -n 's/^roadmap: //p' "$rm_err" | tail -n1)"; rm -f "$rm_err"
    printf '# %s ROADMAP.md is malformed: %s\n' "$slug" "${msg:-roadmap.sh exited $rm_rc}"
    exit 0
  fi
  rm -f "$rm_err"
  states="$(bash "$(dirname "${BASH_SOURCE[0]}")/spec-state.sh" "$project_dir")"
  state_of() { printf '%s\n' "$states" | awk -F'\t' -v n="$1" '$1==n {print $2; exit}'; }
  referenced="$(printf '%s\n' "$rows" | cut -f4)"
  out=()
  for _u in ${unreported[@]+"${unreported[@]}"}; do
    [[ "$_u" == specs/* ]] && continue
    printf '%s\n' "$referenced" | grep -qxF "$_u" && continue
    out+=("/implement $slug"); break
  done
  needs_planning=0; comments=()
  ordered="$(printf '%s\n' "$rows" | awk -F'\t' '$3=="yes" && tolower($2)=="in-progress"'
             printf '%s\n' "$rows" | awk -F'\t' '$3=="yes" && tolower($2)=="planned"')"
  while IFS=$'\t' read -r id _st _ready sub _feat; do
    [[ -n "$id" ]] || continue
    if [[ "$sub" == "—" ]]; then needs_planning=1; continue; fi
    case "$(state_of "$sub")" in
      none|partial) ;;
      # Awaiting /close's `done` flip: say so, rather than fall through to a
      # `/project` for a row whose work is finished.
      complete) comments+=("# $slug $id's spec is complete — run /close to flip the row to done"); continue ;;
      *) needs_planning=1; continue ;;   # the Sub-spec it names is not on disk
    esac
    if [[ "$sub" == specs/* ]] && ! bash "$(dirname "${BASH_SOURCE[0]}")/open-clarifications.sh" "$project_dir/$sub" >/dev/null 2>&1; then
      needs_planning=1; continue
    fi
    out+=("/implement $slug $(printf '%s' "$id" | tr '[:upper:]' '[:lower:]')")
  done <<<"$ordered"
  [[ "$needs_planning" -eq 1 ]] && out+=("/project $slug")
  while IFS=$'\t' read -r id st ready _sub _feat; do
    [[ -n "$id" && "$ready" == no ]] || continue
    case "$(printf '%s' "$st" | tr '[:upper:]' '[:lower:]')" in
      blocked:*) comments+=("# $slug $id is ${st}") ;;
      planned|in-progress|done|"absorbed by "*) ;;
      *) comments+=("# $slug $id has a Status outside the vocabulary: $st") ;;
    esac
  done <<<"$rows"
  [[ ${#out[@]} -gt 0 || ${#comments[@]} -gt 0 ]] || out+=("/project $slug")
  printf '%s\n' ${out[@]+"${out[@]}"} ${comments[@]+"${comments[@]}"}
  exit 0
fi

# Sharded project? The opt-in signal is a `## Shard Status` table — the legacy
# layout, still read; the rule today is the README
# template's derivation rule (.agents/skills/project/references/templates/README.md,
# the <!-- --> block). When present, each <shard>.spec.md is a shard and
# the command is `/implement <slug> <shard>`; otherwise the command is the bare
# `/implement <slug>` (Phase 1 auto-resolves the single un-reported SPEC, or
# AskUserQuestion-disambiguates if several — the argument stays the slug).
is_sharded=0
grep -qE '^## +Shard Status' "$readme" && is_sharded=1

# ── The shard table's State column, which is the SSOT ────────────────────────
#
# WHY THIS EXISTS. The report-presence heuristic below is wrong for a sharded
# project the moment one shard is part-done: an `in-flight` shard with task
# reports written reads as "has a report", so it drops out of the queue and the
# `planned` ones are offered instead — including ones the project's own decided
# order says cannot start until the in-flight shard finishes.
#
# In the legacy layout the table is the SSOT for which shards exist and what
# state each is in, so read THAT: an `in-flight` shard is the work in
# motion and comes first, exclusively. `planned` shards are only offered when
# nothing is in flight. `reported` and `closed` are done. A `blocked` shard is
# named either way, because it is waiting on something a human clears.
#
# (A ROADMAP.md project never reaches this table — its rows declare their
# dependencies and are read above. What follows is the legacy shard layout.)
#
# Ordering BETWEEN planned shards is deliberately not attempted here: it lives
# in each project's own prose (a decided order, a dependency column) and
# guessing it from a table would be exactly the judgment this script must not
# make. What the state column CAN say is which
# shard is already underway, and that is enough to stop offering a later one.
shard_rows_seen=0
inflight=(); planned=(); blocked_shards=()
if [[ "$is_sharded" -eq 1 ]]; then
  while IFS= read -r row; do
    shard_rows_seen=1
    name="${row%%|*}"
    state="${row##*|}"
    [[ -n "$name" && -n "$state" ]] || continue
    case "$state" in
      in-flight) inflight+=("$name") ;;
      planned) planned+=("$name") ;;
      blocked) blocked_shards+=("$name") ;;
    esac
  done < <(
    awk '
      /^## +Shard Status/ { in_table = 1; next }
      in_table && /^## / { exit }
      in_table && /^\|/ {
        # Skip the header row and the |---| separator.
        if ($0 ~ /\| *Shard *\|/) next
        if ($0 ~ /^\|[ :-]*\|/) next
        n = split($0, cell, "|")
        if (n < 4) next
        name = cell[2]; state = cell[n - 1]
        gsub(/[` ]/, "", name); gsub(/[` ]/, "", state)
        if (name != "" && state != "") print name "|" state
      }
    ' "$readme"
  )
fi

if [[ "$shard_rows_seen" -eq 1 ]]; then
  next_shards=()
  if [[ ${#inflight[@]} -gt 0 ]]; then
    next_shards=(${inflight[@]+"${inflight[@]}"})
  elif [[ ${#planned[@]} -gt 0 ]]; then
    next_shards=(${planned[@]+"${planned[@]}"})
  fi
  if [[ ${#next_shards[@]} -gt 0 ]]; then
    printf '%s\n' ${next_shards[@]+"${next_shards[@]}"} | sort | while IFS= read -r shard; do
      printf '/implement %s %s\n' "$slug" "$shard"
    done
    for shard in ${blocked_shards[@]+"${blocked_shards[@]}"}; do
      printf '# %s %s is blocked — see its row in ## Shard Status\n' "$slug" "$shard"
    done
    exit 0
  fi
  if [[ ${#blocked_shards[@]} -gt 0 ]]; then
    for shard in ${blocked_shards[@]+"${blocked_shards[@]}"}; do
      printf '# %s %s is blocked — see its row in ## Shard Status\n' "$slug" "$shard"
    done
    exit 0
  fi
  # Every shard reported or closed → the project needs its next phase decided.
  printf '/project %s\n' "$slug"
  exit 0
fi

if [[ ${#unreported[@]} -gt 0 ]]; then
  if [[ "$is_sharded" -eq 1 ]]; then
    # One line per pending shard (sorted for stable output).
    printf '%s\n' ${unreported[@]+"${unreported[@]}"} | sort | while IFS= read -r shard; do
      printf '/implement %s %s\n' "$slug" "$shard"
    done
  else
    # Non-sharded: ALWAYS the bare project slug, never the SPEC basename.
    printf '/implement %s\n' "$slug"
  fi
  for _p in ${partial_specs[@]+"${partial_specs[@]}"}; do
    printf '# %s %s is reported but not claimed complete — see its report Status line\n' "$slug" "$_p"
  done
  exit 0
fi

# No pending SPEC but the project is active → the next phase needs a SPEC; the
# /project router stage-detects and runs the next-phase think flow.
printf '/project %s\n' "$slug"
