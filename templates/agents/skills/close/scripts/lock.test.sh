#!/usr/bin/env bash
# lock.test.sh — peer of lock.sh: mutual exclusion under contention, a timeout
# that leaves a live holder alone, a dead holder's lock taken over, and a
# release that only ever removes the caller's own lock. Run: bash lock.test.sh
set -uo pipefail

LIB="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lock.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
is() { if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$3]"; echo "  actual:   [$2]"; fi; }

# A worker: take the lock, read-modify-write a counter slowly, release.
worker() {
  bash -c '
    source "$1"
    lock_take "$2" 30 || exit 1
    n=$(cat "$3"); sleep 0.05; echo $((n + 1)) >"$3"
  ' _ "$LIB" "$TMP/lock" "$TMP/counter"
}
echo 0 >"$TMP/counter"
for _ in $(seq 1 15); do worker & done; wait
is "15 contending writers lose no increment" "$(cat "$TMP/counter")" "15"
is "the lock is released after the last one" "$([[ -L "$TMP/lock" ]] && echo held || echo free)" "free"

# A live holder: the wait times out, returns 1, and the lock is left alone.
sleep 30 & live=$!
ln -s "$live" "$TMP/lock"
rc=0; bash -c 'source "$1"; lock_take "$2" 1' _ "$LIB" "$TMP/lock" || rc=$?
is "a live holder times the waiter out" "$rc" "1"
is "…and keeps its lock" "$(readlink "$TMP/lock")" "$live"
kill "$live" 2>/dev/null; wait "$live" 2>/dev/null

# The holder is now dead: the next taker takes over.
rc=0; out="$(bash -c 'source "$1"; lock_take "$2" 5 && readlink "$2"' _ "$LIB" "$TMP/lock")" || rc=$?
is "a dead holder's lock is taken over" "$rc" "0"
case "$out" in "$live"|"") is "…by the taker" "$out" "a new pid" ;; *) is "…by the taker" ok ok ;; esac
is "…and no takeover guard is left" "$([[ -d "$TMP/lock.takeover" ]] && echo left || echo gone)" "gone"

# release removes only the caller's own lock.
sleep 30 & other=$!
rm -f "$TMP/lock"; ln -s "$other" "$TMP/lock"
bash -c 'source "$1"; lock_release "$2"' _ "$LIB" "$TMP/lock"
is "release never removes another holder's lock" "$(readlink "$TMP/lock")" "$other"
kill "$other" 2>/dev/null; wait "$other" 2>/dev/null

echo "lock.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
