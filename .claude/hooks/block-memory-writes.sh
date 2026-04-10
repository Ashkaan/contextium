#!/bin/bash
# Block writes to Claude's auto-memory directory.
# Forces all knowledge into the repo where it's version-controlled and searchable.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0

# Block writes to any Claude memory directory
if [[ "$FILE_PATH" == *"/.claude/projects/"*"/memory/"* ]] || [[ "$FILE_PATH" == *"/.claude/projects/"*"/MEMORY.md" ]]; then
  echo "BLOCKED: Don't write to Claude memory files. Store knowledge in the repo instead (knowledge/, journal/, projects/). This keeps everything version-controlled and searchable." >&2
  exit 2
fi

exit 0