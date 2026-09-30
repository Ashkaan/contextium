# shellcheck shell=bash
# paths.sh — two GNU-only calls the hooks need, written so a stock macOS runs
# them too. Sourced, never executed.
#
#   canon_missing <path>   `realpath --canonicalize-missing`: absolute, every
#                          symlink in the part that exists followed, a missing
#                          tail kept as written, `.` and `..` folded
#   run_bounded <secs> <cmd…>   `timeout`: the command's own exit code, or 124
#                          when it ran past <secs> and was stopped
#
# peers:
#   .agents/hooks/lib/paths.test.ts
#   .agents/hooks/check-shared-checkout-write.sh

# Walk the path one component at a time, the way the kernel resolves it: a
# symlink is replaced by its target BEFORE the components after it are read, so
# a `..` after a link steps out of the link's target, not out of the folder
# holding the link. Folding `..` first would turn ~/.agents/skills/../AGENTS.md
# into ~/.agents/AGENTS.md when it really lands in the checkout the link points
# into. Past the first missing component nothing can be a link, and `..` folds
# lexically. At most 40 links are followed, as the kernel allows.
canon_missing() {
  local p="$1" cur="" rest c link hops=0
  case "$p" in /*) ;; *) p="${PWD}/${p}" ;; esac
  rest="${p#/}"
  while [ -n "$rest" ]; do
    case "$rest" in
      */*) c="${rest%%/*}"; rest="${rest#*/}" ;;
      *) c="$rest"; rest="" ;;
    esac
    case "$c" in
      "" | .) continue ;;
      ..) cur="${cur%/*}"; continue ;;
    esac
    if [ -L "$cur/$c" ] && [ "$hops" -lt 40 ]; then
      link="$(readlink "$cur/$c")"
      hops=$((hops + 1))
      case "$link" in /*) cur="" ;; esac
      rest="${link#/}${rest:+/$rest}"
      continue
    fi
    cur="$cur/$c"
  done
  printf '%s\n' "${cur:-/}"
}

run_bounded() {
  local secs="$1" pid watcher rc=0 t v
  shift
  # A coreutils timeout only (GNU, or the uutils rewrite some distributions
  # ship): its 124 is the contract, where busybox's answers 143. macOS has it
  # as gtimeout when coreutils is installed, and neither otherwise, hence the
  # watcher below. The version is captured, not piped into `grep -q`: under
  # pipefail an early-exiting grep fails the pipe and the binary is skipped.
  for t in timeout gtimeout; do
    v="$("$t" --version 2>/dev/null || true)"
    case "$v" in
      *"coreutils"*)
        "$t" "$secs" "$@"
        return $?
        ;;
    esac
  done
  # A watcher that kills the command at the limit. `wait` returns the moment
  # the command ends, so a quick command costs nothing. The watcher marks that
  # it fired before it kills, so the answer never depends on who ran first.
  local fired
  fired="$(mktemp "${TMPDIR:-/tmp}/run-bounded.XXXXXX")" && rm -f "$fired"
  "$@" &
  pid=$!
  # At the limit: the command, then the children it had (listed first, since
  # they are re-parented once it dies) — a child such as a script's `sleep`
  # would otherwise keep the caller's pipe open past the limit.
  # The watcher's own streams are /dev/null: under `x="$(run_bounded …)"` an
  # inherited stdout is the substitution's pipe, and its `sleep` would hold
  # that open — the caller blocked to the limit however quick the command.
  # The sleep runs in the background and is waited for, so the TERM sent when
  # the command ends interrupts the wait and the trap cancels the sleep.
  (
    trap 'kill "${spid:-}" 2>/dev/null; exit 0' TERM
    sleep "$secs" &
    spid=$!
    wait "$spid" 2>/dev/null
    : >"$fired"
    kids="$(pgrep -P "$pid" 2>/dev/null || true)"
    kill "$pid" 2>/dev/null
    # shellcheck disable=SC2086  # one pid per word
    [ -z "$kids" ] || kill $kids 2>/dev/null
  ) </dev/null >/dev/null 2>&1 &
  watcher=$!
  wait "$pid" 2>/dev/null || rc=$?
  if [ -e "$fired" ]; then
    rm -f "$fired"
    wait "$watcher" 2>/dev/null
    return 124
  fi
  kill "$watcher" 2>/dev/null
  wait "$watcher" 2>/dev/null
  return "$rc"
}
