#!/usr/bin/env bash
# spec-audit.test.sh — peer of spec-audit.sh: what the reviewer is handed.
# The vendor is a stub that records its prompt, so no live chain is called.
set -uo pipefail
SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/spec-audit.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else
    fail=$((fail+1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}
tmp="$(mktemp -d "${TMPDIR:-/tmp}/spec-audit-test.XXXXXX")"; trap 'rm -rf "$tmp"' EXIT
printf '#!/usr/bin/env bash\ncat >"%s/prompt.txt"\necho NO_FINDINGS\n' "$tmp" >"$tmp/vendor"
printf '#!/usr/bin/env bash\necho stub-model\n' >"$tmp/resolver"
chmod +x "$tmp/vendor" "$tmp/resolver"
audit() {
  rm -f "$tmp/prompt.txt"
  CODEX_BIN="$tmp/vendor" GROK_BIN="$tmp/vendor" POLICY_CHAIN_RESOLVER="$tmp/resolver" \
    bash "$SUT" "$1" "brief" >/dev/null 2>&1
}

# A spec folder: every design file, each under its own header, in a fixed order
mkdir -p "$tmp/specs/001-a"
echo 'SPEC BODY' >"$tmp/specs/001-a/spec.md"
echo 'PLAN BODY' >"$tmp/specs/001-a/plan.md"
echo 'TASKS BODY' >"$tmp/specs/001-a/tasks.md"
echo 'RESEARCH BODY' >"$tmp/specs/001-a/research.md"
echo 'REPORT BODY' >"$tmp/specs/001-a/report.md"
audit "$tmp/specs/001-a"
t "a folder audits cleanly" "0" "$?"
t "the folder's four files, headed, in order" "=== spec.md ===
SPEC BODY
=== plan.md ===
PLAN BODY
=== tasks.md ===
TASKS BODY
=== research.md ===
RESEARCH BODY" "$(grep -E '^(=== |[A-Z]+ BODY)' "$tmp/prompt.txt")"
t "report.md is not design, and is not sent" "" "$(grep 'REPORT BODY' "$tmp/prompt.txt")"

# data-model.md and contracts/ ride along when the plan produced them
echo 'MODEL BODY' >"$tmp/specs/001-a/data-model.md"
mkdir -p "$tmp/specs/001-a/contracts"; echo 'API BODY' >"$tmp/specs/001-a/contracts/api.yaml"
audit "$tmp/specs/001-a"
t "data-model and contracts are sent after research" "=== research.md ===
=== data-model.md ===
=== contracts/api.yaml ===" "$(grep '^=== ' "$tmp/prompt.txt" | tail -n 3)"
rm -r "$tmp/specs/001-a/data-model.md" "$tmp/specs/001-a/contracts"

# A folder missing tasks and research sends what it has
rm "$tmp/specs/001-a/tasks.md" "$tmp/specs/001-a/research.md"
audit "$tmp/specs/001-a"
t "a partial folder sends what it has" "=== spec.md ===
=== plan.md ===" "$(grep '^=== ' "$tmp/prompt.txt")"

# No spec.md, or no plan.md, is a caller error — nothing is sent
mkdir -p "$tmp/norspec"; echo 'R' >"$tmp/norspec/research.md"; echo 'P' >"$tmp/norspec/plan.md"
audit "$tmp/norspec"
t "a folder without spec.md exits 2" "2" "$?"
t "a folder without spec.md is never sent" "no" "$([[ -f "$tmp/prompt.txt" ]] && echo yes || echo no)"
mkdir -p "$tmp/noplan"; echo 'S' >"$tmp/noplan/spec.md"
audit "$tmp/noplan"
t "a folder without plan.md exits 2" "2" "$?"

# An empty folder is a caller error
mkdir -p "$tmp/empty"
audit "$tmp/empty"
t "an empty folder exits 2" "2" "$?"

# A single file still works, with no headers
echo 'LEGACY BODY' >"$tmp/x.spec.md"
audit "$tmp/x.spec.md"
t "a file audits cleanly" "0" "$?"
t "a file is sent whole, unheaded" "LEGACY BODY|" "$(grep -c '^=== ' "$tmp/prompt.txt" | sed 's/^0$//')$(grep -o 'LEGACY BODY' "$tmp/prompt.txt")|"

# Contextium: with no reviewer vendor installed, the shipped row falls back —
# exit 3, naming the fresh-context review and the NOT-independent line.
mkdir -p "$tmp/specs/009-fb"; echo 'S' >"$tmp/specs/009-fb/spec.md"; echo 'P' >"$tmp/specs/009-fb/plan.md"
rc=0; err="$(CODEX_BIN="$tmp/none" GROK_BIN="$tmp/none" bash "$SUT" "$tmp/specs/009-fb" brief 2>&1 >/dev/null)" || rc=$?
t "no vendor installed: exit 3" "3" "$rc"
t "…names the line to record" "yes" "$(grep -qF 'claude-fallback (fresh context, NOT independent)' <<<"$err" && echo yes)"

echo "spec-audit.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
