#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# journal-file.test.sh — naming, collisions, the resume path with and without a
# session id, and --check. Run: bash journal-file.test.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$HERE/journal-file.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }

REPO="$TMP/repo"
git init -q "$REPO"
git -C "$REPO" config user.email t@example.com
git -C "$REPO" config user.name tester
echo seed >"$REPO/README.md"
git -C "$REPO" add README.md
git -C "$REPO" commit -q -m seed
REPO="$(cd "$REPO" && pwd)"

# run [env assignments...] -- <args>; always from inside the repo, with a
# fixed start time and no inherited session id.
run() {
  local envs=()
  while [[ $# -gt 0 && "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  OUT="$(cd "$REPO" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u JOURNAL_SESSION_ID -u CLAUDE_PROJECT_DIR \
    JOURNAL_STARTED="2026-01-12 20:15" ${envs[@]+"${envs[@]}"} bash "$SCRIPT" "$@" 2>&1)"; RC=$?
}
S1="JOURNAL_SESSION_ID=session-one"

# ── The name ───────────────────────────────────────────────────────────────
run "$S1" -- "The checkout retry fix"
is "path is <repo>/journal/<day>/<HHMM>-<stem>.md" "$OUT" "$REPO/journal/2026-01-12/2015-the-checkout-retry-fix.md"
is "exits 0" "$RC" "0"
if [[ -d "$REPO/journal/2026-01-12" ]]; then ok "the day folder is created"; else bad "no day folder"; fi
if [[ -f "$OUT" && ! -s "$OUT" ]]; then ok "the file is reserved: created, empty"; else bad "the file was not reserved"; fi

run "$S1" -- "  Mixed CASE, punctuation! and   spaces  "
is "the stem is kebabbed and trimmed" "$(basename "$OUT")" "2015-mixed-case-punctuation-and-spaces.md"

run "$S1" -- "$(printf 'a%.0s' $(seq 1 90))"
is "a long stem is cut to 60 characters" "$(basename "$OUT" .md | sed 's/^2015-//' | tr -d '\n' | wc -c | tr -d ' ')" "60"

run "$S1" -- "!!!"
is "a stem with nothing usable is refused" "$RC" "2"
has "…and says why" "$OUT" "no usable characters"

run "$S1" "JOURNAL_STARTED=yesterday" -- "x"
is "a malformed start time is refused" "$RC" "2"
has "…naming the format" "$OUT" "YYYY-MM-DD HH:MM"

run "$S1" "JOURNAL_STARTED=2026-01-13T09:05:00" -- "iso start"
is "an ISO start time works" "$(basename "$OUT")" "0905-iso-start.md"

# ── Collisions ─────────────────────────────────────────────────────────────
touch "$REPO/journal/2026-01-12/2015-same-stem.md"
run "$S1" -- "same stem"
is "a taken name moves to -2" "$OUT" "$REPO/journal/2026-01-12/2015-same-stem-2.md"
run "$S1" -- "same stem"
is "…then to -3 (the -2 reservation holds the name)" "$OUT" "$REPO/journal/2026-01-12/2015-same-stem-3.md"

mkdir -p "$REPO/journal/2026-01-12"
echo x >"$REPO/journal/2026-01-12/2015-gone.md"
git -C "$REPO" add journal/2026-01-12/2015-gone.md
git -C "$REPO" commit -q -m gone
rm "$REPO/journal/2026-01-12/2015-gone.md"
run "$S1" -- "gone"
is "a committed name deleted from disk is still taken" "$(basename "$OUT")" "2015-gone-2.md"

# ── --existing and --check, with a session id ──────────────────────────────
run "$S1" -- "resume me"
RESUME="$OUT"
run "$S1" -- --existing
is "--existing returns the reservation while it is still empty" "$OUT" "$RESUME"
run "$S1" -- --check
is "--check refuses the empty reservation" "$RC" "3"
run "JOURNAL_SESSION_ID=never-allocated" -- --existing
is "--existing exits 1 when nothing was reserved" "$RC" "1"
is "…and prints nothing" "$OUT" ""

cat >"$RESUME" <<'EOF'
---
date: 2026-01-12
time: "20:15"
title: resume-me
---

### one-off (resume me)
**Action:** fixed

Fixed it.
EOF
run "$S1" -- --existing
is "--existing prints the path once the file is there" "$OUT" "$RESUME"
run "$S1" -- --check
is "--check on a title/heading mismatch exits 3" "$RC" "3"
has "…with the checker's diagnosis" "$OUT" "J3"
sed 's/^title: resume-me$/title: one-off (resume me)/' "$RESUME" >"$RESUME.new" && mv "$RESUME.new" "$RESUME"
run "$S1" -- --check
is "--check passes once repaired" "$RC" "0"
is "…and prints the path" "$OUT" "$RESUME"

git -C "$REPO" add journal && git -C "$REPO" commit -q -m "close"
run "$S1" -- --existing
is "with a session id, a committed entry is still this session's" "$OUT" "$RESUME"

run "JOURNAL_SESSION_ID=session-two" -- --existing
is "another session id does not see it" "$RC" "1"

run "CLAUDE_CODE_SESSION_ID=session-one" -- --existing
is "the harness session id is the same key" "$OUT" "$RESUME"

# ── --existing without a session id ────────────────────────────────────────
run -- "no session"
NOSID="$OUT"
printf -- '---\ndate: 2026-01-12\ntitle: one-off (no session)\n---\n\n### one-off (no session)\n**Action:** fixed\n\nx\n' >"$NOSID"
run -- --existing
is "no session id: an uncommitted entry resumes" "$OUT" "$NOSID"
git -C "$REPO" add journal && git -C "$REPO" commit -q -m "close 2"
run -- --existing
is "no session id: a committed entry is not resumed" "$RC" "1"
echo "more" >>"$NOSID"
run -- --existing
is "no session id: a committed entry edited again resumes" "$OUT" "$NOSID"


# ── The race: same minute, same stem, many sessions at once ────────────────
RACE="$TMP/race"; mkdir -p "$RACE"
for i in 1 2 3 4 5 6 7 8; do
  ( cd "$REPO" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID JOURNAL_SESSION_ID="race-$i" \
      JOURNAL_STARTED="2026-01-14 10:00" bash "$SCRIPT" "same minute" >"$RACE/$i" 2>&1 ) &
done
wait
is "eight racing closes get eight distinct paths" "$(cat "$RACE"/* | LC_ALL=C sort -u | grep -c .)" "8"
is "…and eight reserved files" "$(find "$REPO/journal/2026-01-14" -name '1000-same-minute*.md' | grep -c .)" "8"

# ── Usage and repo errors ──────────────────────────────────────────────────
run "$S1" -- --check extra
is "extra arguments are usage" "$RC" "2"
OUT2="$(cd "$TMP" && env -u CLAUDE_PROJECT_DIR bash "$SCRIPT" "x" 2>&1)"; RC2=$?
is "outside a git repo it exits 2" "$RC2" "2"
has "…and says why" "$OUT2" "not inside a git repo"
OUT3="$(cd "$TMP" && CLAUDE_PROJECT_DIR="$REPO" JOURNAL_STARTED="2026-01-12 20:15" bash "$SCRIPT" "from outside" 2>&1)"
is "CLAUDE_PROJECT_DIR names the repo from anywhere" "$OUT3" "$REPO/journal/2026-01-12/2015-from-outside.md"

echo
echo "journal-file.test.sh: $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
