#!/usr/bin/env bash
# project-remaining-work.sh — emit the HARD signals of unfinished work in a
# project, so /close can decide whether the project just finished. Counting
# files and table rows is data, not judgment; the judgment left to the model is
# only whether the goal is met and whether the shipped thing needs a watch.
#
# Usage: project-remaining-work.sh <project-folder>
#   <project-folder> — path to projects/<domain>/<date>_<slug>/
#
# Output (stdout), key: value lines:
#   status: active|blocked|monitor|completed|         (frontmatter, empty if absent)
#   spec: <name> none|partial (<evidence>)            (one line per spec still owed
#                                                      work, per spec-state.sh)
#   unreported_specs: N                               (how many such specs)
#   next_steps_section: yes|no                        (NO ROADMAP.md only: the README
#   next_steps_unchecked: N                            ## Next Steps of the layout
#   todo: <text>                                       before ROADMAP.md; `- [ ]` boxes
#   next_steps_unparsed: N                             are todos, any other top-level
#   unparsed: <text>                                   list item is unparsed backlog)
#   roadmap_table: yes                                (ROADMAP.md present — these
#   roadmap_open: N                                    lines appear ONLY then; one
#   roadmap: <ID> <status>                             `roadmap:` per row not done
#                                                      or absorbed)
#   roadmap-error: <message>                          (ROADMAP.md malformed)
#   verdict: work-remains|no-hard-signal
#
# `no-hard-signal` does NOT mean "the project is done" — it means nothing
# countable is outstanding, so the completion call is now the model's.
# `work-remains` is the deterministic veto: never flip a project holding one.
# Anything this script cannot read resolves toward work-remains, because a veto
# that resolves ambiguity toward "nothing left" closes projects with work in them.
#
# peers:
#   .agents/skills/close/scripts/project-remaining-work.test.sh
#   .agents/skills/close/scripts/spec-state.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/SKILL.md

set -euo pipefail

err() { echo "Error: $*" >&2; }
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ $# -eq 1 ]] || { err "usage: project-remaining-work.sh <project-folder>"; exit 2; }

project_dir="${1%/}"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

readme="$project_dir/README.md"
[[ -f "$readme" ]] || { err "no README.md in $project_dir"; exit 2; }

remains=0

# ── Frontmatter status ─────────────────────────────────────────────────
status="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$readme" | head -n1)"
printf 'status: %s\n' "$status"

# ── Specs still owed work (spec-state.sh owns what "reported" means) ────
spec_count=0
while IFS="$(printf '\t')" read -r _name _state _evidence; do
  [[ -n "$_name" ]] || continue
  case "$_state" in
    none)    spec_count=$((spec_count + 1)); printf 'spec: %s none\n' "$_name" ;;
    partial) spec_count=$((spec_count + 1)); printf 'spec: %s partial (%s)\n' "$_name" "$_evidence" ;;
  esac
done < <(bash "$SCRIPT_DIR/spec-state.sh" "$project_dir")

printf 'unreported_specs: %d\n' "$spec_count"
[[ "$spec_count" -gt 0 ]] && remains=1

# ── Remaining work under ## Next Steps (the README layout before ROADMAP.md) ──
# Two counts. An unchecked box at any depth is a todo. Any other TOP-LEVEL list
# item — numbered, lettered, a plain bullet — is backlog whose done-state cannot
# be read, so it is counted as unparsed rather than ignored. An indented item is
# a child (usually detail under a `- [x]`), and counting it would pin a finished
# checklist open forever. The heading match ignores case. A project with
# ROADMAP.md is read from its rows alone — the roadmap is its one list of
# outstanding work, and a stale README list must not hold it open.
todo_count=0
unparsed_count=0
if [[ -f "$project_dir/ROADMAP.md" ]]; then
  :
elif grep -qiE '^## +next steps' "$readme"; then
  printf 'next_steps_section: yes\n'
  scan="$(awk '
    tolower($0) ~ /^## +next steps/ { in_section = 1; next }
    in_section && /^## / { in_section = 0 }
    !in_section { next }
    /^[ \t]*[-*+] \[ \]/ {
      line = $0
      sub(/^[ \t]*[-*+] \[ \][ \t]*/, "", line)
      print "TODO:" line
      next
    }
    /^[ \t]*[-*+] \[[xX]\]/ { next }
    /^([0-9]+[.)]|[A-Za-z][.)]|[-*+])[ \t]+/ {
      line = $0
      sub(/^([0-9]+[.)]|[A-Za-z][.)]|[-*+])[ \t]+/, "", line)
      if (line != "") print "UNPARSED:" line
    }
  ' "$readme")"
  todos="$(printf '%s\n' "$scan" | sed -n 's/^TODO://p')"
  unparsed="$(printf '%s\n' "$scan" | sed -n 's/^UNPARSED://p')"
  [[ -n "$todos" ]] && todo_count="$(printf '%s\n' "$todos" | grep -c . || true)"
  [[ -n "$unparsed" ]] && unparsed_count="$(printf '%s\n' "$unparsed" | grep -c . || true)"
  printf 'next_steps_unchecked: %d\n' "$todo_count"
  [[ -n "$todos" ]] && printf '%s\n' "$todos" | sed 's/^/todo: /'
  printf 'next_steps_unparsed: %d\n' "$unparsed_count"
  [[ -n "$unparsed" ]] && printf '%s\n' "$unparsed" | sed 's/^/unparsed: /'
else
  printf 'next_steps_section: no\n'
  printf 'next_steps_unchecked: 0\n'
  printf 'next_steps_unparsed: 0\n'
fi
[[ "$todo_count" -gt 0 || "$unparsed_count" -gt 0 ]] && remains=1

# ── ROADMAP.md rows not done ───────────────────────────────────────────
# The roadmap is the ONE list of outstanding work on a project that has one,
# read through roadmap.sh so this cannot disagree with detect-stage.sh or
# next-implement-command.sh. Every row that is not `done` or `absorbed by …` is
# open — a `blocked:` watch included, since a watch is exactly what must keep a
# project from closing. A table roadmap.sh cannot read is also work-remains.
if [[ -f "$project_dir/ROADMAP.md" ]]; then
  printf 'roadmap_table: yes\n'
  rm_err="$(mktemp)"; rm_rc=0
  rm_rows="$(bash "$SCRIPT_DIR/roadmap.sh" "$project_dir" 2>"$rm_err")" || rm_rc=$?
  if [[ "$rm_rc" -ne 0 ]]; then
    msg="$(sed -n 's/^roadmap: //p' "$rm_err" | tail -n1)"
    printf 'roadmap_open: 0\n'
    printf 'roadmap-error: %s\n' "${msg:-roadmap.sh exited $rm_rc}"
    remains=1
  else
    cat "$rm_err" >&2
    open_rows="$(printf '%s\n' "$rm_rows" | awk -F'\t' '
      $1 == "" { next }
      { s = tolower($2) }
      s == "done" || s ~ /^absorbed by / { next }
      { print $1 " " $2 }')"
    open_count=0
    [[ -n "$open_rows" ]] && open_count="$(printf '%s\n' "$open_rows" | grep -c .)"
    printf 'roadmap_open: %d\n' "$open_count"
    [[ -n "$open_rows" ]] && printf '%s\n' "$open_rows" | sed 's/^/roadmap: /'
    [[ "$open_count" -gt 0 ]] && remains=1
  fi
  rm -f "$rm_err"
fi

if [[ "$remains" -eq 1 ]]; then
  printf 'verdict: work-remains\n'
else
  printf 'verdict: no-hard-signal\n'
fi
