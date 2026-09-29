#!/usr/bin/env bash
# layer-3.sh — Layer 3 of /implement Phase 4 (quality-check dry-run).
#
# Runs the workbench's own checks against the change as a pre-commit dry-run,
# so Phase 4 surfaces the same violations land.sh would refuse the close on —
# before the close. Advisory: always exits 0.
#
# The checks are the ones in `.agents/checks/` that the close runs: decision
# records, skill manifests and secrets over what changed since HEAD, and
# standards citations over the tracked tree. Each present one prints a RAN
# line; when none is present, a NO-MATCH line.
#
# peers: layer-1.sh, layer-2.sh, resolve-scope.sh,
#        .agents/skills/close/scripts/land.sh (the same checks, blocking)
#
# Usage:
#   layer-3.sh --scope <arg>     (the scope is accepted for symmetry with the
#                                 other layers; the checks read the change)
#
# Output (stdout):
#   RAN: check-decision-records.sh → PASS
#   NO-MATCH: no quality check applies to this scope
#
# Exit:
#   0  always (advisory; land.sh is the blocking surface)
#   1  scope-arg invalid / repo missing

set -euo pipefail

err() { echo "$@" >&2; }

SCOPE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE="${2:-}"
      shift
      [[ $# -gt 0 ]] && shift
      ;;
    -h|--help)
      sed -n '2,30p' "$0" >&2
      exit 0
      ;;
    *)
      err "unknown flag: $1"
      exit 1
      ;;
  esac
done

# Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
# back to git when unset (some callers leave it unset). Keep `|| true`
# inside the substitution so a failing rev-parse outside a repo doesn't trip
# `set -e` (exit 128) before the guard surfaces the documented exit code.
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_DIR" ]] || { err "CLAUDE_PROJECT_DIR unset and not inside a git repo"; exit 1; }
CHECKS_REL=".agents/checks"
cd "$REPO_DIR"
: "${SCOPE}"   # accepted, not used: the checks read the change themselves

ran=0
for check in check-decision-records.sh check-skills.sh check-secrets.sh check-standards-refs.sh; do
  [[ -f "$CHECKS_REL/$check" ]] || continue
  ran=1
  if [[ "$check" == check-standards-refs.sh ]]; then set -- ; else set -- --since HEAD; fi
  if bash "$CHECKS_REL/$check" "$@" >/dev/null 2>&1; then
    echo "RAN: $check → PASS"
  else
    echo "RAN: $check → FAIL"
  fi
done
[[ "$ran" -eq 1 ]] || echo "NO-MATCH: no quality check applies to this scope"

exit 0
