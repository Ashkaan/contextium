#!/usr/bin/env bash
# grep-rule-peers.sh — Step `peer-sweep` of /author rule branch. Greps the
# target rule file for sibling `^## <slug>` sections so the orchestrator
# can review them for overlap with the drafted rule.
#
# The peer-sweep judgment (which siblings overlap, whether to subsume)
# stays the model's — the script owns the discovery (mechanism-not-prose).
#
# peers: run-rule-linters.sh, .agents/skills/author/SKILL.md
#
# Usage:
#   grep-rule-peers.sh <path-to-rule-file>
#
# Output (stdout): one line per `^## <slug>` heading: `<lineno>:## <slug>`.
# Empty stdout when the file has zero sections.
# exit: 0 when file readable; non-zero when arg missing or file missing.

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

# Match h2 headings (`## <slug>`) — these are the per-rule sections.
# Returns 1 when grep finds no match; treat that as a clean empty result.
grep -nE '^## [a-zA-Z][a-zA-Z0-9-]*$' "$rule_file" || true
