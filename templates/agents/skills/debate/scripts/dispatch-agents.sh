#!/usr/bin/env bash
# dispatch-agents.sh — run every debate role in parallel, one model CLI each.
#
# Sanitized from the source repo's version, which read its voice lineup from a
# private model-assignment table. Here the lineup is whatever model CLIs you
# have installed (see voices.sh), and a thin lineup degrades rather than fails:
# with one model CLI present, it plays every role and the skill says so.
# That is a weaker debate — one model arguing with itself agrees more readily
# than two different ones — but it is a debate, and it runs on a stock install.
#
# peers: build-agent-prompts.sh, parse-agent-output.sh, ../SKILL.md
#
# USAGE
#   dispatch-agents.sh --prompts-dir <path> [--timeout-s <int>]
#
# OUTPUT (stdout): output_dir=<path>, holding <role>.output for each role that
#   answered and <role>.gap for each that did not. The gap files are the point:
#   a synthesis built on 2 of 3 voices has to say so.
#
# EXIT: 0 if at least one role answered; 1 if every one failed; 2 on bad input.

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist. A check that dies with
# "mapfile: command not found" takes every commit on that machine down with it.
set -uo pipefail

err() { echo "$@" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAYER_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PROMPTS_DIR=""
TIMEOUT_S=120

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompts-dir) PROMPTS_DIR="${2:-}"; shift 2 ;;
    --timeout-s)   TIMEOUT_S="${2:-}"; shift 2 ;;
    # Both accepted and ignored: seat COUNT is decided by how many .prompt files
    # the build step wrote, and who fills them by what is installed. Callers pass
    # these through from the same variables they gave the build script.
    --agents|--config) shift 2 ;;
    -h|--help)     sed -n '2,22p' "$0" >&2; exit 0 ;;
    *)             err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$PROMPTS_DIR" && -d "$PROMPTS_DIR" ]] || { err "--prompts-dir <path> required"; exit 2; }
[[ "$TIMEOUT_S" =~ ^[0-9]+$ ]] || { err "--timeout-s must be an integer"; exit 2; }

prompt_files=()
while IFS= read -r _p; do
  [ -n "$_p" ] && prompt_files+=("$_p")
done < <(find "$PROMPTS_DIR" -maxdepth 1 -name '*.prompt' | sort)
[[ ${#prompt_files[@]} -gt 0 ]] || { err "no .prompt files in $PROMPTS_DIR"; exit 2; }

# shellcheck source=/dev/null
source "$LAYER_DIR/scripts/voices.sh"
# shellcheck source=/dev/null
source "$LAYER_DIR/scripts/reviewer-chain.sh"   # for _reviewer_run_capped
set +e   # reviewer-chain.sh turns on `set -e`; this script handles its own errors

VOICES=()
while IFS= read -r _v; do
  [ -n "$_v" ] && VOICES+=("$_v")
done < <(voices_available)
if [[ ${#VOICES[@]} -eq 0 ]]; then
  err "no model CLI found on PATH (looked for: ${CONTEXTIUM_VOICES:-claude codex gemini grok})."
  err "Install at least one, or run the debate roles by hand."
  exit 1
fi
voices_warn_if_thin "${#VOICES[@]}" "${#prompt_files[@]}" "debate"

OUTPUT_DIR="$(mktemp -d -t debate-outputs-XXXXXX)"

# Only the flag shape lives here — how each CLI takes a prompt headlessly and
# answers without asking for permission. A name with no entry is skipped loudly
# rather than guessed at, because guessing a CLI's flags produces a confident
# error message the user has to decode.
run_voice() {
  local cli="$1" prompt_body="$2" outf="$3" errf="$4"
  case "$cli" in
    claude)
      _reviewer_run_capped "$TIMEOUT_S" claude -p --output-format text "$prompt_body" \
        >"$outf" 2>"$errf" </dev/null
      ;;
    codex)
      # A debate agent only reads and answers, so read-only is the right
      # capability: it withholds writes rather than asking the model not to.
      # --skip-git-repo-check because the CLI otherwise refuses outside a repo,
      # and --color never keeps ANSI escapes out of what the parser has to strip.
      _reviewer_run_capped "$TIMEOUT_S" codex exec --sandbox=read-only \
        --skip-git-repo-check --color never "$prompt_body" \
        >"$outf" 2>"$errf" </dev/null
      ;;
    gemini)
      _reviewer_run_capped "$TIMEOUT_S" gemini --approval-mode plan -p "$prompt_body" \
        >"$outf" 2>"$errf" </dev/null
      ;;
    grok)
      # --verbatim: without it the CLI preprocesses the prompt and, past a size
      # threshold, truncates it and hands the rest to the model as a file to go
      # read — which turns one answer into an agent loop whose narration is what
      # comes back instead of the argument.
      _reviewer_run_capped "$TIMEOUT_S" grok -p "$prompt_body" --output-format plain \
        --verbatim --permission-mode dontAsk \
        >"$outf" 2>"$errf" </dev/null
      ;;
    *)
      return 3
      ;;
  esac
}

dispatch_one() {
  local prompt_file="$1" role_idx="$2"
  local role outf errf gapf cli rc=0
  role="$(basename "$prompt_file" .prompt)"
  outf="$OUTPUT_DIR/${role}.output"
  errf="$OUTPUT_DIR/${role}.err"
  gapf="$OUTPUT_DIR/${role}.gap"

  # Roles cycle over the available voices. With three roles and one CLI, all
  # three are that CLI — the seat is still filled, and the caller was warned.
  cli="${VOICES[$((role_idx % ${#VOICES[@]}))]}"

  run_voice "$cli" "$(cat "$prompt_file")" "$outf" "$errf" || rc=$?

  if [[ "$rc" -eq 3 ]]; then
    echo "no invocation known for CLI '$cli' — skipped" > "$gapf"
    rm -f "$outf"
  elif [[ "$rc" -eq 124 ]]; then
    echo "timeout after ${TIMEOUT_S}s ($cli)" > "$gapf"
    rm -f "$outf"
  elif [[ "$rc" -ne 0 ]]; then
    echo "exit $rc ($cli)" > "$gapf"
    head -c 1024 "$errf" 2>/dev/null >> "$gapf" || true
    rm -f "$outf"
  elif [[ ! -s "$outf" ]]; then
    # An empty answer is a failed seat, not a silent agreement.
    echo "empty answer ($cli)" > "$gapf"
    rm -f "$outf"
  fi
}

idx=0
pids=()
for pf in "${prompt_files[@]}"; do
  dispatch_one "$pf" "$idx" &
  pids+=("$!")
  idx=$((idx + 1))
done
for pid in "${pids[@]}"; do wait "$pid" || true; done

ok_count=0
for pf in "${prompt_files[@]}"; do
  role="$(basename "$pf" .prompt)"
  if [[ -s "$OUTPUT_DIR/${role}.gap" ]]; then
    err "  $role: $(cat "$OUTPUT_DIR/${role}.gap")"
  else
    ok_count=$((ok_count + 1))
  fi
done

echo "output_dir=$OUTPUT_DIR"

# Non-zero only when EVERY role failed. A partial panel is a real result the
# synthesis can use, as long as it names what is missing.
[[ "$ok_count" -gt 0 ]]
