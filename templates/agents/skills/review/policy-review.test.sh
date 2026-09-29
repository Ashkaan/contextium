#!/usr/bin/env bash
# Boundary rows for policy-review.sh: missing args, unknown task-kind, missing files, claude-slot exit, vendor resolution order.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy-review.sh"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/policy-review-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [[ "$expected_rc" == "$actual_rc" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — expected rc=$expected_rc, got rc=$actual_rc" >&2
  fi
}

ARTIFACT="$TMP/artifact.md"
BRIEF="$TMP/brief.md"
echo "some artifact content" >"$ARTIFACT"
echo "attack this artifact" >"$BRIEF"

# A stand-in policy so tests never depend on the live one drifting.
POLICY="$TMP/policy.json"
cat >"$POLICY" <<'EOF'
{
  "rows": {
    "adversarial-review": {
      "mode": "single",
      "chain": [{ "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }, { "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }]
    },
    "judgment": {
      "mode": "single",
      "chain": [{ "vendor": "grok", "model": "grok", "tracks": "grok-{v}" }, { "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "claude-only": {
      "mode": "single",
      "chain": [{ "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }]
    },
    "bogus-vendor": {
      "mode": "single",
      "chain": [{ "vendor": "nosuchvendor", "model": "x", "tracks": "x" }]
    },
    "panel": {
      "mode": "panel",
      "voices": [{ "vendor": "claude", "model": "opus", "tracks": "opus[1m]" }, { "vendor": "codex", "model": "codex", "tracks": "gpt-{v}-sol" }]
    }
  }
}
EOF
export POLICY_JSON="$POLICY"

# Model resolution reads a vendor's live catalog; these cases stub the vendor,
# so they stub the resolver too (POLICY_CHAIN_RESOLVER, policy-chain.sh). It
# resolves the fixture families the way a real catalog would and
# fails a family named `unresolvable-{v}`.
cat >"$TMP/resolve-model.sh" <<'RESOLVER'
#!/usr/bin/env bash
case "$2" in
  "gpt-{v}-sol") echo gpt-6-sol ;;
  "grok-{v}") echo grok-4.7 ;;
  unresolvable-*) echo "no $2 in the $1 catalog" >&2; exit 1 ;;
  *) echo "$2" ;;
esac
RESOLVER
chmod +x "$TMP/resolve-model.sh"
export POLICY_CHAIN_RESOLVER="$TMP/resolve-model.sh"

# --- argument validation ---
"$SCRIPT" >/dev/null 2>&1
check "no args rejected" 2 $?

"$SCRIPT" adversarial-review >/dev/null 2>&1
check "missing artifact and brief rejected" 2 $?

"$SCRIPT" adversarial-review "$ARTIFACT" >/dev/null 2>&1
check "missing brief rejected" 2 $?

"$SCRIPT" adversarial-review "$TMP/nope.md" "$BRIEF" >/dev/null 2>&1
check "missing artifact file rejected" 2 $?

"$SCRIPT" adversarial-review "$ARTIFACT" "$TMP/nope.md" >/dev/null 2>&1
check "missing brief file rejected" 2 $?

# --- unknown task-kind is an error, never a silent default ---
out=$("$SCRIPT" no-such-kind "$ARTIFACT" "$BRIEF" 2>&1); rc=$?
check "unknown task-kind rejected" 2 $rc
grep -q "known rows" <<<"$out" || { fail=$((fail + 1)); echo "FAIL: error does not list known rows" >&2; }

# --- a chain whose only slot is claude exits 3 (caller uses its agent) ---
"$SCRIPT" claude-only "$ARTIFACT" "$BRIEF" >/dev/null 2>&1
check "claude-only chain signals agent-dispatch" 3 $?

# --- an unsupported vendor exhausts the chain rather than crashing ---
"$SCRIPT" bogus-vendor "$ARTIFACT" "$BRIEF" >/dev/null 2>&1
check "unsupported vendor exhausts cleanly" 1 $?

# --- policy file must exist ---
POLICY_JSON="$TMP/absent.json" "$SCRIPT" adversarial-review "$ARTIFACT" "$BRIEF" >/dev/null 2>&1
check "missing policy file rejected" 2 $?

# --- panel rows expose voices, not chain — the reader must handle both ---
out=$(POLICY_JSON="$POLICY" bash -c '
  jq -r --arg k panel "(.rows[\$k].chain // .rows[\$k].voices // []) | length" "$0"
' "$POLICY" 2>/dev/null)
if [[ "$out" == "2" ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1)); echo "FAIL: panel voices not readable — got '$out'" >&2
fi

# --- the SHIPPED policy must carry the rows the reviewers depend on ---
# It is the table beside this script; LIVE_POLICY_JSON points at another copy.
REPO_POLICY="${LIVE_POLICY_JSON:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/policy.json}"
if [[ -f "$REPO_POLICY" ]]; then
  for kind in adversarial-review judgment; do
    if jq -e --arg k "$kind" '.rows[$k]' "$REPO_POLICY" >/dev/null 2>&1; then
      pass=$((pass + 1))
    else
      fail=$((fail + 1)); echo "FAIL: live policy has no '$kind' row — reviewers would break" >&2
    fi
  done
else
  echo "note: live policy not found at $REPO_POLICY, skipping live-row check" >&2
fi

echo "policy-review: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
