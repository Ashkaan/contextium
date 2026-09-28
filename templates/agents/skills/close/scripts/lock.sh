#!/usr/bin/env bash
# lock.sh — a portable exclusive lock for the close scripts, sourced, not run.
# Used where flock(1) may be missing (stock macOS): roadmap.sh's writers, and
# safe-commit.sh's fallback.
#
#   source lock.sh
#   lock_take <lock-path> <wait-seconds> || <timed out>   # sets an EXIT trap
#   lock_release <lock-path>                               # optional; the trap does it
#
# THE LOCK IS A SYMLINK whose target is the holder's pid. `ln -s` creates it
# atomically and fails when it exists, and the pid is written in the same step,
# so there is never a lock without an owner to check.
#
# A DEAD HOLDER'S LOCK IS TAKEN OVER, one taker at a time. Read-pid-then-remove
# is a race on its own: the holder read as dead may be a live one that replaced
# it a moment ago. So a taker first takes `<lock>.takeover` (mkdir), re-reads
# the pid, and removes the lock only if the dead pid still owns it. A dead
# holder cannot release, so only a serialized taker can change the lock then.
#
# Portable: bash 3.2, BSD and GNU userland.
#
# peers:
#   .agents/skills/close/scripts/lock.test.sh
#   .agents/skills/close/scripts/roadmap.sh
#   .agents/skills/close/scripts/safe-commit.sh

lock_take() {
  local lock="$1" wait_s="${2:-30}" ticks=0 holder
  until ln -s "$$" "$lock" 2>/dev/null; do
    holder="$(readlink "$lock" 2>/dev/null || true)"
    if [[ -n "$holder" ]] && ! kill -0 "$holder" 2>/dev/null && mkdir "$lock.takeover" 2>/dev/null; then
      if [[ "$(readlink "$lock" 2>/dev/null || true)" == "$holder" ]]; then rm -f "$lock"; fi
      rmdir "$lock.takeover" 2>/dev/null || true
      continue
    fi
    # shellcheck disable=SC2034  # LOCK_HOLDER is read by the caller's message
    [[ "$ticks" -ge $((wait_s * 5)) ]] && { LOCK_HOLDER="$holder"; return 1; }
    sleep 0.2
    ticks=$((ticks + 1))
  done
  LOCK_PATH="$lock"
  trap 'lock_release "$LOCK_PATH"' EXIT
  return 0
}

lock_release() {
  local lock="$1"
  if [[ "$(readlink "$lock" 2>/dev/null || true)" == "$$" ]]; then rm -f "$lock"; fi
  return 0
}
