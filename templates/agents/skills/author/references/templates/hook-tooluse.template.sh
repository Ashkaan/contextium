#!/usr/bin/env bash
# {{name}}.sh — TODO one-line: a PreToolUse/PostToolUse hook. <what it guards>.
#
# Category (pick ONE, delete the rest):
#   (6) memory-write redirect  (7) tool-sandbox block
#   (8) session-discipline gate (9) context injection on tool call
#
# Wiring (REQUIRED — fires from nothing until added) in each harness's hook
# manifest: Claude Code ~/.claude/settings.json, Codex ~/.codex/hooks.json,
# Antigravity .agents/hooks.json. Claude Code's shape:
#   { "matcher": "<ToolName or regex>",
#     "hooks": [{ "type": "command",
#                 "command": "$CLAUDE_PROJECT_DIR/.agents/hooks/{{name}}.sh" }] }
#
# Exit-code contract (Anthropic hooks, code.claude.com/docs/en/hooks):
#   exit 0 = allow · exit 2 = BLOCK (stderr becomes the denial reason shown to
#   Claude) · exit 1 is NON-blocking — never use it to block (the canonical bug).

set -euo pipefail

# Anything this hook sources (a shared helper, a telemetry logger) goes in a
# SUBSHELL: `source` runs the file in THIS shell, so an `exit` or a `set -u`
# fatal inside it terminates the hook — and a non-zero exit leaking out of a
# tool-call hook denies the tool call, with exit 2 blocking it outright and an
# empty reason.

# The tool-call event arrives as JSON on stdin. Parse the bits you need with jq.
INPUT=$(cat)
[ -n "$INPUT" ] || exit 0

# TODO the guard. Block with exit 2 + an actionable reason naming the file + fix.
# Example:
#
#   TOOL=$(printf '%s' "$INPUT" | jq -r '.tool_name // empty')
#   FILE=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty')
#   if [ "$TOOL" = "Write" ] && [[ "$FILE" == *.forbidden ]]; then
#     echo "  {{name}}: $FILE: writes to .forbidden are blocked — use .allowed" >&2
#     exit 2
#   fi

exit 0
