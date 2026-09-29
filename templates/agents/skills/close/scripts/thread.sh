#!/usr/bin/env bash
# thread.sh — which session (thread) is this shell in?
#
# A session is a thread: in T3 Code, a T3 thread; in any other harness, the
# harness's own session. Everything the close does — which worktrees this
# session owns, where its journal file goes, what the user actually typed —
# hangs off that thread id. T3 Code's id is read from T3's own record, never
# invented; outside T3 the harness's session id is used, and when the harness
# exports none, one is generated once and remembered for this tree.
#
# WHY NOT AN ENVIRONMENT VARIABLE. `CLAUDE_CODE_SESSION_ID` exists and would be
# one line, but it is Claude-only and the point of this close is that Codex,
# Grok Build and Antigravity run it unchanged. T3 itself exports no thread
# variable — the 0.0.40 bundle sets `T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT` and
# `T3_SERVICE_LAUNCHER_CONTEXT`, and nothing else. What every harness DOES
# share is the directory it was started in, and T3's db maps that directory to
# the thread.
#
# THREE PLACES THE ANSWER CAN COME FROM, in order:
#
#   1. The T3 database, keyed on the toplevel of the current directory. This is
#      the normal case: the shell stands in the thread's own worktree.
#   2. The ledger, keyed the same way. Once a session has written to a SECOND
#      repo it has a satellite worktree, and a shell standing in that satellite
#      is in no T3 worktree at all — the db has never heard of the path. The
#      ledger that recorded the satellite knows which thread owns it.
#   3. Outside T3: the harness's session id (harness.sh — CONTEXTIUM_SESSION,
#      CLAUDE_CODE_SESSION_ID), else a generated `session-<date>-<random>` kept
#      in ~/.cache/workbench/sessions/ for the tree the shell stands in (the
#      main checkout, or the linked worktree the session started in) until a
#      close of it lands. Two id-less sessions in one checkout at once share
#      that id; in two worktrees of their own (T3 Code, `claude -w`, …) they
#      get two.
#      The thread's start is recorded the first time the id is seen.
#
# Exactly one ledger may claim a path. Two claiming it is a corrupted cache
# rather than a question to answer by picking one, so it exits 2.
#
# WHY THE FULL ID AND NOT A PREFIX. The worktrees write-root.sh makes for other
# repos are named by the whole uuid (T3's own `t3code-<8 hex>` folders are not
# derived from the id at all). An 8-character prefix reads better and two threads can share one; the
# collision would land one session's commits in another's ledger.
#
# Usage:
#   thread.sh                  — the thread id
#   thread.sh --id             — same
#   thread.sh --branch         — the branch T3 gave the thread's worktree
#   thread.sh --worktree       — the thread's own worktree path (T3's, or the
#                                linked worktree a harness started it in)
#   thread.sh --started        — thread creation time, ISO 8601 as stored
#   thread.sh --started --local      — the same instant as HHMM, local time
#   thread.sh --started --local-day  — the same instant as YYYY-MM-DD, local time
#                                (`--la` is accepted as the old name of --local)
#
# Env:
#   WORKBENCH_THREAD_ID — override. For a plain terminal and for the test
#                         suites; nothing in a real session sets it. With it
#                         set, `--id` answers from it alone, and the other
#                         modes still need the database row.
#   T3CODE_HOME         — T3's data root. Defaults to ~/.t3; T3 exports it to
#                         the providers it runs.
#   CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID — a non-T3 session's id
#                         (harness.sh reads them).
#
# peers:
#   .agents/skills/close/scripts/thread.test.sh
#   .agents/skills/close/scripts/write-root.sh   (the ledger's writer)
#
# Exit: 0 ok (answer on stdout) · 2 no thread, or an unreadable database

set -euo pipefail

T3_HOME="${T3CODE_HOME:-${HOME}/.t3}"
DB="${T3_HOME}/userdata/state.sqlite"
LEDGER_HOME="${HOME}/.cache/workbench/threads"
SESSIONS_HOME="${HOME}/.cache/workbench/sessions"
# shellcheck disable=SC1091  # a sibling file, resolved at run time
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/harness.sh"

fail() {
  echo "thread: $*" >&2
  exit 2
}

MODE="id"
LOCAL=""
for arg in "$@"; do
  case "${arg}" in
    --id)       MODE="id" ;;
    --branch)   MODE="branch" ;;
    --worktree) MODE="worktree" ;;
    --started)  MODE="started" ;;
    --local|--la) LOCAL="%H%M" ;;
    --local-day)  LOCAL="%Y-%m-%d" ;;
    *) fail "usage: thread.sh [--id | --branch | --worktree | --started [--local | --local-day]]" ;;
  esac
done

# An ISO 8601 instant in local time, in format $2. GNU date parses ISO itself;
# BSD date (macOS) needs the UTC seconds spelled out first.
local_fmt() {
  local iso="$1" fmt="$2" epoch
  if date -d "${iso}" "+${fmt}" 2>/dev/null; then return 0; fi
  epoch="$(date -j -u -f '%Y-%m-%dT%H:%M:%S' "${iso%%[.Z]*}" +%s 2>/dev/null)" || return 1
  date -r "${epoch}" "+${fmt}"
}

# ── Outside T3: the harness's session ──────────────────────────────────────
# The id is the harness's own (harness.sh), else one generated for this
# checkout and kept until a close of it lands. Its start is recorded the first
# time it is seen, and its own worktree is the linked worktree it started in —
# the harness made that one — recorded the same way.
harness_session() {
  local main key file sid
  sid="$(harness_session_id)"
  if [ -z "${sid}" ]; then
    # Keyed on the tree the shell stands in: the main checkout, or a linked
    # worktree the session started in. Two id-less sessions in two worktrees
    # are two sessions; keyed on the main checkout they shared one id, and the
    # second's close landed the first's tree as its own.
    main="$(cd "$(git rev-parse --show-toplevel 2>/dev/null)" 2>/dev/null && pwd -P)" || return 1
    key="$(printf '%s' "${main}" | cksum | cut -d' ' -f1)"
    file="${SESSIONS_HOME}/${key}"
    sid="$(cat "${file}" 2>/dev/null || true)"
    if [ -z "${sid}" ] || [ -f "${LEDGER_HOME}/${sid}/closed" ]; then
      sid="session-$(date +%Y%m%d-%H%M%S)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
      mkdir -p "${SESSIONS_HOME}"
      printf '%s\n' "${sid}" >"${file}"
    fi
  fi
  printf '%s\n' "${sid}"
}

# The row for a non-T3 thread: id, branch, own worktree, start.
harness_row() {
  local tid="$1" state="${LEDGER_HOME}/$1" own="" top common
  mkdir -p "${state}"
  [ -f "${state}/started" ] || date -u +%Y-%m-%dT%H:%M:%SZ >"${state}/started"
  own="$(cat "${state}/own" 2>/dev/null || true)"
  if [ -z "${own}" ] && [ "${2:-}" = "fresh" ]; then
    top="$(git rev-parse --show-toplevel 2>/dev/null || true)"
    common="$(git rev-parse --git-common-dir 2>/dev/null || true)"
    if [ -n "${top}" ] && [ -n "${common}" ] \
      && [ "$(cd "${top}" && pwd -P)" != "$(cd "${common}/.." && pwd -P)" ]; then
      own="$(cd "${top}" && pwd -P)"
      printf '%s\n' "${own}" >"${state}/own"
    fi
  fi
  local branch=""
  [ -z "${own}" ] || branch="$(git -C "${own}" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  printf '%s\037%s\037%s\037%s' "${tid}" "${branch}" "${own}" "$(cat "${state}/started")"
}

# One query, one row, fields joined by \x1f — or exit 4 for "no such row" so the caller
# can tell an empty result from a broken database. Read-only is not politeness:
# T3 is usually running and writing, and an accidental write lock here would
# stall the UI.
db_row() {
  local sql="$1"
  shift
  node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, sql, ...params] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  process.stderr.write(e.message + "\n");
  process.exit(3);
}
const row = db.prepare(sql).get(...params);
if (!row) process.exit(4);
process.stdout.write(
  Object.values(row).map((v) => (v === null ? "" : String(v))).join("\x1f"),
);
' "${DB}" "${sql}" "$@"
}

COLUMNS='thread_id, branch, worktree_path, created_at'

row=""
if [ -n "${WORKBENCH_THREAD_ID:-}" ]; then
  # The override names the thread. Everything except `--id` still needs the row,
  # and a missing database is reported rather than papered over — a caller that
  # asked for the branch must not be handed an empty string.
  if [ "${MODE}" = "id" ]; then
    printf '%s\n' "${WORKBENCH_THREAD_ID}"
    exit 0
  fi
  if [ -f "${DB}" ]; then
    row="$(db_row "select ${COLUMNS} from projection_threads where thread_id = ? and deleted_at is null" \
      "${WORKBENCH_THREAD_ID}")" || {
      case $? in
        3) fail "cannot read ${DB}" ;;
        *) fail "no thread ${WORKBENCH_THREAD_ID} in ${DB}" ;;
      esac
    }
  else
    # No T3 at all: the override names a harness session.
    row="$(harness_row "${WORKBENCH_THREAD_ID}" fresh)"
  fi
else
  # The toplevel, not the cwd: a shell three directories deep in the worktree is
  # still in the thread, and the db stores the worktree root.
  TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "${TOP}" ] || fail "not in a thread: $(pwd) is not a git worktree"
  TOP="$(cd "${TOP}" && pwd -P)"

  if [ -f "${DB}" ]; then
    row="$(db_row "select ${COLUMNS} from projection_threads where worktree_path = ? and deleted_at is null" \
      "${TOP}")" || {
      status=$?
      [ "${status}" = 3 ] && fail "cannot read ${DB}"
      row=""
    }
  fi

  if [ -z "${row}" ]; then
    # Not a T3 worktree. It may still be a satellite this session created, and
    # the ledger is the only record of that — `git worktree list` knows the
    # branch but not which thread the branch belongs to.
    hits=""
    if [ -d "${LEDGER_HOME}" ]; then
      hits="$(awk -v want="${TOP}" -F'\t' '$1 == want { print FILENAME }' \
        "${LEDGER_HOME}"/*/worktrees 2>/dev/null | sort -u || true)"
    fi
    count="$(printf '%s' "${hits}" | grep -c . || true)"
    case "${count}" in
      0)
        # Not T3, and no ledger claims this tree: the harness's own session.
        TID="$(harness_session)" || fail "cannot name a session for ${TOP}"
        row="$(harness_row "${TID}" fresh)"
        ;;
      1) ;;
      *) fail "ambiguous: ${TOP} is claimed by ${count} ledgers" ;;
    esac
    if [ -z "${row}" ]; then
      TID="$(basename "$(dirname "${hits}")")"
      if [ "${MODE}" = "id" ]; then
        printf '%s\n' "${TID}"
        exit 0
      fi
      # A T3 thread's satellite reads T3's row; any other session's, its own.
      if [ -f "${DB}" ]; then
        row="$(db_row "select ${COLUMNS} from projection_threads where thread_id = ? and deleted_at is null" \
          "${TID}" 2>/dev/null)" || row=""
      fi
      [ -n "${row}" ] || row="$(harness_row "${TID}")"
    fi
  fi
fi

# Fields are split on the unit separator, not a tab: a tab is whitespace to
# `read`, so an empty field between two tabs would shift every later one.
IFS=$'\x1f' read -r F_ID F_BRANCH F_WORKTREE F_CREATED <<<"${row}"

case "${MODE}" in
  id)       printf '%s\n' "${F_ID}" ;;
  branch)
    [ -n "${F_BRANCH}" ] || fail "thread ${F_ID} has no branch recorded"
    printf '%s\n' "${F_BRANCH}"
    ;;
  worktree)
    [ -n "${F_WORKTREE}" ] || fail "thread ${F_ID} has no worktree recorded"
    printf '%s\n' "${F_WORKTREE}"
    ;;
  started)
    [ -n "${F_CREATED}" ] || fail "thread ${F_ID} has no created_at"
    if [ -n "${LOCAL}" ]; then
      # The journal files by the session's START, in local time, never by the
      # close time: a session that closes after midnight would otherwise file
      # under a day it did not happen on.
      local_fmt "${F_CREATED}" "${LOCAL}" \
        || fail "cannot parse created_at: ${F_CREATED}"
    else
      printf '%s\n' "${F_CREATED}"
    fi
    ;;
esac
