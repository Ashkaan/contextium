#!/usr/bin/env bash
# write-root.test.sh — every boundary row from close.spec.md § 4 that names the
# resolver.
#
# Run: bash .agents/skills/close/scripts/write-root.test.sh
#
# Fixtures are real git repos with real bare origins under a temp dir, plus a
# fixture state.sqlite and a throwaway HOME. Nothing here can reach the real
# cache, the real checkouts or the real T3 database.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/write-root.sh"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() {
  # The fixture checkouts own worktrees under the throwaway HOME; removing the
  # tree is enough, but prune first so no `.git/worktrees` entry outlives it.
  local wt
  for wt in "${TMP}"/checkouts/*; do
    [ -d "${wt}" ] && git -C "${wt}" worktree prune 2>/dev/null
  done
  rm -rf "${TMP}"
  rm -f "/tmp/wrt-$$-"*-git.lock
}
trap cleanup EXIT

ok()   { PASS=$((PASS + 1)); echo "ok   $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()   { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has()  { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }

FAKE_HOME="${TMP}/home"
T3="${TMP}/t3"
mkdir -p "${FAKE_HOME}" "${T3}/userdata" "${TMP}/origins" "${TMP}/checkouts"

TID=cccccccc-1111-2222-3333-555555555555
LEDGER="${FAKE_HOME}/.cache/workbench/threads/${TID}/worktrees"

# A repo with a bare origin and one commit on main. The basename is prefixed
# with the pid so the /tmp lock this script takes cannot collide with a
# concurrent run of this same suite.
# The second argument is the TRUNK BRANCH and defaults to `main`. It is a
# parameter rather than a constant because a repo on `master` is the case the
# resolver exists for, and a fixture factory that can only build `main` cannot
# test it.
mkrepo() {
  local name="wrt-$$-$1" branch="${2:-main}" bare wt
  bare="${TMP}/origins/${name}.git"
  wt="${TMP}/checkouts/${name}"
  git init -q --bare -b "${branch}" "${bare}"
  git init -q -b "${branch}" "${wt}"
  git -C "${wt}" config user.email t@example.com
  git -C "${wt}" config user.name tester
  echo seed >"${wt}/seed.txt"
  git -C "${wt}" add seed.txt
  git -C "${wt}" commit -q -m seed
  git -C "${wt}" remote add origin "${bare}"
  git -C "${wt}" push -q -u origin "${branch}"
  printf '%s' "${wt}"
}

CODE="$(mkrepo code)"
LIB="$(mkrepo lib)"

# The thread's T3 worktree: a LINKED worktree of CODE, on a branch named the way
# T3 names them. The `session/` prefix this script uses for satellites is not
# what T3 picks, and a resolver that assumed one would register the wrong branch.
T3_WT="${TMP}/t3-worktrees/thread-one"
mkdir -p "$(dirname "${T3_WT}")"
git -C "${CODE}" worktree add -q -b "t3code/some-title" "${T3_WT}" main

# shellcheck disable=SC2016  # the JS below must reach node unexpanded —
# bash interpolating `$` inside it is the bug, not the quoting.
node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, tid, wt] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)`);
db.prepare(`insert into projection_threads values (?,?,?,?,?,?,?,?)`)
  .run(tid, "p", "T", "t3code/some-title", wt, "2026-09-14T03:15:51.803Z", "x", null);
' "${T3}/userdata/state.sqlite" "${TID}" "${T3_WT}"

E=("HOME=${FAKE_HOME}" "T3CODE_HOME=${T3}")
# The harness's own session env must not leak in from the shell running the suite.
U=(-u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION -u CONTEXTIUM_HARNESS)

run() {  # run <cwd> <args...> — prints output, sets RC
  local cwd="$1"; shift
  OUT="$(cd "${cwd}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} bash "${SCRIPT}" "$@" 2>&1)"
  RC=$?
}

# ── --main creates nothing and names the shared checkout ───────────────────

run "${T3_WT}" --main .
is "--main . names the shared checkout, not the worktree" "${OUT}" "${CODE}"
if [ -e "${FAKE_HOME}/.cache/workbench/worktrees" ]; then
  bad "--main created something under the cache"
  else ok "--main created nothing"; fi

run "${T3_WT}" --main "${LIB}"
is "--main <path> names another repo's shared checkout" "${OUT}" "${LIB}"

# ── The thread's own repo answers with the T3 worktree ─────────────────────

run "${T3_WT}" .
is "the thread's own repo resolves to its T3 worktree" "${OUT}" "${T3_WT}"

# ── … and registering it is what the first call also does ──────────────────

REG="$(awk -F'\t' -v w="${T3_WT}" '$1 == w { print $2 "|" $3 }' "${LEDGER}")"
is "the T3 worktree is registered with its shared checkout and T3's branch" \
  "${REG}" "${CODE}|t3code/some-title"

# ── A second repo gets a satellite ─────────────────────────────────────────

run "${T3_WT}" "${LIB}"
LIBSAT="${OUT}"
if [ "${RC}" = 0 ] && [ -d "${LIBSAT}" ]; then
  ok "a second repo gets a worktree of its own"
  else bad "second-repo satellite not created (rc=${RC}): ${OUT}"; fi
has "the satellite is keyed by basename and path hash" "${LIBSAT}" \
  "/.cache/workbench/worktrees/wrt-$$-lib-"
has "the satellite is named for the thread" "${LIBSAT}" "/${TID}"
is "the satellite is on the thread's branch" \
  "$(git -C "${LIBSAT}" rev-parse --abbrev-ref HEAD)" "session/${TID}"

# ── A second call creates nothing and appends nothing ──────────────────────

BEFORE="$(wc -l <"${LEDGER}")"
run "${T3_WT}" "${LIB}"
is "a second call prints the same path" "${OUT}" "${LIBSAT}"
is "a second call appends no ledger line" "$(wc -l <"${LEDGER}")" "${BEFORE}"

# ── Two spellings of one repo are one repo ─────────────────────────────────

run "${LIBSAT}" .
is "'.' inside a satellite resolves back to the same satellite" "${OUT}" "${LIBSAT}"

# A subdirectory of a worktree is still that worktree — `--show-toplevel` is
# what makes the resolver work from wherever a skill script happens to stand.
mkdir -p "${LIBSAT}/sub/deeper" "${T3_WT}/sub/deeper"
run "${LIBSAT}/sub/deeper" .
is "a subdirectory of a satellite resolves to the satellite" "${OUT}" "${LIBSAT}"
run "${T3_WT}/sub/deeper" .
is "a subdirectory of the T3 worktree resolves to the T3 worktree" "${OUT}" "${T3_WT}"

# Standing in the SHARED checkout is in no T3 thread, and two threads can both
# hold satellites of it, so nothing is inferred from them: it is a session of
# its own (thread.sh), with a worktree of its own.
mkdir -p "${LIB}/sub/deeper"
run "${LIB}/sub/deeper" .
is "standing in a shared checkout is a session of its own" "${RC}" "0"
if [ "${OUT}" != "${LIBSAT}" ] && [ "${OUT}" != "${T3_WT}" ]; then ok "…not the T3 thread's satellite"; else bad "shared checkout inherited a thread's worktree: ${OUT}"; fi

# ── Two repos with the same basename do not collide ────────────────────────

mkdir -p "${TMP}/elsewhere"
DUP="${TMP}/elsewhere/$(basename "${LIB}")"
git init -q -b main "${DUP}"
git -C "${DUP}" config user.email t@example.com
git -C "${DUP}" config user.name tester
echo other >"${DUP}/seed.txt"
git -C "${DUP}" add seed.txt
git -C "${DUP}" commit -q -m seed
git -C "${DUP}" remote add origin "${TMP}/origins/wrt-$$-lib.git"
git -C "${DUP}" fetch -q origin main

run "${T3_WT}" "${DUP}"
if [ "${OUT}" != "${LIBSAT}" ]; then
  ok "same basename, different path, different worktree"
  else bad "same-basename repos collided on one worktree"; fi
DUPSAT="${OUT}"

# ── Concurrency: two first calls, one worktree ─────────────────────────────

CONC="$(mkrepo conc)"
(cd "${T3_WT}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} bash "${SCRIPT}" "${CONC}" >"${TMP}/c1" 2>&1) &
P1=$!
(cd "${T3_WT}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} bash "${SCRIPT}" "${CONC}" >"${TMP}/c2" 2>&1) &
P2=$!
wait "${P1}"; R1=$?
wait "${P2}"; R2=$?
C1="$(cat "${TMP}/c1")"
C2="$(cat "${TMP}/c2")"
if [ "${R1}" = 0 ] && [ "${R2}" = 0 ] && [ "${C1}" = "${C2}" ]; then
  ok "two concurrent first calls agree on one path"
else
  bad "concurrent calls disagreed: rc=${R1}/${R2} '${C1}' vs '${C2}'"
fi
is "and left exactly one ledger line for it" \
  "$(awk -F'\t' -v s="${CONC}" '$2 == s' "${LEDGER}" | wc -l)" "1"
is "and exactly one worktree directory" \
  "$(find "${FAKE_HOME}/.cache/workbench/worktrees" -maxdepth 2 -name "${TID}" -path "*conc*" | wc -l)" "1"

# ── Reclaim: the directory is gone, the branch and its commits are not ─────

echo work >"${DUPSAT}/unlanded.txt"
git -C "${DUPSAT}" config user.email t@example.com
git -C "${DUPSAT}" config user.name tester
git -C "${DUPSAT}" add unlanded.txt
git -C "${DUPSAT}" commit -q -m "work a crashed close never landed"
LOST_SHA="$(git -C "${DUPSAT}" rev-parse HEAD)"
rm -rf "${DUPSAT}"
git -C "${DUP}" worktree prune

RECLAIM_OUT="$(cd "${T3_WT}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} bash "${SCRIPT}" "${DUP}" \
  2>"${TMP}/reclaim.err")"
is "a crashed close's worktree is recreated at the same path" "${RECLAIM_OUT}" "${DUPSAT}"
has "and the reclaim is announced on stderr" "$(cat "${TMP}/reclaim.err")" \
  "reclaimed existing branch session/${TID}"
is "and its unlanded commit is still there" \
  "$(git -C "${DUPSAT}" rev-parse HEAD)" "${LOST_SHA}"

RECLAIM_MSG="$(cd "${T3_WT}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} bash "${SCRIPT}" "${DUP}" 2>&1 >/dev/null)"
is "a reclaim that is now a plain hit is silent" "${RECLAIM_MSG}" ""

# ── A repo with no TRUNK cannot be landed, so it is refused ────────────────

NOREMOTE="${TMP}/no-remote"
git init -q -b main "${NOREMOTE}"
git -C "${NOREMOTE}" config user.email t@example.com
git -C "${NOREMOTE}" config user.name tester
echo x >"${NOREMOTE}/f"
git -C "${NOREMOTE}" add f
git -C "${NOREMOTE}" commit -q -m seed

run "${T3_WT}" "${NOREMOTE}"
is "a repo with no trunk branch exits 2" "${RC}" "2"
has "and names the repo" "${OUT}" "no trunk branch in ${NOREMOTE}"
# It refuses because it could not FIND a trunk, not because the trunk was not
# called `main`. That wording was the bug this guards: a script that spells the
# trunk `main` turns away every repo whose trunk is `master`.
has "and names the real condition" "${OUT}" "origin/HEAD unset"

# ── A repo whose trunk is `master` gets a worktree like any other ─────────
# The reason `trunk.sh` exists. A repo whose trunk is `master` was once refused
# outright, so a session that had to write there built a worktree by hand that
# no close could land and no ledger recorded.
MASTERREPO="$(mkrepo master-trunk master)"
run "${T3_WT}" "${MASTERREPO}"
is "a master-trunk repo gets a satellite" "${RC}" "0"
is "and the satellite is a real directory" "$([ -d "${OUT}" ] && echo yes)" "yes"
# Branched from the repo's OWN trunk, not from a `main` that does not exist.
is "branched from origin/master" \
  "$(git -C "${OUT}" rev-parse HEAD)" "$(git -C "${MASTERREPO}" rev-parse origin/master)"
# And it is in the ledger, which is the half that was missing when it was done
# by hand: land.sh walks the ledger, so a repo absent from it is landed by nobody.
has "and is recorded in the ledger" "$(cat "${LEDGER}" 2>/dev/null)" "${MASTERREPO}"

# ── Bad arguments ──────────────────────────────────────────────────────────

run "${T3_WT}" relative/path
is "a relative path is refused" "${RC}" "2"
has "with the two spellings named" "${OUT}" "want '.' or an absolute path"

# A bare word names no repo: a caller saying one must be told, not routed
# somewhere by a guess.
run "${T3_WT}" library
is "a bare word is refused" "${RC}" "2"
has "…as a repo it does not know" "${OUT}" "not a repo I know: 'library'"

run "${T3_WT}" "${TMP}/origins"
is "a directory that is not a git repo is refused" "${RC}" "2"
has "and says so" "${OUT}" "not a git repo"

run "${T3_WT}" "${TMP}/does-not-exist"
is "a path that does not exist is refused" "${RC}" "2"
has "and says so" "${OUT}" "no such directory"

# ── Outside T3: the harness's session, or a generated one ─────────────────

OUTSIDE="$(cd "${LIB}" && env ${U[@]+"${U[@]}"} "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" \
  bash "${SCRIPT}" "${LIB}" 2>/dev/null)"
OUTSIDE_RC=$?
is "outside T3 with no session id, the resolver still answers" "${OUTSIDE_RC}" "0"
has "…with a worktree under ~/.cache/workbench for a generated session" "${OUTSIDE}" "${FAKE_HOME}/.cache/workbench/worktrees/"
has "…on a session/ branch" "$(git -C "${OUTSIDE}" rev-parse --abbrev-ref HEAD 2>/dev/null)" "session/session-"
AGAIN="$(cd "${LIB}" && env ${U[@]+"${U[@]}"} "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" bash "${SCRIPT}" "${LIB}" 2>/dev/null)"
is "…and the same worktree on the next call" "${AGAIN}" "${OUTSIDE}"

CLAUDE_WT="$(cd "${LIB}" && env ${U[@]+"${U[@]}"} "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" \
  CONTEXTIUM_SESSION=cc-9 CONTEXTIUM_HARNESS=claude bash "${SCRIPT}" "${LIB}" 2>/dev/null)"
is "a recorded harness puts it where that harness keeps worktrees" "${CLAUDE_WT}" "${LIB}/.claude/worktrees/cc-9"
is "…on that harness's branch name" "$(git -C "${CLAUDE_WT}" rev-parse --abbrev-ref HEAD 2>/dev/null)" "worktree-cc-9"

# ── The override is what makes a plain terminal usable ─────────────────────

PLAIN="$(cd "${LIB}" && env ${U[@]+"${U[@]}"} ${E[@]+"${E[@]}"} "WORKBENCH_THREAD_ID=${TID}" \
  bash "${SCRIPT}" "${LIB}" 2>&1)"
is "WORKBENCH_THREAD_ID reaches the same satellite from a plain shell" \
  "${PLAIN}" "${LIBSAT}"

# ── --existing answers only what the thread already has ────────────────────

run "${T3_WT}" --existing .
is "--existing names the thread's own worktree of its repo" "${OUT}" "${T3_WT}"
ADOPT="$(mkrepo adopt)"
run "${T3_WT}" --existing "${ADOPT}"
is "--existing with no worktree of that repo exits 1" "${RC}" "1"
is "…printing nothing" "${OUT}" ""
if grep -q "${ADOPT}" "${LEDGER}" 2>/dev/null; then bad "--existing recorded something"; else ok "--existing recorded nothing"; fi

# ── --adopt records a worktree something else made ─────────────────────────

NAMED="${TMP}/named/my-slug"
mkdir -p "$(dirname "${NAMED}")"
git -C "${ADOPT}" worktree add -q -b worktree-my-slug "${NAMED}" main
run "${T3_WT}" --adopt "${NAMED}"
is "--adopt prints the worktree" "${OUT}" "${NAMED}"
is "…and records it with its repo and branch" \
  "$(awk -F'\t' -v w="${NAMED}" '$1 == w { print $2 "|" $3 }' "${LEDGER}")" "${ADOPT}|worktree-my-slug"
run "${T3_WT}" "${ADOPT}"
is "the default mode then answers the adopted worktree, making no satellite" "${OUT}" "${NAMED}"
run "${T3_WT}" --existing "${ADOPT}"
is "…and so does --existing" "${OUT}" "${NAMED}"
run "${T3_WT}" --adopt "${NAMED}"
is "adopting it again is a no-op" "${RC}|$(grep -c "^${NAMED}	" "${LEDGER}")" "0|1"

OTHER="${TMP}/named/other"
git -C "${ADOPT}" worktree add -q -b worktree-other "${OTHER}" main
run "${T3_WT}" --adopt "${OTHER}"
is "a second worktree of the same repo is refused" "${RC}" "2"
has "…naming the one the thread already has" "${OUT}" "already has ${NAMED}"
run "${T3_WT}" --adopt "${ADOPT}"
is "the shared checkout itself cannot be adopted" "${RC}" "2"
has "…and says so" "${OUT}" "is the shared checkout"

echo
echo "write-root.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
