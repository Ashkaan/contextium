#!/usr/bin/env bash
# land.sh — put everything this thread wrote on its repo's trunk, and prove it.
#
# The thread owns one worktree per repo it touched (see write-root.sh): its
# workbench worktree, which holds the code, the records and the skills
# together, plus a satellite for each product repo it wrote to.
# This walks that ledger and, for each one: commits, merges the trunk into it,
# pushes it AS that repo's trunk, records the merge SHA, checks that the push
# started a deploy, and removes the worktree. Then it re-fetches every repo and
# checks three things before it will say the session is safe to close.
#
# THE MERGE HAPPENS IN THE WORKTREE, not in the shared checkout. Merging in the
# shared tree puts a conflict in the copy every other session and every
# automation is using, and that tree's index may already be dirty with somebody
# else's work. Here a conflict stays inside this thread's own worktree, where
# re-running the close resumes on it.
#
# THE LAST LINE IS EARNED, NOT ASSERTED. The report ends on a line saying the
# session is safe to close, and the only way a line like that means anything is
# if a script prints it after checking. So it exists nowhere else: the skill copies what
# this prints. The three checks are run against a FRESHLY FETCHED trunk
# because the interesting failures (a push that raced, a journal name another
# thread took) are all invisible against a stale ref.
#
# WHAT REPLACED WHAT. This is one script where there were six: close-attest.sh
# wrote marker files, close-sha.sh recorded a SHA for them, a `closed-by:`
# trailer went on the commit and a script checked it before each commit. Three
# moving parts to prove what one ancestry check proves — and a commit-hook
# checker never runs in a repo whose hooks path points elsewhere.
#
# Usage:
#   land.sh "<commit subject>"   — land, check, then emit the final report
#   land.sh --check              — the checks only; land nothing
#   land.sh --verbose            — also print each repo's SHA
#   land.sh --gate               — `fired` / `not-fired`, for the auto-close gate
#
# Env:
#   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.sh.
#   LAND_PUSH_RETRIES, LAND_PUSH_SLEEP — 3 and 5s. The test suite shortens the
#                                        sleep; nothing in production sets them.
#
# THE CHECKS run before each commit, from the ledger worktree that holds
# `.agents/checks/` (the workbench's): decision records, integration manifests
# (when that checker exists), skill manifests, secrets and standards citations.
#
# THE DEPLOY CHECK is off unless the repo carries `.agents/deployable-prefixes.json`
# (a JSON array of path prefixes whose push deploys something). With it, a
# landing that touched one of those paths runs `.agents/deploy/await-deploy-run.sh
# --sha <sha>` from the repo, which must confirm a deploy run started for it.
#
# peers:
#   .agents/skills/close/scripts/land.test.sh
#   .agents/skills/close/scripts/roadmap-merge.sh   (ROADMAP.md merges row by row)
#   .agents/skills/close/scripts/write-root.sh   (writes the ledger)
#   .agents/checks/check-decision-records.sh     (run before each commit)
#   .agents/checks/check-integration-manifest.sh (run before each commit, when present)
#   .agents/checks/check-scripts.sh              (run before each commit)
#   .agents/checks/check-skills.sh               (run before each commit)
#   .agents/checks/check-secrets.sh              (run before each commit, when present)
#   .agents/checks/check-standards-refs.sh       (run before each commit, when present)
#   .agents/deploy/await-deploy-run.sh           (polled, per repo, on landing — opt-in)
#   .agents/skills/close/scripts/lock.sh         (the per-repo lock)
#
# Exit: 0 landed and checked (the line on stdout) · 2 no thread · 3 NOT CLOSED

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091  # a sibling file, resolved at run time
source "${SCRIPT_DIR}/lock.sh"
THREAD="${SCRIPT_DIR}/thread.sh"
WRITE_ROOT="${SCRIPT_DIR}/write-root.sh"
TRUNK_SH="${SCRIPT_DIR}/trunk.sh"
NEXT_COMMAND="${SCRIPT_DIR}/next-implement-command.sh"

PUSH_RETRIES="${LAND_PUSH_RETRIES:-3}"
PUSH_SLEEP="${LAND_PUSH_SLEEP:-5}"

MODE="land"
VERBOSE=0
SUBJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)   MODE="check"; shift ;;
    --gate)    MODE="gate"; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -*)        echo 'usage: land.sh "<subject>" | --check [--verbose] | --gate' >&2; exit 2 ;;
    *)         SUBJECT="$1"; shift ;;
  esac
done

# NOT CLOSED is the one phrase the skill looks for, so every refusal uses it and
# nothing else prints it.
not_closed() {
  echo "NOT CLOSED: $*"
  exit 3
}

die() { echo "land: $*" >&2; exit 2; }

TID="$(bash "${THREAD}" --id 2>&1)" || die "${TID#thread: }"

STATE="${HOME}/.cache/workbench/threads/${TID}"
LEDGER="${STATE}/worktrees"
LANDED="${STATE}/landed"
JOURNAL_REF="${STATE}/journal"
CLOSED="${STATE}/closed"
DEPLOY_LOG="${STATE}/deploy.log"
NEXT_REF="${STATE}/next"
mkdir -p "${STATE}"

# ── The auto-close gate ────────────────────────────────────────────────────
#
# It answers "has this session already been closed, with nothing written
# since?" — rather than "did some skill dispatch a close at some point".
#
# WHY THE MARKER ALONE IS NOT THE ANSWER. A bare per-thread marker is a
# session-wide latch: the first producer skill to close in a session would
# suppress every later auto-close in it and strand the rest of the session's
# work uncommitted. A session keeps working after a close — /spec, then
# /implement, then a standalone /implement-audit — and a later edit
# legitimately needs a second one. So the marker is treated as STALE the moment
# any worktree has something in it again — which is the same condition the
# third check below tests, and needs no key.
if [ "${MODE}" = "gate" ]; then
  if [ ! -f "${CLOSED}" ] || [ ! -f "${LEDGER}" ]; then
    echo "not-fired"
    exit 0
  fi
  while IFS=$'\t' read -r WT _SHARED _BRANCH; do
    [ -n "${WT:-}" ] || continue
    [ -d "${WT}" ] || continue
    # An unreadable worktree is not a clean one: the close runs.
    if ! _GATE_ST="$(git -C "${WT}" status --porcelain 2>/dev/null)" || [ -n "${_GATE_ST}" ]; then
      echo "not-fired"
      exit 0
    fi
    # The gate runs BEFORE `trunk_of` is defined, so it resolves inline. An
    # unresolvable trunk reports `not-fired` through the `|| echo 0` below,
    # which is the safe direction: the gate's job is to prove there is nothing
    # left, and a repo it cannot read is not a repo it can vouch for.
    _GT="$(bash "${TRUNK_SH}" "${WT}" 2>/dev/null || true)"
    if [ -z "${_GT}" ]; then
      echo "not-fired"
      exit 0
    fi
    if [ "$(git -C "${WT}" rev-list --count "origin/${_GT}..HEAD" 2>/dev/null || echo 0)" != "0" ]; then
      echo "not-fired"
      exit 0
    fi
  done <"${LEDGER}"
  echo "fired"
  exit 0
fi

# A successful prior close starts a new reporting window. Keep the log when a
# landing failed (there is no CLOSED marker), because its retry must still
# report deployments completed before the failure. Once a close succeeded,
# carrying that log into later work falsely attributes old deployments to the
# new close.
if [ "${MODE}" = "land" ] && [ -f "${CLOSED}" ]; then
  : >"${DEPLOY_LOG}"
  rm -f "${CLOSED}"
fi

# SEED THE LEDGER WITH THE THREAD'S OWN WORKTREE, exactly as verify.sh does.
# A session that only ever edited the tree its harness handed it has never called the
# resolver — nothing needed to ask where to write. Its ledger is empty, and
# without this the close refuses with "owns no worktrees" while the work sits
# right there uncommitted. Whichever step runs first seeds it; the resolver is
# idempotent, so the second one is free. Deliberately after the gate above,
# which is a read-only question and must create nothing.
T3_WT_SEED="$(bash "${THREAD}" --worktree 2>/dev/null || true)"
if [ -n "${T3_WT_SEED}" ] && [ -d "${T3_WT_SEED}" ]; then
  bash "${WRITE_ROOT}" "${T3_WT_SEED}" >/dev/null 2>&1 || true
fi

[ -f "${LEDGER}" ] || die "this thread owns no worktrees — nothing to land"
[ "${MODE}" = "check" ] || [ -n "${SUBJECT}" ] || die "a commit subject is required"

# THE WORKTREE THAT HOLDS THE JOURNAL is told from the others by the journal
# path itself: journal-file.sh records `<worktree>/journal/<date>/<file>`, and
# the ledger row whose worktree that path starts with is the one whose entry
# has to reach the trunk and whose SHA the last line quotes. The path is the
# answer; no second lookup is needed.
holds_journal() {  # holds_journal <worktree>
  [ -f "${JOURNAL_REF}" ] || return 1
  local p
  p="$(head -n 1 "${JOURNAL_REF}")"
  [ -n "${p}" ] || return 1
  case "${p}" in "$1/journal/"*) return 0 ;; esac
  return 1
}

# RESOLVED ONCE, HERE, BEFORE ANYTHING IS REMOVED — and this is load-bearing.
# These scripts live in the workbench, and a thread opened on a product repo
# holds the workbench as a SATELLITE — one of the worktrees this run removes.
# Every later `bash "${THREAD}"` would then read a file that is no longer there,
# return empty under its own `|| true`, and the own-worktree guard below would
# compare against "" and remove the harness's worktree instead of skipping it.
# The rule holds because the worktree these scripts run from is still one this
# run may remove at the end.
#
# NO_OWN_WORKTREE is the one EMPTY answer that is definite: a session outside
# T3 that started in the main checkout has no worktree of its own (thread.sh
# says so), so every worktree in its ledger is one write-root.sh made and may go.
NO_OWN_WORKTREE=0
T3_WORKTREE="$(bash "${THREAD}" --worktree 2>"${STATE}/own.err" || true)"
if [ -z "${T3_WORKTREE}" ] && grep -q "has no worktree recorded" "${STATE}/own.err" 2>/dev/null; then
  NO_OWN_WORKTREE=1
fi
rm -f "${STATE}/own.err"

# Capture the project's deterministic next command while the worktree holding
# the records still exists. Landing removes it when it is a satellite, and
# asking the model to run the generator later is exactly how a required Next
# line was omitted. A journal without a project is a one-off close and
# legitimately has no Next field.
NEXT_OUTPUT=""
[ -f "${NEXT_REF}" ] && NEXT_OUTPUT="$(cat "${NEXT_REF}")"
if [ -f "${JOURNAL_REF}" ]; then
  JOURNAL_PATH="$(head -n 1 "${JOURNAL_REF}")"
  if [ -f "${JOURNAL_PATH}" ]; then
    PROJECT_REF="$(sed -nE 's/^project:[[:space:]]*(.+)[[:space:]]*$/\1/p' "${JOURNAL_PATH}" | head -n 1)"
    PROJECT_REF="${PROJECT_REF%\"}"; PROJECT_REF="${PROJECT_REF#\"}"
    PROJECT_REF="${PROJECT_REF%\'}"; PROJECT_REF="${PROJECT_REF#\'}"
    # `null` / `~` is YAML's null — the schema's one-off value — not a folder.
    case "${PROJECT_REF}" in null|Null|NULL|'~') PROJECT_REF="" ;; esac
    if [ -n "${PROJECT_REF}" ]; then
      RECORDS_WT="${JOURNAL_PATH%%/journal/*}"
      case "${PROJECT_REF}" in
        projects/*) PROJECT_PATH="${RECORDS_WT}/${PROJECT_REF}" ;;
        *)          PROJECT_PATH="${RECORDS_WT}/projects/${PROJECT_REF}" ;;
      esac
      NEXT_OUTPUT="$(bash "${NEXT_COMMAND}" "${PROJECT_PATH}" 2>&1)" \
        || not_closed "could not derive next action: ${NEXT_OUTPUT}"
      printf '%s\n' "${NEXT_OUTPUT}" >"${NEXT_REF}"
    fi
  fi
fi

# A worktree that HOLDS THESE SCRIPTS cannot be removed while they are running.
# Bash keeps reading an unlinked file, but the siblings this script shells out
# to are opened by name, every time. So self-removal is deferred to the very
# end, after the last helper call.
SCRIPT_WORKTREE=""
_probe="${SCRIPT_DIR}"
while [ "${_probe}" != "/" ] && [ -n "${_probe}" ]; do
  if [ -e "${_probe}/.git" ]; then
    SCRIPT_WORKTREE="${_probe}"
    break
  fi
  _probe="$(dirname "${_probe}")"
done
DEFERRED_REMOVALS=()

landed_sha_for() {
  [ -f "${LANDED}" ] || return 1
  local sha
  sha="$(awk -F'\t' -v s="$1" '$1 == s { print $2 }' "${LANDED}" | tail -n 1)"
  [ -n "${sha}" ] || return 1
  printf '%s' "${sha}"
}

# The journal path recorded by journal-file.sh, as a repo-relative path. Taken
# from the `journal/` segment rather than by stripping a worktree prefix,
# because by check time that worktree may already have been removed.
journal_rel() {
  [ -f "${JOURNAL_REF}" ] || return 1
  local p
  p="$(head -n 1 "${JOURNAL_REF}")"
  [ -n "${p}" ] || return 1
  case "${p}" in
    */journal/*) printf 'journal/%s' "${p##*/journal/}" ;;
    *) return 1 ;;
  esac
}

# wt_status <worktree> — sets WT_STATUS to its `git status --porcelain`, or the
# close stops. Read as `$(git status … 2>/dev/null)`, a failed read was empty,
# and empty is "clean": the work was never committed and the final check
# vouched for it. A variable, not stdout, so the NOT CLOSED line is never
# swallowed by a command substitution.
WT_STATUS=""
wt_status() {
  WT_STATUS="$(git -C "$1" status --porcelain 2>/dev/null)" \
    || not_closed "could not read the status of $1 — git failed; re-run"
}

# changed_paths <worktree> <base> <file> — what <worktree> changed since <base>,
# tracked changes plus untracked files, NUL-separated into <file>. The gates
# below read it. A git read that fails stops the close: read through a
# process substitution, its failure was invisible, and "could not list the
# change" became "nothing changed" — a gate that then saw nothing to check.
changed_paths() {
  local wt="$1" base="$2" out="$3"
  if ! git -C "${wt}" diff -z --name-only --no-renames "${base}" >"${out}" 2>/dev/null \
    || ! git -C "${wt}" ls-files -z --others --exclude-standard >>"${out}" 2>/dev/null; then
    rm -f "${out}"
    not_closed "could not list what ${wt} changed since ${base} — git failed; re-run"
  fi
}

# Does this worktree change a decision record that is still on disk? Asked only
# when no checker resolved, to tell "nothing to check" from "cannot check". The
# same file set check-decision-records.sh scans with `--since` — tracked
# changes since <base> plus untracked files, a `.md` directly inside a
# `decisions/` folder, not its README — so a close that only deletes or moves a
# record away, or edits a README, is not refused for want of a checker.
changed_decision_records() {
  local wt="$1" base="$2" p f rc=1
  f="$(mktemp)"
  changed_paths "${wt}" "${base}" "${f}"
  while IFS= read -r -d '' p; do
    [[ "${p}" =~ (^|/)decisions/[^/]+\.md$ ]] || continue
    [ "${p##*/}" != "README.md" ] || continue
    [ -f "${wt}/${p}" ] && { rc=0; break; }
  done <"${f}"
  rm -f "${f}"
  return "${rc}"
}

# The same question for integration manifests: an `integrations/<name>/README.md`
# changed since <base> and still on disk — the file set
# check-integration-manifest.sh scans with `--since`. Deleting an integration is
# not refused for want of a checker.
changed_integration_manifests() {
  local wt="$1" base="$2" p f rc=1
  f="$(mktemp)"
  changed_paths "${wt}" "${base}" "${f}"
  while IFS= read -r -d '' p; do
    [[ "${p}" =~ ^integrations/[^/]+/README\.md$ ]] || continue
    [ -f "${wt}/${p}" ] && { rc=0; break; }
  done <"${f}"
  rm -f "${f}"
  return "${rc}"
}

# The same question for scripts: a file check-scripts.sh would scan — under
# .agents/, with one of its five extensions — changed since <base>. `*.test.*`
# files count, and DELETED paths count: removing a script's only test is
# exactly the change the checker must see (the same reasoning as
# changed_skill_tree below), and a deleted script whose test survives is the
# checker's to judge, not this predicate's to wave through.
changed_scripts() {
  local wt="$1" base="$2" p
  while IFS= read -r -d '' p; do
    [[ "${p}" =~ ^\.agents/.*\.(sh|ts|mjs|js|py)$ ]] || continue
    return 0
  done < <(
    git -C "${wt}" diff -z --name-only --no-renames "${base}" 2>/dev/null
    git -C "${wt}" ls-files -z --others --exclude-standard 2>/dev/null
  )
  return 1
}

# The skills tree's own gate. `.agents/checks/check-skills.sh` checks the tree
# at `.agents/skills/` of the workbench, and scans by FOLDER: any
# path under `.agents/skills/<folder>/` changed since <base> — a SKILL.md, a state/
# file, a new folder — selects that folder, and a file directly under
# `.agents/skills/` or anywhere else in the repo selects nothing. That predicate is
# what decides whether the checker is run at all; the narrower one below (a
# SKILL.md itself) is what a worktree WITHOUT the checker is refused on. Both
# are scoped to `.agents/skills/`: when the tree was a repo of its own the predicate
# was "any top-level folder", and in this repo that would fire on every close,
# because every close changes `journal/`.
changed_skill_tree() {
  local wt="$1" base="$2" p f rc=1
  f="$(mktemp)"
  changed_paths "${wt}" "${base}" "${f}"
  while IFS= read -r -d '' p; do
    [[ "${p}" =~ ^\.agents/skills/[^/]+/ ]] || continue
    # The FOLDER has to exist, not the path: a deleted `state/_doc.md` is
    # exactly the change the checker must see. A whole folder deleted is a
    # skill removed, and the checker skips what is not on disk.
    local folder="${p#.agents/skills/}"
    [ -d "${wt}/.agents/skills/${folder%%/*}" ] && { rc=0; break; }
  done <"${f}"
  rm -f "${f}"
  return "${rc}"
}
changed_skill_manifests() {
  local wt="$1" base="$2" p f rc=1
  f="$(mktemp)"
  changed_paths "${wt}" "${base}" "${f}"
  while IFS= read -r -d '' p; do
    [[ "${p}" =~ ^\.agents/skills/[^/]+/SKILL\.md$ ]] || continue
    [ -f "${wt}/${p}" ] && { rc=0; break; }
  done <"${f}"
  rm -f "${f}"
  return "${rc}"
}

# refuse_on_check <checker> <worktree> <base> <what> — run one pre-commit
# checker over what <worktree> changed since <base>, and refuse the close with
# EVERY violation line printed, not just the first: one close per violation is
# the cost the checkers' accumulate-then-exit design exists to avoid.
refuse_on_check() {
  local check="$1" wt="$2" base="$3" what="$4" out
  if ! out="$(cd "${wt}" && bash "${check}" --since "${base}" 2>&1 >/dev/null)"; then
    if [ -z "${out}" ]; then
      not_closed "${what} rejected in ${wt}: ${check} exited non-zero with no message"
    fi
    printf '%s\n' "${out}" | sed 's/^/  /' >&2
    not_closed "${what} rejected in ${wt}: $(printf '%s\n' "${out}" | head -n 1) ($(printf '%s\n' "${out}" | wc -l | tr -d ' ') line(s) above)"
  fi
}

# ── Landing ────────────────────────────────────────────────────────────────

remove_worktree() {
  local WT="$1" SHARED="$2" BRANCH="$3"
  git -C "${SHARED}" worktree remove --force "${WT}" 2>/dev/null || rm -rf "${WT}"
  git -C "${SHARED}" worktree prune 2>/dev/null || true
  git -C "${SHARED}" branch -q -D "${BRANCH}" 2>/dev/null || true
  if git -C "${SHARED}" ls-remote --exit-code --heads origin "${BRANCH}" >/dev/null 2>&1; then
    git -C "${SHARED}" push -q origin --delete "${BRANCH}" 2>/dev/null || true
  fi
}

# THE TRUNK BRANCH IS ASKED FOR, PER REPO, NEVER SPELLED.
#
# Spelling it `main` is correct for most repos and wrong for any that predates
# the rename: a repo whose trunk is `master` would be refused by write-root.sh,
# landed by hand, and never seen here. The resolution lives in `trunk.sh` and
# the answer is memoized per repo, because `land_one` and the three checks each
# ask about the same repo more than once and `git symbolic-ref` should not be
# run eight times to learn one fact. The memo is `<repo>\t<trunk>` lines rather
# than an associative array, which bash 3.2 (macOS) does not have.
_TRUNK_CACHE=""

trunk_of() {
  local repo="$1" key answer
  key="$(cd "${repo}" 2>/dev/null && pwd -P || printf '%s' "${repo}")"
  answer="$(printf '%s' "${_TRUNK_CACHE}" | awk -F'\t' -v k="${key}" '$1 == k { print $2; exit }')"
  if [ -n "${answer}" ]; then
    printf '%s\n' "${answer}"
    return 0
  fi
  answer="$(bash "${TRUNK_SH}" "${repo}" 2>/dev/null)" || return 1
  _TRUNK_CACHE="${_TRUNK_CACHE}${key}"$'\t'"${answer}"$'\n'
  printf '%s\n' "${answer}"
}

# The worktrees whose removal waits until after the final check: the one these
# scripts run from, and the one holding the checkers. Asked both when a
# satellite lands and when a re-run finds it already landed.
removal_is_deferred() {
  { [ -n "${SCRIPT_WORKTREE}" ] && [ "$1" = "${SCRIPT_WORKTREE}" ]; } \
    || { [ -n "${DR_CHECK_WT}" ] && [ "$1" = "${DR_CHECK_WT}" ]; } \
    || { [ -n "${IM_CHECK_WT}" ] && [ "$1" = "${IM_CHECK_WT}" ]; } \
    || { [ -n "${SEC_CHECK_WT}" ] && [ "$1" = "${SEC_CHECK_WT}" ]; } \
    || { [ -n "${STD_CHECK_WT}" ] && [ "$1" = "${STD_CHECK_WT}" ]; } \
    || { [ -n "${SC_CHECK_WT}" ] && [ "$1" = "${SC_CHECK_WT}" ]; }
}

# register_roadmap_merge <worktree> — wire roadmap-merge.sh into this repo's
# merges of ROADMAP.md and of a project README (its `next:` line): the driver in its config (a driver cannot be committed — git reads it
# only from config), and the attribute in its info/attributes, so every repo a
# close merges gets it without carrying a .gitattributes of its own. Both are
# rewritten on each close, so a moved checkout of this script never leaves a
# stale path behind. Best effort: without it the merge is git's own, as before.
register_roadmap_merge() {
  local wt="$1" attrs
  git -C "${wt}" config merge.roadmap.name "ROADMAP.md, row by row" 2>/dev/null || return 0
  git -C "${wt}" config merge.roadmap.driver \
    "bash '${SCRIPT_DIR}/roadmap-merge.sh' %O %A %B %P" 2>/dev/null || return 0
  attrs="$(git -C "${wt}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)/info/attributes" \
    || return 0
  mkdir -p "$(dirname "${attrs}")" 2>/dev/null || return 0
  local line
  for line in 'ROADMAP.md merge=roadmap' 'projects/**/README.md merge=roadmap'; do
    grep -qxF "${line}" "${attrs}" 2>/dev/null \
      || printf '%s\n' "${line}" >>"${attrs}" 2>/dev/null || true
  done
}

# resync_next <worktree> <trunk ref> — re-derive `next:` for every project whose
# ROADMAP.md OR README.md this push changes against the trunk. That is the
# whole invariant: a push never changes a project's table or README without the
# README's `next:` matching the table that lands. Both files, because either
# side of a merge can be the stale one — two sessions each derived `next:` from
# their own copy of the table, and when only the trunk moved the table while
# this branch touched only the README, the README merge keeps OUR `next:` over
# a table ours never saw. It runs before EVERY push, not only after a merge: a
# failed re-derive leaves the merge committed, and a re-run that sees nothing
# left to merge must not push past it. Re-deriving a `next:` that is already
# right changes nothing. A project whose re-derive fails stops the close:
# pushing would ship a README whose `next:` names the wrong row.
resync_next() {
  local wt="$1" base="$2" path dir changed="" why paths
  # Read first and checked: a diff that fails must not read as "nothing to
  # re-derive" and let the push through.
  paths="$(git -C "${wt}" diff --name-only "${base}" HEAD -- '*ROADMAP.md' '*README.md')" \
    || not_closed "could not list the projects this push changes in ${wt}"
  while IFS= read -r dir; do
    [ -n "${dir}" ] || continue
    # Only a project with a table has a next: to derive — and a table this push
    # deletes has none.
    [ -f "${wt}/${dir}/ROADMAP.md" ] && [ -f "${wt}/${dir}/README.md" ] || continue
    if why="$(bash "${SCRIPT_DIR}/roadmap.sh" "${wt}/${dir}" --sync-next 2>&1 >/dev/null)"; then
      git -C "${wt}" diff --quiet -- "${dir}/README.md" || changed="${changed} ${dir}/README.md"
    else
      not_closed "next: could not be re-derived for ${dir}: $(printf '%s\n' "${why}" | tail -n 1) — fix the table in ${wt}, then re-run"
    fi
  done < <(printf '%s\n' "${paths}" | while IFS= read -r path; do
             [ -n "${path}" ] && dirname "${path}"; done | sort -u)
  [ -n "${changed}" ] || return 0
  # shellcheck disable=SC2086  # the list is repo-relative paths with no spaces
  if ! git -C "${wt}" add -- ${changed} \
    || ! git -C "${wt}" commit -q -m "${SUBJECT} (next: re-derived from the merged table)"; then
    not_closed "could not commit the re-derived next: in ${wt}"
  fi
}

land_one() {
  local WT="$1" SHARED="$2" BRANCH="$3"

  # An obligation is never dropped. A worktree that vanished before it was
  # landed took uncommitted or unpushed work with it, and the close must say so
  # rather than quietly closing without it.
  if [ ! -d "${WT}" ]; then
    if landed_sha_for "${SHARED}" >/dev/null; then
      return 0
    fi
    not_closed "worktree missing before landing: ${WT}"
  fi

  # Already landed AND nothing has happened since. Both halves are needed. A
  # partly-failed close re-runs through here and must not re-land what it
  # already landed — but a session that kept working after its close (the
  # mid-graph callers do exactly that) has new commits, and skipping on the
  # mere PRESENCE of a SHA would strand them with no warning at all.
  local PREV
  if PREV="$(landed_sha_for "${SHARED}")"; then
    wt_status "${WT}"
    if [ "${PREV}" = "$(git -C "${WT}" rev-parse HEAD 2>/dev/null)" ] \
      && [ -z "${WT_STATUS}" ]; then
      # A DEFERRED satellite landed on an earlier run that then failed before
      # the end, so its removal never happened. Queue it again, or the retry
      # that succeeds leaves it and its branch on disk under the proof line.
      if [ -n "${T3_WORKTREE}" ] && [ "${WT}" != "${T3_WORKTREE}" ] \
        && removal_is_deferred "${WT}"; then
        DEFERRED_REMOVALS+=("${WT}"$'\t'"${SHARED}"$'\t'"${BRANCH}")
      fi
      return 0
    fi
  fi

  # ONE LOCK PER REPO, the same one write-root.sh takes and any automated
  # committer should, so a close and an automation cannot interleave a merge and
  # a push on one remote. flock(1) where it exists, a portable lock where not.
  local LOCK
  LOCK="/tmp/$(basename "${SHARED}")-git.lock"
  if ! lock_repo "${LOCK}" 120; then
    not_closed "could not take ${LOCK} within 120s — another writer holds it"
  fi

  # AN UNRESOLVED CONFLICT IS NOT "DIRTY", IT IS UNFINISHED. A close that
  # conflicted left the worktree with unmerged index entries and the markers in
  # the files. Re-running lands here, where `git add -A` would mark every one of
  # them resolved and commit `<<<<<<<` straight to the trunk — the close
  # would then print the safe-to-close line over a corrupted tree. The conflict
  # test covers the retry as well as the first run for this reason.
  local UNMERGED
  UNMERGED="$(git -C "${WT}" diff --name-only --diff-filter=U 2>/dev/null)"
  if [ -n "${UNMERGED}" ]; then
    not_closed "unresolved conflict in ${WT}: $(printf '%s' "${UNMERGED}" | tr '\n' ' ')— resolve it, then re-run"
  fi

  # THE JOURNAL ENTRY GATE. This is the last point before an entry is committed:
  # front matter a reader cannot parse makes the session invisible to anything
  # that reads the journal rather than loud, and a body outside journal-entry.md's schema
  # is the decision prose the schema exists to stop, so both are checked
  # before the commit, not after. Only the worktree holding the journal path
  # is asked — the workbench row, whichever repo the thread was opened on.
  #
  # A MISSING CHECKER REFUSES, it does not skip. A `[ -f "${FM_CHECK}" ]` guard
  # would turn the gate off with no word said the day the script is renamed or
  # not shipped — the same silent `[ -f ]` the decision-record gate below
  # refuses to copy. An entry about to be committed
  # with no checker on disk is a close that cannot say it checked.
  local FM_CHECK="${SCRIPT_DIR}/check-journal-entry.sh"
  if holds_journal "${WT}"; then
    local JREL
    if JREL="$(journal_rel)" && [ -f "${WT}/${JREL}" ]; then
      [ -f "${FM_CHECK}" ] || not_closed "journal check missing: ${FM_CHECK}"
      if ! (cd "${WT}" && bash "${FM_CHECK}" "${JREL}"); then
        not_closed "journal entry fails the schema: ${WT}/${JREL}"
      fi
    fi
  fi

  # THE DECISION-RECORD GATE: check-decision-records.sh, over the records this
  # worktree changed. Before the commit for the same reason as the journal gate
  # above — once `git add -A` runs, a malformed record is on its way to the
  # trunk — but for EVERY repo, not just the records one: a `decisions/` folder
  # lives at a repo root, a project folder or a product repo alike.
  #
  # It FAILS rather than skips when records changed and no checker resolved.
  # A silent `[ -f ]` guard is how a check goes quiet the day its script moves; a
  # gate that stops firing without a word is worse than none, because the close
  # still reads as checked.
  # Nothing changed means nothing to check, so an unresolvable checker costs
  # that close nothing.
  #
  # The checker is resolved once from the ledger's WORKTREES (DR_CHECK, below),
  # never from a shared checkout: a shared checkout is fast-forwarded only after
  # its commit, and only when clean, so the close that ADDS the script could
  # never see it there.
  #
  # "Changed" is measured from where this branch left the trunk, NOT from HEAD:
  # /implement commits in the worktree before it closes, and a record already
  # committed differs from nothing at HEAD: measured from HEAD, a close would
  # count 0 records and land the record unchecked.
  #
  # Every path through this block falls through to the staging below. A
  # `return` here leaves land_one with nothing committed.
  #
  # The trunk is resolved and FETCHED here, ahead of the gate, rather than after
  # the commit where the merge below first needs it: `trunk.sh` can name a trunk
  # from origin/HEAD before `origin/<trunk>` exists locally, and only the fetch
  # creates it. Measuring from a ref that is not there would refuse every close.
  local TRUNK
  TRUNK="$(trunk_of "${SHARED}")" \
    || not_closed "no trunk branch in ${SHARED} (origin/HEAD unset and no origin/main or origin/master)"
  git -C "${WT}" fetch -q origin "${TRUNK}" 2>/dev/null \
    || not_closed "could not fetch origin/${TRUNK} for ${SHARED}"
  local DR_BASE
  DR_BASE="$(git -C "${WT}" merge-base HEAD "origin/${TRUNK}" 2>/dev/null)" \
    || not_closed "git merge-base HEAD origin/${TRUNK} failed in ${WT}, so its decision records cannot be scoped"
  if [ -n "${DR_CHECK}" ]; then
    refuse_on_check "${DR_CHECK}" "${WT}" "${DR_BASE}" "decision record"
  elif changed_decision_records "${WT}" "${DR_BASE}"; then
    not_closed "decision records changed in ${WT}, but no worktree this thread owns holds ${DR_CHECK_REL} — run write-root.sh on the workbench checkout, then close again"
  fi

  # THE INTEGRATION-MANIFEST GATE: check-integration-manifest.sh, over the
  # integrations/*/README.md this worktree changed, the same way as the
  # decision-record gate above — when the workbench ships that checker. A
  # workbench without one has no manifest schema to hold them to, so a changed
  # manifest is reported, not refused.
  if [ -n "${IM_CHECK}" ]; then
    refuse_on_check "${IM_CHECK}" "${WT}" "${DR_BASE}" "integration manifest"
  elif changed_integration_manifests "${WT}" "${DR_BASE}"; then
    echo "  note: integration manifests changed in ${WT}; no ${IM_CHECK_REL} to check them"
  fi

  # THE SCRIPT-TESTS GATE: check-scripts.sh, over the scripts this worktree
  # changed — every one must carry a paired test, and a program's test must run
  # it rather than import it. Same shape and reasons as the two gates above;
  # every repo is asked, and one with no .agents/ has nothing for it to check.
  if [ -n "${SC_CHECK}" ]; then
    refuse_on_check "${SC_CHECK}" "${WT}" "${DR_BASE}" "script tests"
  elif changed_scripts "${WT}" "${DR_BASE}"; then
    not_closed "scripts changed in ${WT}, but no worktree this thread owns holds ${SC_CHECK_REL} — run write-root.sh on the workbench checkout, then close again"
  fi

  # THE SKILL-MANIFEST GATE: .agents/checks/check-skills.sh, over the skill folders
  # this worktree changed. The checker is the worktree's OWN file (it ships in
  # the same tree as the skills it checks), so there is no ledger lookup and no
  # deferred removal. A worktree branched from before the checker was there is
  # refused rather than landed unchecked, the way a missing workbench checker is.
  local SK_CHECK="${WT}/.agents/checks/check-skills.sh"
  if [ -f "${SK_CHECK}" ] && changed_skill_tree "${WT}" "${DR_BASE}"; then
    refuse_on_check "${SK_CHECK}" "${WT}" "${DR_BASE}" "skill manifest"
  elif [ ! -f "${SK_CHECK}" ] && changed_skill_manifests "${WT}" "${DR_BASE}"; then
    not_closed "skill manifests changed in ${WT}, but ${WT} holds no .agents/checks/check-skills.sh — merge origin/${TRUNK} into the branch, then close again"
  fi

  # THE SECRETS GATE: check-secrets.sh over what this worktree changed, for
  # every repo, from the workbench worktree that holds the checks. A credential
  # committed is a credential leaked, whichever repo it lands in.
  if [ -n "${SEC_CHECK}" ]; then
    refuse_on_check "${SEC_CHECK}" "${WT}" "${DR_BASE}" "secret scan"
  fi

  # THE STANDARDS GATE: every `§ Standards → <Name>` citation in the workbench
  # names a bullet that exists. Only the worktree that carries AGENTS.md's
  # Standards — the one holding this checker — is asked; the checker reads the
  # tracked tree, not a range.
  if [ -n "${STD_CHECK}" ] && [ "${WT}" = "${STD_CHECK_WT}" ]; then
    local STD_OUT
    if ! STD_OUT="$(cd "${WT}" && bash "${STD_CHECK}" 2>&1 >/dev/null)"; then
      printf '%s\n' "${STD_OUT}" | sed 's/^/  /' >&2
      not_closed "standards citations rejected in ${WT}: $(printf '%s\n' "${STD_OUT}" | head -n 1)"
    fi
  fi

  wt_status "${WT}"
  if [ -n "${WT_STATUS}" ]; then
    git -C "${WT}" add -A || not_closed "could not stage ${WT}"
    git -C "${WT}" commit -q -m "${SUBJECT}" || not_closed "could not commit ${WT}"
  fi

  # THE JOURNAL NAME, RE-CHECKED. journal-file.sh already looked at the trunk,
  # but another thread may have landed the same name in the minutes since. Two
  # sessions' entries merging into one path is the shared-write failure the
  # one-file-per-session shape exists to remove, so this renames rather than
  # merges.
  if holds_journal "${WT}"; then
    local REL
    if REL="$(journal_rel)"; then
      # "THE NAME IS TAKEN" MUST MEAN TAKEN BY SOMEBODY ELSE. A close that runs
      # twice — a failed Land, or a correction to an entry already pushed —
      # finds its OWN file sitting on the trunk, and a bare existence test
      # reads that as a collision and renames it: the second run would move this
      # session's landed entry to `-2` for no reason, and a third to `-3`.
      #
      # The question is whose commit put it there. If the commit that last
      # touched that path on the trunk is an ancestor of this worktree's
      # HEAD, it is ours — we pushed it. Anyone else's is not.
      local OWNER=""
      if git -C "${WT}" cat-file -e "origin/${TRUNK}:${REL}" 2>/dev/null; then
        OWNER="$(git -C "${WT}" rev-list -1 "origin/${TRUNK}" -- "${REL}" 2>/dev/null || true)"
      fi
      if [ -n "${OWNER}" ] \
        && ! git -C "${WT}" merge-base --is-ancestor "${OWNER}" HEAD 2>/dev/null; then
        local DIR BASE STEM N NEWREL
        DIR="$(dirname "${REL}")"
        BASE="$(basename "${REL}" .md)"
        STEM="${BASE}"
        N=1
        while :; do
          N=$((N + 1))
          NEWREL="${DIR}/${STEM}-${N}.md"
          git -C "${WT}" cat-file -e "origin/${TRUNK}:${NEWREL}" 2>/dev/null && continue
          [ -e "${WT}/${NEWREL}" ] && continue
          break
        done
        git -C "${WT}" mv "${REL}" "${NEWREL}" \
          || not_closed "could not rename ${REL} around a collision"
        git -C "${WT}" commit -q -m "${SUBJECT} (journal renamed around a collision)" \
          || not_closed "could not commit the journal rename"
        printf '%s\n' "${WT}/${NEWREL}" >"${JOURNAL_REF}"
        echo "  journal renamed: ${REL} was taken on origin/${TRUNK}, using ${NEWREL}"
      fi
    fi
  fi

  # NO REBASE AND NO PULL. A conflict halts with both sides intact in this
  # thread's own worktree; re-running the close reclaims it and resumes here.
  #
  # ROADMAP.md MERGES ROW BY ROW. Two sessions landing two rows of one project
  # each flip their own row, and git's line merge calls two adjacent rows a
  # conflict — so the second of two parallel closes always stopped here. The
  # driver merges the table by row ID and still conflicts on a real clash.
  register_roadmap_merge "${WT}"
  if ! git -C "${WT}" merge-base --is-ancestor "origin/${TRUNK}" HEAD 2>/dev/null; then
    if ! git -C "${WT}" merge -q --no-edit "origin/${TRUNK}" 2>/dev/null; then
      not_closed "conflict in ${WT}"
    fi
  fi
  # Every attempt, not only the one that merged: a re-run after a failed
  # re-derive finds trunk already merged, and must not push past it.
  resync_next "${WT}" "origin/${TRUNK}"

  # NOTHING TO PUSH IS NOT A FAILED PUSH. A thread's own worktree is in the
  # ledger whether or not the session wrote to it, and a satellite is opened
  # on the first write — so a worktree that saw no work sits exactly on the
  # trunk. Pushing it is a harmless no-op everywhere except against a repo
  # that refuses writes at all — an archived repo rejects even an empty push,
  # so every close of a thread opened on one would die here while the session's
  # real work sat committed and unpushed in the other worktrees.
  #
  # The test is HEAD against the freshly fetched trunk, NOT "did this
  # session write files": a worktree carrying commits still pushes them, and a
  # repo that went archived mid-flight with work in it must still fail loudly
  # rather than be silently skipped.
  #
  # It skips the push ONLY. The satellite removal and the final all-clear below
  # still run, so a no-work worktree is cleaned up exactly like any other.
  # Where the trunk stood before this push, for the owed-run rule below: the
  # landed diff is `TRUNK_BEFORE..SHA`, and it is what the deployer saw.
  local TRUNK_BEFORE
  TRUNK_BEFORE="$(git -C "${WT}" rev-parse "origin/${TRUNK}" 2>/dev/null || true)"
  if [ "$(git -C "${WT}" rev-parse HEAD 2>/dev/null)" \
    = "$(git -C "${WT}" rev-parse "origin/${TRUNK}" 2>/dev/null)" ]; then
    echo "  ${SHARED}: nothing to push (already at origin/${TRUNK})"
  else
    local attempt=1
    while :; do
      git -C "${WT}" push -q origin "HEAD:${TRUNK}" 2>/dev/null && break
      if [ "${attempt}" -ge "${PUSH_RETRIES}" ]; then
        # The SHA is deliberately NOT persisted: the work is committed and the
        # worktree is intact, so the next close lands it.
        not_closed "push of ${SHARED} failed"
      fi
      attempt=$((attempt + 1))
      sleep "${PUSH_SLEEP}"
    done
  fi

  local SHA
  SHA="$(git -C "${WT}" rev-parse HEAD)"
  printf '%s\t%s\n' "${SHARED}" "${SHA}" >>"${LANDED}"

  # Release before the slow parts: the deploy can take minutes and holds up
  # every other writer on this repo for no reason.
  lock_repo_release "${LOCK}"

  # ── The shared checkout, best effort ────────────────────────────────────
  # The trunk on the remote is the truth. The shared tree is a convenience, and one that
  # another session may have dirty or on another branch.
  if [ -d "${SHARED}/.git" ] || [ -f "${SHARED}/.git" ]; then
    local SHARED_BRANCH SHARED_DIRTY
    SHARED_BRANCH="$(git -C "${SHARED}" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    # Unreadable counts as dirty: the shared tree is then left alone.
    SHARED_DIRTY="$(git -C "${SHARED}" status --porcelain 2>/dev/null)" || SHARED_DIRTY="(status unreadable)"
    SHARED_DIRTY="${SHARED_DIRTY%%$'\n'*}"
    if [ "${SHARED_BRANCH}" != "${TRUNK}" ]; then
      echo "  shared checkout ${SHARED} not advanced (on ${SHARED_BRANCH}, not ${TRUNK})"
    elif [ -n "${SHARED_DIRTY}" ]; then
      echo "  shared checkout ${SHARED} not advanced (uncommitted changes)"
    else
      git -C "${SHARED}" fetch -q origin "${TRUNK}" 2>/dev/null || true
      git -C "${SHARED}" merge --ff-only -q "origin/${TRUNK}" 2>/dev/null \
        || echo "  shared checkout ${SHARED} not advanced (fast-forward refused)"
    fi
    # A THREE-CONDITION `SHARED_HAS_LANDED` FLAG USED TO BE COMPUTED HERE, and
    # it is gone rather than kept for a future reader. It existed to answer one
    # question — is this checkout safe to BUILD from — and that question stopped
    # being asked when the deploy moved to its own tree. The three `not advanced`
    # lines above already report every shape of drift it could detect, so what
    # is left is the reporting and none of the branching.
  fi

  # ── Check that the push deployed — do NOT deploy ────────────────────────
  #
  # OFF UNLESS THE REPO OPTS IN. A repo whose push deploys something (a CI
  # workflow, a webhook) says so by carrying `.agents/deployable-prefixes.json`:
  # a JSON array of the path prefixes whose change a push deploys. Without it
  # there is nothing to check, and this block is skipped.
  #
  # With it, the push is the deployer and this script only CHECKS. A merger
  # that deployed would deploy the shared checkout, which another session may
  # hold dirty; the push deploys the landed commit. But a push-triggered deploy
  # can be lost silently — a dropped webhook, a runner that is down — and
  # silence looks exactly like success. So a landing that starts no deploy run
  # is NOT CLOSED. The check is the repo's own `.agents/deploy/await-deploy-run.sh
  # --sha <sha>`: it prints one line and exits 0 when a deploy of that commit
  # started. Opting in without it is NOT CLOSED too — an opt-in nobody can check
  # is the silent case again.
  #
  # AND ONLY FOR A PUSH THAT CAN DEPLOY SOMETHING. A close that wrote only its
  # journal would otherwise wait on a run nothing starts. The list is read out
  # of the LANDED commit, never the shared checkout's working tree, and the
  # check runs only when the landed paths match. THE PATHS ARE THE DEPLOYER'S
  # PATHS: the union of every commit's files in the pushed range (`git log
  # --name-only`), which is what a push event carries, plus the net diff. A file
  # added in one commit and deleted in the next is in that union and starts a
  # run, while the net diff alone would call the landing not owed. The list is
  # JSON-parsed in node, not grepped; a prefix matches at the start of a path
  # and nowhere else. Anything this cannot read — unparseable JSON, no range, no
  # node — checks, rather than skips: skipping on an unknown is the one way a
  # deployed-nothing close ships stale under a green report.
  local LIST_REL=".agents/deployable-prefixes.json"
  local LIST_JSON=""
  if LIST_JSON="$(git -C "${WT}" show "${SHA}:${LIST_REL}" 2>/dev/null)"; then
    local AWAIT="${WT}/.agents/deploy/await-deploy-run.sh"
    local OWED="poll"
    if [ -n "${TRUNK_BEFORE}" ]; then
      local DIFF TOUCHED DECISION
      if DIFF="$(git -C "${WT}" diff --name-only "${TRUNK_BEFORE}" "${SHA}" 2>/dev/null)" \
        && TOUCHED="$(git -C "${WT}" log --format= --name-only "${TRUNK_BEFORE}..${SHA}" 2>/dev/null)"; then
        DECISION="$(printf '%s\n%s\n' "${DIFF}" "${TOUCHED}" | LIST_JSON="${LIST_JSON}" node -e '
          let prefixes;
          try { prefixes = JSON.parse(process.env.LIST_JSON); } catch { process.exit(2); }
          if (!Array.isArray(prefixes) || prefixes.length === 0
              || !prefixes.every((p) => typeof p === "string" && p.length > 0)) process.exit(2);
          const paths = require("node:fs").readFileSync(0, "utf8").split("\n").filter(Boolean);
          process.stdout.write(paths.some((p) => prefixes.some((x) => p.startsWith(x))) ? "owed" : "not-owed");
        ' 2>>"${DEPLOY_LOG}")" || DECISION="poll"
        [ "${DECISION}" = "not-owed" ] && OWED="no"
      fi
    fi
    if [ "${OWED}" = "no" ]; then
      local NOT_OWED="deploy: not owed (no deployable path)"
      printf '%s\n' "${NOT_OWED}" >>"${DEPLOY_LOG}"
      echo "  ${NOT_OWED}"
    elif [ ! -f "${AWAIT}" ]; then
      not_closed "deploy: ${SHARED} carries ${LIST_REL} but no .agents/deploy/await-deploy-run.sh to confirm the deploy of ${SHA}"
    else
      local DEPLOY_LINE=""
      local DEPLOY_RC=0
      DEPLOY_LINE="$(bash "${AWAIT}" --sha "${SHA}" 2>>"${DEPLOY_LOG}")" || DEPLOY_RC=$?
      [ -n "${DEPLOY_LINE}" ] && printf '%s\n' "${DEPLOY_LINE}" >>"${DEPLOY_LOG}"
      if [ "${DEPLOY_RC}" -ne 0 ]; then
        not_closed "${DEPLOY_LINE:-deploy: could not read the run for ${SHA}} — ${SHARED} is on origin but nothing deployed it"
      fi
      echo "  ${DEPLOY_LINE}"
    fi
  fi

  # ── Remove the satellite, never the harness's own worktree ──────────────
  # The harness made that one (T3's thread worktree, a `claude -w` one),
  # checkpoints into it, and reaps it itself. The comparison
  # is against the value resolved at startup, NOT a fresh lookup: by the time
  # the second repo lands, the helper that lookup needs may already have been
  # removed with the first one.
  if [ -n "${T3_WORKTREE}" ] && [ "${WT}" = "${T3_WORKTREE}" ]; then
    echo "  landed ${SHARED} at ${SHA}"
    return 0
  fi

  # The own worktree could not be identified at all. Removing on "it is not the
  # empty string" would remove the harness's worktree whenever the lookup
  # failed; refusing to remove is the safe direction, since a leftover worktree
  # costs disk and a wrongly removed one costs the thread. A session with NO
  # own worktree (it started in the main checkout) is a definite answer, not a
  # failed lookup, and its satellites go like any other.
  if [ -z "${T3_WORKTREE}" ] && [ "${NO_OWN_WORKTREE}" != 1 ]; then
    echo "  kept ${WT} — could not confirm it is not the harness's own worktree" >&2
    echo "  landed ${SHARED} at ${SHA}"
    return 0
  fi

  if removal_is_deferred "${WT}"; then
    # This is the worktree these scripts are running from, or the one holding
    # the decision-record checker. Removing the first now would pull thread.sh
    # and write-root.sh out from under the rest of the run; removing the second
    # would leave every repo landed after it with no checker, and a re-run after
    # any later failure with none either. Both go last, after the final check.
    DEFERRED_REMOVALS+=("${WT}"$'\t'"${SHARED}"$'\t'"${BRANCH}")
  else
    remove_worktree "${WT}" "${SHARED}" "${BRANCH}"
  fi

  echo "  landed ${SHARED} at ${SHA}"
}

LEDGER_LINES=()
while IFS= read -r line; do
  [ -n "${line}" ] && LEDGER_LINES+=("${line}")
done <"${LEDGER}"

# The shared checkout of the row that holds the journal, RESOLVED FROM THE
# LEDGER BEFORE ANYTHING IS REMOVED: the checks below run after the worktree
# may be gone, and they need the repo — not the worktree — to ask the trunk
# whether the entry arrived. A rename around a collision keeps the path inside
# the same worktree, so this cannot go stale mid-run. Empty when no journal
# was allocated; a journal in no ledger row is refused in the checks below,
# because nothing would ever land it.
JOURNAL_SHARED=""
for line in ${LEDGER_LINES[@]+"${LEDGER_LINES[@]}"}; do
  IFS=$'\t' read -r _J_WT _J_SHARED _ <<<"${line}"
  [ -n "${_J_WT:-}" ] || continue
  if holds_journal "${_J_WT}"; then
    JOURNAL_SHARED="${_J_SHARED}"
    break
  fi
done

# The decision-record checker, RESOLVED ONCE, BEFORE ANYTHING IS REMOVED, for
# the same reason as T3_WORKTREE above. It lives in the workbench, so it is
# found in whichever ledger worktree is a workbench checkout — field 1 of each
# WT⇥SHARED⇥BRANCH line — and that worktree's removal is deferred to the end.
# The other checkers sit beside it in `.agents/checks/` and are resolved the
# same way, EACH ON ITS OWN: a worktree holding some of `.agents/checks/` must
# not hide a checker only a later ledger worktree carries.
DR_CHECK_REL=".agents/checks/check-decision-records.sh"
DR_CHECK=""
DR_CHECK_WT=""
IM_CHECK_REL=".agents/checks/check-integration-manifest.sh"
IM_CHECK=""
IM_CHECK_WT=""
SEC_CHECK=""
SEC_CHECK_WT=""
STD_CHECK=""
STD_CHECK_WT=""
SC_CHECK_REL=".agents/checks/check-scripts.sh"
SC_CHECK=""
SC_CHECK_WT=""
for line in ${LEDGER_LINES[@]+"${LEDGER_LINES[@]}"}; do
  IFS=$'\t' read -r _DR_WT _ _ <<<"${line}"
  [ -n "${_DR_WT:-}" ] || continue
  if [ -z "${DR_CHECK}" ] && [ -f "${_DR_WT}/${DR_CHECK_REL}" ]; then
    DR_CHECK="${_DR_WT}/${DR_CHECK_REL}"
    DR_CHECK_WT="${_DR_WT}"
  fi
  if [ -z "${IM_CHECK}" ] && [ -f "${_DR_WT}/${IM_CHECK_REL}" ]; then
    IM_CHECK="${_DR_WT}/${IM_CHECK_REL}"
    IM_CHECK_WT="${_DR_WT}"
  fi
  if [ -z "${SEC_CHECK}" ] && [ -f "${_DR_WT}/.agents/checks/check-secrets.sh" ]; then
    SEC_CHECK="${_DR_WT}/.agents/checks/check-secrets.sh"
    SEC_CHECK_WT="${_DR_WT}"
  fi
  if [ -z "${STD_CHECK}" ] && [ -f "${_DR_WT}/.agents/checks/check-standards-refs.sh" ]; then
    STD_CHECK="${_DR_WT}/.agents/checks/check-standards-refs.sh"
    STD_CHECK_WT="${_DR_WT}"
  fi
  if [ -z "${SC_CHECK}" ] && [ -f "${_DR_WT}/${SC_CHECK_REL}" ]; then
    SC_CHECK="${_DR_WT}/${SC_CHECK_REL}"
    SC_CHECK_WT="${_DR_WT}"
  fi
done

if [ "${MODE}" = "land" ]; then
  for line in ${LEDGER_LINES[@]+"${LEDGER_LINES[@]}"}; do
    IFS=$'\t' read -r WT SHARED BRANCH <<<"${line}"
    [ -n "${WT:-}" ] || continue
    land_one "${WT}" "${SHARED}" "${BRANCH}"
  done
fi

# ── The three checks ───────────────────────────────────────────────────────
#
# Run against a freshly fetched trunk in every repo, because every
# failure worth catching here is invisible against a stale ref.

[ -f "${LANDED}" ] || not_closed "nothing was landed"

LAST_SHA=""
JOURNAL_MAIN_SHA=""
JOURNAL_TRUNK=""
LAST_TRUNK=""
JOURNAL_LANDED=""

while IFS=$'\t' read -r SHARED SHA; do
  [ -n "${SHARED:-}" ] || continue
  # A RETIRED REPO. The ledger keeps every repo the thread ever landed in, so a
  # thread that closed into a repo since merged into another still lists a
  # checkout that no longer exists, and every later close of that thread would
  # refuse on it. A merge that keeps the history accounts for the landing: it
  # passes when its SHA is an ancestor of a surviving repo's trunk, and is
  # refused when it is on none.
  if ! git -C "${SHARED}" rev-parse --git-dir >/dev/null 2>&1; then
    FOUND=""
    while IFS=$'\t' read -r OTHER _; do
      [ -n "${OTHER:-}" ] && [ "${OTHER}" != "${SHARED}" ] || continue
      O_TRUNK="$(trunk_of "${OTHER}")" || continue
      git -C "${OTHER}" fetch -q origin "${O_TRUNK}" 2>/dev/null || continue
      if git -C "${OTHER}" merge-base --is-ancestor "${SHA}" "origin/${O_TRUNK}" 2>/dev/null; then
        FOUND="${OTHER}"
        break
      fi
    done <"${LANDED}"
    [ -n "${FOUND}" ] || not_closed "${SHARED} is gone and ${SHA} is on no surviving repo's trunk"
    [ "${VERBOSE}" = 1 ] && echo "$(basename "${SHARED}")  ${SHA}  retired, ancestor-of-$(basename "${FOUND}")"
    continue
  fi
  CHK_TRUNK="$(trunk_of "${SHARED}")" \
    || not_closed "no trunk branch in ${SHARED} to check against"
  git -C "${SHARED}" fetch -q origin "${CHK_TRUNK}" 2>/dev/null \
    || not_closed "could not re-fetch ${SHARED} to check it"
  if ! git -C "${SHARED}" merge-base --is-ancestor "${SHA}" "origin/${CHK_TRUNK}" 2>/dev/null; then
    not_closed "${SHA} is not on origin/${CHK_TRUNK} in ${SHARED}"
  fi
  MAIN_SHA="$(git -C "${SHARED}" rev-parse "origin/${CHK_TRUNK}")"
  LAST_SHA="${MAIN_SHA}"
  LAST_TRUNK="${CHK_TRUNK}"
  if [ -n "${JOURNAL_SHARED}" ] && [ "${SHARED}" = "${JOURNAL_SHARED}" ]; then
    JOURNAL_MAIN_SHA="${MAIN_SHA}"
    # The trunk the REPORT line names. It is the journal repo's, because that
    # is the repo whose SHA the line carries — naming another repo's trunk
    # beside that SHA would be a false sentence with a real SHA in it.
    JOURNAL_TRUNK="${CHK_TRUNK}"
  fi
  [ "${VERBOSE}" = 1 ] && echo "$(basename "${SHARED}")  ${SHA}  ancestor-of-origin/${CHK_TRUNK}"
done <"${LANDED}"

# The journal is checked by PATH, not by "a journal was written": a close that
# renamed the file around a collision has to prove the renamed one landed.
if REL="$(journal_rel)"; then
  [ -n "${JOURNAL_SHARED}" ] \
    || not_closed "${REL} is in no worktree this thread owns, so nothing landed it"
  if landed_sha_for "${JOURNAL_SHARED}" >/dev/null; then
    J_CHK_TRUNK="$(trunk_of "${JOURNAL_SHARED}")" \
      || not_closed "no trunk branch in ${JOURNAL_SHARED} to check the journal against"
    if ! git -C "${JOURNAL_SHARED}" cat-file -e "origin/${J_CHK_TRUNK}:${REL}" 2>/dev/null; then
      not_closed "${REL} is not on origin/${J_CHK_TRUNK} in ${JOURNAL_SHARED}"
    fi
    # The path the close hands back. Absolute, and in the shared checkout
    # rather than the worktree the next block may remove: a relative path is
    # resolved against the thread's OWN project, so a record written from a
    # thread on another repo renders as a link that cannot open.
    JOURNAL_LANDED="${JOURNAL_SHARED}/${REL}"
    [ "${VERBOSE}" = 1 ] && echo "journal  ${REL}  present"
  fi
fi

# Anything still on disk must have nothing left in it. A satellite that was
# removed after landing is covered by its SHA above; the T3 worktree stays, so
# this is what proves it was emptied.
for line in ${LEDGER_LINES[@]+"${LEDGER_LINES[@]}"}; do
  IFS=$'\t' read -r WT SHARED _BRANCH <<<"${line}"
  [ -n "${WT:-}" ] || continue
  # A worktree that is gone is fine ONLY if its SHA was persisted first — that
  # is the whole point of persisting before removing. Skipping on absence alone
  # let `--check` certify a partial landing whose remaining satellite had since
  # been deleted, which is the one thing this line must never do.
  if [ ! -d "${WT}" ]; then
    landed_sha_for "${SHARED}" >/dev/null \
      || not_closed "worktree missing before landing: ${WT}"
    continue
  fi
  wt_status "${WT}"
  if [ -n "${WT_STATUS}" ]; then
    not_closed "uncommitted changes left in ${WT}"
  fi
  WT_TRUNK="$(trunk_of "${SHARED}")" \
    || not_closed "no trunk branch in ${SHARED} to check ${WT} against"
  git -C "${WT}" fetch -q origin "${WT_TRUNK}" 2>/dev/null || true
  AHEAD="$(git -C "${WT}" rev-list --count "origin/${WT_TRUNK}..HEAD" 2>/dev/null || echo 0)"
  if [ "${AHEAD}" != "0" ]; then
    not_closed "${AHEAD} commit(s) in ${WT} that origin/${WT_TRUNK} does not have"
  fi
done

# ── Passed ─────────────────────────────────────────────────────────────────
#
# The marker is what the auto-close gate reads (--gate, above), and it is
# written HERE rather than when the journal is
# written: a journal written before a failed Land would otherwise suppress the
# re-run that lands it.
: >"${CLOSED}"

# ── Last of all: the worktree these scripts are running from ──────────────
#
# Everything above is done, the checks have passed and the marker is written,
# so nothing left to do needs a sibling script. Only builtins and git below.
if [ "${#DEFERRED_REMOVALS[@]}" -gt 0 ]; then
  for entry in ${DEFERRED_REMOVALS[@]+"${DEFERRED_REMOVALS[@]}"}; do
    IFS=$'\t' read -r _WT _SHARED _BRANCH <<<"${entry}"
    remove_worktree "${_WT}" "${_SHARED}" "${_BRANCH}"
  done
fi

if [ -s "${DEPLOY_LOG}" ] && [ "${MODE}" = "land" ]; then
  echo
  echo "Deploy:"
  sed 's/^/  /' "${DEPLOY_LOG}"
  echo
fi

# This is the final-response block. It is generated here so /close copies one
# complete artifact instead of manually reconstructing fields and dropping a
# deterministic result. Deployment diagnostics stay above it; the proof line
# remains last and retains its existing machine-earned meaning.
if [ "${MODE}" = "land" ]; then
  echo "**Shipped:** ${SUBJECT}"
  if [ -n "${JOURNAL_LANDED}" ]; then
    printf '**Journal:** [%s](<%s>)\n' "${JOURNAL_LANDED##*/}" "${JOURNAL_LANDED}"
  fi
  # Every command gets its OWN fenced block, so each one has its own copy
  # button: a close on a ROADMAP project can print several `/implement` rows
  # that run in parallel, and one multi-line block would paste them as one
  # prompt. A `#` comment line is prose — escaped so a renderer does not turn
  # it into a heading — and anything else is printed as it came.
  if [ -n "${NEXT_OUTPUT}" ]; then
    echo '**Next:**'
    while IFS= read -r _next_line; do
      # shellcheck disable=SC2016  # the fences are literal markdown, not an expansion
      case "${_next_line}" in
        "") ;;
        /*) printf '\n```\n%s\n```\n' "${_next_line}" ;;
        '#'*) printf '\n\\%s\n' "${_next_line}" ;;
        *) printf '\n%s\n' "${_next_line}" ;;
      esac
    done <<<"${NEXT_OUTPUT}"
  fi
  echo
fi

# The SHA of the repo the journal landed in, when there is one — workbench,
# the repo every journal close pushes. Otherwise the last repo landed, so a
# thread that never wrote a record still gets a checkable line.
# The trunk is named from whichever repo supplied the SHA, so the sentence and
# the SHA always describe the same ref. On every repo here that prints
# `origin/main`; on a `master` repo it prints `origin/master` rather than a
# reassuring line about a branch the SHA is not on.
if [ -n "${JOURNAL_MAIN_SHA}" ]; then
  REPORT_SHA="${JOURNAL_MAIN_SHA}"; REPORT_TRUNK="${JOURNAL_TRUNK:-main}"
else
  REPORT_SHA="${LAST_SHA}"; REPORT_TRUNK="${LAST_TRUNK:-main}"
fi
echo "origin/${REPORT_TRUNK} is at ${REPORT_SHA} — closing this tab loses nothing."
