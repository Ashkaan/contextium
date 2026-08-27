#!/usr/bin/env bash
# relocate-evidence.sh — Change 3 of the /author compress flow. The MECHANICAL
# half of evidence relocation: append prose the compression cut out of a rule
# into the journal entry the rule's `[date]` already points at. The JUDGMENT
# half (which sentences are narrative vs. directive) stays in the skill body
# (@rule:deterministic-over-ai) — this script only moves text a caller already
# decided to cut.
#
# The rule's `[YYYY-MM-DD]` IS the link id: a reader following it lands on
# journal/<date>.md, which carries the full story (keeping the rule body minimal
# detached-evidence contract, enacted rather than assumed).
#
# peers: .claude/skills/author/SKILL.md, .claude/skills/author/references/rule.md
#
# Usage:
#   relocate-evidence.sh <slug> <date> <evidence-file>
#     <slug>          rule id, e.g. deploy-is-part-of-implementing
#     <date>          YYYY-MM-DD from the rule's trailing [date]
#     <evidence-file> file holding the cut prose (use - for stdin)
#
# Behavior:
#   - Appends a `### <slug> — evidence (relocated from rule)` block to
#     journal/<date>.md.
#   - Idempotent: if that block already exists, exits 0 without duplicating.
#   - If journal/<date>.md is absent (rule predates journaling), creates a
#     minimal back-dated stub with valid frontmatter first.
# exit: 0 on append or idempotent skip; 1 on bad args / unreadable evidence;
#       2 on usage.

set -euo pipefail

err() { echo "$@" >&2; }

if [[ $# -lt 3 ]]; then
  err "usage: $(basename "$0") <slug> <date> <evidence-file|->"
  exit 2
fi

slug="$1"
date="$2"
ev_src="$3"

if [[ ! "$date" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
  err "invalid date (want YYYY-MM-DD): $date"
  exit 1
fi
if [[ ! "$slug" =~ ^[a-z][a-z0-9-]*$ ]]; then
  err "invalid slug (want kebab-case): $slug"
  exit 1
fi

REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  err "not inside a git repo, and CLAUDE_PROJECT_DIR is unset"
  exit 1
fi
journal="$REPO_ROOT/journal/$date.md"

# Read the evidence (file or stdin).
if [[ "$ev_src" == "-" ]]; then
  evidence="$(cat)"
else
  if [[ ! -f "$ev_src" ]]; then
    err "evidence file not found: $ev_src"
    exit 1
  fi
  evidence="$(cat "$ev_src")"
fi
# Strip leading/trailing blank lines.
evidence="$(printf '%s\n' "$evidence" | sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba}')"

if [[ -z "$evidence" ]]; then
  err "no evidence text supplied — nothing to relocate"
  exit 1
fi

heading="### $slug — evidence (relocated from rule)"

# Idempotency guard: if this rule's relocated block already exists, skip.
if [[ -f "$journal" ]] && grep -qF "$heading" "$journal"; then
  err "already relocated: '$heading' present in journal/$date.md — skipping"
  exit 0
fi

# Create a minimal valid stub if the journal entry does not exist.
if [[ ! -f "$journal" ]]; then
  mkdir -p "$REPO_ROOT/journal"
  {
    echo "---"
    echo "date: $date"
    echo "tags: [relocated-evidence]"
    echo "---"
    echo ""
    echo "# $date"
    echo ""
    echo "Back-dated stub holding rule evidence relocated out of always-loaded"
    echo "rules during a /author compress pass. Not a session log."
  } > "$journal"
  err "created back-dated stub: journal/$date.md"
fi

# Append the relocated block.
{
  echo ""
  echo "$heading"
  echo ""
  printf '%s\n' "$evidence"
} >> "$journal"

err "relocated evidence for '$slug' → journal/$date.md"
exit 0
