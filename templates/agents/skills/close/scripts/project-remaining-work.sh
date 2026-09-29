#!/usr/bin/env bash
# project-remaining-work.sh — emit the HARD signals of unfinished work in a
# project, so /close step-2.1 can decide whether the project just finished.
# Counting files and table rows is DATA, not judgment;
# the judgment left to the agent is only "does the remaining Next Steps prose
# describe real work, and does the shipped thing need a watch window?".
#
# Usage: project-remaining-work.sh <project-folder>
#   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
#
# Output (stdout), key: value lines:
#   status: active|blocked|monitor|completed|         (frontmatter, empty if absent)
#   spec: <name> none|partial (<evidence>)            (one line per SPEC still owed work,
#                                                      per spec-state.sh; printed before the count)
#   unreported_specs: N                               (how many such SPECs)
#   shard_table: yes|no                               (## Shard Status present)
#   shard_open: N                                     (rows whose State cell is not closed)
#   shard: <name> <state>                             (one line per open shard row)
#   next_steps_section: yes|no
#   next_steps_unchecked: N                           (`- [ ]` under ## Next Steps)
#   todo: <text>                                      (one line per unchecked box)
#   next_steps_unparsed: N                            (list items that are NOT checkboxes)
#   unparsed: <text>                                  (one line per such item)
#   roadmap_table: yes                                (ROADMAP.md present — these three
#   roadmap_open: N                                    lines appear ONLY then, so a legacy
#   roadmap: <ID> <status>                             project's output is unchanged; one
#                                                      `roadmap:` per row not done/absorbed)
#   roadmap-error: <message>                          (ROADMAP.md malformed; work-remains)
#   verdict: work-remains|no-hard-signal
#
# `verdict: no-hard-signal` does NOT mean "the project is done" — it means
# nothing countable is outstanding, so the completion call is now the agent's to
# make by reading the README goal against whatever prose sits in Next Steps
# (numbered backlogs carry no done-state and cannot be counted). `work-remains`
# is the deterministic veto: never flip a project holding one.
#
# peers:
#   .agents/skills/close/scripts/project-remaining-work.test.sh
#   .agents/skills/close/scripts/next-implement-command.sh
#   .agents/skills/close/SKILL.md (step-2.1-project-completion)

set -euo pipefail

err() { echo "Error: $*" >&2; }
trim() { printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'; }

[[ $# -eq 1 ]] || { err "usage: project-remaining-work.sh <project-folder>"; exit 2; }

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

remains=0

# ── Frontmatter status ─────────────────────────────────────────────────
status="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$readme" | head -n1)"
printf 'status: %s\n' "$status"

# ── Un-reported SPECs ──────────────────────────────────────────────────
# spec-state.sh owns the rule for what "reported" means — a SPEC whose report is
# named for the slice it covered rather than the SPEC, or whose report never
# claimed completion, is exactly the loose end this is supposed to surface.
specs=()
while IFS=$'\t' read -r _name _state _evidence; do
  [[ -n "$_name" ]] || continue
  case "$_state" in
    none)    specs+=("$_name"); printf 'spec: %s none\n' "$_name" ;;
    partial) specs+=("$_name"); printf 'spec: %s partial (%s)\n' "$_name" "$_evidence" ;;
  esac
done < <(bash "$(dirname "${BASH_SOURCE[0]}")/spec-state.sh" "$project_dir")

printf 'unreported_specs: %d\n' "${#specs[@]}"
[[ ${#specs[@]} -gt 0 ]] && remains=1

# ── Shard table rows not yet closed ────────────────────────────────────
# The State cell is the LAST non-empty column of each `| ... |` row under
# ## Shard Status. A shard counts as done only when that cell reads closed/
# done/complete(d)/shipped/dropped; anything else (in-flight, pending,
# blocked, —) is open.
shard_rows=""
if grep -qE '^## +Shard Status' "$readme"; then
  printf 'shard_table: yes\n'
  shard_rows="$(awk '
    /^## +Shard Status/ { in_section = 1; next }
    in_section && /^## / { in_section = 0 }
    in_section && /^\|/  { print }
  ' "$readme")"
else
  printf 'shard_table: no\n'
fi

open_shards=()
if [[ -n "$shard_rows" ]]; then
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    # Skip the |---|---| separator and the header row.
    [[ "$row" =~ ^\|[[:space:]]*:?-+ ]] && continue
    [[ "$row" =~ ^\|[[:space:]]*Shard[[:space:]]*\| ]] && continue
    # Split on |, trim; first cell = shard name, last non-empty = state.
    IFS='|' read -r -a cells <<<"${row#|}"
    [[ ${#cells[@]} -ge 2 ]] || continue
    name="$(trim "${cells[0]}")"
    name="${name#\`}"
    name="${name%\`}"
    state=""
    for ((i = ${#cells[@]} - 1; i >= 0; i--)); do
      candidate="$(trim "${cells[i]}")"
      [[ -n "$candidate" ]] && {
        state="$candidate"
        break
      }
    done
    [[ -n "$name" ]] || continue
    case "$(printf '%s' "$state" | tr '[:upper:]' '[:lower:]')" in
      # `state` is the header row's own last cell — matched case-insensitively
      # so a lowercase `| shard | ... | state |` header is not read as an open
      # shard named "shard".
      state | closed | done | complete | completed | shipped | dropped) ;;
      *) open_shards+=("$name $state") ;;
    esac
  done <<<"$shard_rows"
fi

printf 'shard_open: %d\n' "${#open_shards[@]}"
for row in ${open_shards[@]+"${open_shards[@]}"}; do
  printf 'shard: %s\n' "$row"
done
[[ ${#open_shards[@]} -gt 0 ]] && remains=1

# ── Remaining work under ## Next Steps ─────────────────────────────────
#
# TWO counts, not one, and the second exists because counting only unchecked boxes
# silently misses real work: a backlog written as a numbered or bulleted list, or under
# the heading "## Next steps" with a lowercase s, would report `next_steps_section: no`
# and `verdict: no-hard-signal` — indistinguishable, to a caller, from a project with an
# empty backlog.
#
# The heading match is case-insensitive, and a list item that is not an unchecked box
# is counted as UNPARSED rather than ignored. Unparsed items still set `work-remains`:
# this script is the deterministic VETO, and a veto that resolves ambiguity toward
# "nothing left" is the wrong direction for a gate whose whole job is refusing to close
# a project with work in it. A checked box (`- [x]`) is done and counts as neither.
# A project WITH ROADMAP.md is read from its rows alone (below): the roadmap is
# its one list of outstanding work, and a leftover README list must not hold it
# open. Its section is reported as absent.
if [[ ! -f "$project_dir/ROADMAP.md" ]] && grep -qiE '^## +next steps' "$readme"; then
  printf 'next_steps_section: yes\n'
  scan="$(awk '
    tolower($0) ~ /^## +next steps/ { in_section = 1; next }
    in_section && /^## / { in_section = 0 }
    !in_section { next }
    /^[[:space:]]*[-*+] \[ \]/ {
      line = $0
      sub(/^[[:space:]]*[-*+] \[ \][[:space:]]*/, "", line)
      print "TODO\t" line
      next
    }
    # A completed box is done: neither a todo nor unparsed.
    #
    # All three bullet markers, here and in the unchecked rule above. Markdown allows
    # `-`, `*` and `+` interchangeably, and recognizing only two of them means a `+ [ ]`
    # is not a checkbox to this scanner. That was survivable while the unparsed rule
    # scanned every indent (it caught the item as backlog either way), but narrowing
    # unparsed to column zero re-opened it for NESTED `+` boxes, which would then be
    # counted as nothing at all.
    /^[[:space:]]*[-*+] \[[xX]\]/ { next }
    # Any other TOP-LEVEL list item — numbered, lettered in either case, or a plain
    # bullet — is real backlog the counters cannot read a done-state from. Named, not
    # dropped. `[A-Za-z]`, not `[a-z]`: an "A. …" list is the same backlog as an "a. …"
    # one, and matching only one case is how the checkbox-only version missed work.
    #
    # UNINDENTED only, and that is the guard against the opposite failure. An indented
    # item is a CHILD — most often explanatory sub-bullets under a `- [x]` that is
    # already done — and counting those would pin a finished checklist `work-remains`
    # forever, which is the same defect as under-counting pointed the other way. An
    # unchecked `- [ ]` still counts at ANY depth, because a box is an explicit
    # done-state and a nested one is still open work.
    /^([0-9]+[.)]|[A-Za-z][.)]|[-*+])[[:space:]]+/ {
      line = $0
      sub(/^([0-9]+[.)]|[A-Za-z][.)]|[-*+])[[:space:]]+/, "", line)
      if (line != "") print "UNPARSED\t" line
    }
  ' "$readme")"
  # A literal tab in the pattern: BSD sed (macOS) reads `\t` as `t`.
  todos="$(printf '%s\n' "$scan" | sed -n "s/^TODO$(printf '\t')//p")"
  unparsed="$(printf '%s\n' "$scan" | sed -n "s/^UNPARSED$(printf '\t')//p")"
else
  printf 'next_steps_section: no\n'
  todos=""
  unparsed=""
fi

todo_count=0
if [[ -n "$todos" ]]; then
  todo_count="$(printf '%s\n' "$todos" | grep -c . || true)"
fi
printf 'next_steps_unchecked: %d\n' "$todo_count"
if [[ -n "$todos" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf 'todo: %s\n' "$line"
  done <<<"$todos"
fi

unparsed_count=0
if [[ -n "$unparsed" ]]; then
  unparsed_count="$(printf '%s\n' "$unparsed" | grep -c . || true)"
fi
printf 'next_steps_unparsed: %d\n' "$unparsed_count"
if [[ -n "$unparsed" ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && printf 'unparsed: %s\n' "$line"
  done <<<"$unparsed"
fi
[[ "$unparsed_count" -gt 0 ]] && remains=1

[[ "$todo_count" -gt 0 ]] && remains=1

# ── ROADMAP.md rows not done ───────────────────────────────────────────
# On a spec-kit project the roadmap is the ONE list of outstanding work
# (project/references/templates/ROADMAP.md), read through roadmap.sh so this
# cannot disagree with detect-stage.sh or next-implement-command.sh about the
# table. Every row that is not `done` or `absorbed by …` is open — a `blocked:`
# watch included, since a watch is exactly what must keep a project from
# closing. A table roadmap.sh cannot read is also work-remains: a veto that
# resolves a parse failure toward "nothing left" would flip the project done.
if [[ -f "$project_dir/ROADMAP.md" ]]; then
  printf 'roadmap_table: yes\n'
  rm_err="$(mktemp)"; rm_rc=0
  rm_rows="$(bash "$(dirname "${BASH_SOURCE[0]}")/roadmap.sh" "$project_dir" 2>"$rm_err")" || rm_rc=$?
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
