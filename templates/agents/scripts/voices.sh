#!/usr/bin/env bash
# voices.sh — which models are available to argue, investigate, or review.
#
# Two skills want a PANEL of models rather than one: /debate (agents holding
# opposing positions) and /explain (agents chasing competing hypotheses). Both
# are worth more when the voices come from different vendors, because two
# instances of one model tend to agree with each other for reasons that have
# nothing to do with the question.
#
# But requiring a second vendor would break the skill for the many people who
# have one model CLI installed. So this reports what is actually available, and
# the callers degrade: the work still runs, on fewer distinct voices, and the
# user is told once that the panel is single-vendor.
#
# CONFIGURING
#   CONTEXTIUM_VOICES   space-separated CLI names to consider, in preference
#                       order. Default: "claude codex gemini grok".
#                       Only the ones actually on PATH are used.
#
# Adding a vendor here is not enough on its own — the calling script needs a
# flag shape for it (how that CLI takes a prompt headlessly). The two callers
# each carry that table; an unknown name is skipped with a warning rather than
# guessed at.
#
# USAGE (source, then call)
#   source "$(dirname "$0")/voices.sh"
#   VOICES=(); while IFS= read -r v; do VOICES+=("$v"); done < <(voices_available)
#   voices_warn_if_thin "${#VOICES[@]}" 3 "debate"
#
# The read loop rather than `mapfile`: macOS ships bash 3.2, which has neither
# `mapfile` nor `readarray`.
#
# voices_available   prints one CLI name per line, installed ones only.
#                    Always prints at least `claude` if it is on PATH.
# voices_warn_if_thin <have> <want> <label>
#                    prints a one-time note to stderr when the panel is thinner
#                    than the caller wanted. Never fails.

VOICES_DEFAULT="claude codex gemini grok"

voices_available() {
  local candidates="${CONTEXTIUM_VOICES:-$VOICES_DEFAULT}"
  local v found=0
  for v in $candidates; do
    if command -v "$v" >/dev/null 2>&1; then
      echo "$v"
      found=1
    fi
  done
  [[ "$found" -eq 1 ]]
}

voices_warn_if_thin() {
  local have="${1:-0}" want="${2:-1}" label="${3:-this}"
  [[ "$have" -ge "$want" ]] && return 0
  {
    echo "[voices] ${label}: ${have} model CLI(s) available, ${want} would be better."
    echo "         Running anyway with what is here — the same model filling several"
    echo "         seats agrees with itself more than two different ones would, so treat"
    echo "         the result as weaker rather than wrong."
    echo "         To widen the panel, install another CLI (codex, gemini, grok) or set"
    echo "         CONTEXTIUM_VOICES to the ones you have."
  } >&2
  return 0
}
