#!/usr/bin/env bash
# policy-chain.sh — walk a policy row's chain until a vendor answers.
#
# THE shell-side executor of the policy table, `policy.json` beside this file.
# Every shell caller that wants an AI answer declares a TASK-KIND and sources
# this file; none of them names a vendor. It was extracted from
# policy-review.sh's inlined walk, which was the only copy — so the two review
# scripts each hardcoded one `codex exec` and a Codex outage took them both down
# with nothing to fall back to.
#
# THE AUTHOR LEAVES A REVIEW CHAIN. The installer records the model family that
# writes the code as `agent=<name>` in `.agents/harness` (two levels above this
# skill's folder). For every row read from `.chain` — the review rows — the slot
# whose vendor is that family is skipped: a reviewer of the same model as the
# author shares the blind spots that produced the mistake. antigravity is the
# gemini family; cursor and copilot name no single family, so nothing is
# skipped. A `.voices` row (a panel) keeps every seat. The claude slot is never
# skipped: it is not a CLI call but "dispatch your own agent" (return 3), which
# every caller already labels as reduced independence. No file, or no `agent=`
# key: the row as written.
#
# Usage (source, then call):
#   source "$(dirname "$0")/policy-chain.sh"
#   rc=0; policy_run_chain adversarial-review "$PROMPT_FILE" || rc=$?
#
# `|| rc=$?` is the required call shape: callers run under `set -e`, where a
# bare non-zero call would kill them before they can map the code.
#
# Sourcing this file turns `set -euo pipefail` ON in the sourcing shell, per
# Shell safe mode (and the same way log-mechanism-fired.sh does). Every
# caller here already runs that way, so it is a no-op for them; a shell that
# deliberately does NOT (policy-chain.test.sh, which must survive its own
# failing cases) has to restore its options after the source.
#
#   stdout: the answering vendor's raw output, and NOTHING else.
#   stderr: every diagnostic — one line per slot tried, with vendor + reason.
#   return 0:   a slot answered
#   return 1:   chain exhausted (every slot absent or failed)
#   return 2:   caller error (unknown row, policy.json missing, jq absent,
#               empty prompt)
#   return 3:   chain reached a claude slot in a shell context — or, on a row
#               marked `"fallback": "fresh-context"` (Contextium), every vendor
#               in it was unavailable: the caller runs a fresh-context review
#               of its own and records it as NOT independent
#   return 124: chain exhausted and the LAST failure was a timeout
#   return 125: chain exhausted, and AT LEAST ONE slot was alive, answered, and
#               was rejected for its SHAPE. Not "the last failure was" — any
#               such slot earns this code, because a caller's re-ask re-walks
#               the WHOLE chain, so a primary that answered wrongly is still
#               recoverable when the backup behind it was dead. Distinct from 1
#               so a caller with its own re-ask can tell "ask again, differently"
#               from "there is nobody left to ask", and spend a second walk only
#               on the first. A timeout still outranks it: 124 is checked first,
#               because callers map that to their own fatal message.
#
# Exports POLICY_CHAIN_VENDOR / POLICY_CHAIN_MODEL — who answered.
#
# Those exports only survive if the call runs in the CALLER's shell. Capturing
# the helper's stdout with `$(policy_run_chain ...)` or piping it puts the walk
# in a subshell, where the assignment dies with it and the caller silently reads
# a stale or empty vendor. Redirect to a file instead — `policy_run_chain ... >
# "$OUT"` — which is what all three callers here do. A caller in a SEPARATE
# process (`bash code-review.sh`) cannot see a sourced helper's exports at all,
# so the same fact is written to stderr as one `answered: <vendor>/<model>`
# line; that line is the durable channel and is what the tests assert on.
#
# Environment:
#   POLICY_JSON                  path to policy.json (default: the one beside
#                                this script)
#   CODEX_BIN / GROK_BIN         per-vendor binary override; load-bearing for
#                                stub-driven failure tests, which must never
#                                depend on a live vendor's quota or auth
#   POLICY_CHAIN_RESOLVER        command that prints the model a slot's
#                                `tracks` resolves to, given `<vendor> <tracks>`
#                                (default: `tracks` itself, verbatim — there is
#                                no model catalog here, so a `{v}` family cannot
#                                resolve; an empty `tracks` runs the CLI's own
#                                default model); a test seam
#   CONTEXTIUM_HARNESS_FILE      the harness record read for `agent=` (default:
#                                `.agents/harness`, two levels above this skill)
#   POLICY_CHAIN_SLOT_TIMEOUT_S  per-slot wall clock (default 900)
#   POLICY_CHAIN_VALIDATOR       optional shape test — see below
#
# THE SHAPE TEST (POLICY_CHAIN_VALIDATOR)
#
# A slot used to be banked on `rc == 0` alone, so a vendor that answered with
# prose instead of the review the caller asked for spent the WHOLE chain: both
# callers here parse afterwards, outside the walk, where a rejection can no
# longer reach the backup sitting untried.
#
# Set POLICY_CHAIN_VALIDATOR to a command or shell function and the walk calls
# it with the slot's output file before banking. Non-zero exit = this slot did
# not answer, and the walk keeps going exactly as it does for a timeout. Unset
# → today's behavior.
#
#   _my_check() { grep -q '^FINDING' "$1"; }
#   POLICY_CHAIN_VALIDATOR=_my_check
#   rc=0; policy_run_chain adversarial-review "$PROMPT_FILE" >"$OUT" || rc=$?
#
# Four properties of it are load-bearing, not stylistic:
#
#   1. Its stdout goes to /dev/null, enforced HERE rather than by convention at
#      the call site. This helper's stdout IS the answer stream a caller
#      redirects into a file and parses; one stray echo from a validator would
#      land inside the review and corrupt it.
#   2. Its stderr (last 500B) is the rejection reason, quoted into the
#      diagnostic — mirroring how a failed slot's vendor stderr is surfaced.
#   3. It is NOT exported, and the export attribute is stripped if a caller
#      exported it anyway. An exported name leaks into every vendor CLI
#      subprocess the walk spawns and into any nested call.
#   4. An UNRUNNABLE validator (a name that resolves to no function and no
#      command) is a caller error — return 2, before any vendor is invoked.
#      Defaulting it to "accept" would silently reinstate the exact hole it was
#      set to close, and finding that out costs a whole chain's spend.
#
# `policy_run_chain` UNSETS it on return, so one gate's shape test cannot bleed
# into another's run in the same sourced shell. Callers therefore set it
# immediately before each call, never once at the top of the script.
#
# There is deliberately no CLAUDE_BIN: a claude slot returns 3 WITHOUT invoking
# anything, because the Claude layer here is an agent with repo tools, not a
# one-shot CLI call — so there is no binary for an override to point at.
#
# Per-slot timeout, not a total one. A timed-out slot FALLS THROUGH to the next:
# a hang is the failure class this file exists to survive, and the old hard
# `exit 124` with no fallthrough left the most common outage uncovered.
# Worst-case wall clock is therefore slots x slot-timeout. A caller bounds that
# by LOWERING POLICY_CHAIN_SLOT_TIMEOUT_S — never by wrapping the whole call in
# its own `timeout`, which becomes a total-chain cap that kills the walk
# mid-fallthrough, the exact behavior this design removes.
#
# The prompt arrives as a FILE and is piped on stdin, never on argv. A large
# diff on argv dies `Argument list too long` (exit 126) on exactly the changes
# that most need reviewing.
#
# Diagnostics are stderr-ONLY. code-review.sh's stdout is a triage-line stream
# that /implement-audit's fix loop parses, so a banner there corrupts it.
#
# This file is the one place a review vendor's CLI is invoked from shell.

set -euo pipefail

POLICY_CHAIN_DEFAULT_SLOT_TIMEOUT_S=900

# Read-only is the tightest sandbox that still lets Codex read the repo. Every shell caller of this helper reviews an artifact:
# it reads and reports, it never writes, so it should not be able to.
POLICY_CHAIN_CODEX_SANDBOX="--sandbox=read-only"

# There is no Grok DENYLIST here: both chain-driven shapes are allowlists, and
# both run under a mode that ignores `--disallowed-tools` outright, so the flag
# would assert a protection that does not apply.
# What it used to withhold must still be unreachable: Grok's default set includes
# `run_terminal_command`, `write`, `search_replace` and `spawn_subagent`, the
# prompts on this path carry untrusted text (diffs, SPEC bodies, fetched pages),
# and an unscoped call is a prompt-injection path to a shell on the reviewing
# machine. The two allowlists in the scope block below are the only thing
# keeping it unreachable, which is why neither may be empty.
# If a denylist ever returns on a `dontAsk` shape, do NOT put a `scheduler_*`
# tool in it: `scheduler_list` declares a requirement on them, so denying one
# fails session creation outright.

# The system prompt exists to stop the Grok CLI planning instead of answering.
# No apostrophes and no ${VAR:-default}: an apostrophe inside a `:-` default
# breaks bash quoting and the parse error surfaces ~80 lines later, which is a
# miserable thing to debug. Override by exporting the variable before calling.
# TWO prompts, picked by the same condition that picks the tool scope below.
# The allowlist path (POLICY_CHAIN_GROK_TOOLS, used by code-review.sh and
# spec-audit.sh with read_file,list_dir,grep) exists precisely so the model CAN
# read repo artifacts — telling it not to would forbid the only tools that path
# grants, and the review would come back thin or empty. The other path is
# prompt-in/answer-out and needs no local reads at all.
_policy_chain_grok_system_prompt() {
  local sp
  if [[ -n "${POLICY_CHAIN_GROK_SYSTEM_PROMPT:-}" ]]; then
    printf '%s' "$POLICY_CHAIN_GROK_SYSTEM_PROMPT"
    return 0
  fi
  sp="You are a review service. Answer the message directly. "
  sp+="Do NOT plan. Do NOT announce or describe what you are "
  sp+="about to do. Your entire reply must BE the answer itself, "
  sp+="with no preamble and nothing after it. "
  if [[ -n "${POLICY_CHAIN_GROK_TOOLS:-}" ]]; then
    sp+="Read whatever repo files you need in order to answer."
  else
    sp+="Answer from the message alone; do not read local files."
  fi
  printf '%s' "$sp"
}

# The prompt-in/answer-out path's ALLOWLIST, and the mode welded to it. Measured:
# `dontAsk` cancels a share of runs that call no tool at all (2/8 against a real
# 30k-char prompt, 0/8 under bypassPermissions), and `bypassPermissions`
# ignores --disallowed-tools, so the
# scoping has to flip to an allowlist in the same change. It must be NON-EMPTY:
# `--tools ''` granted a file write and a shell command, 2/2. This path reads
# nothing, so list_dir is the least-capable non-empty value, not a capability.
POLICY_CHAIN_GROK_PLAIN_TOOLS="list_dir"

_policy_chain_err() { echo "policy-chain: $*" >&2; }

# Is the caller's validator name something this shell can actually call? A
# function first (the shape both real callers use — they need the sourcing
# shell's own helpers), then a command on PATH, then an executable path.
_policy_chain_validator_runnable() {
  local name="$1"
  declare -F "$name" >/dev/null 2>&1 && return 0
  command -v "$name" >/dev/null 2>&1 && return 0
  [[ -x "$name" ]] && return 0
  return 1
}

# Where policy.json lives. An explicit POLICY_JSON wins; otherwise it is the
# table shipped beside this script.
_policy_chain_policy_path() {
  if [[ -n "${POLICY_JSON:-}" ]]; then
    printf '%s\n' "$POLICY_JSON"
    return 0
  fi
  printf '%s\n' "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.json"
}

# The vendor that wrote the code, from `agent=` in the harness record, or
# nothing (see the header: THE AUTHOR LEAVES A REVIEW CHAIN).
_policy_chain_author() {
  local file agent
  file="${CONTEXTIUM_HARNESS_FILE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../harness}"
  agent="$(sed -n 's/^[[:space:]]*agent[[:space:]]*=[[:space:]]*//p' "$file" 2>/dev/null | head -n 1 | tr -d "\"' \r")"
  case "$agent" in
    claude|codex|gemini|grok) printf '%s\n' "$agent" ;;
    antigravity) printf 'gemini\n' ;;
    *) ;;
  esac
}

# A per-slot wall clock that also works on a stock macOS, which ships neither
# GNU `timeout` nor `gtimeout`: without one the slot is capped by a watchdog
# here rather than run uncapped, and a hang still ends in 124.
_policy_chain_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "${secs}s" "$@"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "${secs}s" "$@"; return $?; fi
  "$@" &
  local pid=$! waited=0 rc=0
  while kill -0 "$pid" 2>/dev/null; do
    if [[ "$waited" -ge "$secs" ]]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
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

# The exact model a slot's `tracks` names. There is no model catalog here, so
# the default rule is the identity: an exact id is passed through, and a `{v}`
# family — which only a catalog could resolve — fails the slot rather than
# guessing. `bin` is kept in the signature for a resolver that asks the CLI.
_policy_chain_resolve() {
  local vendor="$1" tracks="$2" bin="$3"
  : "$bin"
  if [[ -n "${POLICY_CHAIN_RESOLVER:-}" ]]; then
    # shellcheck disable=SC2086 # a command line, split on purpose
    ${POLICY_CHAIN_RESOLVER} "$vendor" "$tracks"
    return
  fi
  case "$tracks" in
    *'{v}'*) echo "a model family ($tracks) needs a resolver; name an exact model or leave tracks empty" >&2; return 1 ;;
  esac
  printf '%s\n' "$tracks"
}

# Emit a slot's captured output on stdout, guaranteeing a trailing newline. A
# vendor that ends without one would otherwise have its LAST line silently
# dropped by every caller's `while IFS= read -r line` parse — losing the final
# finding of a review rather than failing loudly.
_policy_chain_emit() {
  local file="$1"
  cat "$file"
  if [[ -s "$file" ]] && [[ -n "$(tail -c 1 "$file")" ]]; then
    printf '\n'
  fi
}

_policy_chain_run_codex() {
  local bin="$1" prompt_file="$2" out="$3" secs="$4" pin="$5"
  local -a model=()
  if [[ -n "$pin" ]]; then model=(-m "$pin"); fi
  _policy_chain_timeout "$secs" "$bin" exec ${model[@]+"${model[@]}"} "$POLICY_CHAIN_CODEX_SANDBOX" - \
    <"$prompt_file" >"$out" 2>"${POLICY_CHAIN_TMP}/slot.err"
}

_policy_chain_run_grok() {
  local bin="$1" prompt_file="$2" out="$3" secs="$4" pin="$5"
  local raw="${out}.grok-raw" rc=0 text="" stop=""
  local -a scope=()
  # Two shapes, each a permission MODE plus an allowlist — never a mode alone.
  # Neither carries a denylist.
  #
  # POLICY_CHAIN_GROK_TOOLS set → an agentic read-only run (code review, SPEC
  # audit) that must actually reach repo files. `dontAsk` cancels repo-reading
  # agent runs, and runs that call no tool at all, so no Grok path keeps it:
  # this branch takes bypassPermissions + the caller's allowlist. The allowlist
  # is the only scoping that mode enforces, so the caller's list must be
  # non-empty and read-only — code-review.sh and spec-audit.sh both pass
  # read_file,list_dir,grep. No web hop either: a review reads the repo.
  #
  # Unset → prompt-in/answer-out, no local reads, and no `dontAsk` either: that
  # mode also cancels runs which call NO tool, so this branch takes
  # bypassPermissions + a non-empty allowlist. `--disable-web-search` joins it —
  # this branch answers from the message alone, and a mode that cannot cancel is
  # not a reason to leave a web hop reachable.
  if [[ -n "${POLICY_CHAIN_GROK_TOOLS:-}" ]]; then
    scope=(--permission-mode bypassPermissions --tools "$POLICY_CHAIN_GROK_TOOLS"
           --disable-web-search)
  else
    scope=(--permission-mode bypassPermissions --tools "$POLICY_CHAIN_GROK_PLAIN_TOOLS"
           --disable-web-search)
  fi
  # `--verbatim` because without it the CLI TRUNCATES
  # a large --prompt-file and offloads the rest to a file the model is told to
  # read, forcing an agent loop whose narration lands in `.text`. The prompts on
  # this path are review diffs and SPEC audits — routinely large enough to trip
  # it — and a review that comes back as first-turn narration with no findings is
  # indistinguishable from a clean pass. Tool denial (the cancelled branch below)
  # is one cause of narration-instead-of-answer; this is the other.
  #
  # The other two flags travel with it: verbatim ALONE still self-cancelled 8/8
  # on a real 27k-char prompt, because the CLI's default system prompt makes it a
  # planning agent and its default effort resolves to xhigh. Two measurements
  # disagreed, so the union ships.
  local sysprompt
  sysprompt="$(_policy_chain_grok_system_prompt)"
  # --no-plan is the CLI's own switch for the planning behaviour the flags
  # above fight indirectly.
  local -a model=()
  if [[ -n "$pin" ]]; then model=(-m "$pin"); fi
  _policy_chain_timeout "$secs" "$bin" --prompt-file "$prompt_file" ${model[@]+"${model[@]}"} \
    --output-format json --verbatim --no-plan \
    --reasoning-effort high --system-prompt-override "$sysprompt" \
    ${scope[@]+"${scope[@]}"} \
    >"$raw" 2>"${POLICY_CHAIN_TMP}/slot.err" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    rm -f "$raw"
    return "$rc"
  fi
  # A cancelled run exits 0 and still carries `.text`, but that text is the
  # narration the model emitted before it was cut off — NOT an answer. Returning
  # it would hand the caller a confident-looking partial as if it were the whole
  # review, so fail the slot and say why.
  stop="$(jq -r '.stopReason // empty' <"$raw" 2>/dev/null || true)"
  if [[ "$stop" == "cancelled" ]]; then
    _policy_chain_err "grok run was CANCELLED mid-agent-loop (stopReason=cancelled); output is partial narration, not an answer"
    _policy_chain_err "grok: a cancel most often means the permission mode regressed to dontAsk"
    rm -f "$raw"
    return 1
  fi
  # `--output-format json` emits one object carrying `.text`. When the payload
  # is not that shape, fall back to the raw stdout so a CLI format change
  # surfaces the model's output instead of an empty "success".
  if text="$(jq -er '.text' <"$raw" 2>/dev/null)" && [[ -n "$text" ]]; then
    printf '%s\n' "$text" >"$out"
  else
    mv "$raw" "$out"
    return 0
  fi
  rm -f "$raw"
  return 0
}

_policy_chain_walk() {
  local task_kind="${1:-}" prompt_file="${2:-}"
  local policy chain secs
  local vendor model tracks pin bin out rc i next vrc vreason
  local -a slots=()
  local last_was_timeout=0
  local any_schema_reject=0

  if [[ -z "$task_kind" || -z "$prompt_file" ]]; then
    _policy_chain_err "usage: policy_run_chain <task-kind> <prompt-file>"
    return 2
  fi

  if ! command -v jq >/dev/null 2>&1; then
    _policy_chain_err "jq is required to read the policy"
    return 2
  fi

  policy="$(_policy_chain_policy_path)"
  if [[ ! -f "$policy" ]]; then
    _policy_chain_err "policy.json not found at $policy"
    _policy_chain_err "it ships beside policy-chain.sh; reinstall, or point POLICY_JSON at a copy"
    return 2
  fi

  if [[ ! -f "$prompt_file" ]]; then
    _policy_chain_err "prompt file not found: $prompt_file"
    return 2
  fi
  # Never burn an agent run on an empty prompt: the vendor would answer
  # something, and that answer would be indistinguishable from a real one.
  if [[ ! -s "$prompt_file" ]]; then
    _policy_chain_err "prompt file is empty: $prompt_file — refusing to invoke any vendor"
    return 2
  fi

  # Checked BEFORE the first vendor is invoked, not at the moment of use: an
  # unrunnable shape test discovered after a slot answered has already cost the
  # slot, and the walk would then have to choose between accepting an unchecked
  # answer and throwing away a good one. Neither is right, so it is a caller
  # error up here where nothing has been spent yet.
  if [[ -n "${POLICY_CHAIN_VALIDATOR:-}" ]]; then
    # Strip the export attribute while keeping the value. A caller that exported
    # the name would otherwise put it in the environment of every vendor CLI
    # this walk spawns, and of any nested chain call.
    export -n POLICY_CHAIN_VALIDATOR 2>/dev/null || true
    if ! _policy_chain_validator_runnable "$POLICY_CHAIN_VALIDATOR"; then
      _policy_chain_err "POLICY_CHAIN_VALIDATOR '$POLICY_CHAIN_VALIDATOR' is not a function, command, or executable"
      _policy_chain_err "refusing to run the chain: an unrunnable shape test that defaulted to accept would silently reinstate the hole it was set to close"
      return 2
    fi
  fi

  # The policy is the SSOT for which vendor does which work-type. An unknown
  # task-kind is an error, never a silent default — same contract as the router,
  # where an unknown TaskKind is a compile error.
  chain="$(jq -r --arg k "$task_kind" '
    .rows[$k] // empty
    | (.chain // .voices // [])
    | .[]
    | "\(.vendor)\t\(.model)\t\(.tracks // "")"
  ' "$policy")"

  if [[ -z "$chain" ]]; then
    _policy_chain_err "no policy row for task-kind '$task_kind'"
    _policy_chain_err "known rows: $(jq -r '.rows | keys | join(", ")' "$policy")"
    return 2
  fi

  secs="${POLICY_CHAIN_SLOT_TIMEOUT_S:-$POLICY_CHAIN_DEFAULT_SLOT_TIMEOUT_S}"
  out="${POLICY_CHAIN_TMP}/slot.out"

  # Read the whole chain up front rather than streaming it. The walk has to know
  # whether a NEXT slot exists before it names a failure: promising "trying next
  # slot" on a one-slot row is a diagnostic that lies about what happens next.
  # bash 3.2 has no mapfile.
  while IFS= read -r _slot_line; do slots+=("$_slot_line"); done <<<"$chain"

  # The author's vendor, for a review row (`.chain`); a panel (`.voices`) keeps
  # every seat.
  local author="" is_review=""
  is_review="$(jq -r --arg k "$task_kind" 'if .rows[$k].chain then "yes" else "" end' "$policy")"
  if [[ -n "$is_review" ]]; then author="$(_policy_chain_author)"; fi

  for ((i = 0; i < ${#slots[@]}; i++)); do
    IFS=$'\t' read -r vendor model tracks <<<"${slots[i]}"
    [[ -n "$vendor" ]] || continue
    if [[ $((i + 1)) -lt ${#slots[@]} ]]; then
      next=" — trying next slot"
    else
      next=""
    fi

    if [[ -n "$author" && "$vendor" == "$author" && "$vendor" != "claude" ]]; then
      _policy_chain_err "$vendor left out of '$task_kind': it wrote the code (.agents/harness agent=)${next}"
      last_was_timeout=0
      continue
    fi

    if [[ "$vendor" == "claude" ]]; then
      # The Claude slot is the agent layer's job, not this script's — an agent
      # gets fresh context and repo tools, which a one-shot CLI call does not.
      # Terminal, not a fallthrough: the caller must dispatch its own agent (or,
      # for a gate that requires vendor independence from the author, report
      # unavailable) rather than have this walk answer for it.
      _policy_chain_err "chain for '$task_kind' reached the claude slot ($model) — dispatch the Claude agent instead"
      return 3
    fi

    case "$vendor" in
      codex) bin="${CODEX_BIN:-codex}" ;;
      grok) bin="${GROK_BIN:-grok}" ;;
      *)
        _policy_chain_err "unsupported vendor '$vendor' in the '$task_kind' chain${next}"
        last_was_timeout=0
        continue
        ;;
    esac

    # A slot's `tracks` names the exact model it runs. An EMPTY tracks runs the
    # CLI's own default model — the shipped table leaves it empty, so each
    # vendor runs whatever its user configured. A family that does not resolve
    # is refused rather than run as something else.

    if ! command -v "$bin" >/dev/null 2>&1 && [[ ! -x "$bin" ]]; then
      _policy_chain_err "$vendor CLI absent ($bin)${next}"
      last_was_timeout=0
      continue
    fi

    pin=""
    if [[ -n "$tracks" ]] && { ! pin="$(_policy_chain_resolve "$vendor" "$tracks" "$bin" 2>"${POLICY_CHAIN_TMP}/resolve.err")" || [[ -z "$pin" ]]; }; then
      _policy_chain_err "$vendor slot ($model) could not resolve $tracks: $(tail -c 300 "${POLICY_CHAIN_TMP}/resolve.err") — refusing to run the CLI default${next}"
      last_was_timeout=0
      continue
    fi

    : >"$out"
    : >"${POLICY_CHAIN_TMP}/slot.err"
    rc=0
    case "$vendor" in
      codex) _policy_chain_run_codex "$bin" "$prompt_file" "$out" "$secs" "$pin" || rc=$? ;;
      grok) _policy_chain_run_grok "$bin" "$prompt_file" "$out" "$secs" "$pin" || rc=$? ;;
    esac

    if [[ "$rc" -eq 0 ]]; then
      # The shape test, between "the CLI exited 0" and "this slot answered" —
      # the only place a rejection still has a backup to fall through to.
      if [[ -n "${POLICY_CHAIN_VALIDATOR:-}" ]]; then
        vrc=0
        # stdout to /dev/null: this function's stdout is the answer stream the
        # caller parses, and a chatty validator would be read as findings.
        "$POLICY_CHAIN_VALIDATOR" "$out" >/dev/null 2>"${POLICY_CHAIN_TMP}/validator.err" || vrc=$?
        if [[ "$vrc" -ne 0 ]]; then
          vreason=""
          if [[ -s "${POLICY_CHAIN_TMP}/validator.err" ]]; then
            vreason=": $(tail -c 500 "${POLICY_CHAIN_TMP}/validator.err" | tr '\n' ' ')"
          fi
          _policy_chain_err "$vendor answered in the wrong shape (validator exit $vrc)${vreason}${next}"
          last_was_timeout=0
          any_schema_reject=1
          continue
        fi
      fi
      POLICY_CHAIN_VENDOR="$vendor"
      POLICY_CHAIN_MODEL="$model"
      export POLICY_CHAIN_VENDOR POLICY_CHAIN_MODEL
      _policy_chain_err "answered: ${vendor}/${model} (row '$task_kind')"
      _policy_chain_emit "$out"
      return 0
    fi

    if [[ "$rc" -eq 124 ]]; then
      _policy_chain_err "$vendor timed out after ${secs}s${next}"
      last_was_timeout=1
    else
      _policy_chain_err "$vendor failed (exit $rc)${next}"
      last_was_timeout=0
    fi
    # The vendor's own last words. Without this a quota lockout, an expired
    # auth, or a bad flag all read as a bare exit code, which takes a session
    # to diagnose.
    if [[ -s "${POLICY_CHAIN_TMP}/slot.err" ]]; then
      _policy_chain_err "$vendor stderr (last 500B): $(tail -c 500 "${POLICY_CHAIN_TMP}/slot.err" | tr '\n' ' ')"
    fi
  done

  # A one-slot row prints no "trying next slot" line above, so this sentence is
  # the whole story for it. Named `or was unavailable` because an absent CLI and
  # a crashed one are both exhaustion from the caller's side.
  _policy_chain_err "every vendor in the '$task_kind' chain failed or was unavailable (${#slots[@]} slot(s) tried)"
  # Contextium: a review row marked `"fallback": "fresh-context"` does not end
  # in "unavailable" when no vendor could answer — most installs have one model
  # CLI, and no review at all is worse than a weaker one said plainly. It returns
  # 3, the code callers already treat as "dispatch your own fresh-context agent".
  # Vendors that were ALIVE but answered in the wrong shape (125, below) are not
  # unavailable, so they keep the re-ask path instead.
  if [[ "$any_schema_reject" -eq 0 ]] &&
    [[ "$(jq -r --arg k "$task_kind" '.rows[$k].fallback // ""' "$policy")" == "fresh-context" ]]; then
    _policy_chain_err "no independent vendor for '$task_kind' — fall back to a fresh-context review, NOT independent (the row's fallback)"
    return 3
  fi
  if [[ "$last_was_timeout" -eq 1 ]]; then
    return 124
  fi
  # At least one slot was ALIVE and answered, and what it said was the wrong
  # shape. ANY such slot earns this code, not merely the last one: a caller's
  # re-ask re-walks the WHOLE chain, so a primary that narrated is recoverable
  # even when the backup behind it was dead. Keying on the last slot would have
  # withheld the re-ask in exactly that case — primary narrates, backup down —
  # which is the compound outage the re-ask is most needed for.
  if [[ "$any_schema_reject" -eq 1 ]]; then
    return 125
  fi
  return 1
}

# Public entry point. Wraps the walk so the per-call scratch dir is removed on
# every return path without installing a trap that would clobber the caller's.
policy_run_chain() {
  local rc=0
  POLICY_CHAIN_TMP="$(mktemp -d "${TMPDIR:-/tmp}/policy-chain.XXXXXX")" || {
    _policy_chain_err "cannot create a scratch dir"
    return 2
  }
  _policy_chain_walk "$@" || rc=$?
  rm -rf "$POLICY_CHAIN_TMP"
  # One gate's shape test must not survive into the next gate's run in the same
  # sourced shell — it would silently apply the wrong contract to the wrong
  # answer, which is harder to spot than no test at all. Callers set it
  # immediately before each call for exactly this reason.
  unset POLICY_CHAIN_VALIDATOR
  return "$rc"
}
