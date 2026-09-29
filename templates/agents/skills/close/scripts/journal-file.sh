#!/usr/bin/env bash
# journal-file.sh — the path this session's journal entry goes to.
#
# A journal day is a FOLDER, `journal/<date>/`, and a session is one file in
# it: `<HHMM>-<slug>.md`. A day kept as one shared file every session appends
# to is merged by concurrent closes without a git conflict — which silently
# drops whole sessions from it.
#
# THE TIME IS THE SESSION'S START, not the close, in local time. A session that
# closes after midnight files under the day it happened on, which is the day
# its work is in.
#
# TWO PLACES A NAME CAN ALREADY BE TAKEN, and both are checked. The obvious one
# is this worktree. The other is the trunk: another thread that started in
# the same minute with the same slug allocated the name in ITS worktree, where
# this one cannot see it, and landed first. Checking only locally picks a name
# that collides at merge time — and a merge of two files with one path is
# exactly the shared-write failure the one-file-per-session shape removed.
# `land.sh` re-checks against a freshly fetched trunk at merge time,
# because the other thread may land in between; this is the first of the two.
#
# THE PATH IS PERSISTED, not remembered. `land.sh` verifies that this exact
# path reached the trunk, and a re-run after a failed Land resumes on the
# file already written rather than writing a second one.
#
# Usage:
#   journal-file.sh "<filename-stem>" — choose and print the path (creates the day
#                                folder; does NOT create the file)
#   journal-file.sh --existing — print the path already chosen for this thread,
#                                if the file is there. Exit 1 if not.
#   journal-file.sh --check    — validate that existing entry using the same
#                                gate as Land (check-journal-entry.sh: front
#                                matter and the body's sections), then print
#                                its path. No writes.
#
# Env:
#   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.sh.
#
# WHERE. Under `journal/` of this thread's worktree of THIS repo — the one
# these scripts live in, the workbench, where the records sit beside the code.
# The repo is found by asking git for the toplevel of the script's own
# directory. That works from a worktree copy of the scripts and through the
# `~/.agents/skills` link into the landed checkout alike: write-root.sh
# canonicalises whatever it is handed to the shared checkout and answers with
# the thread's worktree of it — the harness's own when the thread is on the
# workbench, a satellite when the thread is on a product repo.
#
# peers:
#   .agents/skills/close/scripts/journal-file.test.sh
#   .agents/skills/close/references/journal-entry.md  (the file's shape)
#   .agents/skills/close/scripts/check-journal-entry.sh (the gate --check runs)
#   .agents/skills/close/scripts/land.sh              (re-checks at merge)
#
# Exit: 0 ok (path on stdout) · 1 no existing file · 2 usage/thread error
#       3 --check found an invalid entry

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREAD="${SCRIPT_DIR}/thread.sh"
WRITE_ROOT="${SCRIPT_DIR}/write-root.sh"
TRUNK_SH="${SCRIPT_DIR}/trunk.sh"

fail() { echo "journal-file: $*" >&2; exit 2; }

[ $# -eq 1 ] || fail 'usage: journal-file.sh "<filename-stem>" | --existing | --check'

# The repo the journal belongs to is the one this script is in.
SELF_REPO="$(git -C "${SCRIPT_DIR}" rev-parse --show-toplevel 2>/dev/null)" \
  || fail "these scripts are not inside a git repo: ${SCRIPT_DIR}"

TID="$(bash "${THREAD}" --id 2>&1)" || fail "${TID#thread: }"
LEDGER_JOURNAL="${HOME}/.cache/workbench/threads/${TID}/journal"

if [ "$1" = "--existing" ] || [ "$1" = "--check" ]; then
  [ -f "${LEDGER_JOURNAL}" ] || exit 1
  CHOSEN="$(head -n 1 "${LEDGER_JOURNAL}")"
  [ -n "${CHOSEN}" ] || exit 1
  # RECREATE BEFORE TESTING. `land.sh` merges the entry to the trunk and then
  # removes this thread's worktree of this repo when it is a satellite (a
  # thread T3 opened on a product repo), so the recorded path leaves disk
  # while the entry itself is safe on origin. Work continues in the same
  # session, and the next close must resume on that entry — but a `-f` test run
  # first reports it missing, and the allocator then files a second entry
  # beside the one already landed. write-root re-adds the worktree at the same deterministic path from
  # origin/<trunk>, so the landed entry comes back exactly where it was; a path
  # missing for any other reason is still a miss, and still exits 1 below.
  [ -f "${CHOSEN}" ] || bash "${WRITE_ROOT}" "${SELF_REPO}" >/dev/null || true
  [ -f "${CHOSEN}" ] || exit 1
  if [ "$1" = "--check" ]; then
    bash "${SCRIPT_DIR}/check-journal-entry.sh" "${CHOSEN}" || exit 3
  fi
  printf '%s\n' "${CHOSEN}"
  exit 0
fi

SLUG_IN="$1"

# Kebab: lower-case, every run of anything else collapsed to one hyphen, ends
# trimmed, 60 characters at most (`journal-entry.md` § One file per session).
SLUG="$(printf '%s' "${SLUG_IN}" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
  | cut -c1-60 \
  | sed -E 's/-+$//')"
[ -n "${SLUG}" ] || fail "slug '${SLUG_IN}' has no usable characters"

WT="$(bash "${WRITE_ROOT}" "${SELF_REPO}")" || exit 2

STARTED="$(bash "${THREAD}" --started)" || fail "no start time for thread ${TID}"
DATE="$(bash "${THREAD}" --started --local-day)" \
  || fail "cannot parse the thread's start time: ${STARTED}"
HHMM="$(bash "${THREAD}" --started --local)" || fail "cannot format the start time"

DAY_DIR="${WT}/journal/${DATE}"
mkdir -p "${DAY_DIR}"

# The trunk ref is only as fresh as the last fetch, and a stale one is how two
# threads agree on a name that is already taken. The trunk's NAME is asked of
# trunk.sh rather than spelled `main`, the same as every other close script;
# a repo it cannot name gets the local check only, which is the most this can
# do without a ref to compare against.
JTRUNK="$(bash "${TRUNK_SH}" "${WT}" 2>/dev/null || true)"
[ -z "${JTRUNK}" ] || git -C "${WT}" fetch -q origin "${JTRUNK}" 2>/dev/null || true

taken() {
  local rel="journal/${DATE}/$1"
  [ -e "${WT}/${rel}" ] && return 0
  [ -n "${JTRUNK}" ] || return 1
  git -C "${WT}" cat-file -e "origin/${JTRUNK}:${rel}" 2>/dev/null && return 0
  return 1
}

NAME="${HHMM}-${SLUG}.md"
N=1
while taken "${NAME}"; do
  N=$((N + 1))
  NAME="${HHMM}-${SLUG}-${N}.md"
done

CHOSEN="${DAY_DIR}/${NAME}"
mkdir -p "$(dirname "${LEDGER_JOURNAL}")"
printf '%s\n' "${CHOSEN}" >"${LEDGER_JOURNAL}"
printf '%s\n' "${CHOSEN}"
