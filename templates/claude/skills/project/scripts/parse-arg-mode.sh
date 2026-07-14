#!/usr/bin/env bash
# parse-arg-mode.sh
#
# Parse the /project argument into a mode tag. Deterministic — pure regex.
#
# Modes:
#   blank          → no args; /project renders the project index inline (step-0.5-render-index)
#   create         → "create <freeform>" or bare freeform (new project)
#   existing-slug  → "<slug>" or "<domain>/<slug>" matching an existing project
#   complete       → "complete <slug>" (status change only)
#   update         → "update <slug>" (frontmatter edit only)
#
# Usage:
#   parse-arg-mode.sh "$ARGUMENTS"
#
# Output (two lines to stdout):
#   mode: <blank|create|existing-slug|complete|update>
#   payload: <the remainder after the mode verb, or empty for blank>
#
# Exit code: 0 always.

set -euo pipefail

INPUT="${1-}"

# Strip leading/trailing whitespace
INPUT=$(echo "$INPUT" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//')

if [ -z "$INPUT" ]; then
  echo "mode: blank"
  echo "payload:"
  exit 0
fi

# Mode verbs at the start of the input
case "$INPUT" in
  create\ *)
    echo "mode: create"
    echo "payload: ${INPUT#create }"
    exit 0
    ;;
  complete\ *)
    echo "mode: complete"
    echo "payload: ${INPUT#complete }"
    exit 0
    ;;
  update\ *)
    echo "mode: update"
    echo "payload: ${INPUT#update }"
    exit 0
    ;;
esac

# Heuristic: bare kebab-slug (one or more hyphens, no spaces) → existing-slug
# Heuristic: <domain>/<slug> form → existing-slug
# Heuristic: anything with spaces → create (freeform new project)
if [[ "$INPUT" == */* ]] && [[ "$INPUT" != *' '* ]]; then
  echo "mode: existing-slug"
  echo "payload: $INPUT"
  exit 0
fi

if [[ "$INPUT" =~ ^[a-z0-9]+(-[a-z0-9]+)+$ ]]; then
  echo "mode: existing-slug"
  echo "payload: $INPUT"
  exit 0
fi

# Default: freeform description → create
echo "mode: create"
echo "payload: $INPUT"
exit 0
