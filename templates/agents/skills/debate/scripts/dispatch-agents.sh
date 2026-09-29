#!/usr/bin/env bash
# dispatch-agents.sh — Step 3 of /debate. Reads a prompts dir produced by
# build-agent-prompts.sh and puts each prompt in front of one panel voice, in
# parallel, with a per-agent timeout. Emits one .output per answered seat, one
# .gap per seat nobody answered, and one .voice per seat naming who argued it.
#
# SEATS. Prompt N (in sorted order) goes to panel voice N, and the prompt count
# must equal the voice count. For /debate that is Claude, Codex and Grok — the
# `panel` row of .agents/skills/review/policy.json, read with jq. No config:
# always three seats, always the same three voices, so there is no choice to
# get wrong.
#
# STAND-INS. A seat whose voice fails is argued by another voice, so a debate
# still has three positions: Claude fails → Codex doubles; Grok fails → Claude
# doubles; Codex fails → Claude doubles. The stand-in must have
# answered its OWN seat — a voice that just failed is not asked twice — and the
# remaining voice is the second choice when the first cannot. A seat nobody
# could argue stays a .gap. `--no-stand-in` turns this off for a caller that
# needs each voice's own answer or nothing.
#
# peers: build-agent-prompts.sh, parse-agent-output.sh, .agents/skills/debate/SKILL.md
#
# Usage:
#   dispatch-agents.sh --prompts-dir <path> [--timeout-s <int>] [--no-stand-in] [--research]
#   (--research, Contextium: the grok seat may read the repo and search the web)

# bash 3.2 compatible on purpose: macOS still ships bash 3.2, where `mapfile`
# and `declare -A` do not exist, and an empty array under `set -u` is unbound.
set -euo pipefail

err() { echo "$@" >&2; }

PROMPTS_DIR=""
TIMEOUT_S=300
STAND_IN=1
RESEARCH=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompts-dir) PROMPTS_DIR="${2:-}"; shift 2 ;;
    --timeout-s)   TIMEOUT_S="${2:-}"; shift 2 ;;
    --no-stand-in) STAND_IN=0; shift ;;
    # Contextium: /explain's seats investigate rather than argue, so they may
    # read the repo and search the web; a debate seat answers from its prompt.
    --research)    RESEARCH=1; shift ;;
    -h|--help)     sed -n '2,24p' "$0" >&2; exit 0 ;;
    *)             err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$PROMPTS_DIR" ]] || { err "--prompts-dir required"; exit 2; }
[[ -d "$PROMPTS_DIR" ]] || { err "prompts dir not found: $PROMPTS_DIR"; exit 2; }

if ! [[ "$TIMEOUT_S" =~ ^[0-9]+$ ]] || [[ "$TIMEOUT_S" -lt 1 ]]; then
  err "--timeout-s must be positive integer"
  exit 2
fi

# Collect prompt files. Sorted order is seat order.
prompt_files=()
while IFS= read -r _p; do
  [[ -n "$_p" ]] && prompt_files+=("$_p")
done < <(find "$PROMPTS_DIR" -maxdepth 1 -type f -name '*.prompt' | sort)
[[ ${#prompt_files[@]} -ge 1 ]] || { err "prompts dir holds no .prompt files: $PROMPTS_DIR"; exit 2; }

# ── Voices, read from the assignment policy ───────────────────────────

# WHERE IS THE POLICY? Beside the review skill this skill ships with:
# `.agents/skills/debate/scripts/` → `.agents/skills/review/policy.json`, found
# from this script's own directory, so it answers the same way from the
# installed `.agents/skills/` and from the template repo.
#
# DEBATE_POLICY_JSON is a TEST SEAM, not a production knob: it lets the suite
# pin a fixture panel row so a per-vendor flag case (e.g. the grok --verbatim
# regression) tests the branch it names rather than whatever the shipped table
# happens to assign. Unset in every real run.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
POLICY_JSON="${DEBATE_POLICY_JSON:-${SCRIPT_DIR}/../../review/policy.json}"

if [[ ! -f "$POLICY_JSON" ]]; then
  err "policy.json not found at $POLICY_JSON"
  err "The panel row ships with the review skill (.agents/skills/review/policy.json); re-run the installer."
  exit 1
fi
command -v jq >/dev/null 2>&1 || { err "jq is required to read the panel row of $POLICY_JSON"; exit 2; }

# Each voice carries its slot's `tracks`. Empty means "the CLI's own default
# model": no model flag is passed. Non-empty is handed to the CLI verbatim as
# its model.
PANEL=()
while IFS= read -r _v; do
  [[ -n "$_v" ]] && PANEL+=("$_v")
done < <(jq -r '.rows.panel.voices[] | "\(.vendor) \(.tracks // "")"' "$POLICY_JSON")
if [[ ${#prompt_files[@]} -ne ${#PANEL[@]} ]]; then
  err "prompts dir holds ${#prompt_files[@]} prompt(s) but the panel has ${#PANEL[@]} voice(s) — one prompt per seat."
  exit 2
fi

# Resolve every voice's `tracks` to the model its CLI is told, once, before any
# agent runs. The rule is identity: `tracks` IS the model. DEBATE_RESOLVER is a
# TEST SEAM like DEBATE_POLICY_JSON, and an override for a user who keeps a
# resolver of their own (`<resolver> <vendor> <tracks>` prints the model id).
resolve_tracks() {  # resolve_tracks <vendor> <tracks>
  if [[ -n "${DEBATE_RESOLVER:-}" ]]; then
    "$DEBATE_RESOLVER" "$1" "$2"
  else
    printf '%s\n' "$2"
  fi
}
VENDOR=()   # seat → vendor
MODEL=()    # seat → resolved model, empty for the CLI's default
UNUSABLE=() # seat → why its voice cannot run at all, empty when it can
for i in "${!PANEL[@]}"; do
  v="${PANEL[$i]}"
  VENDOR[i]="${v%% *}"
  MODEL[i]=""
  UNUSABLE[i]=""
  if ! command -v "${v%% *}" >/dev/null 2>&1; then
    UNUSABLE[i]="${v%% *} CLI not found"
  elif [[ -z "${v#* }" ]]; then
    :  # no tracks: the CLI's own default model, no flag
  elif ! m="$(resolve_tracks "${v%% *}" "${v#* }" 2>/dev/null)" || [[ -z "$m" ]]; then
    UNUSABLE[i]="${v%% *} could not resolve ${v#* } — refusing to run its CLI default"
  else
    MODEL[i]="$m"
  fi
done

# Who a seat's voice is, for the .voice line: "<vendor> <model>", or
# "<vendor> (default model)" when the table names none.
voice_label() {  # voice_label <seat>
  if [[ -n "${MODEL[$1]}" ]]; then
    printf '%s %s\n' "${VENDOR[$1]}" "${MODEL[$1]}"
  else
    printf '%s (default model)\n' "${VENDOR[$1]}"
  fi
}

OUTPUT_DIR=$(mktemp -d -t debate-outputs-XXXXXX)

# Portable timeout: GNU `timeout`, else Homebrew's `gtimeout`, else a bash
# watchdog (macOS ships neither). Exits 124 on a timeout, as `timeout` does.
run_with_timeout() {  # run_with_timeout <secs> <cmd> [args...]
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${secs}s" "$@"; return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${secs}s" "$@"; return
  fi
  local pid dog rc=0
  "$@" &
  pid=$!
  # The watchdog polls once a second and leaves as soon as the command does,
  # so it never outlives it; it exits 1 only when it had to kill. TERM first,
  # then KILL after a short grace: a CLI that ignores TERM would otherwise hold
  # the debate open forever, so the `wait` below is bounded by the KILL.
  (
    n=0
    while [ "$n" -lt "$secs" ]; do
      sleep 1
      kill -0 "$pid" 2>/dev/null || exit 0
      n=$((n + 1))
    done
    kill -TERM "$pid" 2>/dev/null || exit 0
    g=0
    while [ "$g" -lt 3 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 1
      g=$((g + 1))
    done
    kill -KILL "$pid" 2>/dev/null || true
    exit 1
  ) &
  dog=$!
  wait "$pid" || rc=$?
  if ! wait "$dog"; then
    return 124
  fi
  return "$rc"
}

# Run one prompt on one voice. Writes <role>.output on success, <role>.gap on
# failure; the caller owns <role>.voice.
dispatch_one() {  # dispatch_one <prompt_file> <vendor> <model>
  local prompt_file="$1" cli="$2" model="$3"
  local role
  role=$(basename "$prompt_file" .prompt)
  local outf="$OUTPUT_DIR/${role}.output"
  local errf="$OUTPUT_DIR/${role}.err"
  local gapf="$OUTPUT_DIR/${role}.gap"
  local rc=0
  rm -f "$gapf"

  local prompt_body
  prompt_body=$(cat "$prompt_file")

  # Only the flag shape lives here — CLI trivia, not an assignment. The model
  # flag is added only when the table names a model.
  local mflag=()
  case "$cli" in
    claude)
      [[ -z "$model" ]] || mflag=(--model "$model")
      run_with_timeout "$TIMEOUT_S" claude -p ${mflag[@]+"${mflag[@]}"} --output-format text "$prompt_body" \
        >"$outf" 2>"$errf" </dev/null || rc=$?
      ;;
    codex)
      # --full-auto was REMOVED from `codex exec` (rejected outright by
      # v0.147.0 — every codex agent died at exit 2 with "unexpected
      # argument"). A debate agent only reads and answers, so
      # read-only is also the right capability: it withholds writes rather
      # than asking the model not to. --skip-git-repo-check because the CLI
      # otherwise refuses outside a repo, and --color never keeps ANSI escapes
      # out of what parse-agent-output.sh has to strip.
      [[ -z "$model" ]] || mflag=(-m "$model")
      run_with_timeout "$TIMEOUT_S" codex exec ${mflag[@]+"${mflag[@]}"} --sandbox=read-only \
        --skip-git-repo-check --color never "$prompt_body" \
        >"$outf" 2>"$errf" </dev/null || rc=$?
      ;;
    grok)
      # --verbatim: without it the CLI preprocesses the prompt and, past a size
      # threshold, truncates it and offloads the rest to a file the model is
      # told to read — turning one answer into an agent loop whose narration is
      # what comes back.
      #
      # This is a prompt-in/answer-out seat, not a repo investigation. On a
      # ~2 KB debate prompt, Grok's default agent instruction made tool calls
      # and took minutes, sometimes past the ceiling. A completion instruction
      # plus medium reasoning effort returned full answers in about 75s,
      # without tool calls. Low was faster but gave less consistent coverage of
      # the requested points; high timed out. Keep the instruction
      # task-neutral: another caller may use this same dispatcher with a
      # numbered verdict format instead of debate sections.
      #
      # The permission mode IS carried. `dontAsk` was measured cancelling a
      # quarter of prompt-in/answer-out runs at turn 1 — narration only, no
      # answer — against none under bypassPermissions. A debate voice is
      # exactly that shape, so it takes the mode plus a NON-EMPTY allowlist,
      # which are one change and not two.
      #
      # The allowlist also closes a path this call would otherwise have. Under
      # `dontAsk` with no scoping, every one of Grok's default tools is
      # auto-approved — a terminal command, a file write, a subagent — and a
      # debate prompt carries whatever the user pasted into the question. That
      # is a prompt-injection path to a shell on this machine. Web search is
      # off for the same reason: a debate voice argues from the question it
      # was given.
      #
      # --no-plan: the CLI's own switch for the planning behaviour --verbatim
      # only works around; every grok call here carries it.
      [[ -z "$model" ]] || mflag=(-m "$model")
      # A research seat (--research) reads and searches: a read-only allowlist
      # and the web left on. Still never a shell or a write.
      local -a gscope=(--tools list_dir --disable-web-search)
      local gsys="Answer the user's message directly from its supplied context. Follow its requested output format exactly. Do not use tools or narrate."
      if [[ "$RESEARCH" -eq 1 ]]; then
        gscope=(--tools "read_file,list_dir,grep")
        gsys="Investigate the user's message: read repo files and search the web as needed, then reply with the answer only, in its requested format. Do not narrate."
      fi
      run_with_timeout "$TIMEOUT_S" grok -p "$prompt_body" ${mflag[@]+"${mflag[@]}"} --output-format plain \
        --verbatim --no-plan \
        --permission-mode bypassPermissions ${gscope[@]+"${gscope[@]}"} \
        --reasoning-effort medium \
        --system-prompt-override "$gsys" \
        >"$outf" 2>"$errf" </dev/null || rc=$?
      ;;
    *)
      echo "no CLI mapping for vendor '$cli' (policy added a vendor this script does not drive)" > "$gapf"
      return
      ;;
  esac

  if [[ "$rc" -eq 124 ]]; then
    echo "timeout after ${TIMEOUT_S}s ($cli)" > "$gapf"
    rm -f "$outf"
  elif [[ "$rc" -ne 0 ]]; then
    echo "exit $rc ($cli)" > "$gapf"
    head -c 1024 "$errf" 2>/dev/null >> "$gapf" || true
    rm -f "$outf"
  fi
}

seat_role() { basename "${prompt_files[$1]}" .prompt; }

# Round 1: every seat on its own voice, in parallel.
pids=()
for i in "${!prompt_files[@]}"; do
  role=$(seat_role "$i")
  if [[ -n "${UNUSABLE[$i]}" ]]; then
    echo "${UNUSABLE[$i]}" > "$OUTPUT_DIR/${role}.gap"
    continue
  fi
  voice_label "$i" > "$OUTPUT_DIR/${role}.voice"
  dispatch_one "${prompt_files[$i]}" "${VENDOR[$i]}" "${MODEL[$i]}" &
  pids+=("$!")
done
for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" || true; done

# Round 2: stand-ins for the seats that failed. First choice first; the
# fallback is the voice left over. Keyed by vendor, so it follows the panel.
stand_in_order() {  # stand_in_order <vendor> → the voices that may argue its seat
  case "$1" in
    claude) echo "codex grok" ;;
    grok)   echo "claude codex" ;;
    codex)  echo "claude grok" ;;
  esac
}
answered_own() {  # answered_own <vendor> → prints that voice's seat if it answered its own seat
  local j
  for j in "${!VENDOR[@]}"; do
    [[ "${VENDOR[$j]}" == "$1" ]] || continue
    [[ -s "$OUTPUT_DIR/$(seat_role "$j").output" && ! -e "$OUTPUT_DIR/$(seat_role "$j").gap" ]] || return 1
    grep -q "stood in" "$OUTPUT_DIR/$(seat_role "$j").voice" 2>/dev/null && return 1
    printf '%s\n' "$j"
    return 0
  done
  return 1
}
if [[ "$STAND_IN" -eq 1 ]]; then
  pids=()
  for i in "${!prompt_files[@]}"; do
    role=$(seat_role "$i")
    [[ -e "$OUTPUT_DIR/${role}.gap" ]] || continue
    reason="$(head -n 1 "$OUTPUT_DIR/${role}.gap")"
    for sub in $(stand_in_order "${VENDOR[$i]}"); do
      j="$(answered_own "$sub")" || continue
      echo "$(voice_label "$j") — stood in for ${VENDOR[$i]} (${reason})" > "$OUTPUT_DIR/${role}.voice"
      err "  $role: ${VENDOR[$i]} failed (${reason}); ${VENDOR[$j]} stands in"
      dispatch_one "${prompt_files[$i]}" "${VENDOR[$j]}" "${MODEL[$j]}" &
      pids+=("$!")
      break
    done
  done
  for pid in ${pids[@]+"${pids[@]}"}; do wait "$pid" || true; done
fi

# Summarize per-seat failure on stderr.
ok_count=0
for i in "${!prompt_files[@]}"; do
  role=$(seat_role "$i")
  if [[ -s "$OUTPUT_DIR/${role}.gap" ]]; then
    # A failed stand-in keeps both reasons: the seat's own and the stand-in's.
    if grep -q "stood in" "$OUTPUT_DIR/${role}.voice" 2>/dev/null; then
      gap_text="$(cat "$OUTPUT_DIR/${role}.voice"); the stand-in failed too: $(cat "$OUTPUT_DIR/${role}.gap")"
      printf '%s\n' "$gap_text" > "$OUTPUT_DIR/${role}.gap"
    fi
    err "  $role: $(head -n 1 "$OUTPUT_DIR/${role}.gap")"
    rm -f "$OUTPUT_DIR/${role}.voice"
  else
    ok_count=$((ok_count + 1))
  fi
done

echo "output_dir=$OUTPUT_DIR"

# Exit non-zero only when NO seat was argued (gap-tolerant per SKILL.md).
[[ "$ok_count" -gt 0 ]]
