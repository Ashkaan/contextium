#!/usr/bin/env bash
# open-clarifications.sh — list the `NEEDS CLARIFICATION` markers still open in
# one spec folder. /implement does not start while any remain: a marker is a
# decision nobody made, and building past it is the misalignment the grill in
# /project exists to prevent. setup-worktree.sh refuses on exit 1,
# detect-stage.sh routes the row back to planning, next-implement-command.sh
# prints `/project` for it.
#
# Read: spec.md, plan.md and tasks.md. research.md is not — it is where an open
# question is SUPPOSED to be written down and resolved.
#
# Skipped: anything inside an HTML comment, single- or multi-line. The spec
# template's own instructions name the marker inside one
# (spec/references/templates/spec.md), and those are directions to the writer,
# not open questions.
#
# Usage: open-clarifications.sh <spec-folder>
# Output: `<file>:<line>: <text>` per marker, with the file's own line number.
# Exit: 0 none · 1 some · 2 usage, not a directory, or a spec file that cannot
# be read (an unread file must never pass as one with no markers).
#
# peers:
#   .agents/skills/close/scripts/open-clarifications.test.sh
#   .agents/skills/implement/scripts/setup-worktree.sh
#   .agents/skills/project/scripts/detect-stage.sh
#   .agents/skills/close/scripts/next-implement-command.sh

set -uo pipefail

err() { echo "Error: $*" >&2; }
[[ $# -eq 1 ]] || { err "usage: open-clarifications.sh <spec-folder>"; exit 2; }
folder="${1%/}"
[[ -d "$folder" ]] || { err "not a directory: $folder"; exit 2; }

found=0
for name in spec.md plan.md tasks.md; do
  f="$folder/$name"
  [[ -e "$f" ]] || continue
  [[ -f "$f" && -r "$f" ]] || { err "cannot read $f"; exit 2; }
  hits="$(LC_ALL=C awk -v name="$name" '
    {
      line = $0; out = ""
      while (line != "") {
        if (in_comment) {
          p = index(line, "-->")
          if (!p) { line = ""; break }
          line = substr(line, p + 3); in_comment = 0
        } else {
          p = index(line, "<!--")
          if (!p) { out = out line; line = ""; break }
          out = out substr(line, 1, p - 1); line = substr(line, p + 4); in_comment = 1
        }
      }
      if (out ~ /NEEDS CLARIFICATION/) {
        text = out; gsub(/^[ \t]+|[ \t]+$/, "", text)
        printf "%s:%d: %s\n", name, FNR, text
      }
    }
  ' "$f")" || { err "cannot read $f"; exit 2; }
  if [[ -n "$hits" ]]; then printf '%s\n' "$hits"; found=1; fi
done

exit "$found"
