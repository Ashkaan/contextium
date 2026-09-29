#!/usr/bin/env bash
# journal-file.test.sh — naming, collisions on both sides, and the resume path.
#
# Run: bash .agents/.agents/skills/close/scripts/journal-file.test.sh
#
# A fixture CODE repo with a bare origin stands in for workbench: it carries a
# copy of these scripts under `.agents/.agents/skills/close/scripts/`, exactly where the real
# ones live, so the script under test finds its own repo the way the real one
# does — `git rev-parse --show-toplevel` from its own directory — and the
# journal lands in the thread's worktree of THAT repo.

set -uo pipefail
# Local time is the journal's clock; the fixtures' times are written for this zone.
export TZ=America/Los_Angeles

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"

cleanup() {
  git -C "${TMP}/jf-$$-code" worktree prune 2>/dev/null
  git -C "${TMP}/jf-$$-prod" worktree prune 2>/dev/null
  rm -rf "${TMP}"
  rm -f "/tmp/jf-$$-"*-git.lock
}
trap cleanup EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }

FAKE_HOME="${TMP}/home"
T3="${TMP}/t3"
mkdir -p "${FAKE_HOME}" "${T3}/userdata"

TID=11111111-aaaa-bbbb-cccc-222222222222
LEDGER_DIR="${FAKE_HOME}/.cache/workbench/threads/${TID}"

# The code repo and its origin, holding these scripts at their real path. `jf-$$`
# keeps the /tmp lock write-root takes from colliding with a concurrent run of
# this suite.
CODEBARE="${TMP}/code.git"
CODE="${TMP}/jf-$$-code"
git init -q --bare -b main "${CODEBARE}"
git init -q -b main "${CODE}"
git -C "${CODE}" config user.email t@example.com
git -C "${CODE}" config user.name tester
mkdir -p "${CODE}/.agents/skills/close/scripts" "${CODE}/journal"
cp "${HERE}"/*.sh "${CODE}/.agents/skills/close/scripts/"
echo "# Workbench" >"${CODE}/README.md"
git -C "${CODE}" add README.md .agents
git -C "${CODE}" commit -q -m seed
git -C "${CODE}" remote add origin "${CODEBARE}"
git -C "${CODE}" push -q -u origin main

# The thread's own T3 worktree, of the code repo — the shape a workbench
# thread has, and the one the journal lands in.
T3_WT="${TMP}/t3wt"
git -C "${CODE}" worktree add -q -b t3code/a-title "${T3_WT}" main

# A second thread whose T3 worktree is of some OTHER repo — a product repo —
# so the code repo is a satellite for it, the shape the resume case needs.
TID2=22222222-aaaa-bbbb-cccc-333333333333
LEDGER_DIR2="${FAKE_HOME}/.cache/workbench/threads/${TID2}"
PRODBARE="${TMP}/prod.git"
PROD="${TMP}/jf-$$-prod"
git init -q --bare -b main "${PRODBARE}"
git init -q -b main "${PROD}"
git -C "${PROD}" config user.email t@example.com
git -C "${PROD}" config user.name tester
echo x >"${PROD}/f"
git -C "${PROD}" add f
git -C "${PROD}" commit -q -m seed
git -C "${PROD}" remote add origin "${PRODBARE}"
git -C "${PROD}" push -q -u origin main
T3_WT2="${TMP}/t3wt2"
git -C "${PROD}" worktree add -q -b t3code/b-title "${T3_WT2}" main

node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, tid, wt, tid2, wt2] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)`);
const ins = db.prepare("insert into projection_threads values (?,?,?,?,?,?,?,?)");
ins.run(tid, "p", "T", "t3code/a-title", wt, "2026-09-14T03:15:51.803Z", "x", null);
ins.run(tid2, "p", "U", "t3code/b-title", wt2, "2026-09-14T03:15:51.803Z", "x", null);
' "${T3}/userdata/state.sqlite" "${TID}" "${T3_WT}" "${TID2}" "${T3_WT2}"

# The script under test is the thread's OWN copy, as a session in a workbench
# worktree runs it.
SCRIPT="${T3_WT}/.agents/skills/close/scripts/journal-file.sh"

E=("HOME=${FAKE_HOME}" "T3CODE_HOME=${T3}")
run() { OUT="$(cd "${T3_WT}" && env ${E[@]+"${E[@]}"} bash "${SCRIPT}" "$@" 2>&1)"; RC=$?; }

# ── The name ───────────────────────────────────────────────────────────────
#
# The session started 03:15 UTC on the 14th, which is 20:15 on the 13th in Los
# Angeles — so it files under the 13th, the day the work happened.

run "The close that works in T3"
is "the path is <this repo's worktree>/journal/<start date>/<HHMM>-<slug>.md" "${OUT}" \
  "${T3_WT}/journal/2026-09-13/2015-the-close-that-works-in-t3.md"
is "exits 0" "${RC}" "0"

if [ -d "${T3_WT}/journal/2026-09-13" ]; then
  ok "the day folder is created"; else bad "no day folder"; fi
if [ -e "${OUT}" ]; then bad "the file itself was created"
  else ok "the file itself is not created"; fi

is "the chosen path is persisted for land.sh" "$(cat "${LEDGER_DIR}/journal")" "${OUT}"

run "  Mixed CASE, punctuation! and   spaces  "
is "the slug is kebabbed and trimmed" "$(basename "${OUT}")" \
  "2015-mixed-case-punctuation-and-spaces.md"

run "$(printf 'a%.0s' $(seq 1 90))"
is "a long slug is cut to 60 characters" \
  "$(basename "${OUT}" .md | sed 's/^2015-//' | wc -c)" "61"

run "!!!"
is "a slug with nothing usable in it is refused" "${RC}" "2"
has "and says why" "${OUT}" "no usable characters"

# ── A name taken in this worktree ──────────────────────────────────────────

FIRST="${T3_WT}/journal/2026-09-13/2015-same-slug.md"
touch "${FIRST}"
run "same slug"
is "a name taken locally moves to -2" "${OUT}" \
  "${T3_WT}/journal/2026-09-13/2015-same-slug-2.md"
touch "${OUT}"
run "same slug"
is "…then to -3" "${OUT}" "${T3_WT}/journal/2026-09-13/2015-same-slug-3.md"

# ── A name taken on origin/main by a thread that landed first ──────────────
#
# The other thread wrote it in ITS worktree, so nothing here can see it except
# by looking at the remote.

OTHER="${TMP}/other-thread"
git clone -q "${CODEBARE}" "${OTHER}"
git -C "${OTHER}" config user.email t@example.com
git -C "${OTHER}" config user.name tester
mkdir -p "${OTHER}/journal/2026-09-13"
echo "another session" >"${OTHER}/journal/2026-09-13/2015-remote-slug.md"
git -C "${OTHER}" add journal
git -C "${OTHER}" commit -q -m "another thread's close"
git -C "${OTHER}" push -q origin main

if [ -e "${T3_WT}/journal/2026-09-13/2015-remote-slug.md" ]; then
  bad "fixture error: the name is visible locally"
  else ok "the other thread's name is invisible in this worktree"; fi

run "remote slug"
is "a name taken only on origin/main still moves to -2" "${OUT}" \
  "${T3_WT}/journal/2026-09-13/2015-remote-slug-2.md"

# ── --existing: the resume path ────────────────────────────────────────────

run "resume me"
RESUME="${OUT}"
run --existing
is "--existing exits 1 while the file is unwritten" "${RC}" "1"
is "…and prints nothing" "${OUT}" ""

echo "written" >"${RESUME}"
run --existing
is "--existing prints the path once the file is there" "${OUT}" "${RESUME}"
is "…and exits 0" "${RC}" "0"

# A second close must resume on that file, not allocate a second one.
run "resume me"
is "re-running with the same slug does not reuse a written name" "${OUT}" \
  "${T3_WT}/journal/2026-09-13/2015-resume-me-2.md"

# ── No thread ──────────────────────────────────────────────────────────────

# A failed Land must reuse its entry, expose the validation error before any
# repo is pushed, and accept a repair without allocating another filename.
run --check
is "--check exits 1 while the allocated journal is unwritten" "${RC}" "1"
is "an unwritten journal check prints nothing" "${OUT}" ""

CHECK_PATH="$(cat "${LEDGER_DIR}/journal")"
cat >"${CHECK_PATH}" <<'EOF'
---
date: 2026-09-13
time: "20:15"
slug: security-policy-ai
tags: []
---

### one-off (security policy and client data in AI)
**Action:** completed

Policy drafted.
EOF
run --check
is "the real filename-stem/title mismatch exits 3" "${RC}" "3"
has "the check exposes the existing validator's diagnosis" "${OUT}" "front matter says slug"
is "a failed check preserves the allocated path" "$(cat "${LEDGER_DIR}/journal")" "${CHECK_PATH}"
is "a failed check leaves the journal intact" "$(sed -n '4p' "${CHECK_PATH}")" "slug: security-policy-ai"

sed -i 's/^slug: security-policy-ai$/slug: one-off (security policy and client data in AI)/' "${CHECK_PATH}"
run --check
is "repairing the title makes the same journal pass" "${RC}" "0"
is "a successful check prints the existing path" "${OUT}" "${CHECK_PATH}"
run --existing
is "resume still uses the repaired journal" "${OUT}" "${CHECK_PATH}"

# ── --existing after the close removed the worktree ────────────────────────
#
# `land.sh` merges the entry to the trunk and then REMOVES this thread's
# worktree of this repo — when that worktree is a satellite, which it is for
# a thread T3 opened on a product repo. Work continues in the same session, so
# the next close has to resume on the entry it already landed — but the
# recorded path is off disk until write-root re-adds the worktree at the same
# deterministic path, and the entry itself is safe on the trunk. Testing the
# path before that recreation reports the entry missing, and the allocator
# then files a second entry beside the landed one.
#
# Thread two is that shape: its T3 worktree is of the PROD repo, and the script
# runs out of the shared code checkout — the path the `~/.agents/skills` link
# resolves to — so the code repo is a satellite it creates on first write.

run2() { OUT="$(cd "${T3_WT2}" && env ${E[@]+"${E[@]}"} bash "${CODE}/.agents/skills/close/scripts/journal-file.sh" "$@" 2>&1)"; RC=$?; }

run2 "landed then removed"
LANDED="${OUT}"
is "a thread on another repo files its journal in a satellite of this one" "${RC}" "0"
# Everything below writes to ${LANDED}. When the allocation failed, ${OUT} is
# the error text, and writing to it as a filename would plant a file named
# `write-root: not a repo I know: …` in this scripts folder. A failed
# allocation ends the suite here instead.
if [[ "${RC}" -ne 0 || "${LANDED}" != /* ]]; then
  echo "journal-file.test.sh: allocation failed, cannot continue: ${LANDED}" >&2
  echo "journal-file.test.sh: ${PASS} passed, $((FAIL + 1)) failed"
  exit 1
fi
CODESAT="${LANDED%%/journal/*}"
has "…under the thread's cache, not under its own T3 worktree" "${CODESAT}" \
  "/.cache/workbench/worktrees/jf-$$-code-"
cat >"${LANDED}" <<'ENTRY'
---
date: 2026-09-13
time: "20:15"
slug: landed-then-removed
tags: []
---

### landed-then-removed
**Action:** completed

The entry this session landed.
ENTRY
git -C "${CODESAT}" add -A
git -C "${CODESAT}" -c user.email=t@example.com -c user.name=tester commit -q -m "close: land the entry"
# The other thread above landed first, so this branch merges the trunk before
# pushing — exactly what land.sh does, and without it the entry never reaches
# origin/main and this test would be red for the wrong reason.
git -C "${CODESAT}" fetch -q origin main
git -C "${CODESAT}" -c user.email=t@example.com -c user.name=tester merge -q --no-edit FETCH_HEAD
git -C "${CODESAT}" push -q origin HEAD:main
LANDED_BRANCH="$(git -C "${CODESAT}" rev-parse --abbrev-ref HEAD)"
git -C "${CODE}" worktree remove --force "${CODESAT}"
git -C "${CODE}" branch -q -D "${LANDED_BRANCH}"

if [ -e "${LANDED}" ]; then bad "fixture error: the recorded path survived the removal"
  else ok "the close removed the worktree, taking the recorded path with it"; fi

run2 --existing
is "--existing recovers the landed entry after the worktree is gone" "${OUT}" "${LANDED}"
is "…and exits 0" "${RC}" "0"
is "…and the entry is really back at that path" "$(sed -n '11p' "${LANDED}" 2>/dev/null)" \
  "The entry this session landed."

run2 --check
is "--check validates the recovered entry rather than reporting it missing" "${RC}" "0"
is "…and prints the same path" "${OUT}" "${LANDED}"

# A recorded path that is missing for any OTHER reason is still a miss — the
# recovery is not allowed to turn "no entry yet" into a phantom one.
echo "${CODESAT}/journal/2026-09-13/2015-never-written.md" >"${LEDGER_DIR2}/journal"
run2 --existing
is "a recorded path absent from the trunk too still exits 1" "${RC}" "1"
is "…and prints nothing" "${OUT}" ""
printf '%s\n' "${LANDED}" >"${LEDGER_DIR2}/journal"

run --check unexpected
is "check rejects extra arguments" "${RC}" "2"

OUT2="$(cd "${TMP}" && env "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" \
  bash "${SCRIPT}" "x" 2>&1)"
RC2=$?
is "outside a thread it exits 2" "${RC2}" "2"
has "and says why, rather than choosing a path anyway" "${OUT2}" "not in a thread"

echo
echo "journal-file.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
