#!/usr/bin/env bash
# Refuse a write into a checkout that several sessions share, and name this
# thread's worktree of that checkout to write to instead.
#
# WHY. A harness gives a session a worktree of at most ONE repo. Every other
# write lands in the shared checkout on its trunk, in no ledger — and `land.ts`
# walks the ledger, so nothing commits it and no close can even mention it.
# `close/scripts/write-root.sh` exists to hand back a worktree per repo; this
# hook is what makes asking for one non-optional, because convention alone is
# what fails.
#
# WHAT IT GUARDS — the shared checkout of this workbench, which holds the code,
# the records (`knowledge/`, `journal/`, `projects/`) and the skills
# (`.agents/skills/`), resolved at run time through `write-root.sh --main` on
# the hook's own directory. The home link `~/.agents/skills` reaches
# `.agents/skills/` in that checkout, so a write spelled through it is refused
# the same way. A
# checkout whose resolution fails is simply not guarded for this invocation; a
# resolver failure must not turn into a blanket refusal.
#
# WHAT IT REFUSES. Edit / Write / MultiEdit (`file_path`) and NotebookEdit
# (`notebook_path`) whose target resolves inside a guarded checkout; and the
# unambiguous write forms of a Bash command — `>` / `>>` redirection, `tee`,
# `sed -i`, the destination of `cp` / `mv` / `ln` / `install` (including their
# `-t` form), and `rm`, `mkdir`, `touch`.
#
# ONE CARVE-OUT, for `rm` alone. The guard exists to stop content landing in a
# shared checkout outside any ledger. A delete whose every target holds NO
# tracked content lands nothing and leaves nothing for a close to miss — it
# makes the checkout cleaner — so it passes. The case that forces it: a
# harness's own skill sync can write untracked folders under
# `~/.claude/skills/`, which through the symlink is the checkout's skills, and
# a guard that refused their cleanup would be in the way of the fix. The distinction is git's answer, not a guess: a tracked path, a
# directory holding one, the checkout itself, or a root that is not a git
# repository all refuse exactly as before. Creating an untracked file
# (`touch`, `>`) is the original failure and stays refused.
#
# WHAT IT ALLOWS. Everything under a worktree, which is the point — including
# a worktree the harness keeps inside the checkout (.claude/worktrees/,
# .gemini/worktrees/), which git names as a linked worktree. Every read. And every
# Bash form not on the list above, including `node --experimental-strip-types <guarded>/close/verify.ts`:
# merely NAMING a guarded path is not writing to it, and a hook that refused
# that would be unusable and would be turned off.
#
# KNOWN and DECLINED. Each fails OPEN — a missed refusal, caught afterwards by
# the dirty-checkout backstop in `close/scripts/verify.ts` whenever this thread
# already owns a worktree of that checkout:
#   · a write inside `$(...)`, a heredoc body, or an interpreter one-liner
#     (`python3 -c 'open(p,"w")'`) — the target is not a token of the command;
#   · a target built from a variable or a substitution, which cannot be
#     resolved without running the command;
#   · a relative target after a `cd` this walk could not resolve;
#   · an operand shape past the ones handled below.
# Closing the last of these needs attribution the shared checkout cannot give,
# which is the reasoning write-root.sh:14-19 already records.
#
# Exit: 0 allow · 2 refuse (PreToolUse convention: stderr reaches the model)

# `-e` is dropped under the fail-open carve-out for decision hooks: this is a
# decision hook, and a non-zero from any probe it runs — jq on a payload shape
# it does not know, write-root.sh in a repo with no origin — must leave the
# session able to write, not kill the hook mid-verdict with an exit the harness
# reads as a refusal. Every fallible command below carries its own guard.
set -uo pipefail

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SEGMENTS_LIB="${HOOK_DIR}/lib/shell-segments.sh"
# Guarded rather than assumed, per the carve-out above. Without the lexer the
# Bash half cannot run at all, and silently continuing would leave a hook that
# reports success while guarding nothing.
if [[ ! -f "${SEGMENTS_LIB}" ]]; then
  echo "check-shared-checkout-write: missing ${SEGMENTS_LIB} — not guarding" >&2
  exit 0
fi
# `source=` alone is not enough: the audit runs bare `shellcheck`, without
# `-x`, so it cannot follow the path and reports SC1091 at info level.
# shellcheck source=SCRIPTDIR/lib/shell-segments.sh
# shellcheck disable=SC1091
. "${SEGMENTS_LIB}"

# GNU's `realpath --canonicalize-missing` and `timeout`, portably: stock macOS
# has neither. Missing, the hook cannot resolve a path, so it guards nothing
# rather than refusing everything, as for the lexer above.
PATHS_LIB="${HOOK_DIR}/lib/paths.sh"
if [[ ! -f "${PATHS_LIB}" ]]; then
  echo "check-shared-checkout-write: missing ${PATHS_LIB} — not guarding" >&2
  exit 0
fi
# shellcheck source=SCRIPTDIR/lib/paths.sh
# shellcheck disable=SC1091
. "${PATHS_LIB}"

# The helpers are this layer's own files, beside the hooks under .agents/.
# Overridable so the peer suite can point at stubs instead of the live scripts;
# nothing in a real session sets any of these.
_WR_DEFAULT="${HOOK_DIR}/../skills/close/scripts/write-root.sh"
_TH_DEFAULT="${HOOK_DIR}/../skills/close/scripts/thread.ts"
WRITE_ROOT="${CHECK_SHARED_WRITE_ROOT_SCRIPT:-${_WR_DEFAULT}}"
THREAD="${CHECK_SHARED_WRITE_THREAD_SCRIPT:-${_TH_DEFAULT}}"
# Seconds to wait on write-root.sh. Well inside the 120s flock it takes
# (write-root.sh:208) — a refusal that blocks for two minutes is worse than the
# refusal. The suite shortens it so the degrade case does not cost 20s of wall
# clock; nothing in a real session sets it.
WR_TIMEOUT="${CHECK_SHARED_WRITE_TIMEOUT:-20}"

CWD=""
CWD_KNOWN=1
TARGETS=""
GUARDED=""
COMMAND=""

# ── Functions ─────────────────────────────────────────────────────────────

# Each line is `<verb><TAB><path>`; the verb is empty for every form but `rm`,
# which is the one the untracked carve-out below needs to recognise.
add_target() {
  [[ -n "${1:-}" ]] || return 0
  TARGETS="${TARGETS}${2:-}"$'\t'"${1}"$'\n'
}

# Does git say this path holds nothing it tracks? `ls-files -- <path>` lists
# the tracked files at or under it, so an empty answer with exit 0 means
# untracked, ignored, or absent — all three leave nothing behind when deleted.
# Any git failure, and a root that is not a repository, answer "no" so the old
# refusal stands.
untracked_only() {    # <root> <target>  →  0 yes · 1 no
  local root="$1" target="$2" rel tracked
  [[ "${target}" != "${root}" ]] || return 1
  git -C "${root}" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  rel="${target#"${root}"/}"
  tracked="$(git -C "${root}" ls-files -- "${rel}" 2>/dev/null)" || return 1
  [[ -z "${tracked}" ]]
}

# Which short flags of this verb SWALLOW the next token? Without this the
# argument of `touch -r ref f` reads as a file the command writes, and the
# destination of `cp -t <dir> src` reads as a source.
arg_taking_flags() {
  case "$1" in
    cp | mv | ln) printf '%s\n' "t S" ;;
    install) printf '%s\n' "t m o g" ;;
    touch) printf '%s\n' "t r d" ;;
    mkdir) printf '%s\n' "m Z" ;;
    sed) printf '%s\n' "e f" ;;
    *) printf '%s\n' "" ;;
  esac
}

# Which options do the WRAPPERS take an argument for? Without this
# `sudo -u root touch <guarded>/f` reads `root` as the command and the write
# goes unrefused. Short and long forms are one table per
# a class fix covers every instance — covering only the short ones left
# `env --unset FOO touch <guarded>/f` open.
wrapper_arg_flags() {
  case "$1" in
    sudo | doas) printf '%s\n' "u g p C h r t U D R" ;;
    env) printf '%s\n' "u S C" ;;
    exec) printf '%s\n' "a" ;;
    stdbuf) printf '%s\n' "i o e" ;;
    *) printf '%s\n' "" ;;
  esac
}

wrapper_long_arg_flags() {
  case "$1" in
    sudo | doas)
      printf '%s\n' "user group prompt close-from host role type" \
        "other-user chdir"
      ;;
    env)
      printf '%s\n' "unset split-string chdir block-signal" \
        "default-signal ignore-signal"
      ;;
    stdbuf) printf '%s\n' "input output error" ;;
    *) printf '%s\n' "" ;;
  esac
}

# Does this short cluster take an argument, and is it attached?
#
# Prints `A <arg>` when the argument is attached (`-t/some/dir`, `-St`), or
# `N <letter>` when it is the next word. Prints nothing otherwise. Reading only
# the cluster's LAST character got both wrong: it missed `cp -t<dir> src`
# entirely, and it read `cp -St src <guarded>` as though `src` were the
# destination, so the real destination was never tested.
flag_arg() {
  local swallow="$1" tok="$2" body c rest i
  [[ -n "${swallow}" ]] || return 0
  [[ "${tok}" == -* && "${tok}" != --* ]] || return 0
  body="${tok#-}"
  for ((i = 0; i < ${#body}; i++)); do
    c="${body:i:1}"
    [[ " ${swallow} " == *" ${c} "* ]] || continue
    rest="${body:i+1}"
    if [[ -n "${rest}" ]]; then
      printf 'A %s\n' "${rest}"
    else
      printf 'N %s\n' "${c}"
    fi
    return 0
  done
}

# Which letter of the cluster took the argument — `t` means it is a
# destination directory, anything else means it is a mode, a suffix or an owner.
flag_letter() {
  local swallow="$1" tok="$2" body c i
  [[ -n "${swallow}" ]] || return 0
  body="${tok#-}"
  for ((i = 0; i < ${#body}; i++)); do
    c="${body:i:1}"
    if [[ " ${swallow} " == *" ${c} "* ]]; then
      printf '%s\n' "${c}"
      return 0
    fi
  done
}

# Where a `cd` lands. Prints the directory, or nothing when it cannot be known —
# a variable, a substitution, `cd -`, or more than one operand. Unknowable is
# fail-open, not refuse.
resolve_cd() {
  local arg="$1"
  case "${arg}" in
    *'$'* | *'`'* | '-' | '') return 1 ;;
  esac
  # shellcheck disable=SC2088  # a case PATTERN matched against the argument,
  # not a path being used — expanding it would be the bug, because then nothing
  # could match a literal tilde. Same call write-root.sh:104-107 makes.
  case "${arg}" in
    '~') printf '%s\n' "${HOME}" ;;
    '~/'*) printf '%s\n' "${HOME}/${arg#\~/}" ;;
    /*) printf '%s\n' "${arg}" ;;
    *)
      [[ "${CWD_KNOWN}" == 1 ]] || return 1
      printf '%s\n' "${CWD}/${arg}"
      ;;
  esac
}

# One segment: find every path it WRITES to and hand each to add_target.
scan_segment() {
  local seg="$1"
  local tag rest verb="" swallow="" prev_redirect=0 prev_input=0
  local skip_next=0 skip_flag="" fa wshort="" wlong="" name
  local -a words=() ops=() dest_flag=() swallowed=()
  local w i

  # Tagged tokens, so a quoted path stays one word and a `>` inside quotes
  # stays prose. See split_words in lib/shell-segments.sh.
  while IFS= read -r tag; do
    rest="${tag:2}"
    case "${tag:0:1}" in
      # The word AFTER an output redirection is the file being written. An
      # attached file descriptor (`2>`) was already dropped by the lexer, which
      # is the only place adjacency is knowable.
      R) prev_redirect=1; prev_input=0 ;;
      # And the word after an INPUT redirection is a file being READ. Leaving
      # it among the operands made `tee /tmp/out < <guarded>/input` refuse a
      # command that writes nothing to the guarded tree.
      L) prev_input=1; prev_redirect=0 ;;
      W)
        if [[ "${prev_redirect}" == 1 ]]; then
          add_target "${rest}"
          prev_redirect=0
          continue
        fi
        if [[ "${prev_input}" == 1 ]]; then
          prev_input=0
          continue
        fi
        words+=("${rest}")
        ;;
    esac
  done < <(split_words "${seg}")

  [[ ${#words[@]} -gt 0 ]] || return 0

  # The verb is the first word that is not an environment assignment, a
  # wrapper, or a wrapper's own option. Without this `env X=1 touch <guarded>/f`
  # and `X=1 cp /tmp/a <guarded>/f` both read their wrapper as the command and
  # the write went unrefused.
  i=0
  while [[ ${i} -lt ${#words[@]} ]]; do
    w="${words[${i}]}"
    if [[ "${w}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then i=$((i + 1)); continue; fi
    name="$(basename -- "${w}")"
    case "${name}" in
      sudo | doas | command | nohup | env | exec | time | stdbuf)
        wshort="$(wrapper_arg_flags "${name}")"
        wlong="$(wrapper_long_arg_flags "${name}")"
        i=$((i + 1))
        continue
        ;;
    esac
    if [[ "${w}" == --* ]]; then
      # `--opt=value` carries its own argument; `--opt value` takes the next
      # word, and leaving that word behind made it read as the command.
      if [[ "${w}" != *=* ]]; then
        name="${w#--}"
        [[ " ${wlong} " == *" ${name} "* ]] && i=$((i + 1))
      fi
      i=$((i + 1))
      continue
    fi
    if [[ "${w}" == -* ]]; then
      fa="$(flag_arg "${wshort}" "${w}")"
      [[ "${fa:0:1}" == N ]] && i=$((i + 1))
      i=$((i + 1))
      continue
    fi
    verb="$(basename -- "${w}")"
    break
  done
  [[ -n "${verb}" ]] || return 0

  swallow="$(arg_taking_flags "${verb}")"
  i=$((i + 1))
  while [[ ${i} -lt ${#words[@]} ]]; do
    w="${words[${i}]}"
    i=$((i + 1))
    if [[ "${skip_next}" == 1 ]]; then
      skip_next=0
      # WHICH flag swallowed it decides what it is. Collapsing the two put
      # `install -m 644 src <guarded>` 's mode where the destination goes, so
      # `644` was tested against the guarded roots and the real destination was
      # never looked at.
      if [[ "${skip_flag}" == t ]]; then
        dest_flag+=("${w}")
      else
        swallowed+=("${w}")
      fi
      continue
    fi
    case "${w}" in
      --) break ;;
      --target-directory=*) dest_flag+=("${w#*=}"); continue ;;
      --target-directory) skip_next=1; skip_flag=t; continue ;;
      -*)
        fa="$(flag_arg "${swallow}" "${w}")"
        case "${fa:0:1}" in
          A)
            # Attached: `cp -t<dir> src`, `cp -St src`. Which flag took it is
            # the first argument-taking letter of the cluster.
            if [[ "$(flag_letter "${swallow}" "${w}")" == t ]]; then
              dest_flag+=("${fa:2}")
            else
              swallowed+=("${fa:2}")
            fi
            ;;
          N) skip_next=1; skip_flag="${fa:2}" ;;
        esac
        continue
        ;;
    esac
    ops+=("${w}")
  done
  # Everything after `--` is an operand whatever it looks like.
  while [[ ${i} -lt ${#words[@]} ]]; do
    ops+=("${words[${i}]}")
    i=$((i + 1))
  done

  case "${verb}" in
    cd)
      if [[ ${#ops[@]} -eq 1 ]] && w="$(resolve_cd "${ops[0]}")"; then
        CWD="${w}"
      else
        CWD_KNOWN=0
      fi
      ;;
    rm)
      for w in ${ops[@]+"${ops[@]}"}; do add_target "${w}" rm; done
      ;;
    tee | mkdir | touch)
      for w in ${ops[@]+"${ops[@]}"}; do add_target "${w}"; done
      ;;
    sed)
      # In-place only. The first operand is the script; the rest are files.
      # `-e`/`-f` swallow the script as their own argument, so dropping the
      # first operand is right in both shapes.
      if printf '%s\n' ${words[@]+"${words[@]}"} \
        | grep -qE '^-[A-Za-z]*i'; then
        # `-e`/`-f` already took the script as their own argument, so with one
        # present EVERY operand is a file. Dropping the first regardless left
        # `sed -i -e 's/a/b/' <guarded>/f` with nothing to check.
        if [[ ${#swallowed[@]} -gt 0 ]]; then
          for w in ${ops[@]+"${ops[@]}"}; do add_target "${w}"; done
        else
          for w in ${ops[@]+"${ops[@]:1}"}; do add_target "${w}"; done
        fi
      fi
      ;;
    cp | mv | ln | install)
      # `-t <dir>` / `--target-directory` makes the FLAG carry the destination
      # and every operand a source; `install -d` makes every operand a
      # directory to create. Otherwise the destination is the last operand, and
      # `ln -s target` with no link name creates it in the current directory.
      if [[ ${#dest_flag[@]} -gt 0 ]]; then
        for w in ${dest_flag[@]+"${dest_flag[@]}"}; do add_target "${w}"; done
      elif [[ "${verb}" == install ]] \
        && printf '%s\n' ${words[@]+"${words[@]}"} \
          | grep -qE '^(-[A-Za-z]*d|--directory)$'; then
        for w in ${ops[@]+"${ops[@]}"}; do add_target "${w}"; done
      elif [[ ${#ops[@]} -ge 2 ]]; then
        add_target "${ops[${#ops[@]} - 1]}"
      elif [[ ${#ops[@]} -eq 1 && "${verb}" == ln ]]; then
        add_target "${CWD}/$(basename -- "${ops[0]}")"
      fi
      ;;
  esac
}

# How each harness is told "no". Claude Code and Codex read exit 2 with the
# message on stderr; Antigravity reads a JSON decision on stdout and ignores the
# exit code. Empty stdout is an ALLOW there, and `{}` is a DENY, because `decision` is required and an object missing it fails closed —
# so the pass path must stay silent on every harness and must never print `{}`.
# `{"decision":"allow"}` would be wrong too: it auto-approves the call and
# bypasses the permission prompt, which is not what a gate that found nothing
# should do. Mirrors check-host-infra-safety.sh's deny() exactly.
deny() {
  if [[ -n "${ANTIGRAVITY:-}" ]]; then
    jq -nc --arg r "$1" '{decision:"deny",reason:$r}'
    exit 0
  fi
  printf '%s\n' "$1" >&2
  exit 2
}

refuse() {
  local target="$1" root="$2"
  local rel worktree instead
  if [[ "${target}" == "${root}" ]]; then
    rel=""
  else
    rel="${target#"${root}"/}"
  fi

  # Create-on-demand rather than refuse-and-instruct: the alternative costs a
  # round trip on every thread's first write to a satellite repo, and
  # author/scripts/scaffold.ts:148 already set this precedent.
  worktree="$(run_bounded "${WR_TIMEOUT}" bash "${WRITE_ROOT}" "${root}" \
    2>/dev/null)"
  if [[ -n "${worktree}" && -d "${worktree}" ]]; then
    instead="Write to this thread's worktree of that checkout instead:
  ${worktree}/${rel}"
  else
    instead="Could not resolve this thread's worktree of that checkout just now.
Ask for it, then write under the path it prints:
  bash ${WRITE_ROOT} ${root}"
  fi

  local how="A file written there is in no
ledger, so \`/close\` will not commit it and cannot even report it — the file
is left behind with no session to account for it."
  if [[ "${VERB:-}" == rm ]]; then
    how="This path holds content git tracks. Deleting it here leaves an
uncommitted deletion on the trunk that no close commits and that stops the
shared checkout fast-forwarding for every thread — the file is not lost (git
history has it), the deletion is. \`git rm\` it in the worktree and land.
A delete of untracked content passes this guard; only tracked content refuses."
  fi

  local _msg=""
  # The heredoc is read into a variable, not run inside "$(…)": bash 3.2 (the
  # macOS default) mis-parses a $(…) whose heredoc body holds an unmatched
  # quote or parenthesis, and the whole script then fails to parse.
  IFS= read -r -d '' _msg <<MSG || true
BLOCKED: a write into ${root}, a checkout that several sessions share.

That tree is on the trunk and belongs to no session. ${how}

${instead}

Target:
  ${target}
MSG
  deny "${_msg%$'\n'}"
}

# ── The candidate targets, before anything expensive ──────────────────────
#
# Resolving the three checkouts costs three git invocations, and this hook runs
# on EVERY Bash call. So the parse comes first, and the resolution only happens
# if the payload named something that could be a write at all.

INPUT="$(cat)"

# ── Dialect normalization, BEFORE the tool switch ─────────────────────────
#
# Four harnesses fire this hook and none of them agree on the payload (Grok
# Build's camelCase shape is the branch after Antigravity's). A reader
# of Claude's shape alone — `.tool_name` — would let an Antigravity call
# (`toolCall.name`) leave at the emptiness check below having examined no path
# at all, and Codex's write tool is named `apply_patch`, which would match no
# branch. Both would look guarded and not be.
#
# Read from codex-cli 0.155.0 and agy 1.2.7:
#
#   | field   | Claude / Codex                     | Antigravity                   |
#   |---------|------------------------------------|-------------------------------|
#   | tool    | .tool_name                         | .toolCall.name                |
#   | command | .tool_input.command                | .toolCall.args.CommandLine    |
#   | path    | .tool_input.{file_path,notebook_path} | .toolCall.args.TargetFile  |
#   |         | Codex: parsed out of the patch envelope |                          |
#   | cwd     | .cwd                               | .toolCall.args.Cwd            |
#   |         |                                    |   // .workspacePaths[0]       |
#
# `.toolCall` is the discriminator, the same one check-host-infra-safety.sh:301
# uses, so the two guards beside each other cannot disagree about which harness
# is speaking.
ANTIGRAVITY="$(printf '%s' "${INPUT}" \
  | jq --raw-output 'if .toolCall then "1" else "" end' 2>/dev/null)"

if [[ -n "${ANTIGRAVITY}" ]]; then
  RAW_TOOL="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolCall.name // empty' 2>/dev/null)"
  # Map onto the names the rest of this file already reasons about, rather than
  # adding a third set of branches below.
  case "${RAW_TOOL}" in
    run_command) TOOL="Bash" ;;
    write_to_file | replace_file_content) TOOL="Write" ;;
    *) TOOL="" ;;
  esac
  COMMAND="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolCall.args.CommandLine // empty' 2>/dev/null)"
  WRITE_PATH="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolCall.args.TargetFile // empty' 2>/dev/null)"
  CWD="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolCall.args.Cwd // .workspacePaths[0] // empty' \
      2>/dev/null)"
elif [[ -n "$(printf '%s' "${INPUT}" | jq --raw-output '.toolName // empty' 2>/dev/null)" ]]; then
  # Grok Build: camelCase `toolName` / `toolInput`, its shell tool
  # `run_terminal_command` and its file writes `write` and `search_replace`,
  # each with `toolInput.file_path` (a live grok 1.0.41 payload). Mapped onto
  # the names below, and a deny is exit 2 as for Claude Code.
  RAW_TOOL="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolName // empty' 2>/dev/null)"
  case "${RAW_TOOL}" in
    run_terminal_command) TOOL="Bash" ;;
    write | search_replace | edit | multi_edit) TOOL="Write" ;;
    *) TOOL="" ;;
  esac
  COMMAND="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolInput.command // empty' 2>/dev/null)"
  WRITE_PATH="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.toolInput.file_path // .toolInput.path // empty' 2>/dev/null)"
  CWD="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.cwd // .workspaceRoot // empty' 2>/dev/null)"
else
  TOOL="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.tool_name // empty' 2>/dev/null)"
  COMMAND="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.tool_input.command // empty' 2>/dev/null)"
  # ONE expression covering both field names. A guard that read only
  # `file_path` would let every notebook write through.
  WRITE_PATH="$(printf '%s' "${INPUT}" \
    | jq --raw-output \
      '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)"
  CWD="$(printf '%s' "${INPUT}" \
    | jq --raw-output '.cwd // empty' 2>/dev/null)"
  # Gemini CLI sends this same snake_case shape under its own tool names
  # (@google/gemini-cli-core 0.61.0: run_shell_command, write_file, replace,
  # each file tool with tool_input.file_path). Mapped onto the names below.
  case "${TOOL}" in
    run_shell_command) TOOL="Bash" ;;
    write_file | replace) TOOL="Write" ;;
  esac
fi

# A payload naming no tool this hook knows is a harness whose shape nobody has
# taught it yet: permitted, per the documented fail-open posture at the top.
[[ -n "${TOOL}" ]] || exit 0
[[ -n "${CWD}" ]] || CWD="${PWD}"

# LATENT UNDER CODEX 0.155.0, and kept anyway. Codex fires PreToolUse for its
# SHELL tool and not for `apply_patch` — a `.*` matcher on a
# manifest that demonstrably fires for the shell produced zero invocations for a
# patch write, which then landed in the shared checkout. So this branch guards
# nothing there TODAY. It stays because it is correct, it costs one case in the
# switch, and it starts guarding the moment Codex fires the event; deleting it
# would mean re-deriving the envelope grammar from scratch when that happens.
#
# Every path an `apply_patch` envelope names — and one envelope may name many.
# Codex has no `file_path` key at all; the paths live in the patch body, one per
# verb line. All four verbs, because a Delete and a Move land content in (or
# remove tracked content from) a shared checkout exactly as an Update does, and
# only the FIRST file being safe says nothing about the rest.
patch_paths() {
  local line p
  while IFS= read -r line; do
    line="${line%$'\r'}"
    case "${line}" in
      '*** Add File: '* | '*** Update File: '* | '*** Delete File: '* \
        | '*** Move to: '*)
        p="${line#\*\*\* }"
        p="${p#*: }"
        ;;
      *) continue ;;
    esac
    [[ -n "${p}" ]] && printf '%s\n' "${p}"
  done
}

# A known write tool that yields no path means the PARSER broke, not that the
# call is safe — the one combination the fail-open posture must not cover, since
# it is indistinguishable from "guarded" right up until a file lands on `main`.
parse_failed() {
  deny "BLOCKED: ${TOOL} (${RAW_TOOL:-${TOOL}}) named no writable path this
guard could read, so it cannot tell whether the write lands in a shared
checkout. Refusing rather than guessing.

This is a bug in .agents/hooks/check-shared-checkout-write.sh, not in the call:
the payload shape below is one it does not know. $1"
}

case "${TOOL}" in
  Edit | Write | MultiEdit | NotebookEdit)
    [[ -n "${WRITE_PATH}" ]] || parse_failed "No path field was populated."
    add_target "${WRITE_PATH}"
    ;;

  apply_patch)
    [[ -n "${COMMAND}" ]] || parse_failed "The patch envelope was empty."
    _N_PATCHED=0
    while IFS= read -r _P; do
      add_target "${_P}"
      _N_PATCHED=$((_N_PATCHED + 1))
    done < <(printf '%s\n' "${COMMAND}" | patch_paths)
    [[ "${_N_PATCHED}" -gt 0 ]] \
      || parse_failed "No *** Add/Update/Delete/Move line was found in it."
    ;;

  Bash)
    [[ -n "${COMMAND}" ]] || exit 0
    while IFS= read -r SEG; do
      [[ -n "${SEG//[[:space:]]/}" ]] || continue
      scan_segment "${SEG}"
    done < <(split_segments "${COMMAND}")
    ;;

  *) exit 0 ;;
esac
TARGETS="$(printf '%s' "${TARGETS}" | sed '/^$/d')"
[[ -n "${TARGETS}" ]] || exit 0

# ── No thread, no isolation to offer ──────────────────────────────────────
#
# A plain terminal has no worktree to be sent to, and write-root.sh exits 2 in
# that case by design. Refusing there would leave such a session unable to
# write anywhere at all.
#
# Asked only once a target is INSIDE a guarded checkout, never up front:
# `thread.ts --id` records the session in the cache as it answers, so asking it
# for every command with a redirect — `2>/dev/null` included — left a session
# entry behind for writes that reach no checkout at all.
IN_THREAD=""
# in_linked_worktree <root> <target> — is the target inside a linked worktree
# of this checkout? Claude Code's and Gemini CLI's session worktrees live INSIDE
# the checkout (.claude/worktrees/<id>, .gemini/worktrees/<id> — harness.sh), so
# the prefix test matches them, and refusing there refuses every write a session
# makes in its own worktree. Git's answer for the nearest folder that exists
# tells them apart: another top level that shares this checkout's .git. A repo
# merely nested in the checkout has its own .git, and still refuses.
in_linked_worktree() {
  local root="$1" d="$2" top common
  while [[ ! -d "${d}" ]]; do
    d="${d%/*}"
    [[ -n "${d}" ]] || return 1
  done
  top="$(git -C "${d}" rev-parse --show-toplevel 2>/dev/null)" || return 1
  top="$(canon_missing "${top}" 2>/dev/null)" || return 1
  [[ -n "${top}" && "${top}" != "${root}" ]] || return 1
  common="$(git -C "${d}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  common="$(canon_missing "${common}" 2>/dev/null)" || return 1
  [[ "${common}" == "${root}/.git" ]]
}

in_thread() {
  if [[ -z "${IN_THREAD}" ]]; then
    # thread.ts is TypeScript; this hook stays bash and runs it, never sources it.
    if node --experimental-strip-types "${THREAD}" --id >/dev/null 2>&1; then IN_THREAD=1; else IN_THREAD=0; fi
  fi
  [[ "${IN_THREAD}" == 1 ]]
}

# ── The guarded checkout ──────────────────────────────────────────────────
#
# `${HOOK_DIR}` rather than `.`: `--main` canonicalises through
# `--git-common-dir`, so a worktree resolves to its shared checkout either way,
# but the hook's own location is an answer that does not depend on where the
# session happens to be standing.
if ROOT="$(run_bounded "${WR_TIMEOUT}" bash "${WRITE_ROOT}" --main "${HOOK_DIR}" \
    2>/dev/null)" && [[ -n "${ROOT}" && -d "${ROOT}" ]]; then
  # Through canon_missing for the same reason the targets are: one spelling per
  # checkout, or a symlinked parent makes the prefix test miss.
  ROOT="$(canon_missing "${ROOT}" 2>/dev/null)" || ROOT=""
  [[ -n "${ROOT}" ]] && GUARDED="${ROOT}"$'\n'
fi
[[ -n "${GUARDED//[[:space:]]/}" ]] || exit 0

while IFS= read -r TARGET; do
  [[ -n "${TARGET}" ]] || continue
  VERB="${TARGET%%$'\t'*}"
  TARGET="${TARGET#*$'\t'}"
  [[ -n "${TARGET}" ]] || continue

  # Expand a leading `~` BEFORE canon_missing. Without this step an unexpanded
  # `~/.agents/skills/…` — which is how a quoted path reaches a hook — is under
  # no guarded root and the guard silently fails open.
  # shellcheck disable=SC2088  # a case PATTERN, not a path — see resolve_cd.
  case "${TARGET}" in
    '~') TARGET="${HOME}" ;;
    '~/'*) TARGET="${HOME}/${TARGET#\~/}" ;;
  esac

  case "${TARGET}" in
    /*) ;;
    *)
      # Relative, and only meaningful if the `cd` walk stayed resolvable.
      [[ "${CWD_KNOWN}" == 1 ]] || continue
      TARGET="${CWD}/${TARGET}"
      ;;
  esac

  # A target built from a variable cannot be resolved without running the
  # command. Fail open rather than guess.
  case "${TARGET}" in *'$'* | *'`'*) continue ;; esac

  # `--canonicalize-missing` because the file need not exist yet — a write is
  # usually to a path that does not. It also collapses the `~/.claude/skills`
  # and `~/.agents/skills` home links to the checkout's `skills/`.
  #
  # EXCEPT for `rm` of a SYMLINK, where resolving the leaf charges the delete to
  # whatever the link points at. Removing a link in a harness home that points
  # into this checkout unlinks an entry in that home and leaves the checkout
  # untouched, and every harness home holds links like it — a class, not one
  # path. The
  # PARENT is still resolved — a link entry lives in a directory, that directory
  # is what the delete writes to, and a symlinked parent inside a guarded root
  # must still refuse.
  if [[ "${VERB}" == rm && -L "${TARGET}" ]]; then
    TARGET_DIR="${TARGET%/*}"
    [[ -n "${TARGET_DIR}" ]] || TARGET_DIR=/
    TARGET_DIR="$(canon_missing "${TARGET_DIR}" 2>/dev/null)" || continue
    TARGET="${TARGET_DIR%/}/${TARGET##*/}"
  else
    TARGET="$(canon_missing "${TARGET}" 2>/dev/null)" || continue
  fi
  [[ -n "${TARGET}" ]] || continue

  while IFS= read -r ROOT; do
    [[ -n "${ROOT}" ]] || continue
    case "${TARGET}" in
      "${ROOT}" | "${ROOT}"/*)
        in_linked_worktree "${ROOT}" "${TARGET}" && continue
        if [[ "${VERB}" == rm ]] && untracked_only "${ROOT}" "${TARGET}"; then
          continue
        fi
        in_thread || exit 0
        refuse "${TARGET}" "${ROOT}"
        ;;
    esac
  done <<< "${GUARDED}"
done <<< "${TARGETS}"

exit 0
