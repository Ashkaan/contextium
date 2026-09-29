#!/usr/bin/env bash
# thread.test.sh — every resolution path and every refusal in thread.sh.
#
# Run: bash .agents/skills/close/scripts/thread.test.sh
#
# Each case builds a throwaway HOME, a fixture `state.sqlite` with the two
# columns thread.sh reads, and fake git worktrees to stand in. T3CODE_HOME
# points at the fixture, so nothing here can reach the real database, and the
# ledger lives under the throwaway HOME, so nothing here can reach the real
# cache.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/thread.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0

# assert <name> <expected-exit> <expected-output-substring> <cwd> -- <env...>
assert() {
  local name="$1" want_code="$2" want_out="$3" cwd="$4"
  shift 4
  local out code
  out="$(cd "${cwd}" && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION \
    "$@" bash "${SCRIPT}" "${EXTRA_ARGS[@]}" 2>&1)"
  code=$?
  if [ "${code}" != "${want_code}" ]; then
    echo "FAIL ${name}: exit ${code}, wanted ${want_code} — ${out}"
    FAIL=$((FAIL + 1))
    return
  fi
  case "${out}" in
    *"${want_out}"*) PASS=$((PASS + 1)); echo "ok   ${name}" ;;
    *) echo "FAIL ${name}: output '${out}' lacks '${want_out}'"; FAIL=$((FAIL + 1)) ;;
  esac
}

EXTRA_ARGS=()

# ── Fixtures ────────────────────────────────────────────────────────────────

FAKE_HOME="${TMP}/home"
T3="${TMP}/t3"
mkdir -p "${FAKE_HOME}" "${T3}/userdata"

# Two fake T3 worktrees, both real git repos so `rev-parse --show-toplevel`
# answers. The second exists to prove a row is matched on its OWN path.
WT_A="${TMP}/wt-a"
WT_B="${TMP}/wt-b"
NOT_A_THREAD="${TMP}/plain-repo"
for d in "${WT_A}" "${WT_B}" "${NOT_A_THREAD}"; do
  mkdir -p "${d}"
  git -C "${d}" init -q
done

TID_A=aaaaaaaa-1111-2222-3333-444444444444
TID_B=bbbbbbbb-1111-2222-3333-444444444444

node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, wtA, tidA, wtB, tidB] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)`);
const ins = db.prepare(`insert into projection_threads
  (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)`);
ins.run(tidA, "p", "A", "t3code/some-title", wtA, "2026-09-14T03:15:51.803Z", "x", null);
ins.run(tidB, "p", "B", "t3code/other", wtB, "2026-09-01T17:04:00.000Z", "x", null);
// A deleted thread whose worktree path is reused: must NOT match.
ins.run("dddddddd-0000-0000-0000-000000000000", "p", "D", "t3code/dead",
  process.argv[6], "2026-08-01T00:00:00.000Z", "x", "2026-08-02T00:00:00.000Z");
' "${T3}/userdata/state.sqlite" "${WT_A}" "${TID_A}" "${WT_B}" "${TID_B}" "${NOT_A_THREAD}"

ENV_OK=("HOME=${FAKE_HOME}" "T3CODE_HOME=${T3}")

# ── The database path: the shell stands in the thread's T3 worktree ─────────

EXTRA_ARGS=()
assert "db hit prints the thread id" 0 "${TID_A}" "${WT_A}" "${ENV_OK[@]}"

EXTRA_ARGS=(--branch)
assert "db hit prints T3's own branch name" 0 "t3code/some-title" "${WT_A}" "${ENV_OK[@]}"

EXTRA_ARGS=(--worktree)
assert "db hit prints the worktree path" 0 "${WT_A}" "${WT_A}" "${ENV_OK[@]}"

EXTRA_ARGS=(--started)
assert "db hit prints created_at as stored" 0 "2026-09-14T03:15:51.803Z" "${WT_A}" "${ENV_OK[@]}"

# 03:15 UTC on the 14th is 20:15 on the 13th in Los Angeles — the case the
# journal's "file by session start, not close time" rule turns on.
EXTRA_ARGS=(--started --local)
assert "started --local converts to local HHMM" 0 "2015" "${WT_A}" "${ENV_OK[@]}" TZ=America/Los_Angeles
EXTRA_ARGS=(--started --local-day)
assert "started --local-day is the local date" 0 "2026-09-13" "${WT_A}" "${ENV_OK[@]}" TZ=America/Los_Angeles
EXTRA_ARGS=(--started --la)
assert "--la is still accepted" 0 "0315" "${WT_A}" "${ENV_OK[@]}" TZ=UTC

EXTRA_ARGS=()
assert "a second thread matches its own row" 0 "${TID_B}" "${WT_B}" "${ENV_OK[@]}"

# ── The ledger path: the shell stands in a satellite ────────────────────────

SAT="${TMP}/satellite"
mkdir -p "${SAT}"
git -C "${SAT}" init -q
LEDGER_A="${FAKE_HOME}/.cache/workbench/threads/${TID_A}"
mkdir -p "${LEDGER_A}"
printf '%s\t%s\t%s\n' "${SAT}" "${TMP}/shared" "t3/${TID_A}" >"${LEDGER_A}/worktrees"

EXTRA_ARGS=()
assert "satellite resolves through the ledger" 0 "${TID_A}" "${SAT}" "${ENV_OK[@]}"

# From the satellite the branch still comes from the db row, not from the
# ledger's `t3/<id>` — they are different branches and only one is T3's.
EXTRA_ARGS=(--branch)
assert "satellite still reports T3's branch" 0 "t3code/some-title" "${SAT}" "${ENV_OK[@]}"

# ── Two ledgers claiming one path is corruption, not a coin toss ────────────

LEDGER_B="${FAKE_HOME}/.cache/workbench/threads/${TID_B}"
mkdir -p "${LEDGER_B}"
printf '%s\t%s\t%s\n' "${SAT}" "${TMP}/shared" "t3/${TID_B}" >"${LEDGER_B}/worktrees"

EXTRA_ARGS=()
assert "two ledgers claiming one path is ambiguous" 2 "ambiguous" "${SAT}" "${ENV_OK[@]}"
rm -rf "${LEDGER_B}"

# ── No thread at all ────────────────────────────────────────────────────────

EXTRA_ARGS=()
assert "a git repo T3 never heard of gets a generated session" 0 "session-" \
  "${NOT_A_THREAD}" "${ENV_OK[@]}"

# The deleted-thread row names that same path. If `deleted_at is null` were
# missing from the query this case would pass an id back instead of refusing.
OUT_DEL="$(cd "${NOT_A_THREAD}" && env "${ENV_OK[@]}" bash "${SCRIPT}" 2>&1)"
case "${OUT_DEL}" in
  *dddddddd*) echo "FAIL deleted thread matched"; FAIL=$((FAIL + 1)) ;;
  *) PASS=$((PASS + 1)); echo "ok   a deleted thread does not match its old path" ;;
esac

EXTRA_ARGS=()
assert "outside any git repo there is no thread" 2 "not in a thread" \
  "${TMP}" "${ENV_OK[@]}"

# ── Outside T3: the harness's session ───────────────────────────────────────

NO_T3=("HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere")
run() { (cd "$1" && shift && env -u CLAUDE_CODE_SESSION_ID -u CLAUDE_SESSION_ID -u CONTEXTIUM_SESSION "${NO_T3[@]}" "$@" bash "${SCRIPT}" "${ARGS[@]}" 2>&1); }
ARGS=(); GEN1="$(run "${WT_A}")"
case "${GEN1}" in session-*) PASS=$((PASS + 1)); echo "ok   no T3 and no session id: an id is generated" ;; *) FAIL=$((FAIL + 1)); echo "FAIL generated id: ${GEN1}" ;; esac
ARGS=(); GEN2="$(run "${WT_A}")"
if [ "${GEN1}" = "${GEN2}" ]; then PASS=$((PASS + 1)); echo "ok   …and remembered for the checkout"; else FAIL=$((FAIL + 1)); echo "FAIL generated id changed: ${GEN1} then ${GEN2}"; fi
ARGS=(--started); S="$(run "${WT_A}")"
case "${S}" in 20[0-9][0-9]-*T*Z) PASS=$((PASS + 1)); echo "ok   …its start is recorded" ;; *) FAIL=$((FAIL + 1)); echo "FAIL generated start: ${S}" ;; esac
ARGS=(--worktree); W="$(run "${WT_A}")"
case "${W}" in *"no worktree recorded"*) PASS=$((PASS + 1)); echo "ok   …a main checkout is not its own worktree" ;; *) FAIL=$((FAIL + 1)); echo "FAIL main checkout worktree: ${W}" ;; esac
mkdir -p "${FAKE_HOME}/.cache/workbench/threads/${GEN1}"; : >"${FAKE_HOME}/.cache/workbench/threads/${GEN1}/closed"
ARGS=(); GEN3="$(run "${WT_A}")"
if [ "${GEN3}" != "${GEN1}" ]; then PASS=$((PASS + 1)); echo "ok   …and a new one after its close landed"; else FAIL=$((FAIL + 1)); echo "FAIL generated id survived its close"; fi
ARGS=(); S="$(run "${WT_A}" CONTEXTIUM_SESSION=my-session)"
if [ "${S}" = "my-session" ]; then PASS=$((PASS + 1)); echo "ok   the harness's own session id wins"; else FAIL=$((FAIL + 1)); echo "FAIL harness id: ${S}"; fi
git -C "${WT_A}" commit -q --allow-empty -m seed 2>/dev/null || git -C "${WT_A}" -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m seed
git -C "${WT_A}" worktree add -q -b harness/one "${TMP}/linked" >/dev/null 2>&1
ARGS=(--worktree); W="$(run "${TMP}/linked" CLAUDE_CODE_SESSION_ID=cc-1)"
if [ "${W}" = "$(cd "${TMP}/linked" && pwd -P)" ]; then PASS=$((PASS + 1)); echo "ok   a linked worktree the harness started in is the session's own"; else FAIL=$((FAIL + 1)); echo "FAIL linked own worktree: ${W}"; fi
ARGS=(--branch); W="$(run "${TMP}/linked" CLAUDE_CODE_SESSION_ID=cc-1)"
if [ "${W}" = "harness/one" ]; then PASS=$((PASS + 1)); echo "ok   …and its branch is read from git"; else FAIL=$((FAIL + 1)); echo "FAIL linked branch: ${W}"; fi
# Two id-less sessions, each in a linked worktree of its own: two sessions, not
# one. Sharing a generated id would record the first one's worktree as both
# sessions' own, and the second session's close would land the first one's tree.
git -C "${WT_A}" worktree add -q -b harness/two "${TMP}/linked2" >/dev/null 2>&1
git -C "${WT_A}" worktree add -q -b harness/three "${TMP}/linked3" >/dev/null 2>&1
ARGS=(); L2="$(run "${TMP}/linked2")"; L3="$(run "${TMP}/linked3")"
if [ -n "${L2}" ] && [ "${L2}" != "${L3}" ]; then PASS=$((PASS + 1)); echo "ok   id-less sessions in two worktrees get two ids"; else FAIL=$((FAIL + 1)); echo "FAIL shared id-less session: ${L2} and ${L3}"; fi
ARGS=(--worktree); W3="$(run "${TMP}/linked3")"
if [ "${W3}" = "$(cd "${TMP}/linked3" && pwd -P)" ]; then PASS=$((PASS + 1)); echo "ok   …each owning its own worktree"; else FAIL=$((FAIL + 1)); echo "FAIL second session's own worktree: ${W3}"; fi
ARGS=(); L2B="$(run "${TMP}/linked2")"
if [ "${L2B}" = "${L2}" ]; then PASS=$((PASS + 1)); echo "ok   …and each remembered"; else FAIL=$((FAIL + 1)); echo "FAIL id-less worktree session changed: ${L2} then ${L2B}"; fi

# ── The override ────────────────────────────────────────────────────────────

EXTRA_ARGS=()
assert "WORKBENCH_THREAD_ID answers --id with no db at all" 0 "forced-id" \
  "${TMP}" "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" "WORKBENCH_THREAD_ID=forced-id"

EXTRA_ARGS=(--branch)
assert "WORKBENCH_THREAD_ID still reads the row for --branch" 0 "t3code/some-title" \
  "${TMP}" "${ENV_OK[@]}" "WORKBENCH_THREAD_ID=${TID_A}"

EXTRA_ARGS=(--branch)
assert "an override naming no row is refused, not guessed" 2 "no thread" \
  "${TMP}" "${ENV_OK[@]}" "WORKBENCH_THREAD_ID=no-such-thread"

# ── Usage ───────────────────────────────────────────────────────────────────

EXTRA_ARGS=(--nonsense)
assert "an unknown flag is refused" 2 "usage:" "${WT_A}" "${ENV_OK[@]}"

echo
echo "thread.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
