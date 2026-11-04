#!/usr/bin/env bash
# check-close-reached.sh — the end-of-turn (Stop) hook: did the close reach
# the user, and has a thread that closed closed again?
#
# The check itself is .agents/skills/close/scripts/end-of-turn.ts; this wrapper only runs it,
# from the checkout this file is in, with the harness's payload on stdin and
# the arguments the manifest passes (`--harness <id>`). It stays bash because
# every manifest names a hook as a shell command, beside the two guards here.
#
# A broken check must never trap a reply: a missing
# script, a crash or a run past the bound allows the reply, says so on stderr
# where the harness logs it, and appends a line to
# ~/.cache/workbench/end-of-turn.log. Exit 0 (allow) and exit 2 (refuse, the
# reason on stderr) pass through unchanged; Antigravity's refusal is JSON on
# stdout with exit 0, which passes through too.
#
# The bound is lib/paths.sh's run_bounded: a coreutils `timeout` where there is
# one, else its own watcher — stock macOS has neither `timeout` nor `gtimeout`,
# and calling `timeout` directly turned its command-not-found into an allowed
# reply with the check never run. A missing lib is the missing-script case.
#
# Env: END_OF_TURN_TIMEOUT — seconds before the check is stopped (10). The
#      suite shortens it; nothing in a real session sets it.
#
# peers: .agents/hooks/check-close-reached.test.ts, .agents/skills/close/scripts/end-of-turn.ts,
#        .agents/hooks/lib/paths.sh (run_bounded)
set -euo pipefail

HOOK_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${HOOK_DIR}/../skills/close/scripts/end-of-turn.ts"
LOG="${HOME}/.cache/workbench/end-of-turn.log"

note() {
  # Every line here is best effort: a stderr or log that cannot be written
  # must not turn the allow into a failure under set -e.
  echo "end-of-turn check: $1; reply allowed" >&2 || true
  { mkdir -p "$(dirname "${LOG}")" &&
    printf '%s\tcheck-close-reached.sh: %s; allowed\n' "$(date -u +%FT%TZ)" "$1" >>"${LOG}"; } 2>/dev/null || true
  exit 0
}

[[ -f "${CHECK}" ]] || note "missing: ${CHECK}"
PATHS_LIB="${HOOK_DIR}/lib/paths.sh"
[[ -f "${PATHS_LIB}" ]] || note "missing: ${PATHS_LIB}"
# shellcheck source=SCRIPTDIR/lib/paths.sh
# shellcheck disable=SC1091
. "${PATHS_LIB}"

# Inside a conditional, so strict mode keeps the check's own exit: 2 is a
# refusal, not a wrapper failure.
rc=0
run_bounded "${END_OF_TURN_TIMEOUT:-10}" node --experimental-strip-types "${CHECK}" "$@" || rc=$?
case "${rc}" in
  0 | 2) exit "${rc}" ;;
  124) note "stopped after ${END_OF_TURN_TIMEOUT:-10}s" ;;
  *) note "exited ${rc}" ;;
esac
