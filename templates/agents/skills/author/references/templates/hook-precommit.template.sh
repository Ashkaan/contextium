#!/usr/bin/env bash
# {{name}}.sh — TODO one-line: a pre-commit check. <what it validates>.
#
# Category (pick ONE, delete the rest; all nine are in /author's hook.md):
#   (1) syntactic check  (2) peer-file co-commit  (3) progress-doc co-commit
#   (4) checklist gate    (5) journal frontmatter
#
# Wiring (REQUIRED). Add an invocation in .githooks/pre-commit:
#   bash "$root/.githooks/checks/{{name}}.sh" <staged-files>
# Until that line exists this file never runs, and nothing will tell you.
#
# Exit-code contract: takes file paths as args; exit 1 on violation (the
# pre-commit body turns any non-zero into a commit block). Errors name the
# file + line + remediation (@rule:hook-errors-actionable).

set -euo pipefail

# Actionable-error helper — name the file, the issue, and the fix.
# shellcheck disable=SC2329  # template stub: the author's filled-in body calls this
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
