#!/usr/bin/env bash
# Paired test for session-key.sh: the boundary cases of the session-key rule.
# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/session-key.sh"
SETUP="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/setup-worktree.sh"

pass=0
fail=0
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }

# key <raw> → prints key, echoes "RC=<rc>" on failure
key() { bash "$SCRIPT" "$@" 2>/dev/null; }

expect_key() { # <raw> <expected> <label>
  local got
  got="$(key "$1")"
  [[ "$got" == "$2" ]] && ok "$3" || no "$3" "expected '$2', got '$got'"
}

expect_rc() { # <raw> <expected-rc> <label>
  local rc=0
  bash "$SCRIPT" "$1" >/dev/null 2>&1 || rc=$?
  [[ "$rc" -eq "$2" ]] && ok "$3" || no "$3" "expected rc $2, got $rc"
}

# ── Identity: a normal UUID session id must pass through unchanged ──
# Load-bearing: every worktree already on disk was created with a raw-UUID
# marker name, so if this were not identity the change would orphan them.
expect_key "b764f990-6c1c-4d79-905b-be05dca8524f" \
           "b764f990-6c1c-4d79-905b-be05dca8524f" "uuid is identity"

# ── Uppercase ──
got="$(key "ABC123")"
[[ "$got" == abc123-* || "$got" == "abc123" ]] && ok "uppercase lowercased" \
  || no "uppercase lowercased" "got '$got'"

# ── Underscore (the observed `cse_01HFo2Jk` shape) ──
# Lossy input, so the key carries a digest of the raw id — see the collision
# block below for why. Assert the readable prefix, not the exact digest.
got="$(key "cse_01HFo2Jk")"
[[ "$got" == cse-01hfo2jk-* ]] && ok "underscore becomes hyphen" \
  || no "underscore becomes hyphen" "got '$got'"

# ── Glob metacharacters — the reason the sanitizer is shared ──
got="$(key 'a*b')"
[[ "$got" == a-b-* || "$got" == "a-b" ]] && ok "asterisk neutralized" \
  || no "asterisk neutralized" "got '$got'"
got="$(key 'a?b')"
[[ "$got" == a-b-* || "$got" == "a-b" ]] && ok "question mark neutralized" \
  || no "question mark neutralized" "got '$got'"
got="$(key 'a[b]c')"
[[ "$got" == a-b-c-* || "$got" == "a-b-c" ]] && ok "brackets neutralized" \
  || no "brackets neutralized" "got '$got'"
for meta in '*' '?' '[' ']'; do
  got="$(key "sess${meta}id")"
  [[ "$got" != *"$meta"* ]] \
    && ok "output carries no '$meta'" \
    || no "output carries no '$meta'" "got '$got'"
done

# ── Repeated separators collapse ──
got="$(key "a__b")"
[[ "$got" == a-b-* || "$got" == "a-b" ]] && ok "repeated underscores collapse" \
  || no "repeated underscores collapse" "got '$got'"
got="$(key "a---b")"
[[ "$got" == a-b-* || "$got" == "a-b" ]] && ok "repeated hyphens collapse" \
  || no "repeated hyphens collapse" "got '$got'"
got="$(key "a_-_b")"
[[ "$got" == a-b-* || "$got" == "a-b" ]] && ok "mixed separators collapse" \
  || no "mixed separators collapse" "got '$got'"

# ── Leading / trailing separators stripped ──
got="$(key "_abc_")"
[[ "$got" == abc-* || "$got" == "abc" ]] && ok "leading+trailing underscores stripped" \
  || no "leading+trailing underscores stripped" "got '$got'"
got="$(key "--abc--")"
[[ "$got" == abc-* || "$got" == "abc" ]] && ok "leading+trailing hyphens stripped" \
  || no "leading+trailing hyphens stripped" "got '$got'"

# ── Over-length truncation ──
MAXLEN="$(bash "$SCRIPT" --max-key-len)"
long="$(printf 'a%.0s' $(seq 1 200))"
got="$(key "$long")"
[[ "${#got}" -eq "$MAXLEN" ]] \
  && ok "over-length truncated to $MAXLEN" \
  || no "over-length truncated" "got length ${#got}, want $MAXLEN"

# Truncation must never leave a trailing hyphen.
# Build an input whose char at MAXLEN+1 is the first of a hyphen run, so a
# naive truncate would end on `-`.
trailing_probe="$(printf 'a%.0s' $(seq 1 $((MAXLEN - 1))))_____tail"
got="$(key "$trailing_probe")"
[[ "$got" != *- ]] \
  && ok "truncation leaves no trailing hyphen" \
  || no "truncation leaves no trailing hyphen" "got '$got'"

# ── The composed name must satisfy the real slug gate, not a copy of it ──
# This is the assertion that matters: session-key.sh and setup-worktree.sh must
# agree, so validate against setup-worktree.sh's own --validate-slug.
for raw in "b764f990-6c1c-4d79-905b-be05dca8524f" "cse_01HFo2Jk" "ABC123" \
           'a*b[c]?d' "$long" "$trailing_probe" "___x___"; do
  k="$(key "$raw")"
  if bash "$SETUP" --validate-slug "session-$k" >/dev/null 2>&1; then
    ok "session-$k accepted by setup-worktree --validate-slug"
  else
    no "composed slug accepted" "session-$k rejected (from raw '$raw')"
  fi
done

# ── Distinct raw ids must never share a key ──────────────────────────────
# Sanitizing is many-to-one: `a_b`, `a__b`, and `a*b` all reduce to `a-b`. If the
# key stopped there, three live sessions would share one marker name and one
# worktree — the index-sharing this whole mechanism exists to end, reintroduced
# by its own key function.
# One "<key><TAB><raw>" line per id seen: bash 3.2 (macOS) has no associative arrays.
seen_keys=""
collision=""
for raw in "a_b" "a__b" "a*b" "a-b" "a?b" "a[b]" "A_B" "a_B" "a.b" "a/b"; do
  k="$(key "$raw")"
  prev="$(printf '%s' "$seen_keys" | awk -F'\t' -v k="$k" '$1 == k { print $2; exit }')"
  if [[ -n "$prev" ]]; then
    collision="'$raw' and '$prev' both map to '$k'"
    break
  fi
  seen_keys="$seen_keys$k"$'\t'"$raw"$'\n'
done
[[ -z "$collision" ]] && ok "distinct raw ids produce distinct keys" \
  || no "distinct raw ids produce distinct keys" "$collision"

# Over-length ids that share a prefix must also stay distinct.
longa="$(printf 'a%.0s' $(seq 1 80))x"
longb="$(printf 'a%.0s' $(seq 1 80))y"
[[ "$(key "$longa")" != "$(key "$longb")" ]] \
  && ok "over-length ids sharing a prefix stay distinct" \
  || no "over-length ids sharing a prefix stay distinct" "both '$(key "$longa")'"

# And the key stays a deterministic function of the id.
[[ "$(key "a_b")" == "$(key "a_b")" ]] && ok "key is deterministic" \
  || no "key is deterministic" "two calls differed"

# ── Empty and all-invalid input → exit 2 ──
expect_rc "" 2 "empty input exits 2"
expect_rc "___" 2 "all-separator input exits 2"
expect_rc "!!!" 2 "all-invalid input exits 2"
expect_rc "***" 2 "all-glob input exits 2"

# No-arg invocation (distinct from empty-string arg) must also refuse.
rc=0
bash "$SCRIPT" >/dev/null 2>&1 || rc=$?
[[ "$rc" -eq 2 ]] && ok "no-arg exits 2" || no "no-arg exits 2" "got rc $rc"

echo ""
echo "$pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
