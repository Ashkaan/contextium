#!/usr/bin/env bash
# parallel-research.sh — Step 3 Deep of /explain. Invokes the research CLIs in
# parallel against three hypothesis prompts; captures each result with per-CLI
# isolation (one failure doesn't tank the others) + a configurable timeout.
#
# Owns the parallel-orchestration logic previously inlined as 3 sequential
# bash lines in .claude/skills/explain/SKILL.md (lines 87-91 of the pre-rebuild
# body).
#
# WHICH MODELS ANSWER is whatever model CLIs you have installed (see
# ../../../hooks/checks/voices.sh). Three different models chasing three
# hypotheses is the point — one model asked three times tends to agree with
# itself — but a thin lineup degrades instead of failing: with only Claude
# installed, Claude takes all three hypotheses and the run says so.
#
# peers: parallel-research.test.sh, ../SKILL.md, ../../../hooks/checks/voices.sh
#
# Usage:
#   parallel-research.sh --h1 "<prompt>" --h2 "<prompt>" --h3 "<prompt>"
#                        [--timeout <sec>] [--skip-missing]
#
# Output (stdout): block-separated per-voice result, then SUMMARY line.
# exit: 0 if at least 1 voice returned a result; non-zero on all-fail / bad input.

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`,
# `readarray` and `declare -A` do not exist. A check that dies with
# "mapfile: command not found" takes every commit on that machine down with it.
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
    -h|--help)       sed -n '2,24p' "$0" >&2; exit 0 ;;
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

# ── Voices: whatever is installed ─────────────────────────────────────

LAYER_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
# shellcheck source=/dev/null
source "$LAYER_DIR/hooks/checks/voices.sh"
# shellcheck source=/dev/null
source "$LAYER_DIR/hooks/checks/reviewer-chain.sh"   # for _reviewer_run_capped

INSTALLED=()
while IFS= read -r _v; do
  [ -n "$_v" ] && INSTALLED+=("$_v")
done < <(voices_available)
if [[ ${#INSTALLED[@]} -eq 0 ]]; then
  err "no model CLI found on PATH (looked for: ${CONTEXTIUM_VOICES:-claude codex gemini grok})."
  err "Install at least one, or investigate the hypotheses yourself."
  exit 1
fi
voices_warn_if_thin "${#INSTALLED[@]}" 3 "explain"

# Three seats, filled by cycling whatever is installed. Fewer than three distinct
# CLIs means a repeat, which is weaker than three different models and is not a
# failure — the warning above already said so.
VOICES=(
  "${INSTALLED[$((0 % ${#INSTALLED[@]}))]}"
  "${INSTALLED[$((1 % ${#INSTALLED[@]}))]}"
  "${INSTALLED[$((2 % ${#INSTALLED[@]}))]}"
)

# ── Setup ─────────────────────────────────────────────────────────────

TMPDIR_BASE="${TMPDIR:-/tmp}"
PID=$$
out1="$TMPDIR_BASE/explain-research-${PID}-1.out"
out2="$TMPDIR_BASE/explain-research-${PID}-2.out"
out3="$TMPDIR_BASE/explain-research-${PID}-3.out"
err1="$TMPDIR_BASE/explain-research-${PID}-1.err"
err2="$TMPDIR_BASE/explain-research-${PID}-2.err"
err3="$TMPDIR_BASE/explain-research-${PID}-3.err"
: > "$out1" "$out2" "$out3" "$err1" "$err2" "$err3"
rm -f "${out1}.meta" "${out2}.meta" "${out3}.meta"

# Pre-flight CLI availability BEFORE forking — exit from a background
# subshell can't kill the parent, so missing-CLI fail-loud has to happen up here.
# voices_available only reports CLIs on PATH, so every seat is fillable by
# construction. The map is kept because the emit path reads it, and because a
# CLI can still vanish between this check and the call.
# A function rather than an associative array: `declare -A` is bash 4+, and
# macOS ships 3.2.
is_available() { command -v "$1" >/dev/null 2>&1; }

# Per-vendor headless invocation. The vendor comes from the policy; only the
# flag shape lives here, since that is CLI trivia rather than an assignment.
# Sources: integrations/{claude-code,codex,grok}/README.md.
voice_argv() {
  local vendor="$1" prompt="$2"
  case "$vendor" in
    claude) printf '%s\0' claude -p --output-format text "$prompt" ;;
    # --full-auto no longer exists on `codex exec` (v0.147.0 rejects it at
    # exit 2). Read-only is the correct capability for a researcher anyway.
    # Peer of the same flag in .claude/skills/debate/scripts/dispatch-agents.sh,
    # where the measurement note lives (@rule:class-fix-is-atomic).
    codex)  printf '%s\0' codex exec --sandbox=read-only \
              --skip-git-repo-check --color never "$prompt" ;;
    # grok takes --verbatim: without it the CLI truncates a long prompt and
    # offloads the rest to a file, so the answer comes back as agent narration.
    # Peer of the flag in integrations/grok/run.ts (@rule:class-fix-is-atomic).
    # ONLY that flag, deliberately — run.ts's other two anchor the model to JSON
    # and this call asks for prose a human reads. Same reasoning as the debate
    # dispatcher; see its comment for the full note.
    gemini) printf '%s\0' gemini --approval-mode plan -p "$prompt" ;;
    grok)   printf '%s\0' grok -p "$prompt" --output-format plain \
              --verbatim --permission-mode dontAsk ;;
    *)      return 1 ;;
  esac
}

run_with_timeout() {
  local outf="$1" errf="$2"; shift 2
  local start end elapsed rc=0
  start=$(date +%s)
  # _reviewer_run_capped returns 124 on timeout, with a portable fallback for
  # machines that have neither `timeout` nor `gtimeout` — stock macOS is the
  # common one, and there every seat would otherwise die command-not-found.
  _reviewer_run_capped "$TIMEOUT" "$@" >"$outf" 2>"$errf" </dev/null || rc=$?
  end=$(date +%s)
  elapsed=$((end - start))
  printf '%s\n' "$rc:$elapsed" > "${outf}.meta"
}

# PIDs are recorded into a global rather than echoed out of a command
# substitution: `$(...)` would fork a subshell, the background job would be the
# SUBSHELL's child, and the parent's `wait` would then fail with "not a child
# of this shell" — every voice silently unwaited.
PIDS=("" "" "")

dispatch_voice() {
  local idx="$1" prompt="$2" outf="$3" errf="$4"
  local vendor="${VOICES[$idx]}"
  is_available "$vendor" || return 0
  local argv=()
  while IFS= read -r -d '' _a; do
    argv+=("$_a")
  done < <(voice_argv "$vendor" "$prompt")
  run_with_timeout "$outf" "$errf" "${argv[@]}" &
  PIDS[idx]=$!
}

dispatch_voice 0 "$H1" "$out1" "$err1"
dispatch_voice 1 "$H2" "$out2" "$err2"
dispatch_voice 2 "$H3" "$out3" "$err3"

for pid in "${PIDS[@]}"; do
  [[ -n "$pid" ]] || continue
  wait "$pid" || true
done

ok_count=0
fail_count=0
timeout_count=0

emit_block() {
  local label="$1" cli="$2" outf="$3" errf="$4" avail="$5"
  if [[ "$avail" -eq 0 ]]; then
    echo "=== $label ($cli) — MISSING ==="
    echo "(CLI not installed; skipped)"
    echo
    fail_count=$((fail_count + 1))
    return
  fi
  if [[ ! -s "${outf}.meta" ]]; then
    echo "=== $label ($cli) — UNKNOWN ==="
    echo "(no metadata captured)"
    echo
    fail_count=$((fail_count + 1))
    return
  fi
  local rc elapsed
  IFS=: read -r rc elapsed < "${outf}.meta"
  if [[ "$rc" -eq 124 ]]; then
    echo "=== $label ($cli) — TIMEOUT after ${TIMEOUT}s ==="
    echo "(no body)"
    echo
    timeout_count=$((timeout_count + 1))
    return
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "=== $label ($cli) — FAIL exit=$rc ==="
    head -c 1024 "$errf" 2>/dev/null || true
    echo
    fail_count=$((fail_count + 1))
    return
  fi
  echo "=== $label ($cli) — ${elapsed}s ==="
  # Cap at 10KB.
  head -c 10240 "$outf"
  local sz
  sz=$(wc -c < "$outf")
  if [[ "$sz" -gt 10240 ]]; then
    echo
    echo "(truncated at 10KB; full body at $outf)"
  fi
  echo
  ok_count=$((ok_count + 1))
}

voice_label() { echo "${VOICES[$1]}"; }

avail_flag() { if is_available "$1"; then echo 1; else echo 0; fi; }
emit_block "H1" "$(voice_label 0)" "$out1" "$err1" "$(avail_flag "${VOICES[0]}")"
emit_block "H2" "$(voice_label 1)" "$out2" "$err2" "$(avail_flag "${VOICES[1]}")"
emit_block "H3" "$(voice_label 2)" "$out3" "$err3" "$(avail_flag "${VOICES[2]}")"

printf 'SUMMARY: %d OK, %d FAIL, %d TIMEOUT\n' "$ok_count" "$fail_count" "$timeout_count"

[[ "$ok_count" -gt 0 ]]
