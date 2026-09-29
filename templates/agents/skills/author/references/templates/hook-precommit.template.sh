#!/usr/bin/env bash
# {{name}}.sh — TODO one-line: a check. <what it validates>.
#
# Category (pick ONE, delete the rest):
#   (1) syntactic check  (2) peer-file co-commit  (3) progress-doc co-commit
#   (4) checklist gate    (5) journal frontmatter
#
# What fires it: nothing yet. Nothing dispatches the checks in .agents/checks/
# on its own; until something calls this one it runs by hand, from the
# workbench root, and its test is {{name}}.test.sh beside it.
#
# Exit-code contract: takes file paths as args; exit 1 on violation. Errors
# name the file + line + remediation.

set -euo pipefail

# Actionable-error helper — name the file, the issue, and the fix.
# shellcheck disable=SC2317,SC2329  # template stub: the author's filled-in body calls this (SC2317 before shellcheck 0.11, SC2329 from it)
fail() {
  echo "  {{name}}: $1" >&2
  exit 1
}

# TODO the check. Example:
#   for file in "$@"; do
#     [[ -f "$file" ]] || continue
#     grep -q 'FORBIDDEN' "$file" && fail "$file: contains FORBIDDEN — remove it"
#   done

exit 0
