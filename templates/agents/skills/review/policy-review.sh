#!/usr/bin/env bash
# Contract: run an adversarial review on an artifact using the vendor the
# policy table (policy.json beside this script) assigns to the task-kind. No
# caller names a model.
#
# Usage: policy-review.sh <task-kind> <artifact-path> <brief-file>
#
# This script owns ONLY prompt construction. The chain walk it used to inline
# was extracted to .agents/skills/review/policy-chain.sh so the review scripts
# could share it instead of each hardcoding one vendor — which is why a Codex
# quota lockout once took them all down with nothing to fall back to.
#
# Output (stdout): the answering vendor's findings, and nothing else.
# Output (stderr): every diagnostic, including the `### reviewer:` line. That
#   line USED to go to stdout; it moved here in the extraction, because stdout
#   has to carry vendor output only for a caller that parses it.
#
# Exit: 0 = a vendor answered; 1 = chain exhausted; 2 = caller error;
#       3 = chain reached the claude slot (caller should dispatch its Claude
#       agent instead); 124 = exhausted, last failure was a timeout.
set -euo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TASK_KIND="${1:-}"
ARTIFACT="${2:-}"
BRIEF_FILE="${3:-}"

if [[ -z "$TASK_KIND" || -z "$ARTIFACT" || -z "$BRIEF_FILE" ]]; then
  err "Usage: $0 <task-kind> <artifact-path> <brief-file>"
  exit 2
fi

for f in "$ARTIFACT" "$BRIEF_FILE"; do
  if [[ ! -f "$f" ]]; then
    err "policy-review: file not found: $f"
    exit 2
  fi
done

ARTIFACT_CONTENTS="$(cat "$ARTIFACT")"
BRIEF_CONTENTS="$(cat "$BRIEF_FILE")"

PROMPT_FILE=$(mktemp "${TMPDIR:-/tmp}/policy-review-prompt.XXXXXX")
# shellcheck disable=SC2329 # invoked indirectly by the trap on EXIT below
cleanup() { rm -f "$PROMPT_FILE"; }
trap cleanup EXIT

cat >"$PROMPT_FILE" <<EOF
$BRIEF_CONTENTS

ARTIFACT UNDER REVIEW: $ARTIFACT

--- BEGIN ARTIFACT ---
$ARTIFACT_CONTENTS
--- END ARTIFACT ---
EOF

# shellcheck source=/dev/null
source "$SCRIPT_DIR/policy-chain.sh"

RC=0
policy_run_chain "$TASK_KIND" "$PROMPT_FILE" || RC=$?

if [[ "$RC" -eq 0 ]]; then
  err "### reviewer: ${POLICY_CHAIN_VENDOR}/${POLICY_CHAIN_MODEL} (per policy row '$TASK_KIND')"
fi

exit "$RC"
