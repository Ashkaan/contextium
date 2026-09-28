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
#      a rule file under .agents/rules/.
#      Triggers on: "MUST", "MUST NOT", "user pushback", "user corrected",
#                   "@rule:", "feedback:", "directive"
#   3. Filename or content is about a project (Claude provides the actual
#      path from session context):
#      a. the project's own status → projects/<domain>/<date>_<slug>/README.md,
#         whose front matter holds status, blocked-on and monitoring-until.
#         Triggers on: "status:", "blocked-on", "monitoring-until"
#      b. outstanding work → a row in projects/<domain>/<date>_<slug>/ROADMAP.md,
#         the project's one list of it, where each row carries its own status.
#         Triggers on: "blocked", "next steps", "in progress"
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
  DEST=".agents/rules/<id>.md"
  WHY="content describes a behavioral rule or user correction — add it as a new rule file (see @rule:write-your-own-rules)"
fi

# 3a. The project's own status — checked first, since "blocked-on" also
# contains "blocked".
if [ -z "$DEST" ] && echo "$LOWER" | grep -qE '(status:|blocked-on|monitoring-until)'; then
  DEST="projects/<domain>/<date>_<slug>/README.md"
  WHY="content is the project's status — it lives in the README front matter (status, blocked-on, monitoring-until)"
fi

# 3b. Outstanding work.
if [ -z "$DEST" ] && echo "$LOWER" | grep -qE '\b(blocked|next steps|in progress)\b'; then
  DEST="projects/<domain>/<date>_<slug>/ROADMAP.md"
  WHY="content is outstanding work — it is a row in the project's ROADMAP.md, with the row's own status"
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