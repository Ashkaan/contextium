#!/usr/bin/env bash
# check-staleness.sh
#
# Two independent "this project needs a decision" scans over projects/*/*/.
#
#   1. STALE   — active/blocked/monitor project with no journal mention in the
#                last N days (default 14). Optional; fire when the user asks
#                "anything I'm forgetting?".
#   2. EXPIRED — monitor project whose `monitoring-until:` date has already
#                passed. Fires on every blank-mode /project via
#                `step-0.5-render-index`.
#
# The two answer different questions and a project can trip either alone: a
# monitor window can lapse while the project is still being mentioned daily,
# and a stale project can sit well inside its window.
#
# EXPIRED exists because a monitor window that lapses silently is a decision
# nobody made: the project stops being watched and nothing says so.
#
# Deterministic — filesystem + frontmatter + journal grep, no AI.
#
# Usage:
#   check-staleness.sh                # both scans, 14-day staleness cutoff
#   check-staleness.sh [days]         # both scans, custom staleness cutoff
#   check-staleness.sh --expired-only # frontmatter only, no journal grep
#
# Output (zero or more lines to stdout):
#   STALE:<domain>/<slug>:days-since-last-mention=<N|never>
#   EXPIRED:<domain>/<slug>:monitoring-until=<YYYY-MM-DD>:days-overdue=<N>
#   NOWINDOW:<domain>/<slug>            # status: monitor, no parseable date
#
# Output is empty if nothing is flagged. Exit code: 0 always.
#
# PERFORMANCE — why frontmatter is read by ONE awk, not per-project subshells.
# `--expired-only` runs on every blank-mode /project, so it is on the
# interactive path. Shelling out per project costs seconds across a few hundred
# projects; one awk pass plus bash string ops costs a tenth of one. Keep it that
# way: no subshell inside the per-project loop except `date` on an
# already-expired row.
#
# Dates are compared in the machine's local timezone, and a window whose date IS
# today is NOT overdue — the day is still being watched. Day counts round to the
# nearest day, so a daylight-saving hour does not turn 10 days into 9.
#
# Journal days are folders, `journal/<date>/<HHMM>-<slug>.md`; a day written as
# one file, `journal/<date>.md` (the older shape), is read too. The date comes
# from the path, not the file's contents.
#
# peers:
#   .agents/skills/project/scripts/check-staleness.test.sh
#   .agents/skills/project/SKILL.md  (step-0.5-render-index + scripts table)

set -uo pipefail

RUN_STALE=1
DAYS=14
case "${1:-}" in
  --expired-only) RUN_STALE=0 ;;
  "") ;;
  *) DAYS="$1" ;;
esac

CUTOFF_DATE=$(date -d "${DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -v-"${DAYS}d" +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)
TODAY_EPOCH=$(date -d "$TODAY" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$TODAY" +%s)

# One pass over every project README: emit `path <TAB> status <TAB> until-value`.
# Frontmatter ONLY — a body may quote `monitoring-until:` in prose, and a prose
# mention is not a field.
# The flush-on-next-file shape avoids gawk's ENDFILE, which mawk lacks.
scan_frontmatter() {
  awk '
    function emit() { if (file != "") print file "\t" status "\t" until_ }
    FNR == 1 {
      emit()
      file = FILENAME; status = ""; until_ = ""
      infm = ($0 == "---") ? 1 : 0
      next
    }
    infm && $0 == "---" { infm = 0; next }
    infm && /^status:[ \t]/ && status == "" { status = $2 }
    infm && /^monitoring-until:[ \t]/ && until_ == "" {
      line = $0; sub(/^monitoring-until:[ \t]*/, "", line); until_ = line
    }
    END { emit() }
  ' projects/*/*/README.md 2>/dev/null
}

while IFS=$'\t' read -r readme status until_raw; do
  case "$status" in
    active|blocked|monitor) ;;
    *) continue ;;
  esac

  dir="${readme%/README.md}"
  slug="${dir##*/}"
  slug="${slug#[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_}"
  domain="${dir%/*}"
  domain="${domain##*/}"

  # --- EXPIRED (monitor only) ---
  if [ "$status" = "monitor" ]; then
    # The value may be a bare date, a date followed by prose, or a quoted date
    # followed by prose. Take the leading ISO date and ignore the rest.
    until_date="${until_raw#\"}"
    until_date="${until_date#\'}"
    until_date="${until_date:0:10}"
    until_epoch=""
    case "$until_date" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
        # Shape is right; `date` still rejects an impossible day (2026-13-45).
        until_epoch=$(date -d "$until_date" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$until_date" +%s 2>/dev/null || echo "")
        ;;
    esac

    if [ -z "$until_epoch" ]; then
      echo "NOWINDOW:${domain}/${slug}"
    elif [[ "$until_date" < "$TODAY" ]]; then
      echo "EXPIRED:${domain}/${slug}:monitoring-until=${until_date}:days-overdue=$(( (TODAY_EPOCH - until_epoch + 43200) / 86400 ))"
    fi
  fi

  [ "$RUN_STALE" -eq 1 ] || continue

  # --- STALE (active/blocked/monitor) ---
  # The boundary is hand-rolled, not `\b`: a journal usually names a project by
  # its FOLDER (`projects/web/2026-01-10_checkout-flow/`), and `_` is a word
  # character, so `\bcheckout-flow` never matches there. Excluding `-` on both
  # sides keeps a slug from matching a longer one that merely contains it.
  latest_mention=$(grep -rlE "(^|[^A-Za-z0-9-])${slug}([^A-Za-z0-9-]|$)" journal 2>/dev/null \
    | sed -n -e 's|^journal/\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]\)/.*|\1|p' \
             -e 's|^journal/\([0-9]\{4\}-[0-9][0-9]-[0-9][0-9]\)\.md$|\1|p' \
    | sort -ru \
    | head -1)

  if [ -z "$latest_mention" ]; then
    echo "STALE:${domain}/${slug}:days-since-last-mention=never"
    continue
  fi

  # Compare date strings (YYYY-MM-DD sorts lexicographically)
  if [[ "$latest_mention" < "$CUTOFF_DATE" ]]; then
    days_diff=$(( ( TODAY_EPOCH - $(date -d "$latest_mention" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$latest_mention" +%s) + 43200 ) / 86400 ))
    echo "STALE:${domain}/${slug}:days-since-last-mention=${days_diff}"
  fi
done < <(scan_frontmatter)

exit 0
