#!/usr/bin/env bash
# run-rule-linters.sh — Step `co-commit` of /author rule branch. Runs the three
# rule-file linters against the rule file passed as $1; aggregates exit
# codes — fails loud on the first non-zero, naming which linter failed.
#
# Owns the SSOT for the linter set; SKILL.md cites this script, never lists
# the three linters by name (per @rule:single-source-of-truth).
#
# peers: grep-rule-peers.sh, .claude/skills/author/SKILL.md
#
# Usage:
#   run-rule-linters.sh <path-to-rule-file>
#
# Output (stdout):
#   PASS — check-rule-format
#   PASS — check-rule-refs
#
# stderr: failing linter's stderr is passed through.
# exit: 0 on all-pass; first non-zero linter's exit code on failure.

set -euo pipefail

err() { echo "$@" >&2; }

if [[ $# -lt 1 ]]; then
  err "usage: $(basename "$0") <path-to-rule-file>"
  exit 2
fi

rule_file="$1"

if [[ ! -f "$rule_file" ]]; then
  err "rule file not found: $rule_file"
  exit 1
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  err "cannot resolve repo root (set CLAUDE_PROJECT_DIR or run inside a git repo)"
  exit 1
fi

linters=(
  "check-rule-format.sh"
  "check-rule-refs.sh"
)

for linter in "${linters[@]}"; do
  script="$REPO_ROOT/.claude/hooks/checks/$linter"
  # A missing linter is a SKIP, not a failure. Someone who trimmed the layer
  # down should still be able to author a rule; refusing here would make an
  # optional check a hard dependency.
  if [[ ! -x "$script" ]]; then
    echo "SKIP — ${linter%.sh} (not installed)"
    continue
  fi
  rc=0
  # check-rule-refs.sh scans the whole repo; others take the file as arg.
  if [[ "$linter" == "check-rule-refs.sh" ]]; then
    "$script" >/dev/null || rc=$?
  else
    # The linters match on a repo-relative path and silently skip anything else,
    # so an absolute path here would pass every malformed rule.
    "$script" "${rule_file#"$REPO_ROOT"/}" >/dev/null || rc=$?
  fi
  if [[ $rc -ne 0 ]]; then
    err "FAIL — $linter (exit $rc)"
    exit "$rc"
  fi
  echo "PASS — ${linter%.sh}"
done
