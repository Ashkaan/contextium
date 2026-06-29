#!/usr/bin/env bash
# Block writes to the AI runtime memory dir (~/.claude/projects/*/memory/) and
# route the content to the right destination in the context repo
# deterministically — no AskUserQuestion round-trip.
#
# The runtime memory directory is session-local scratch; it is not a durable
# storage surface. Knowledge belongs in the repo. Classification reads the
# proposed text + filename and proposes ONE concrete destination path. Claude
# reads the destination from the block message and writes there directly. Skip
# is still allowed — Claude can decline to persist.
#
# Routing rules (apply in order; first match wins):
#   1. Filename or content mentions a person → a per-person note under
#      knowledge/ (knowledge/<name>/<slug>.md).
#      Triggers on filename like "person-<name>", "people-<name>", "<name>-bio".
#   2. Filename or content describes a behavioral rule / feedback / correction →
#      a rule file under .claude/rules/.
#      Triggers on: "MUST", "MUST NOT", "user pushback", "user corrected",
#                   "@rule:", "feedback:", "directive"
#   3. Filename or content is project status / blocker / progress →
#      projects/<domain>/<date>_<slug>/README.md (Claude provides the actual
#      path from session context).
#      Triggers on: "blocked", "next steps", "status:", "in progress"
#   4. Filename or content names an app or integration →
#      apps/<name>/README.md or integrations/<name>/README.md
#      Triggers on: matching a directory under apps/ or integrations/
#   5. Default fallback when none of the above match → propose a sibling
#      knowledge/<domain>/ note and ask Claude to confirm the domain inline.

set -euo pipefail

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

[ -z "$FILE_PATH" ] && exit 0
[[ "$FILE_PATH" =~ \.claude/projects/.*/memory/ ]] || exit 0

CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // empty')
FILENAME=$(basename "$FILE_PATH")
LOWER=$(printf '%s\n%s' "$FILENAME" "$CONTENT" | tr '[:upper:]' '[:lower:]')

# Compose a single destination proposal. Order: people → rules → projects →
# apps/integrations → fallback. Each branch sets DEST + WHY.
DEST=""
WHY=""

# 1. People classification
if [[ "$FILENAME" =~ ^(person|people)[-_] ]] || [[ "$FILENAME" =~ -bio\.md$ ]]; then
  name=$(echo "$FILENAME" | sed -E 's/^(person|people)[-_]//; s/-bio\.md$//; s/\.md$//')
  DEST="knowledge/${name}/${FILENAME}"
  WHY="filename matches people pattern; content is about a person"
fi

# 2. Rules / feedback classification
if [ -z "$DEST" ] && echo "$LOWER" | grep -qE '\b(must not|must|user pushback|user corrected|@rule:|feedback:|directive)\b'; then
  DEST=".claude/rules/<id>.md"
  WHY="content describes a behavioral rule or user correction — add it as a new rule file (see @rule:write-your-own-rules)"
fi

# 3. Project status / blocker classification
if [ -z "$DEST" ] && echo "$LOWER" | grep -qE '\b(blocked|next steps|status:|in progress|monitoring-until)\b'; then
  DEST="projects/<domain>/<date>_<slug>/README.md"
  WHY="content is project status/progress — use the matching project's README"
fi

# 4. App / integration classification
if [ -z "$DEST" ]; then
  REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  for d in "$REPO_ROOT/apps"/*/ "$REPO_ROOT/integrations"/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    [[ "$name" == _* ]] && continue
    if echo "$LOWER" | grep -qiw "$name"; then
      kind=$(basename "$(dirname "$d")")
      DEST="${kind}/${name}/README.md"
      WHY="content mentions ${kind}/${name}/"
      break
    fi
  done
fi

# 5. Fallback
if [ -z "$DEST" ]; then
  DEST="knowledge/<domain>/<topic>.md"
  WHY="no clear classification — pick the matching knowledge/ domain"
fi

cat >&2 <<EOF
MEMORY WRITE BLOCKED at: ${FILE_PATH}

Claude's per-project memory directory is not a storage surface. Knowledge
belongs in the context repo.

ROUTE: ${DEST}
WHY:   ${WHY}

Write the content to the routed destination (or a near-sibling if the routed
path needs adjustment based on session context — e.g., the actual project
slug, the actual person's name). Follow the destination's frontmatter and
section conventions; commit in the normal flow.

If the content shouldn't be persisted at all, skip the write.
EOF

exit 2