#!/usr/bin/env bash
# relocate-evidence.test.sh — tests for relocate-evidence.sh.
# Uses a throwaway CLAUDE_PROJECT_DIR so no real journal is touched.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SUT="$SCRIPT_DIR/relocate-evidence.sh"
CHECKER="$SCRIPT_DIR/../../close/scripts/check-journal-entry.sh"
pass=0
fail=0
check() { if [[ "$2" == "$3" ]]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL: $1 — want [$3] got [$2]"; fi; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export CLAUDE_PROJECT_DIR="$WORK"
F="$WORK/journal/2026-05-16/0000-deploy-is-part-of-implementing-evidence.md"

# ── 1: writes the evidence file into the day folder ─────────────────────────
mkdir -p "$WORK/journal/2026-05-16"
echo "a session file" > "$WORK/journal/2026-05-16/0930-other-session.md"
echo "the deploy is already automatic because the post-commit hook redeploys." \
  | bash "$SUT" deploy-is-part-of-implementing 2026-05-16 - >/dev/null 2>&1
if [[ -f "$F" ]]; then created=0; else created=1; fi
check "evidence file created in the day folder" "$created" "0"
grep -qE '^date: 2026-05-16$' "$F"; check "front matter date" "$?" "0"
check "title equals the heading" \
  "$(sed -n 's/^title: //p' "$F")" "$(sed -n 's/^### //p' "$F")"
grep -qF "post-commit hook redeploys" "$F"; check "evidence body present" "$?" "0"
check "another session's file untouched" "$(cat "$WORK/journal/2026-05-16/0930-other-session.md")" "a session file"

# ── 2: the close's journal check accepts it ─────────────────────────────────
if [[ -f "$CHECKER" ]]; then
  bash "$CHECKER" "$F" >/dev/null 2>"$WORK/check.err"
  rc=$?
  check "check-journal-entry.sh accepts it: $(cat "$WORK/check.err")" "$rc" "0"
fi

# ── 3: idempotency — second run leaves the file as it was ───────────────────
before="$(cat "$F")"
echo "different text" | bash "$SUT" deploy-is-part-of-implementing 2026-05-16 - >/dev/null 2>&1
check "idempotent — the second run exits 0" "$?" "0"
check "idempotent — file unchanged" "$(cat "$F")" "$before"

# ── 4: a day with no folder yet ─────────────────────────────────────────────
printf '\n\nold failure story.\n\n' | bash "$SUT" some-old-rule 2026-02-08 - >/dev/null 2>&1
check "a new day's run exits 0" "$?" "0"
grep -qF "old failure story." "$WORK/journal/2026-02-08/0000-some-old-rule-evidence.md"
check "day folder created" "$?" "0"
check "blank lines around the evidence are trimmed" \
  "$(tail -n 1 "$WORK/journal/2026-02-08/0000-some-old-rule-evidence.md")" "> old failure story."

# ── 4b: evidence that looks like entry schema is quoted, not parsed ─────────
H="$WORK/journal/2026-03-01/0000-hostile-rule-evidence.md"
printf 'date: 2026-01-01\n**Decisions:**\nnot a link\n**Next:**\n- later\n' \
  | bash "$SUT" hostile-rule 2026-03-01 - >/dev/null 2>"$WORK/hostile.err"
check "schema-shaped evidence is written: $(cat "$WORK/hostile.err")" "$?" "0"
if [[ -f "$CHECKER" ]]; then
  bash "$CHECKER" "$H" >/dev/null 2>"$WORK/check.err"
  rc=$?
  check "…and the journal check accepts it: $(cat "$WORK/check.err")" "$rc" "0"
fi
check "…with the evidence quoted line by line" "$(grep -c '^> ' "$H")" "5"

# ── 4c: a written entry the journal check refuses is not reported as success
FAKE="$WORK/layer/skills"
mkdir -p "$FAKE/author/scripts" "$FAKE/close/scripts"
cp "$SUT" "$FAKE/author/scripts/"
printf '#!/usr/bin/env bash\necho "J9 — refused for the test" >&2\nexit 1\n' >"$FAKE/close/scripts/check-journal-entry.sh"
echo "some story" | bash "$FAKE/author/scripts/relocate-evidence.sh" refused-rule 2026-04-01 - >/dev/null 2>"$WORK/refused.err"
check "a refused entry exits 1" "$?" "1"
check "…says why" "$(grep -c 'J9 — refused for the test' "$WORK/refused.err")" "1"
if [[ -e "$WORK/journal/2026-04-01/0000-refused-rule-evidence.md" ]]; then gone=1; else gone=0; fi
check "…and leaves no half-written entry behind" "$gone" "0"

# ── 5-7: boundaries ─────────────────────────────────────────────────────────
printf '' | bash "$SUT" empty-rule 2026-05-16 - >/dev/null 2>&1
check "empty evidence → exit 1" "$?" "1"
echo "x" | bash "$SUT" r 2026-5-1 - >/dev/null 2>&1
check "bad date → exit 1" "$?" "1"
bash "$SUT" only-one-arg >/dev/null 2>&1
check "missing args → exit 2" "$?" "2"

echo "── relocate-evidence: $pass passed, $fail failed ──"
[[ $fail -eq 0 ]]
