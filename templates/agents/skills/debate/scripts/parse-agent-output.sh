#!/usr/bin/env bash
# parse-agent-output.sh — Step 4 input preparation for /debate. Reads
# the .output files in the output dir produced by dispatch-agents.sh,
# strips Codex header/footer noise, extracts the structured `## Position`
# block, and emits cleaned blocks delimited by `=== <role> ===`.
#
# Handles two schemas: round-1 (`## Position`, `## Key Arguments`,
# `## Strongest Point`, `## Acknowledged Weaknesses`) and round-2
# (`## Rebuttal`, `## Underweighted Argument`, `## Revised Position`).
#
# NO ANSWER IS DROPPED. Skipping an output whose anchor heading was not at the
# start of a line silently takes an agent out of the debate — a model's
# preamble can run straight into `## Position` with no newline. The anchor
# is found anywhere in a line, and an answer with no anchor at all is
# passed through whole, marked unstructured, for the synthesis to read.
#
# Each block names who argued it (`argued by:`), from the `.voice` file
# dispatch-agents.sh writes — including a stand-in for a failed voice.
#
# peers: build-agent-prompts.sh, dispatch-agents.sh, .agents/skills/debate/SKILL.md
#
# Usage:
#   parse-agent-output.sh --output-dir <path> [--round 1|2]

set -euo pipefail

err() { echo "$@" >&2; }

OUTPUT_DIR=""
ROUND=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="${2:-}"; shift 2 ;;
    --round)      ROUND="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,15p' "$0" >&2; exit 0 ;;
    *)            err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$OUTPUT_DIR" ]] || { err "--output-dir required"; exit 2; }
[[ -d "$OUTPUT_DIR" ]] || { err "output dir not found: $OUTPUT_DIR"; exit 2; }

case "$ROUND" in
  1|2) ;;
  *) err "--round must be 1 or 2 (got: $ROUND)"; exit 2 ;;
esac

# Anchor heading that marks the start of the structured block per round.
if [[ "$ROUND" -eq 1 ]]; then
  anchor='## Position'
else
  anchor='## Rebuttal'
fi

ok_count=0
files_found=0
for f in "$OUTPUT_DIR"/*.output; do
  [[ -e "$f" ]] || continue
  files_found=$((files_found + 1))
  role=$(basename "$f" .output)
  # The anchor's line: the heading may follow a preamble on the same line, but
  # it ends the line — a sentence that merely MENTIONS it is not the heading.
  # Empty when there is none.
  start_line=$(grep -nE -- "${anchor}[[:space:]]*$" "$f" | head -n 1 | cut -d: -f1 || true)
  echo "=== $role ==="
  if [[ -s "$OUTPUT_DIR/${role}.voice" ]]; then
    echo "argued by: $(head -n 1 "$OUTPUT_DIR/${role}.voice")"
  fi
  if [[ -z "$start_line" ]]; then
    err "  $role: unstructured output — no '$anchor' heading; passing it through whole"
    echo "(unstructured — no '$anchor' heading)"
    start_line=1
  fi
  # From the anchor onward (cutting any preamble on the anchor's own line);
  # stop at the first codex-style footer marker (`[done`, `total tokens:`,
  # `tokens-in:`, `tokens-out:`). Trim trailing blank lines from the result.
  tail -n "+${start_line}" "$f" | awk -v a="$anchor" '
    NR == 1 { i = index($0, a); if (i > 0 && substr($0, i + length(a)) ~ /^[[:space:]]*$/) $0 = substr($0, i) }
    /^\[done|^total tokens:|^tokens-(in|out):/ { exit }
    { print }
  ' | awk '
    { lines[NR] = $0 }
    END {
      end = NR
      while (end > 0 && lines[end] ~ /^[[:space:]]*$/) end--
      for (i = 1; i <= end; i++) print lines[i]
    }
  '
  echo
  ok_count=$((ok_count + 1))
done

# When no .output files exist at all, count .gap files for diagnostics.
if [[ "$files_found" -eq 0 ]]; then
  gaps=$(find "$OUTPUT_DIR" -name '*.gap' | wc -l)
  err "no .output files in $OUTPUT_DIR (gap count: $gaps)"
  exit 1
fi

[[ "$ok_count" -gt 0 ]]
