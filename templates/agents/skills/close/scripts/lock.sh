#!/usr/bin/env bash
# lock.sh — a portable exclusive lock for the close scripts, sourced, not run.
# Used where flock(1) may be missing (stock macOS): the per-repo git lock
# write-root.sh and land.ts share (land.ts takes it through a bash child that
# sources this file and holds it). roadmap.ts's per-project lock is this same
# symlink protocol, ported to TypeScript beside it.
#
#   source lock.sh
#   lock_take <lock-path> <wait-seconds> || <timed out>   # sets an EXIT trap
#   lock_release <lock-path>                               # optional; the trap does it
#   lock_repo <lock-file> <wait-seconds> || <timed out>   # the per-repo git lock
#   lock_repo_release <lock-file>
#
# lock_repo is flock(1) on fd 9 where flock exists — so it excludes every other
# writer that flocks the same file — and lock_take on `<lock-file>.lnk` where
# it does not.
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
#   .agents/skills/close/scripts/lock.test.ts
#   .agents/skills/close/scripts/land.ts      (holds lock_repo through a bash child)
#   .agents/skills/close/scripts/roadmap.ts   (lock_take's protocol, in TypeScript)
#   .agents/skills/close/scripts/write-root.sh

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

lock_repo() {
  if command -v flock >/dev/null 2>&1 && [[ -z "${LOCK_NO_FLOCK:-}" ]]; then
    exec 9>"$1"
    flock -w "$2" 9
  else
    lock_take "$1.lnk" "$2"
  fi
}

lock_repo_release() {
  if command -v flock >/dev/null 2>&1 && [[ -z "${LOCK_NO_FLOCK:-}" ]]; then
    flock -u 9 2>/dev/null || true
    exec 9>&-
  else
    lock_release "$1.lnk"
  fi
}

lock_release() {
  local lock="$1"
  if [[ "$(readlink "$lock" 2>/dev/null || true)" == "$$" ]]; then rm -f "$lock"; fi
  return 0
}
