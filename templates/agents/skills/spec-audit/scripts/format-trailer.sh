#!/usr/bin/env bash
# format-trailer.sh — emit the one-line `spec-audit:` trailer for a commit message.
#
# The commit trailer is the only durable record that a SPEC was reviewed and by
# whom. The git-hook gate (.githooks/checks/check-audit-trailers.sh) requires the
# trailer to EXIST on a commit that touches a SPEC; it never parses the fields,
# so the content here is for the human reading `git log` later.
#
# USAGE
#   format-trailer.sh round-1 <reviewer> <spirit-verdict>
#   format-trailer.sh round-2 <reviewer> <accepted> <escalated> <spirit-verdict>
#   format-trailer.sh skipped-user "<verbatim user authorization>"
#   format-trailer.sh skipped-non-material <typo|formatting|link|wording-polish|section-reorder|clarification>
#
# <reviewer>        who ACTUALLY answered — read it off the `answered: <slot>`
#                   line spec-review.sh writes to stderr, or `claude-fallback`
#                   when no external reviewer was available. A trailer naming the
#                   wrong reviewer is worse than one naming none.
# <spirit-verdict>  MATCH | DRIFT | AMBIGUOUS
#
# OUTPUT (one line on stdout):
#   spec-audit: <reviewer> <result>; spirit <verdict>
#   spec-audit: skipped — <reason>
#
# EXIT: 0 on a valid mode; 1 on an invalid mode, reviewer, or verdict.

set -euo pipefail

MODE="${1:?mode required: round-1 | round-2 | skipped-user | skipped-non-material}"

validate_spirit() {
  case "$1" in
    MATCH|DRIFT|AMBIGUOUS) return 0 ;;
    *) echo "error: invalid spirit verdict '$1' — must be MATCH | DRIFT | AMBIGUOUS" >&2; return 1 ;;
  esac
}

validate_reviewer() {
  # ANCHORED regex, not a `case` glob. A glob like `[a-z]*)` matches anything
  # after the first character, so `co dex; rm -rf` would pass — and this value
  # lands verbatim in a commit message.
  if [[ "$1" =~ ^[a-z][a-z0-9-]*$ ]]; then
    return 0
  fi
  echo "error: invalid reviewer '$1' — expected the slot that answered, e.g. codex | custom | claude-fallback" >&2
  return 1
}

case "$MODE" in
  round-1)
    REVIEWER="${2:?reviewer required — the slot that answered, per the stderr of spec-review.sh}"
    SPIRIT="${3:?spirit verdict required: MATCH | DRIFT | AMBIGUOUS}"
    validate_reviewer "$REVIEWER"
    validate_spirit "$SPIRIT"
    echo "spec-audit: ${REVIEWER} round-1; spirit ${SPIRIT}"
    ;;
  round-2)
    REVIEWER="${2:?reviewer required}"
    ACCEPTED="${3:?accepted count required for round-2}"
    ESCALATED="${4:?escalated count required for round-2}"
    SPIRIT="${5:?spirit verdict required: MATCH | DRIFT | AMBIGUOUS}"
    validate_reviewer "$REVIEWER"
    validate_spirit "$SPIRIT"
    echo "spec-audit: ${REVIEWER} round-2 (${ACCEPTED} conceded, ${ESCALATED} escalated); spirit ${SPIRIT}"
    ;;
  skipped-user)
    QUOTE="${2:?verbatim user authorization quote required}"
    echo "spec-audit: skipped — user authorized \"${QUOTE}\""
    ;;
  skipped-non-material)
    REASON="${2:?reason required: typo|formatting|link|wording-polish|section-reorder|clarification}"
    case "$REASON" in
      typo|formatting|link|wording-polish|section-reorder|clarification)
        echo "spec-audit: skipped — non-material (${REASON})"
        ;;
      *)
        echo "error: invalid reason '${REASON}' — must be typo|formatting|link|wording-polish|section-reorder|clarification" >&2
        exit 1
        ;;
    esac
    ;;
  *)
    echo "error: invalid mode '${MODE}' — must be round-1 | round-2 | skipped-user | skipped-non-material" >&2
    exit 1
    ;;
esac

exit 0
