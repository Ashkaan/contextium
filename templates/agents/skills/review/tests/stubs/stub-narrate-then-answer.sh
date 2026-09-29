#!/usr/bin/env bash
# stub-narrate-then-answer.sh — CODEX_BIN/GROK_BIN stub: narrates on the first
# call, reviews properly on the second.
#
# Reproduces what a real vendor did, more than once in a row:
# exit 0 with only its own progress narration ("I'll review the full diff...")
# and no triage line. From the chain's side that slot SUCCEEDED, so the walk
# stops and the backup never runs — the review is spent without a review.
# code-review.sh re-asks the same slot once, which is what this stub's second
# call answers.
#
# Statefulness is the point and cannot be faked with a fixed-output stub: the
# two calls must differ. STUB_NARRATE_STATE names the marker file so the caller
# owns the lifetime and two cases in one suite cannot bleed into each other.
set -euo pipefail

STATE="${STUB_NARRATE_STATE:-${TMPDIR:-/tmp}/stub-narrate-state}"

if [[ -f "$STATE" ]]; then
  echo "[must-fix] engine.ts:1: a real finding on the re-ask"
  exit 0
fi

: > "$STATE"
echo "I'll review the full diff and the changed files against the repo conventions.Reading the full changed implementations and their callers."
exit 0
