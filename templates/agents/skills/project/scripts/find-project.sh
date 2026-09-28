#!/usr/bin/env bash
# find-project.sh — resolve a project slug to its folder,
# `projects/<domain>/<date>_<slug>/`, relative to the repo root (run it from
# there). Deterministic: one filesystem scan.
#
# Usage:
#   find-project.sh <slug>
#   find-project.sh <domain>/<slug>   # the qualified form searches one domain
#
# Output (one line on stdout):
#   PATH:projects/<domain>/<date>_<slug>   found
#   NOT_FOUND                              no match
#   NOT_FOUND:nearest: <slug>,<slug>,...   no exact match; up to five slugs
#                                          containing the input
#
# A slug in two domains resolves to the first in path order; the qualified form
# picks the other.
#
# Exit: 0 always — the caller parses stdout.
#
# peers:
#   .agents/skills/project/scripts/find-project.test.sh

set -euo pipefail

INPUT="${1:?slug required}"

if [[ "$INPUT" == */* ]]; then
  DOMAIN="${INPUT%%/*}"
  SLUG="${INPUT##*/}"
  MATCH=$(find "projects/${DOMAIN}" -mindepth 1 -maxdepth 1 -type d -name "*_${SLUG}" 2>/dev/null | sort | head -1 || true)
  if [ -n "$MATCH" ]; then echo "PATH:${MATCH}"; else echo "NOT_FOUND"; fi
  exit 0
fi

MATCH=$(find projects -mindepth 2 -maxdepth 2 -type d -name "*_${INPUT}" 2>/dev/null | sort | head -1 || true)
if [ -n "$MATCH" ]; then
  echo "PATH:${MATCH}"
  exit 0
fi

# Nearest: slugs containing the input, case-insensitively, as a fixed string.
NEAREST=$(find projects -mindepth 2 -maxdepth 2 -type d -name '*_*' 2>/dev/null \
  | sed 's|.*/[^_]*_||' \
  | grep -iF -- "$INPUT" \
  | sort -u \
  | head -5 \
  | paste -sd, - || true)

if [ -n "$NEAREST" ]; then
  echo "NOT_FOUND:nearest: $NEAREST"
else
  echo "NOT_FOUND"
fi
exit 0
