#!/usr/bin/env bash
# find-project.sh
#
# Resolve a project slug to its folder path. Walks `projects/<domain>/<date>_<slug>/`
# and emits the matching path, or "NOT_FOUND" with the nearest matches.
#
# Deterministic — single filesystem scan.
#
# Usage:
#   find-project.sh <slug>
#   find-project.sh <domain>/<slug>   # fully-qualified form bypasses slug-only scan
#
# Output (one or more lines to stdout):
#   PATH:projects/<domain>/<date>_<slug>     → success
#   NOT_FOUND                                → no match
#   NOT_FOUND:nearest: <slug1>, <slug2>, ... → no exact match; suggestions
#
# Exit code: 0 always — caller parses stdout.

set -euo pipefail

INPUT="${1:?slug required}"

# Fully-qualified form: <domain>/<slug>
if [[ "$INPUT" == */* ]]; then
  DOMAIN="${INPUT%%/*}"
  SLUG="${INPUT##*/}"
  MATCH=$(find "projects/${DOMAIN}" -maxdepth 1 -type d -name "*_${SLUG}" 2>/dev/null | head -1)
  if [ -n "$MATCH" ]; then
    echo "PATH:${MATCH}"
    exit 0
  fi
  echo "NOT_FOUND"
  exit 0
fi

# Bare slug: scan all domains
MATCH=$(find projects -maxdepth 2 -type d -name "*_${INPUT}" 2>/dev/null | head -1)

if [ -n "$MATCH" ]; then
  echo "PATH:${MATCH}"
  exit 0
fi

# Suggest nearest matches by substring
NEAREST=$(find projects -maxdepth 2 -type d 2>/dev/null \
  | grep -iE "_.*${INPUT}.*$" \
  | sed 's|.*_||' \
  | sort -u \
  | head -5 \
  | paste -sd, - || true)

if [ -n "$NEAREST" ]; then
  echo "NOT_FOUND:nearest: $NEAREST"
else
  echo "NOT_FOUND"
fi
exit 0
