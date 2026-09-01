#!/usr/bin/env bash
# relocate-evidence.test.sh — tests for relocate-evidence.sh.
# Run from a COPY outside .claude/ per @rule:claude-scripts-tested-outside-claude:
#   cp .agents/skills/author/scripts/relocate-evidence*.sh /tmp/re/ && cd /tmp/re && bash relocate-evidence.test.sh
# Uses a throwaway CLAUDE_PROJECT_DIR so no real journal is touched.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/relocate-evidence.sh"
pass=0
fail=0
check() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 — want [$3] got [$2]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export CLAUDE_PROJECT_DIR="$WORK"
mkdir -p "$WORK/journal"

# ── 1: append to an existing journal ────────────────────────────────────────
echo -e "---\ndate: 2026-05-16\ntags: [x]\n---\n\n# 2026-05-16\n\nexisting body." \
  > "$WORK/journal/2026-05-16.md"
echo "the deploy is already automatic because the post-commit hook redeploys." \
  | bash "$SUT" deploy-is-part-of-implementing 2026-05-16 - >/dev/null 2>&1
grep -qF "### deploy-is-part-of-implementing — evidence (relocated from rule)" \
  "$WORK/journal/2026-05-16.md"; check "append heading present" "$?" "0"
grep -qF "post-commit hook redeploys" "$WORK/journal/2026-05-16.md"
check "append body present" "$?" "0"
check "existing body preserved" \
  "$(grep -c 'existing body.' "$WORK/journal/2026-05-16.md")" "1"

# ── 2: idempotency — second run does not duplicate ──────────────────────────
echo "the deploy is already automatic because the post-commit hook redeploys." \
  | bash "$SUT" deploy-is-part-of-implementing 2026-05-16 - >/dev/null 2>&1
check "idempotent — one heading only" \
  "$(grep -cF '### deploy-is-part-of-implementing — evidence' "$WORK/journal/2026-05-16.md")" "1"

# ── 3: back-dated stub when journal absent ──────────────────────────────────
echo "old failure story." | bash "$SUT" some-old-rule 2026-02-08 - >/dev/null 2>&1
[[ -f "$WORK/journal/2026-02-08.md" ]]; check "stub created" "$?" "0"
grep -qE '^date: 2026-02-08' "$WORK/journal/2026-02-08.md"
check "stub has frontmatter date" "$?" "0"
grep -qF "old failure story." "$WORK/journal/2026-02-08.md"
check "stub carries evidence" "$?" "0"

# ── 4: boundary — empty evidence rejected ───────────────────────────────────
set +e
printf '' | bash "$SUT" empty-rule 2026-05-16 - >/dev/null 2>&1
check "empty evidence → exit 1" "$?" "1"
# ── 5: boundary — bad date rejected ─────────────────────────────────────────
echo "x" | bash "$SUT" r 2026-5-1 - >/dev/null 2>&1
check "bad date → exit 1" "$?" "1"
# ── 6: boundary — missing args → usage exit 2 ───────────────────────────────
bash "$SUT" only-one-arg >/dev/null 2>&1
check "missing args → exit 2" "$?" "2"
set -e

echo "── relocate-evidence: $pass passed, $fail failed ──"
[[ $fail -eq 0 ]]
