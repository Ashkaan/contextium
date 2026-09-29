#!/usr/bin/env bash
# parallel-research.sh — Step 3 Deep of /explain. Puts three hypothesis prompts
# in front of the research CLIs in parallel; captures each result with per-seat
# isolation (one failure doesn't tank the others) + a configurable timeout.
#
# WHICH MODELS ANSWER is the `panel` row of .agents/skills/review/policy.json,
# the same three voices /debate seats, and each seat runs through /debate's
# dispatch-agents.sh — the one place a CLI's flags live. Three different models
# chasing three hypotheses is the point — one model asked three times tends to
# agree with itself — but a thin lineup degrades instead of failing: a seat
# whose CLI is missing or fails is argued by another voice (the dispatcher's
# stand-in rule), and the run says the panel was thin.
#
# peers: ../SKILL.md, ../../debate/scripts/dispatch-agents.sh, ../../review/policy.json
#
# Usage:
#   parallel-research.sh --h1 "<prompt>" --h2 "<prompt>" --h3 "<prompt>"
#                        [--timeout <sec>] [--skip-missing]
#
# Output (stdout): block-separated per-seat result, then SUMMARY line.
# exit: 0 if at least 1 seat returned a result; non-zero on all-fail / bad input.

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist.
set -euo pipefail

err() { echo "$@" >&2; }

H1=""
H2=""
H3=""
TIMEOUT=120

while [[ $# -gt 0 ]]; do
  case "$1" in
    --h1)            H1="${2:-}"; shift 2 ;;
    --h2)            H2="${2:-}"; shift 2 ;;
    --h3)            H3="${2:-}"; shift 2 ;;
    --timeout)       TIMEOUT="${2:-}"; shift 2 ;;
    # Accepted for compatibility and now the only behavior: a CLI that is not
    # installed is skipped, never fatal.
    --skip-missing)  shift ;;
    -h|--help)       sed -n '2,21p' "$0" >&2; exit 0 ;;
    *)               err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$H1" ]] || { err "--h1 empty or missing"; exit 2; }
[[ -n "$H2" ]] || { err "--h2 empty or missing"; exit 2; }
[[ -n "$H3" ]] || { err "--h3 empty or missing"; exit 2; }

if ! [[ "$TIMEOUT" =~ ^[0-9]+$ ]] || [[ "$TIMEOUT" -lt 1 || "$TIMEOUT" -gt 600 ]]; then
  err "--timeout must be integer in [1, 600]; got: $TIMEOUT"
  exit 2
fi

# ── Voices: the panel row, filtered to what is installed ──────────────
# Which models, in what order, is the `panel` row of the review skill's
# policy.json (DEBATE_POLICY_JSON overrides it, for the dispatcher too); how
# each one is called is /debate's dispatch-agents.sh. Nothing about a CLI's
# flags is written here.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCH="$SCRIPT_DIR/../../debate/scripts/dispatch-agents.sh"
POLICY_JSON="${DEBATE_POLICY_JSON:-$SCRIPT_DIR/../../review/policy.json}"
export DEBATE_POLICY_JSON="$POLICY_JSON"

[[ -f "$POLICY_JSON" ]] || { err "policy.json not found at $POLICY_JSON"; exit 1; }
[[ -f "$DISPATCH" ]] || { err "the /debate dispatcher is not installed at $DISPATCH"; exit 1; }
command -v jq >/dev/null 2>&1 || { err "jq is required to read the panel row of $POLICY_JSON"; exit 2; }

PANEL=""
INSTALLED=0
while IFS= read -r _v; do
  [[ -n "$_v" ]] || continue
  PANEL="${PANEL:+$PANEL }$_v"
  if command -v "$_v" >/dev/null 2>&1; then INSTALLED=$((INSTALLED + 1)); fi
done < <(jq -r '.rows.panel.voices[].vendor' "$POLICY_JSON")
if [[ "$INSTALLED" -eq 0 ]]; then
  err "no model CLI found on PATH (looked for: $PANEL)."
  err "Install at least one, or investigate the hypotheses yourself."
  exit 1
fi
if [[ "$INSTALLED" -lt 3 ]]; then
  {
    echo "[voices] explain: ${INSTALLED} model CLI(s) available, 3 would be better."
    echo "         Running anyway with what is here — the same model filling several"
    echo "         seats agrees with itself more than two different ones would, so treat"
    echo "         the result as weaker rather than wrong."
    echo "         To widen the panel, install another of: $PANEL."
  } >&2
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/prompts"
# File names sort into seat order: h1 → the panel's first voice, and so on.
printf '%s\n' "$H1" >"$WORK/prompts/h1.prompt"
printf '%s\n' "$H2" >"$WORK/prompts/h2.prompt"
printf '%s\n' "$H3" >"$WORK/prompts/h3.prompt"

# The dispatcher exits non-zero when no seat answered; its per-seat files are
# still there to report, so its exit code is not ours to stop on.
# --research: these seats investigate, so the dispatcher gives them read and
# web-search tools a debate seat does not get.
dispatch_out="$(bash "$DISPATCH" --prompts-dir "$WORK/prompts" --timeout-s "$TIMEOUT" --research 2>"$WORK/dispatch.err")" || true
OUT_DIR="$(printf '%s\n' "$dispatch_out" | sed -n 's/^output_dir=//p' | tail -n 1)"
if [[ -z "$OUT_DIR" || ! -d "$OUT_DIR" ]]; then
  err "the /debate dispatcher did not run:"
  cat "$WORK/dispatch.err" >&2
  exit 1
fi
trap 'rm -rf "$WORK" "$OUT_DIR"' EXIT

ok_count=0
fail_count=0
timeout_count=0

# The seat's own vendor, in panel order.
seat_vendor() { printf '%s\n' "$PANEL" | tr ' ' '\n' | sed -n "${1}p"; }

emit_block() {
  local n="$1" own who voice sz gap
  own="$(seat_vendor "$n")"
  if [[ -s "$OUT_DIR/h$n.output" ]]; then
    voice="$(head -n 1 "$OUT_DIR/h$n.voice" 2>/dev/null || true)"
    who="${voice%% *}"
    echo "=== H$n (${who:-$own}) ==="
    case "$voice" in
      *"stood in for"*) echo "(${voice#* — })" ;;
    esac
    head -c 10240 "$OUT_DIR/h$n.output"
    sz=$(wc -c <"$OUT_DIR/h$n.output" | tr -d ' ')
    [[ "$sz" -le 10240 ]] || { echo; echo "(truncated at 10KB of ${sz} bytes)"; }
    echo
    ok_count=$((ok_count + 1))
    return
  fi
  gap="$(cat "$OUT_DIR/h$n.gap" 2>/dev/null || echo "the seat recorded no result")"
  case "$gap" in
    "timeout after"*)
      echo "=== H$n ($own) — TIMEOUT after ${TIMEOUT}s ==="
      echo
      timeout_count=$((timeout_count + 1)) ;;
    *"CLI not found"*)
      echo "=== H$n ($own) — MISSING ==="
      echo "(CLI not installed; no other voice could stand in)"
      echo
      fail_count=$((fail_count + 1)) ;;
    *)
      echo "=== H$n ($own) — FAIL ==="
      echo "(no answer: the CLI failed or printed nothing)"
      printf '%s\n' "$gap" | head -c 1024
      echo
      fail_count=$((fail_count + 1)) ;;
  esac
}

emit_block 1
emit_block 2
emit_block 3

printf 'SUMMARY: %d OK, %d FAIL, %d TIMEOUT\n' "$ok_count" "$fail_count" "$timeout_count"

[[ "$ok_count" -gt 0 ]]
