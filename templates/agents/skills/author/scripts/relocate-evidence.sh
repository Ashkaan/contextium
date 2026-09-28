#!/usr/bin/env bash
# relocate-evidence.sh — Change 3 of the /author compress flow. The MECHANICAL
# half of evidence relocation: append prose the compression cut out of a rule
# into the journal entry the rule's `[date]` already points at. The JUDGMENT
# half (which sentences are narrative vs. directive) stays in the skill body
# (@rule:deterministic-over-ai) — this script only moves text a caller already
# decided to cut.
#
# The rule's `[YYYY-MM-DD]` IS the link id: a reader following it lists the
# journal day folder journal/<date>/ and finds the evidence file there, so the
# rule body stays minimal and the story is one hop away.
#
# peers: .agents/skills/author/SKILL.md, .agents/skills/author/references/rule.md,
#        .agents/skills/close/references/journal-entry.md (the entry shape)
#
# Usage:
#   relocate-evidence.sh <slug> <date> <evidence-file>
#     <slug>          rule id, e.g. deploy-is-part-of-implementing
#     <date>          YYYY-MM-DD from the rule's trailing [date]
#     <evidence-file> file holding the cut prose (use - for stdin)
#
# Behavior:
#   - Writes journal/<date>/0000-<slug>-evidence.md, a journal entry in the
#     shape journal-entry.md defines (front matter, a title equal to the
#     heading, Action, a summary, the evidence under Findings), so the close's
#     journal check accepts it. `0000` sorts it before the day's sessions.
#     The evidence is quoted (`> `) so no line of it can read as schema, and
#     the entry is run through close/scripts/check-journal-entry.sh before
#     success is reported; a refused entry is removed and the exit is 1.
#   - Idempotent: if that file already exists, exits 0 without touching it.
# exit: 0 on write or idempotent skip; 1 on bad args / unreadable evidence;
#       2 on usage.

set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKER="$SCRIPT_DIR/../../close/scripts/check-journal-entry.sh"

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
rel="journal/$date/0000-$slug-evidence.md"
journal="$REPO_ROOT/$rel"

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
# Strip leading/trailing blank lines. awk, not a sed loop: BSD sed reads a
# label inside braces differently from GNU sed.
evidence="$(printf '%s\n' "$evidence" | awk 'NF { seen = 1 } seen { buf[++n] = $0 }
  END { while (n > 0 && buf[n] ~ /^[[:space:]]*$/) n--; for (i = 1; i <= n; i++) print buf[i] }')"

if [[ -z "$evidence" ]]; then
  err "no evidence text supplied — nothing to relocate"
  exit 1
fi

title="one-off (evidence relocated from rule $slug)"

if [[ -f "$journal" ]]; then
  err "already relocated: $rel exists — skipping"
  exit 0
fi

mkdir -p "$(dirname "$journal")"
{
  echo "---"
  echo "date: $date"
  echo 'time: "00:00"'
  echo "title: $title"
  echo "project: null"
  echo "tags: [relocated-evidence]"
  echo "---"
  echo ""
  echo "### $title"
  echo "**Action:** updated"
  echo ""
  echo "The failure story behind @rule:$slug, cut from the always-loaded rule by an /author compress pass."
  echo ""
  echo "**Findings:**"
  echo ""
  # Quoted line by line: evidence is prose from a rule, and a line of it that
  # starts `date:` or `**Decisions:**` at column 0 would otherwise be read as
  # the entry's own front matter or sections.
  printf '%s\n' "$evidence" | sed -e 's/^/> /' -e 's/^> $/>/'
} > "$journal"

# Report success only for an entry the close will accept. A refused one is
# removed, so a re-run is not skipped as "already relocated".
if [[ ! -f "$CHECKER" ]]; then
  rm -f "$journal"
  err "cannot validate the entry: no $CHECKER — nothing written"
  exit 1
fi
if ! check_out="$(bash "$CHECKER" "$journal" 2>&1)"; then
  rm -f "$journal"
  err "the journal check refused the entry, so nothing was written:"
  err "$check_out"
  exit 1
fi

err "relocated evidence for '$slug' → $rel"
exit 0
