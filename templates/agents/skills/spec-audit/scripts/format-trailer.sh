#!/usr/bin/env bash
# format-trailer.sh
#
# Emit the consolidated `spec-audit:` line, which /spec-audit writes into the
# spec's plan.md Constitution Check (a record, never a gate on a commit).
# One line carries three facts — who reviewed, the spirit-check verdict, and
# where the user's verbatim ask lives — because all three come from the same
# spec-edit event, and three separate lines would triple the reading without
# adding evidence.
#
# Usage:
#   format-trailer.sh round-1 <vendor> <spirit-verdict>
#   format-trailer.sh round-2 <vendor> <accepted-by-reviewer> <escalated-to-user> <spirit-verdict>
#   format-trailer.sh skipped-user "<verbatim user authorization>"
#   format-trailer.sh skipped-non-material <typo|formatting|link|wording-polish|section-reorder|clarification>
#
# <vendor>: whichever vendor ACTUALLY answered — read it from the
#   `answered: <vendor>/<model>` line spec-audit.sh writes to stderr. It is not
#   a fixed name: the review chain may fall through to its backup, and a line
#   that names the wrong reviewer is worse than one that names none, because
#   plan.md's line is the only durable record of who reviewed the SPEC.
#   Nothing parses this field; the value is for the human reading plan.md.
# <spirit-verdict>: MATCH | DRIFT | AMBIGUOUS
#
# Output (one line to stdout):
#   spec-audit: <vendor> <result>; spirit <verdict>; user-ask-verbatim in spec.md Input
#   spec-audit: skipped — <reason>
#
# Exit code: 0 on valid mode; 1 on invalid mode or vendor.
#
# peers:
#   .agents/skills/spec-audit/scripts/format-trailer.test.sh
#   .agents/skills/spec-audit/scripts/write-audit-line.sh  (writes the line into plan.md)

set -euo pipefail

MODE="${1:?mode required: round-1 | round-2 | skipped-user | skipped-non-material}"

validate_spirit() {
  local verdict="$1"
  case "$verdict" in
    MATCH|DRIFT|AMBIGUOUS) return 0 ;;
    *) echo "error: invalid spirit verdict '${verdict}' — must be MATCH | DRIFT | AMBIGUOUS" >&2; return 1 ;;
  esac
}

validate_vendor() {
  # Any lowercase vendor token the policy could name. Deliberately not a fixed
  # list: pinning one here would reintroduce exactly the coupling this argument
  # removes — a policy edit adding a vendor must not need an edit here too.
  local vendor="$1"
  # ANCHORED regex, not a `case` glob. `[a-z][a-z0-9-]*)` looks like a pattern
  # but `*` matches anything after the first two characters, so `co dex; rm -rf`
  # passed — and this value lands verbatim in the plan.md line that is the only
  # durable record of who reviewed the SPEC.
  if [[ "$vendor" =~ ^[a-z][a-z0-9-]*$ ]]; then
    return 0
  fi
  echo "error: invalid vendor '${vendor}' — expected the answering vendor, e.g. codex | grok" >&2
  return 1
}

# Contextium: the fresh-context fallback (the review chain's exit 3) is named
# `claude-fallback` and ALWAYS carries its caveat in the line, so a weaker
# review can never be read as an independent one.
label_vendor() {
  if [[ "$1" == "claude-fallback" ]]; then
    printf 'claude-fallback (fresh context, NOT independent)'
  else
    printf '%s' "$1"
  fi
}

case "$MODE" in
  round-1)
    VENDOR="${2:?vendor required — the vendor that answered, per the answered: line spec-audit.sh writes to stderr}"
    SPIRIT="${3:?spirit verdict required: MATCH | DRIFT | AMBIGUOUS}"
    validate_vendor "$VENDOR"
    validate_spirit "$SPIRIT"
    echo "spec-audit: $(label_vendor "$VENDOR") round-1; spirit ${SPIRIT}; user-ask-verbatim in spec.md Input"
    ;;
  round-2)
    VENDOR="${2:?vendor required — the vendor that answered, per the answered: line spec-audit.sh writes to stderr}"
    ACCEPTED="${3:?accepted-by-reviewer count required for round-2}"
    ESCALATED="${4:?escalated-to-user count required for round-2}"
    SPIRIT="${5:?spirit verdict required: MATCH | DRIFT | AMBIGUOUS}"
    validate_vendor "$VENDOR"
    validate_spirit "$SPIRIT"
    echo "spec-audit: $(label_vendor "$VENDOR") round-2 (${ACCEPTED} accepted by ${VENDOR}, ${ESCALATED} escalated); spirit ${SPIRIT}; user-ask-verbatim in spec.md Input"
    ;;
  skipped-user)
    QUOTE="${2:?verbatim user authorization quote required}"
    echo "spec-audit: skipped — user authorized \"${QUOTE}\""
    ;;
  skipped-non-material)
    REASON="${2:?non-material reason required: typo|formatting|link|wording-polish|section-reorder|clarification}"
    case "$REASON" in
      typo|formatting|link|wording-polish|section-reorder|clarification)
        echo "spec-audit: skipped — non-material (${REASON})"
        ;;
      *)
        echo "error: invalid non-material reason '${REASON}' — must be typo|formatting|link|wording-polish|section-reorder|clarification" >&2
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
