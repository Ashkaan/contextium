#!/usr/bin/env bash
# reviewer-chain.sh — find a reviewer that is NOT the author, and run a prompt on it.
#
# WHY THIS EXISTS
#
# One model writes nearly all the code and nearly all the SPECs in a repo driven
# by this methodology. That same model reviewing its own work is not independent
# — it shares the blind spots that produced the mistake. So the review runs on a
# DIFFERENT model by construction whenever one is available.
#
# "Whenever one is available" is the honest part. Most people install this with
# one model CLI on the machine. Rather than block the loop, this script reports
# "no external reviewer" as its own exit code (3) and the calling skill falls
# back to a fresh-context agent on the authoring model WITH A LOUD WARNING that
# independence is reduced. A review by a same-model agent that knows it is reviewing still
# catches real defects; it just catches fewer of them.
#
# CONFIGURING A REVIEWER
#
#   CONTEXTIUM_REVIEWERS      space-separated slot names, tried in order.
#                             Default: "codex custom"
#   CONTEXTIUM_REVIEWER_CMD   a shell command for the `custom` slot. It receives
#                             the prompt on STDIN and must print its answer on
#                             stdout. Example for the Gemini CLI:
#                               export CONTEXTIUM_REVIEWER_CMD='gemini --approval-mode plan -p "Follow the instructions in the input."'
#   CODEX_BIN                 override the `codex` binary path.
#   CONTEXTIUM_REVIEW_TIMEOUT_S   per-slot timeout in seconds (default 900).
#
# Slot shapes are deliberately few. Only `codex` is built in, because its
# invocation was verified against the real CLI; every other tool goes through
# `custom`, where YOU name the exact command, so this script never guesses at a
# vendor's flags on your behalf.
#
# USAGE (source, then call — never execute directly):
#
#   source "$(dirname "$0")/reviewer-chain.sh"
#   rc=0; reviewer_run_chain "$PROMPT_FILE" || rc=$?
#
# `|| rc=$?` is the required call shape: callers run under `set -e`, where a
# bare non-zero call would kill them before they can map the code.
#
#   stdout:  the answering reviewer's raw output, and nothing else.
#   stderr:  one line per slot tried, plus `answered: <slot>` on success.
#
# RETURN CODES
#   0    a slot answered
#   1    every configured slot was present but failed
#   2    caller error (missing prompt file, empty prompt)
#   3    no external reviewer is installed or configured — the caller MUST fall
#        back to a fresh-context agent and say so in its report
#   124  chain exhausted and the last failure was a timeout

# Sourcing turns on safe mode in the sourcing shell, matching every caller here.
set -euo pipefail

REVIEWER_CHAIN_DEFAULT_TIMEOUT_S=900

_reviewer_err() { echo "[reviewer-chain] $*" >&2; }

# GNU `timeout` is not installed on a stock macOS, and this project supports
# macOS. Prefer `timeout`, then Homebrew coreutils' `gtimeout`.
_reviewer_timeout_cmd() {
  if command -v timeout >/dev/null 2>&1; then echo "timeout"
  elif command -v gtimeout >/dev/null 2>&1; then echo "gtimeout"
  else echo ""
  fi
}

# With neither installed, cap it ourselves rather than running uncapped. An
# uncapped reviewer that hangs blocks the audit forever with no way out and no
# 124 to fall through on — which is worse than the failure the cap exists for,
# and it would land on exactly the stock-macOS user who has no way to know.
_reviewer_run_capped() {
  local secs="$1"; shift
  local t; t="$(_reviewer_timeout_cmd)"
  if [[ -n "$t" ]]; then
    "$t" "${secs}s" "$@"
    return $?
  fi

  # The caller applies stdin/stdout redirections to this whole function call, so
  # the backgrounded command inherits them.
  "$@" &
  local pid=$! waited=0 rc=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$waited" -ge "$secs" ]]; then
      _reviewer_err "reviewer exceeded ${secs}s — terminating."
      kill -TERM "$pid" 2>/dev/null || true
      # A grace period, then insist. Matches what `timeout` does by default:
      # neither kills grandchildren, so a CLI that forks may leave one behind.
      local grace=0
      while kill -0 "$pid" 2>/dev/null && [[ "$grace" -lt 5 ]]; do
        sleep 1; grace=$((grace + 1))
      done
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" || rc=$?
  return "$rc"
}

# Run one slot. Returns 0 on a non-empty answer, 1 on failure, 124 on timeout,
# 3 when the slot's tool is not installed/configured at all.
_reviewer_run_slot() {
  local slot="$1" prompt_file="$2" out="$3" secs="$4"
  local rc=0

  case "$slot" in
    codex)
      local bin="${CODEX_BIN:-codex}"
      command -v "$bin" >/dev/null 2>&1 || return 3
      # Prompt arrives on stdin as a FILE, never on argv: a full diff or SPEC on
      # argv dies with "Argument list too long" on exactly the large changes that
      # most need reviewing, and an unfed stdin makes the CLI hang until killed.
      _reviewer_run_capped "$secs" "$bin" exec --sandbox=read-only - \
        <"$prompt_file" >"$out" 2>/dev/null || rc=$?
      ;;
    custom)
      [[ -n "${CONTEXTIUM_REVIEWER_CMD:-}" ]] || return 3
      _reviewer_run_capped "$secs" bash -c "$CONTEXTIUM_REVIEWER_CMD" \
        <"$prompt_file" >"$out" 2>/dev/null || rc=$?
      ;;
    *)
      _reviewer_err "unknown slot '${slot}' — use 'codex' or 'custom'"
      return 1
      ;;
  esac

  [[ "$rc" -eq 124 ]] && return 124
  [[ "$rc" -ne 0 ]] && return 1
  # An empty answer is a failure, not a clean review. Silence is what a crashed
  # CLI produces, and treating it as "nothing found" hands the caller a passing
  # gate over work nobody read.
  [[ -s "$out" ]] || return 1
  return 0
}

reviewer_run_chain() {
  local prompt_file="${1:-}"
  local secs="${CONTEXTIUM_REVIEW_TIMEOUT_S:-$REVIEWER_CHAIN_DEFAULT_TIMEOUT_S}"

  [[ -n "$prompt_file" && -f "$prompt_file" ]] || {
    _reviewer_err "prompt file missing: ${prompt_file:-(none)}"
    return 2
  }
  [[ -s "$prompt_file" ]] || { _reviewer_err "prompt file is empty"; return 2; }

  local slots="${CONTEXTIUM_REVIEWERS:-codex custom}"
  local out present=0 last_timeout=0 rc=0
  out="$(mktemp -t reviewer-out-XXXXXX)"
  # shellcheck disable=SC2064 # expand $out now, not at trap time
  trap "rm -f '$out'" RETURN

  local slot
  for slot in $slots; do
    rc=0
    _reviewer_run_slot "$slot" "$prompt_file" "$out" "$secs" || rc=$?
    case "$rc" in
      0)
        _reviewer_err "answered: ${slot}"
        cat "$out"
        return 0
        ;;
      3)
        _reviewer_err "${slot}: not installed or not configured — skipping"
        ;;
      124)
        present=1; last_timeout=1
        _reviewer_err "${slot}: timed out after ${secs}s — falling through"
        ;;
      *)
        present=1; last_timeout=0
        _reviewer_err "${slot}: failed or returned nothing — falling through"
        ;;
    esac
  done

  if [[ "$present" -eq 0 ]]; then
    _reviewer_err "no external reviewer installed or configured (tried: ${slots})."
    _reviewer_err "The caller must fall back to a fresh-context agent and report the"
    _reviewer_err "reduced independence. To get a genuinely independent reviewer, install"
    _reviewer_err "the Codex CLI, or set CONTEXTIUM_REVIEWER_CMD to any CLI that reads a"
    _reviewer_err "prompt on stdin."
    return 3
  fi

  [[ "$last_timeout" -eq 1 ]] && return 124
  return 1
}
