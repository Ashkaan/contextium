#!/usr/bin/env bash
# detect-stage.sh
#
# Detect the stage of an existing project from filesystem + frontmatter.
# Deterministic — no AI judgment. Routes /project to the right next action.
#
# Stages:
#   needs-planning     → status:active + no *.spec.md
#   ready-to-implement → status:active + *.spec.md exists + no matching *-report.md
#   ready-to-close     → status:active + *-report.md exists + no journal/<today>.md mention
#   monitor            → status:monitor
#   blocked            → status:blocked
#   completed          → status:completed
#
# Multiple SPECs: pick the most-recent that has no sibling *-report.md as the
# active SPEC. If all are reported, stage is needs-planning again (for the next
# chunk of work).
#
# Usage:
#   detect-stage.sh <project-path>
#
# Output (multi-line to stdout):
#   stage: <stage-name>
#   status: <frontmatter status>
#   specs: <count>
#   reports: <count>
#   active-spec: <path or empty>
#
# Exit code: 0 always.

set -euo pipefail

PROJECT_PATH="${1:?project path required}"
README="${PROJECT_PATH}/README.md"

if [ ! -f "$README" ]; then
  echo "stage: unknown"
  echo "status: missing-readme"
  echo "specs: 0"
  echo "reports: 0"
  echo "active-spec:"
  exit 0
fi

STATUS=$(awk '/^status:/{print $2; exit}' "$README")
[ -z "$STATUS" ] && STATUS="unknown"

SPEC_FILES=$(find "$PROJECT_PATH" -maxdepth 1 -name "*.spec.md" -type f 2>/dev/null | sort)
REPORT_FILES=$(find "$PROJECT_PATH" -maxdepth 1 -name "*-report.md" -type f 2>/dev/null | sort)

SPEC_COUNT=$(echo -n "$SPEC_FILES" | grep -c '^' 2>/dev/null || true)
REPORT_COUNT=$(echo -n "$REPORT_FILES" | grep -c '^' 2>/dev/null || true)
[ -z "$SPEC_COUNT" ] && SPEC_COUNT=0
[ -z "$REPORT_COUNT" ] && REPORT_COUNT=0

# Find the active SPEC (most-recent .spec.md with no matching -report.md)
ACTIVE_SPEC=""
if [ "$SPEC_COUNT" -gt 0 ]; then
  while IFS= read -r spec_path; do
    [ -z "$spec_path" ] && continue
    spec_stem=$(basename "$spec_path" | sed -E 's/\.spec\.md$//')
    report_path="${PROJECT_PATH}/${spec_stem}-report.md"
    if [ ! -f "$report_path" ]; then
      ACTIVE_SPEC="$spec_path"
    fi
  done <<< "$SPEC_FILES"
fi

# Stage from status first (monitor / blocked / completed override filesystem state)
case "$STATUS" in
  monitor)
    STAGE="monitor"
    ;;
  blocked)
    STAGE="blocked"
    ;;
  completed)
    STAGE="completed"
    ;;
  active)
    if [ -z "$ACTIVE_SPEC" ]; then
      # Either no SPECs at all, or all SPECs have reports
      STAGE="needs-planning"
    else
      # An active SPEC with no sibling report still needs implementing.
      STAGE="ready-to-implement"
    fi
    ;;
  *)
    STAGE="unknown"
    ;;
esac

echo "stage: $STAGE"
echo "status: $STATUS"
echo "specs: $SPEC_COUNT"
echo "reports: $REPORT_COUNT"
echo "active-spec: $ACTIVE_SPEC"
exit 0
