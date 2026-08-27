#!/usr/bin/env bash
# {{name}}.sh — TODO one-line: a PreToolUse/PostToolUse Claude hook. <what it guards>.
#
# Category (the list of things a hook is allowed to do — pick ONE, delete the rest):
#   (6) memory-write redirect  (7) tool-sandbox block
#   (8) session-discipline gate (9) context injection on tool call
#
# Wiring (REQUIRED — fires from nothing until added). In .claude/settings.json:
#   { "matcher": "<ToolName or regex>",
#     "hooks": [{ "type": "command",
#                 "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/{{name}}.sh" }] }
#
# Exit-code contract (Anthropic hooks, code.claude.com/docs/en/hooks):
#   exit 0 = allow · exit 2 = BLOCK (stderr becomes the denial reason shown to
#   Claude) · exit 1 is NON-blocking — never use it to block (the canonical bug).

set -euo pipefail

# If you add anything here that can fail — logging, a lookup, sourcing a helper
# — run it in a SUBSHELL with `|| true`. A non-zero exit leaking out of a
# tool-call hook denies the tool call, and exit 2 blocks it outright with an
# empty reason, which reads to the user as the tool being broken.

# The tool-call event arrives as JSON on stdin. Parse the bits you need with jq.
INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

# TODO the guard. Block with exit 2 + an actionable reason naming the file + fix
# (@rule:hook-errors-actionable). Example:
#
#   TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
#   FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
#   if [ "$TOOL" = "Write" ] && [[ "$FILE" == *.forbidden ]]; then
#     echo "  {{name}}: $FILE: writes to .forbidden are blocked — use .allowed" >&2
#     exit 2
#   fi

exit 0
