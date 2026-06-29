#!/usr/bin/env bash
# check-staleness.sh
#
# Scan all active/blocked/monitor projects for staleness signals — projects with
# no journal mention in the last N days (default 14). Emits a flagged list for
# the /project caller to surface (optional — fires when user asks
# "anything I'm forgetting?").
#
# Deterministic — filesystem + journal grep, no AI.
#
# Usage:
#   check-staleness.sh [days]      # default 14 days
#
# Output (zero or more lines to stdout, one per stale project):
#   STALE:<domain>/<slug>:days-since-last-mention=<N>
#
# Output is empty if no projects flagged.
# Exit code: 0 always.

set -euo pipefail

DAYS="${1:-14}"
CUTOFF_DATE=$(date -d "${DAYS} days ago" +%Y-%m-%d 2>/dev/null || date -v-"${DAYS}d" +%Y-%m-%d)

# For each project folder, find the most recent journal entry mentioning its slug
for project_dir in projects/*/*/; do
  [ -d "$project_dir" ] || continue
  slug=$(basename "$project_dir" | sed 's/^[0-9]\{4\}-[0-9]\{2\}-[0-9]\{2\}_//')
  domain=$(basename "$(dirname "$project_dir")")

  # Status from frontmatter — only flag active/blocked/monitor
  readme="${project_dir}README.md"
  [ -f "$readme" ] || continue
  status=$(awk '/^status:/{print $2; exit}' "$readme")
  case "$status" in
    active|blocked|monitor) ;;
    *) continue ;;
  esac

  # Most recent journal entry mentioning the slug
  latest_mention=$(grep -lE "(\b${slug}\b|/${slug}\b)" journal/*.md 2>/dev/null \
    | sed 's|journal/||; s|\.md$||' \
    | sort -r \
    | head -1)

  if [ -z "$latest_mention" ]; then
    echo "STALE:${domain}/${slug}:days-since-last-mention=never"
    continue
  fi

  # Compare date strings (YYYY-MM-DD sorts lexicographically)
  if [[ "$latest_mention" < "$CUTOFF_DATE" ]]; then
    days_diff=$(( ( $(date -d "$(date +%Y-%m-%d)" +%s 2>/dev/null || date +%s) - $(date -d "$latest_mention" +%s 2>/dev/null || date -j -f "%Y-%m-%d" "$latest_mention" +%s) ) / 86400 ))
    echo "STALE:${domain}/${slug}:days-since-last-mention=${days_diff}"
  fi
done
exit 0
