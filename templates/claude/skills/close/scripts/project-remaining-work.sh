#!/usr/bin/env bash
# project-remaining-work.sh — emit the HARD signals of unfinished work in a
# project, so /close step-2.1 can decide whether the project just finished.
# Counting files and table rows is DATA, not judgment (@rule:deterministic-over-ai);
# the judgment left to Claude is only "does the remaining Next Steps prose
# describe real work, and does the shipped thing need a watch window?".
#
# Usage: project-remaining-work.sh <project-folder>
#   <project-folder> — repo-relative or absolute path to projects/<domain>/<date>_<slug>/
#
# Output (stdout), key: value lines:
#   status: active|blocked|monitor|completed|         (frontmatter, empty if absent)
#   unreported_specs: N                               (*.spec.md with no sibling *-report.md)
#   spec: <name>                                      (one line per un-reported SPEC)
#   shard_table: yes|no                               (## Shard Status present)
#   shard_open: N                                     (rows whose State cell is not closed)
#   shard: <name> <state>                             (one line per open shard row)
#   next_steps_section: yes|no
#   next_steps_unchecked: N                           (`- [ ]` under ## Next Steps)
#   todo: <text>                                      (one line per unchecked box)
#   next_steps_unparsed: N                            (list items that are NOT checkboxes)
#   unparsed: <text>                                  (one line per such item)
#   verdict: work-remains|no-hard-signal
#
# `verdict: no-hard-signal` does NOT mean "the project is done" — it means
# nothing countable is outstanding, so the completion call is now Claude's to
# make by reading the README goal against whatever prose sits in Next Steps
# (numbered backlogs carry no done-state and cannot be counted). `work-remains`
# is the deterministic veto: never flip a project holding one.
#
# peers:
#   .claude/skills/close/scripts/project-remaining-work.test.sh
#   .claude/skills/close/scripts/next-implement-command.sh
#   .claude/skills/close/SKILL.md (step-2.1-project-completion)

set -euo pipefail

err() { echo "Error: $*" >&2; }
trim() { printf '%s' "$1" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//'; }

[[ $# -eq 1 ]] || { err "usage: project-remaining-work.sh <project-folder>"; exit 2; }

project_dir="$1"
[[ -d "$project_dir" ]] || { err "not a directory: $project_dir"; exit 2; }

readme="$project_dir/README.md"
[[ -f "$readme" ]] || { err "no README.md in $project_dir"; exit 2; }

remains=0

# ── Frontmatter status ─────────────────────────────────────────────────
status="$(sed -nE 's/^status:[[:space:]]*([a-z]+).*/\1/p' "$readme" | head -n1)"
printf 'status: %s\n' "$status"

# ── Un-reported SPECs ──────────────────────────────────────────────────
specs=()
shopt -s nullglob
for spec in "$project_dir"/*.spec.md; do
  name="$(basename "$spec" .spec.md)"
  [[ -f "$project_dir/${name}-report.md" ]] || specs+=("$name")
done
shopt -u nullglob

printf 'unreported_specs: %d\n' "${#specs[@]}"
for name in ${specs[@]+"${specs[@]}"}; do
  printf 'spec: %s\n' "$name"
done
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
# TWO counts, not one, and the second exists because the first silently missed real
# work. Measured 2026-08-10 across the 21 active projects: FIVE cleared this gate with
# a written backlog of 3 to 9 items each, because their lists were numbered or bulleted
# rather than checkbox-shaped, and a sixth (linkedin-triager-handles-more) used the
# heading "## Next steps" with a lowercase s, which the old pattern did not match at all.
# In every one of those cases the script reported `next_steps_section: no` and
# `verdict: no-hard-signal` — indistinguishable, to a caller, from a project with an
# empty backlog.
#
# The heading match is now case-insensitive, and a list item that is not an unchecked box
# is counted as UNPARSED rather than ignored. Unparsed items still set `work-remains`:
# this script is the deterministic VETO, and a veto that resolves ambiguity toward
# "nothing left" is the wrong direction for a gate whose whole job is refusing to close
# a project with work in it. A checked box (`- [x]`) is done and counts as neither.
if grep -qiE '^## +next steps' "$readme"; then
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
  todos="$(printf '%s\n' "$scan" | sed -n 's/^TODO\t//p')"
  unparsed="$(printf '%s\n' "$scan" | sed -n 's/^UNPARSED\t//p')"
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

if [[ "$remains" -eq 1 ]]; then
  printf 'verdict: work-remains\n'
else
  printf 'verdict: no-hard-signal\n'
fi
