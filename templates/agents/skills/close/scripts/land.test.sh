#!/usr/bin/env bash
# land.test.sh — the six cases close.spec.md § 6 names as the hard gate.
#
# Run: bash .agents/skills/close/scripts/land.test.sh
#
# Each scenario builds its own throwaway world: two real repos with real bare
# origins, real git worktrees, a fixture state.sqlite with real thread rows,
# and a throwaway HOME for the ledger. The repos are named with this process's
# pid so the /tmp per-repo lock land.sh takes cannot collide with another run.
#
# The CODE repo stands in for the workbench and holds the records too:
# `journal/` and `projects/` live inside it, beside a copy of
# these scripts at `.agents/skills/close/scripts/`, so `journal-file.sh` run out of a
# thread's worktree files the entry in that same worktree. The PROD repo is a
# product repo — the satellite shape a thread still opens for a repo other than
# its own.
#
# Nothing is stubbed except one thing that is not this script's job: in case
# 6, the deploy-run poller (`await-deploy-run.sh` owns its own behavior — what
# is tested here is that its VERDICT is honoured, and that a repo without one
# is not polled at all).

set -uo pipefail
# Local time is the journal's clock; the fixtures' times are written for this zone.
export TZ=America/Los_Angeles
# The harness's own session env must not reach the scripts under test.
unset CLAUDE_CODE_SESSION_ID CLAUDE_SESSION_ID CONTEXTIUM_SESSION CONTEXTIUM_HARNESS

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAND="${HERE}/land.sh"
WRITE_ROOT="${HERE}/write-root.sh"

ROOT="$(mktemp -d)" || exit 1
PASS=0
FAIL=0

cleanup() {
  local d
  for d in "${ROOT}"/*/land-*-code "${ROOT}"/*/land-*-prod "${ROOT}"/*/land-*-legacy "${ROOT}"/*/land-*-third; do
    [ -d "${d}" ] && git -C "${d}" worktree prune 2>/dev/null
  done
  rm -rf "${ROOT}"
  rm -f "/tmp/land-$$-"*-git.lock
}
trap cleanup EXIT

ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: '$2' should not contain '$3'" ;; *) ok "$1" ;; esac; }
isnt() { if [ "$2" != "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted anything but"; fi; }

TID1=aaaa1111-0000-0000-0000-000000000001
TID2=bbbb2222-0000-0000-0000-000000000002

# ── Fixture ────────────────────────────────────────────────────────────────

# fixture <scenario> [created_at_1] [created_at_2]
#
# Sets: S, CODE, PROD, WT1, WT2, HOME_DIR, ENV1, ENV2.
fixture() {
  local name="$1"
  local at1="${2:-2026-09-14T03:15:00.000Z}"
  local at2="${3:-2026-09-14T04:20:00.000Z}"

  S="${ROOT}/${name}"
  mkdir -p "${S}/origins" "${S}/home" "${S}/t3home/userdata" "${S}/t3"

  CODE="${S}/code"
  PROD="${S}/prod"
  HOME_DIR="${S}/home"

  local repo
  for repo in code prod; do
    # The lock land.sh takes is keyed on the checkout's basename, so the
    # basename has to be unique per run — but the variable has to stay short.
    git init -q --bare -b main "${S}/origins/land-$$-${name}-${repo}.git"
    git init -q -b main "${S}/${repo}"
    git -C "${S}/${repo}" config user.email t@example.com
    git -C "${S}/${repo}" config user.name tester
    echo "seed" >"${S}/${repo}/seed.txt"
    git -C "${S}/${repo}" add seed.txt
    if [ "${repo}" = code ]; then
      # The scripts at their real path, so `journal-file.sh` run out of a
      # worktree of this repo finds THIS repo as its own and files the journal
      # there. Tests are left out; nothing here runs them.
      mkdir -p "${S}/code/.agents/skills/close/scripts"
      find "${HERE}" -maxdepth 1 -name '*.sh' ! -name '*.test.sh' \
        -exec cp {} "${S}/code/.agents/skills/close/scripts/" \;
      # The script-tests checker, as a stub that passes everything, seeded ON
      # THE TRUNK: the copies above and the checker stubs the cases commit are
      # scripts under .agents/, and without a resolvable checker land.sh
      # refuses any close that changes one. Case 18 overwrites it with a
      # strict stub; `FIXTURE_SC_STUB=none` leaves it out for the rows that
      # need no checker in any worktree.
      if [ "${FIXTURE_SC_STUB:-}" != none ]; then
        mkdir -p "${S}/code/.agents/checks"
        printf '#!/usr/bin/env bash\necho "OK — stub"\n' \
          >"${S}/code/.agents/checks/check-scripts.sh"
      fi
      git -C "${S}/code" add .agents
    fi
    git -C "${S}/${repo}" commit -q -m seed
    git -C "${S}/${repo}" remote add origin "${S}/origins/land-$$-${name}-${repo}.git"
    git -C "${S}/${repo}" push -q -u origin main
  done

  # The basename land.sh locks on. Renaming the directory after init is
  # simpler than threading the name through every git call above.
  mv "${CODE}" "${S}/land-$$-${name}-code"
  mv "${PROD}" "${S}/land-$$-${name}-prod"
  CODE="${S}/land-$$-${name}-code"
  PROD="${S}/land-$$-${name}-prod"

  # Two T3 threads, each with a linked worktree of the code repo on a branch
  # named the way T3 names them — never `t3/`.
  WT1="${S}/t3/one"
  WT2="${S}/t3/two"
  git -C "${CODE}" worktree add -q -b "t3code/one" "${WT1}" main
  git -C "${CODE}" worktree add -q -b "t3code/two" "${WT2}" main

  node -e '
const { DatabaseSync } = require("node:sqlite");
const [dbPath, t1, w1, a1, t2, w2, a2] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)`);
const ins = db.prepare("insert into projection_threads values (?,?,?,?,?,?,?,?)");
ins.run(t1, "p", "one", "t3code/one", w1, a1, "x", null);
ins.run(t2, "p", "two", "t3code/two", w2, a2, "x", null);
' "${S}/t3home/userdata/state.sqlite" "${TID1}" "${WT1}" "${at1}" "${TID2}" "${WT2}" "${at2}"

  ENV1=("HOME=${HOME_DIR}" "T3CODE_HOME=${S}/t3home" "LAND_PUSH_SLEEP=0")
  ENV2=(${ENV1[@]+"${ENV1[@]}"})
}

# Run a command as thread N, from that thread's own T3 worktree.
as1() { (cd "${WT1}" && env ${ENV1[@]+"${ENV1[@]}"} "$@"); }
as2() { (cd "${WT2}" && env ${ENV2[@]+"${ENV2[@]}"} "$@"); }

# Allocate a journal path as thread N — through the copy of journal-file.sh in
# THAT thread's worktree, which is how a session runs it. The real copy under
# ${HERE} would name the real workbench as its repo, and nothing in this suite
# may touch a real checkout.
jf1() { as1 bash "${WT1}/.agents/skills/close/scripts/journal-file.sh" "$@"; }
jf2() { as2 bash "${WT2}/.agents/skills/close/scripts/journal-file.sh" "$@"; }

# The files one commit touched, by its subject.
files_in_commit() {
  local repo="$1" subject="$2" sha
  sha="$(git -C "${repo}" log origin/main --format='%H' --grep="^${subject}$" | head -n 1)"
  [ -n "${sha}" ] || { echo "NO-SUCH-COMMIT"; return; }
  git -C "${repo}" diff-tree --no-commit-id --name-only -r "${sha}" | sort | tr '\n' ' '
}

on_main() {  # on_main <repo> <path>
  git -C "$1" fetch -q origin main 2>/dev/null
  git -C "$1" cat-file -e "origin/main:$2" 2>/dev/null && echo yes || echo no
}

echo "── Case 1: two threads, two repos, same minute ──────────────────────"

fixture c1
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
SAT2="$(as2 bash "${WRITE_ROOT}" "${PROD}")"

echo "one" >"${WT1}/one.txt"
echo "one" >"${SAT1}/one-prod.md"
echo "two" >"${WT2}/two.txt"
echo "two" >"${SAT2}/two-prod.md"

OUT1="$(as1 bash "${LAND}" "thread one")"
RC1=$?
OUT2="$(as2 bash "${LAND}" "thread two")"
RC2=$?

is "thread one lands" "${RC1}" "0"
is "thread two lands" "${RC2}" "0"
has "thread one prints the safe-to-close line" "${OUT1}" \
  "— closing this tab loses nothing."
has "thread two prints it too" "${OUT2}" "— closing this tab loses nothing."

is "thread one's commit touches only thread one's file" \
  "$(files_in_commit "${CODE}" "thread one")" "one.txt "
is "thread two's commit touches only thread two's file" \
  "$(files_in_commit "${CODE}" "thread two")" "two.txt "
is "…and in the product repo as well" \
  "$(files_in_commit "${PROD}" "thread one")" "one-prod.md "

is "both threads' files are on main in the code repo" \
  "$(on_main "${CODE}" one.txt)$(on_main "${CODE}" two.txt)" "yesyes"
is "both threads' files are on main in the product repo" \
  "$(on_main "${PROD}" one-prod.md)$(on_main "${PROD}" two-prod.md)" "yesyes"

CHECK1="$(as1 bash "${LAND}" --check --verbose)"
is "--check re-passes for thread one" "$?" "0"
has "…and prints the line" "${CHECK1}" "— closing this tab loses nothing."
has "…and --verbose names each repo" "${CHECK1}" "ancestor-of-origin/main"

if [ -f "${HOME_DIR}/.cache/workbench/threads/${TID1}/closed" ]; then
  ok "the closed marker is written"; else bad "no closed marker"; fi

if [ -d "${SAT1}" ]; then bad "the satellite was not removed"
  else ok "the satellite is removed once its SHA is persisted"; fi
if [ -d "${WT1}" ]; then ok "T3's own worktree is left for T3"
  else bad "T3's worktree was removed"; fi

is "the satellite's branch is gone from the product repo" \
  "$(git -C "${PROD}" rev-parse --verify -q "refs/heads/t3/${TID1}" >/dev/null 2>&1 \
     && echo present || echo gone)" "gone"

is "the shared code checkout was fast-forwarded" \
  "$(git -C "${CODE}" rev-parse HEAD)" "$(git -C "${CODE}" rev-parse origin/main)"

echo
echo "── Case 2: a push that fails leaves the obligation in place ─────────"

fixture c2
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "one" >"${WT1}/one.txt"
echo "one" >"${SAT1}/one-prod.md"

# The product repo cannot be pushed to. The code repo, first in the ledger,
# lands normally — which is what makes this a PARTIAL landing.
git -C "${PROD}" remote set-url --push origin "${S}/origins/does-not-exist.git"

OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "a failed push exits 3" "${RC}" "3"
has "and says which repo" "${OUT}" "NOT CLOSED: push of ${PROD} failed"

LANDED="${HOME_DIR}/.cache/workbench/threads/${TID1}/landed"
is "the code repo's SHA is persisted" \
  "$(awk -F'\t' -v s="${CODE}" '$1 == s' "${LANDED}" | wc -l)" "1"
is "the product repo's SHA is NOT persisted" \
  "$(awk -F'\t' -v s="${PROD}" '$1 == s' "${LANDED}" | wc -l)" "0"
if [ -f "${HOME_DIR}/.cache/workbench/threads/${TID1}/closed" ]; then
  bad "a closed marker was written despite the failure"
  else ok "no closed marker is written"; fi
if [ -d "${SAT1}" ]; then ok "the unlanded worktree is kept"
  else bad "the unlanded worktree was removed"; fi
is "…with its commit intact" \
  "$(git -C "${SAT1}" log -1 --format=%s)" "thread one"

# The next close lands it.
git -C "${PROD}" remote set-url --push origin "${S}/origins/land-$$-c2-prod.git"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "the re-run lands what was left" "${RC}" "0"
has "and prints the line" "${OUT}" "— closing this tab loses nothing."
is "the product file is on main" "$(on_main "${PROD}" one-prod.md)" "yes"
hasnt "the already-landed repo is not committed twice" "${OUT}" "landed ${CODE}"
if [ -f "${HOME_DIR}/.cache/workbench/threads/${TID1}/closed" ]; then
  ok "now the closed marker is written"; else bad "still no closed marker"; fi

echo
echo "── Case 3: --check after cleanup, and a dropped obligation ──────────"

fixture c3
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "one" >"${SAT1}/one-prod.md"
as1 bash "${LAND}" "thread one" >/dev/null
CHECK="$(as1 bash "${LAND}" --check)"
is "--check passes with the satellite already gone" "$?" "0"
has "and prints the line" "${CHECK}" "— closing this tab loses nothing."

# Drop the product repo's SHA: now the ledger names a worktree that is not on
# disk and has no landed SHA, which is an obligation nobody can account for.
LANDED="${HOME_DIR}/.cache/workbench/threads/${TID1}/landed"
grep -v "^${PROD}	" "${LANDED}" >"${LANDED}.tmp" && mv "${LANDED}.tmp" "${LANDED}"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "a worktree gone before landing exits 3" "${RC}" "3"
has "naming the path" "${OUT}" "NOT CLOSED: worktree missing before landing: ${SAT1}"

echo
echo "── Case 4: two threads allocate the same journal name ───────────────"

# Same start minute for both threads, so journal-file.sh hands both the same
# name — neither can see the other's worktree.
fixture c4 "2026-09-14T03:15:00.000Z" "2026-09-14T03:15:00.000Z"
J1="$(jf1 "same slug")"
J2="$(jf2 "same slug")"
is "both threads pick the same path" "$(basename "${J1}")" "$(basename "${J2}")"
is "…which is the unsuffixed one" "$(basename "${J1}")" "2015-same-slug.md"
is "…in the thread's OWN worktree, where the records live" \
  "${J1}" "${WT1}/journal/2026-09-13/2015-same-slug.md"
entry() {  # entry <path> <slug> <body>
  cat >"$1" <<ENTRY
---
date: 2026-09-13
time: 20:15
slug: $2
tags: []
---

### $2
**Action:** shipped

$3
ENTRY
}
entry "${J1}" "same-slug" "thread one's entry"
entry "${J2}" "same-slug" "thread two's entry"

as1 bash "${LAND}" "thread one" >/dev/null
OUT2="$(as2 bash "${LAND}" "thread two" 2>&1)"
RC2=$?
is "the second thread still lands" "${RC2}" "0"
has "…saying it renamed around the collision" "${OUT2}" "journal renamed:"
is "the first thread's entry is on main" \
  "$(on_main "${CODE}" journal/2026-09-13/2015-same-slug.md)" "yes"
is "the second thread's entry is on main under -2" \
  "$(on_main "${CODE}" journal/2026-09-13/2015-same-slug-2.md)" "yes"
has "neither entry overwrote the other" \
  "$(git -C "${CODE}" show origin/main:journal/2026-09-13/2015-same-slug.md)" \
  "thread one's entry"
is "the ledger now names the renamed path" \
  "$(basename "$(cat "${HOME_DIR}/.cache/workbench/threads/${TID2}/journal")")" \
  "2015-same-slug-2.md"
CHECK2="$(as2 bash "${LAND}" --check --verbose)"
is "…and --check verifies the renamed path, not the original" "$?" "0"
has "naming it" "${CHECK2}" "journal  journal/2026-09-13/2015-same-slug-2.md  present"

echo
echo "── Case 4b: re-landing your OWN entry does not rename it ────────────"
#
# Observed 2026-09-14: a second close — a correction to an entry already
# pushed — found its own file on origin/main, read that as a collision, and
# moved it to `-2`. A third run would have made it `-3`.

fixture c4b
J="$(jf1 "same slug")"
entry "${J}" "same-slug" "first pass"
as1 bash "${LAND}" "thread one" >/dev/null
REL4B="journal/2026-09-13/$(basename "${J}")"
is "the first close lands it under its own name" "$(on_main "${CODE}" "${REL4B}")" "yes"

# Correct the entry and close again — the same session, a second time.
entry "${WT1}/${REL4B}" "same-slug" "second pass, corrected"
OUT="$(as1 bash "${LAND}" "thread one again" 2>&1)"
is "the second close lands" "$?" "0"
hasnt "and does not rename this session's own entry" "${OUT}" "journal renamed"
is "the entry is still at its original path" "$(on_main "${CODE}" "${REL4B}")" "yes"
is "no -2 was created" \
  "$(on_main "${CODE}" "journal/2026-09-13/$(basename "${J}" .md)-2.md")" "no"
has "and it carries the correction" \
  "$(git -C "${CODE}" show "origin/main:${REL4B}")" "second pass, corrected"
is "the ledger still names the original path" \
  "$(basename "$(cat "${HOME_DIR}/.cache/workbench/threads/${TID1}/journal")")" \
  "$(basename "${J}")"

echo
echo "── Case 5: a conflict halts loud and changes nothing shared ─────────"

fixture c5
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "this thread's version" >"${SAT1}/contested.txt"

# Somebody else lands a different version of the same new file first.
OTHER="${S}/other"
git clone -q "${S}/origins/land-$$-c5-prod.git" "${OTHER}"
git -C "${OTHER}" config user.email t@example.com
git -C "${OTHER}" config user.name tester
echo "somebody else's version" >"${OTHER}/contested.txt"
git -C "${OTHER}" add contested.txt
git -C "${OTHER}" commit -q -m "another writer"
git -C "${OTHER}" push -q origin main

SHARED_BEFORE="$(git -C "${PROD}" rev-parse HEAD)"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "a conflict exits 3" "${RC}" "3"
has "naming the worktree it is in" "${OUT}" "NOT CLOSED: conflict in ${SAT1}"
has "the conflict markers are in the worktree" \
  "$(cat "${SAT1}/contested.txt")" "<<<<<<<"
is "the shared checkout is untouched" \
  "$(git -C "${PROD}" rev-parse HEAD)" "${SHARED_BEFORE}"
is "the shared checkout is clean" "$(git -C "${PROD}" status --porcelain)" ""
if [ -f "${HOME_DIR}/.cache/workbench/threads/${TID1}/closed" ]; then
  bad "a conflicted close still wrote the marker"
  else ok "no closed marker after a conflict"; fi

# Re-running the close over a conflicted worktree must not "resolve" it by
# staging the markers. This is the retry the first cut never covered.
COMMITS_BEFORE="$(git -C "${SAT1}" rev-list --count origin/main..HEAD)"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "a re-run over an unresolved conflict exits 3" "${RC}" "3"
has "naming the file that is still conflicted" "${OUT}" \
  "NOT CLOSED: unresolved conflict in ${SAT1}"
has "…and the file" "${OUT}" "contested.txt"
is "the retry committed nothing over the markers" \
  "$(git -C "${SAT1}" rev-list --count origin/main..HEAD)" "${COMMITS_BEFORE}"
is "and the markers are still in the working tree, not staged away" \
  "$(git -C "${SAT1}" diff --name-only --diff-filter=U)" "contested.txt"
is "and no conflict markers reached main" \
  "$(git -C "${PROD}" show origin/main:contested.txt 2>/dev/null)" "somebody else's version"

# Resolved by hand, the same close lands.
echo "this thread's version, merged by hand" >"${SAT1}/contested.txt"
git -C "${SAT1}" add contested.txt
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "once resolved, the close lands" "$?" "0"
has "…and prints the line" "${OUT}" "— closing this tab loses nothing."

echo
echo "── Case 6: the landing CHECKS the push deployed, and never deploys ─────"

# WHAT CHANGED, AND WHY THE OLD CASES ARE GONE. Until 2026-09-19 this block ran
# `post-merge.sh` after every merge and its three cases were about refusing to
# deploy a shared checkout that did not hold the landed code — dirty, behind, or
# carrying another session's file. The push deploys now, from a clone nobody
# edits, so there is no tree here to refuse and nothing for the merger to run.
#
# What replaced them is the failure the OLD path could not have: a deploy that
# never starts. This script ran the deploy, so it could not lose one silently.
# The Worker can — a dropped delivery, a Worker that is down, a wrong route —
# and silence would look exactly like success. So: a run that completes closes,
# a run that fails does NOT, and no run at all does NOT.

# The poller lives in the repo, so it has to be ON main before the close runs —
# which is how the real one gets there. Its presence is also what tells land.sh
# this repo's pushes deploy at all.
write_await_stub() {
  mkdir -p "${CODE}/.agents/deploy"
  cat >"${CODE}/.agents/deploy/await-deploy-run.sh" <<'STUB'
#!/usr/bin/env bash
sha=""
while [ $# -gt 0 ]; do case "$1" in --sha) sha="$2"; shift 2 ;; *) shift ;; esac; done
echo "polled ${sha}" >&2
printf '%s\n' "${AWAIT_STUB_LINE:-deploy: completed (run_stub)}"
exit "${AWAIT_STUB_RC:-0}"
STUB
  git -C "${CODE}" add .agents
  git -C "${CODE}" commit -q -m "the deploy poller"
  git -C "${CODE}" push -q origin main
  git -C "${WT1}" fetch -q origin main
  git -C "${WT1}" merge -q --no-edit origin/main
}

# The prefix list is the opt-in: without it the deploy check is off. Defined
# here, before the first case needs it.
write_prefix_list() {  # write_prefix_list <json text>
  mkdir -p "${CODE}/.agents"
  printf '%s\n' "$1" >"${CODE}/.agents/deployable-prefixes.json"
  git -C "${CODE}" add .agents
  git -C "${CODE}" commit -q -m "the prefix list"
  git -C "${CODE}" push -q origin main
  git -C "${WT1}" fetch -q origin main
  git -C "${WT1}" merge -q --no-edit origin/main
}

# OFF UNLESS OPTED IN. A poller with no prefix list, or nothing at all: the
# landing closes and no deploy line is printed.
fixture c6off
write_await_stub
echo "one" >"${WT1}/one.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "with no .agents/deployable-prefixes.json the deploy check is off" "$?" "0"
hasnt "…and nothing is polled" "${OUT}" "deploy:"

# OPTED IN WITHOUT A POLLER is the silent case again, so it is NOT CLOSED.
fixture c6nopoll
write_prefix_list '["one"]'
echo "one" >"${WT1}/one.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
isnt "a prefix list with no poller does NOT close" "$?" "0"
has "…and names the missing poller" "${OUT}" ".agents/deploy/await-deploy-run.sh"

fixture c6
write_await_stub
write_prefix_list '["one"]'
echo "one" >"${WT1}/one.txt"
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "prod" >"${SAT1}/one-prod.md"

OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a completed deploy run closes" "$?" "0"
has "…and the run is named in the report" "${OUT}" "deploy: completed (run_stub)"
has "…and the poller was asked about the landed commit" \
  "$(cat "${HOME_DIR}/.cache/workbench/threads/${TID1}/deploy.log")" "polled "
hasnt "the product repo, which carries no poller, was not polled" "${OUT}" "deploy: completed (run_stub)
deploy: completed (run_stub)"

# NO RUN AT ALL IS NOT CLOSED. This is the whole reason the check exists: the
# push is the only thing that deploys, and nothing else would notice it failing.
fixture c6b
write_await_stub
write_prefix_list '["one"]'
echo "one" >"${WT1}/one.txt"
OUT="$(AWAIT_STUB_RC=3 AWAIT_STUB_LINE="deploy: no run seen for sha:abc within 60s" \
  as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
isnt "a landing whose push started no deploy does NOT close" "${RC}" "0"
has "…and says so" "${OUT}" "no run seen"
has "…naming the checkout that is on origin undeployed" "${OUT}" "nothing deployed it"

# A run that FAILED is the same verdict, for the same reason.
fixture c6c
write_await_stub
write_prefix_list '["one"]'
echo "one" >"${WT1}/one.txt"
OUT="$(AWAIT_STUB_RC=3 AWAIT_STUB_LINE="deploy: failed (run_bad)" \
  as1 bash "${LAND}" "thread one" 2>&1)"
isnt "a failed deploy run does NOT close" "$?" "0"
has "…and names the run" "${OUT}" "deploy: failed (run_bad)"

# A RUN IS OWED ONLY WHEN THE LANDED DIFF CAN DEPLOY SOMETHING. Every journal
# close is a workbench push — the records are in this repo — so a
# close that wrote only a journal entry would otherwise wait on a run the
# Worker never starts. The Worker starts one only for a path under a prefix in
# `deployable-prefixes.json`, and this script reads the SAME list — out of the
# landed commit, never the shared checkout's working tree — and polls only when
# the diff since the trunk it left matches. Anything it cannot read (no list
# at that sha, unparseable JSON) polls, as before: never skip on an unknown.

# The journal-only close, the not-owed case: the entry is allocated by
# journal-file.sh into this thread's own worktree, the landed diff touches
# `journal/` and nothing under `apps/`, `integrations/` or `packages/`, so the
# close says no run was owed and never asks the poller, and its deploy line
# says why nothing was waited for.
fixture c6d
write_await_stub
write_prefix_list '["apps/", "integrations/", "packages/"]'
J6D="$(jf1 "journal only")"
entry "${J6D}" "journal-only" "a session that wrote only its journal"
OUT="$(as1 bash "${LAND}" "journal only" 2>&1)"
is "a journal-only close lands" "$?" "0"
has "…and says no run was owed" "${OUT}" "deploy: not owed (no deployable path)"
hasnt "…and the poller was never asked" "${OUT}" "deploy: completed"
is "…nor even started" "$(grep -c 'polled ' "${HOME_DIR}/.cache/workbench/threads/${TID1}/deploy.log" 2>/dev/null || :)" "0"
is "…and the entry is on main" "$(on_main "${CODE}" "journal/2026-09-13/$(basename "${J6D}")")" "yes"

fixture c6e
write_await_stub
write_prefix_list '["apps/", "integrations/", "packages/"]'
mkdir -p "${WT1}/journal/2026-09-25" "${WT1}/projects/ai/x"
echo "entry" >"${WT1}/journal/2026-09-25/1200-x.md"
echo "record" >"${WT1}/projects/ai/x/README.md"
OUT="$(as1 bash "${LAND}" "records only, in the code repo" 2>&1)"
is "a landing touching only records closes" "$?" "0"
has "…and says no run was owed" "${OUT}" "deploy: not owed (no deployable path)"
hasnt "…and the poller was never asked" "${OUT}" "deploy: completed"
is "…nor even started" "$(grep -c 'polled ' "${HOME_DIR}/.cache/workbench/threads/${TID1}/deploy.log" 2>/dev/null || :)" "0"

# A path under a listed prefix is owed a run, and the verdict is the poller's.
fixture c6f
write_await_stub
write_prefix_list '["apps/", "integrations/", "packages/"]'
mkdir -p "${WT1}/packages/shared" "${WT1}/journal/2026-09-25"
echo "code" >"${WT1}/packages/shared/x.ts"
echo "entry" >"${WT1}/journal/2026-09-25/1200-x.md"
OUT="$(as1 bash "${LAND}" "code and a record" 2>&1)"
is "a landing touching a deployable path closes on a completed run" "$?" "0"
has "…and the poller decided" "${OUT}" "deploy: completed (run_stub)"
hasnt "…not the prefix rule" "${OUT}" "not owed"

# THE LIST IS PARSED, NOT GREPPED. A pretty-printed list is the same list, and
# a prefix matches only at the START of a path: `docs/apps/x.ts` is records.
fixture c6g
write_await_stub
write_prefix_list '[
  "apps/",
  "integrations/",
  "packages/"
]'
mkdir -p "${WT1}/docs/apps"
echo "prose" >"${WT1}/docs/apps/x.ts"
OUT="$(as1 bash "${LAND}" "a path with apps in the middle" 2>&1)"
is "a mid-path prefix is not a match" "$?" "0"
has "…so no run is owed" "${OUT}" "deploy: not owed (no deployable path)"

# A LIST THAT CANNOT BE READ POLLS. Skipping on "I could not tell" is the one
# way a deployed-nothing close ships a stale fleet with a green report.
fixture c6h
write_await_stub
write_prefix_list 'not json at all'
mkdir -p "${WT1}/journal/2026-09-25"
echo "entry" >"${WT1}/journal/2026-09-25/1200-x.md"
OUT="$(as1 bash "${LAND}" "records under a broken list" 2>&1)"
is "an unreadable list falls back to polling" "$?" "0"
has "…and the poller was asked" "${OUT}" "deploy: completed (run_stub)"
hasnt "…never skipped on an unknown" "${OUT}" "not owed"

# THE WORKER READS EVERY COMMIT'S FILES, NOT THE NET DIFF. A path added in one
# commit and deleted in the next is in the payload's union and starts a run,
# while `git diff` across the range shows nothing — so the close must read the
# same union, or it reports `not owed` over a run that may have failed.
fixture c6i
write_await_stub
write_prefix_list '["apps/", "integrations/", "packages/"]'
mkdir -p "${WT1}/apps/x"
echo "code" >"${WT1}/apps/x/y.ts"
git -C "${WT1}" add apps && git -C "${WT1}" commit -q -m "add it"
git -C "${WT1}" rm -q apps/x/y.ts && git -C "${WT1}" commit -q -m "remove it again"
mkdir -p "${WT1}/journal/2026-09-25"
echo "entry" >"${WT1}/journal/2026-09-25/1200-x.md"
OUT="$(as1 bash "${LAND}" "a path that came and went" 2>&1)"
is "a path touched by an intermediate commit closes on the poller's verdict" "$?" "0"
has "…and the poller was asked, as the Worker started a run" "${OUT}" "deploy: completed (run_stub)"
hasnt "…never not-owed on the net diff alone" "${OUT}" "not owed"

echo "── Case 7: a journal the aggregator could not parse never lands ─────"

fixture c7
J="$(jf1 "broken entry")"
# Two front-matter blocks: the shape a concurrent append used to produce, and
# the one the aggregator reads only the first of.
cat >"${J}" <<'BROKEN'
---
date: 2026-09-13
slug: broken-entry
---

### broken-entry

---
date: 2026-09-13
tags: []
---
BROKEN

OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is "unparseable front matter exits 3" "${RC}" "3"
has "naming the file" "${OUT}" "NOT CLOSED: journal entry fails the schema"
is "and nothing was committed in the worktree" \
  "$(git -C "${WT1}" log --oneline origin/main..HEAD | wc -l)" "0"
is "so nothing reached main" "$(on_main "${CODE}" "journal/2026-09-13/$(basename "${J}")")" "no"
if [ -f "${HOME_DIR}/.cache/workbench/threads/${TID1}/closed" ]; then
  bad "a broken journal still closed the session"
  else ok "no closed marker"; fi

# Repaired, the same close lands.
entry "${J}" "broken-entry" "now it parses"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "the repaired entry lands" "$?" "0"
has "…and prints the line" "${OUT}" "— closing this tab loses nothing."

echo
echo "── Case 7a: a missing checker refuses the close rather than skipping ─"

# The same scripts, minus the checker — a rename nobody repointed, or a skills
# tree older than the close running on it. Before 2026-09-23 land.sh skipped
# the gate in that case and printed the safe-to-close line over an unchecked
# entry.
fixture c7a
J="$(jf1 "unchecked entry")"
entry "${J}" "unchecked-entry" "a valid entry, with nothing to check it"
NOCHECK="${S}/scripts-nocheck"
cp -R "${HERE}" "${NOCHECK}"
rm -f "${NOCHECK}/check-journal-entry.sh"
OUT="$(as1 bash "${NOCHECK}/land.sh" "thread one" 2>&1)"
RC=$?
is "a missing checker exits 3" "${RC}" "3"
has "naming the script it wanted" "${OUT}" "NOT CLOSED: journal check missing: ${NOCHECK}/check-journal-entry.sh"
is "and nothing was committed in the worktree" \
  "$(git -C "${WT1}" log --oneline origin/main..HEAD | wc -l)" "0"
is "so nothing reached main" "$(on_main "${CODE}" "journal/2026-09-13/$(basename "${J}")")" "no"

# With the checker back, the same entry lands.
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "the entry lands once the checker is present" "$?" "0"

echo
echo "── Case 7b: --check cannot certify an obligation that vanished ──────"

fixture c7b
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "prod" >"${SAT1}/one-prod.md"
# The code repo lands; the product push fails, so its worktree is kept.
git -C "${PROD}" remote set-url --push origin "${S}/origins/gone.git"
as1 bash "${LAND}" "thread one" >/dev/null 2>&1
# Now that kept worktree is deleted by hand — its work exists nowhere.
rm -rf "${SAT1}"
OUT="$(as1 bash "${LAND}" --check 2>&1)"
RC=$?
is "--check refuses rather than certifying it" "${RC}" "3"
has "naming the worktree that went missing" "${OUT}" \
  "NOT CLOSED: worktree missing before landing: ${SAT1}"
hasnt "and never prints the safe-to-close line" "${OUT}" "loses nothing"

echo
echo "── Case 8: the auto-close gate, and what makes it go stale ──────────"

fixture c8
is "before any close, the gate is open" "$(as1 bash "${LAND}" --gate)" "not-fired"

SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "one" >"${SAT1}/one-prod.md"
is "with work outstanding it is still open" "$(as1 bash "${LAND}" --gate)" "not-fired"

as1 bash "${LAND}" "thread one" >/dev/null
is "after a clean close it is shut" "$(as1 bash "${LAND}" --gate)" "fired"

# The regression the per-caller key used to prevent: work done AFTER a close
# must not be suppressed by that close's marker.
echo "later work" >"${WT1}/later.txt"
is "new work in a worktree re-opens it" "$(as1 bash "${LAND}" --gate)" "not-fired"

as1 bash "${LAND}" "thread one again" >/dev/null
is "and closing again shuts it again" "$(as1 bash "${LAND}" --gate)" "fired"
is "the later work reached main" "$(on_main "${CODE}" later.txt)" "yes"

# A commit that was never pushed counts as outstanding too.
echo "unpushed" >"${WT1}/unpushed.txt"
git -C "${WT1}" add unpushed.txt
git -C "${WT1}" commit -q -m "committed but not landed"
is "an unpushed commit re-opens it" "$(as1 bash "${LAND}" --gate)" "not-fired"

# A thread that never closed at all.
is "another thread's marker is not this one's" "$(as2 bash "${LAND}" --gate)" "not-fired"

echo
echo "── Case 9: landing the worktree the scripts run from ────────────────"
#
# The scripts live in a repo this thread holds as a SATELLITE — the workbench
# itself, for a thread T3 opened on a product repo — so the script-bearing worktree is in the ledger
# and is removed by the landing; here it sits AHEAD of T3's own worktree.
# Landing it removed the directory holding thread.sh; every later lookup then
# returned empty, and the T3-worktree guard, which compared against that empty
# string, removed T3's worktree and deleted its branch.
#
# The fixture has the PROD satellite carry the scripts at their real relative
# path. Which repo is which does not matter to the mechanism: what is under
# test is a landing driven from a worktree the same landing removes.
#
# `write-root.sh` normally registers the T3 worktree on its first call, so this
# order is not the common one — it is what you get when a satellite was created
# before the T3 worktree was ever registered. The point of the case is that the
# order must not matter at all.

fixture c9
SATDIR="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
mkdir -p "${SATDIR}/.agents/skills/close/scripts"
cp "${HERE}"/*.sh "${SATDIR}/.agents/skills/close/scripts/"
echo "prod" >"${SATDIR}/one-prod.md"
echo "one" >"${WT1}/one.txt"

# Put the script-bearing satellite first, T3's worktree second.
LEDGER9="${HOME_DIR}/.cache/workbench/threads/${TID1}/worktrees"
{
  grep -F "${SATDIR}" "${LEDGER9}"
  grep -vF "${SATDIR}" "${LEDGER9}"
} >"${LEDGER9}.reordered"
mv "${LEDGER9}.reordered" "${LEDGER9}"
is "the script's own worktree is first in the ledger" \
  "$(head -1 "${LEDGER9}" | cut -f1)" "${SATDIR}"

T3_BRANCH_BEFORE="$(git -C "${WT1}" rev-parse --abbrev-ref HEAD)"
OUT="$(cd "${WT1}" && env ${ENV1[@]+"${ENV1[@]}"} bash "${SATDIR}/.agents/skills/close/scripts/land.sh" "thread one" 2>&1)"
RC=$?

is "the close lands" "${RC}" "0"
has "and prints the line" "${OUT}" "— closing this tab loses nothing."

# The whole point of the case:
if [ -d "${WT1}" ]; then
  ok "T3's own worktree survives a run driven from a landed worktree"
else
  bad "T3's worktree was deleted — the 2026-09-14 regression"
fi
is "…and T3's branch still exists" \
  "$(git -C "${CODE}" rev-parse --verify -q "refs/heads/${T3_BRANCH_BEFORE}" >/dev/null 2>&1 \
     && echo present || echo gone)" "present"
if [ -d "${SATDIR}" ]; then
  bad "the script's own worktree was never removed"
else
  ok "the script's own worktree is removed, last"
fi
is "both repos still reached main" \
  "$(on_main "${CODE}" one.txt)$(on_main "${PROD}" one-prod.md)" "yesyes"

echo "── Case 10: a satellite repo whose trunk is \`master\` ────────────────"

# End to end. `workbench` and a product repo are on `main` and a third repo is
# on `master`. A resolver that refuses a `master` repo outright ("no
# origin/main") leaves the worktree to be built by hand and the push done by
# hand, and this script never sees the repo at all. A close cannot vouch for
# what it could not touch.
#
# Every assertion below is about the `master` repo specifically. If the trunk
# name is ever spelled `main` again anywhere in the landing path, one of them
# fails rather than the whole suite quietly continuing to pass on `main` repos.

fixture c10

# The satellite: same construction as the fixture's repos, but on `master`.
MBARE="${S}/origins/land-$$-c10-legacy.git"
MREPO="${S}/land-$$-c10-legacy"
git init -q --bare -b master "${MBARE}"
git init -q -b master "${MREPO}"
git -C "${MREPO}" config user.email t@example.com
git -C "${MREPO}" config user.name tester
echo seed >"${MREPO}/seed.txt"
git -C "${MREPO}" add seed.txt
git -C "${MREPO}" commit -q -m seed
git -C "${MREPO}" remote add origin "${MBARE}"
git -C "${MREPO}" push -q -u origin master
git -C "${MREPO}" remote set-head origin --auto >/dev/null 2>&1

# 1. The resolver hands out a worktree at all — this is the step that used to
#    refuse, and every later assertion depends on it.
MSAT="$(as1 bash "${WRITE_ROOT}" "${MREPO}" 2>&1)"
RC=$?
is  "write-root accepts a master-trunk repo" "${RC}" "0"
is  "and the satellite exists" "$([ -d "${MSAT}" ] && echo yes)" "yes"
is  "branched from origin/master" \
  "$(git -C "${MSAT}" rev-parse HEAD)" "$(git -C "${MREPO}" rev-parse origin/master)"

# 2. It lands, with real work in it and in the two `main` repos beside it, so
#    the mixed-trunk case is what is being exercised rather than a lone repo.
echo "legacy" >"${MSAT}/legacy.txt"
echo "one" >"${WT1}/one.txt"
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "prod" >"${SAT1}/one-prod.md"
J10="$(jf1 "mixed trunks")"
entry "${J10}" "mixed-trunks" "a close across three repos, one of them on master"

OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
RC=$?
is  "the close lands with a master-trunk repo in the ledger" "${RC}" "0"
has "and prints the line" "${OUT}" "— closing this tab loses nothing."

# 3. The work actually reached origin/master — not a `main` branch quietly
#    created beside it, which is what a hardcoded push would have produced.
git -C "${MREPO}" fetch -q origin master 2>/dev/null
is "the file is on origin/master" \
  "$(git -C "${MREPO}" cat-file -e "origin/master:legacy.txt" 2>/dev/null && echo yes || echo no)" "yes"
is "and no stray origin/main was created" \
  "$(git -C "${MREPO}" rev-parse --verify -q origin/main >/dev/null 2>&1 && echo stray || echo clean)" "clean"

# 4. The two `main` repos are untouched by the change — the regression that
#    would matter most, since every repo in daily use is one of these.
is "the main repos still landed" \
  "$(on_main "${CODE}" one.txt)$(on_main "${PROD}" one-prod.md)" "yesyes"

# 5. The report line names the trunk of the repo the JOURNAL landed in, because
#    that is whose SHA it carries. A line that said `origin/master` beside a
#    `main` SHA would be a false sentence with a real SHA in it.
has "the report line names the trunk the SHA is on" "${OUT}" "origin/main is at"
is "…and the SHA is the journal repo's" "$(printf '%s\n' "${OUT}" | tail -n 1)" \
  "origin/main is at $(git -C "${CODE}" rev-parse origin/main) — closing this tab loses nothing."

# 6. The satellite is gone, like any other.
is "the master satellite is removed" "$([ -d "${MSAT}" ] && echo left || echo gone)" "gone"

# 7. And --check certifies it, which is the half that was missing when this was
#    done by hand: nothing recorded that the repo had landed.
OUT="$(as1 bash "${LAND}" --check 2>&1)"
is "--check certifies the master-trunk close" "$?" "0"

echo "── Case 11: the final report includes the generated next action ─────"

fixture c11
mkdir -p "${WT1}/projects/sales/2026-09-17_portal"
printf '%s\n' '---' 'status: active' '---' '' '# Portal' \
  >"${WT1}/projects/sales/2026-09-17_portal/README.md"
J="$(jf1 portal)"
printf '%s\n' \
  '---' \
  'date: 2026-09-13' \
  'time: "20:15"' \
  'slug: sales/2026-09-17_portal' \
  'project: sales/2026-09-17_portal' \
  'tags: []' \
  '---' \
  '' \
  '### sales/2026-09-17_portal' \
  '**Action:** shipped' \
  '' \
  'Portal phase shipped.' >"${J}"

OUT="$(as1 bash "${LAND}" "Ship portal phase" 2>&1)"
RC=$?
is "the project close lands" "${RC}" "0"
has "the generated block states what shipped" "${OUT}" '**Shipped:** Ship portal phase'
has "the generated block labels the next action" "${OUT}" '**Next:**'
has "the generated block includes the exact command" "${OUT}" '/project portal'
# shellcheck disable=SC2016  # literal markdown the assertion compares byte-for-byte
has "the generated next action is its own fenced block" "${OUT}" "$(printf '**Next:**\n\n```\n/project portal\n```')"
has "the generated block gives the journal's landed path, in the shared checkout" "${OUT}" \
  "**Journal:** [$(basename "${J}")](<${CODE}/journal/2026-09-13/$(basename "${J}")>)"
is "the proof remains the last line" "$(printf '%s\n' "${OUT}" | tail -n 1)" \
  "origin/main is at $(git -C "${CODE}" rev-parse origin/main) — closing this tab loses nothing."

echo "── Case 11b: several next commands, each in its own block ──────────"

# A ROADMAP project with two rows ready to implement and one blocked: the close
# must print TWO fenced blocks — one copy button per parallel session — and the
# blocked row as prose, not a heading, with the proof line still last.
fixture c11b
P11B="${WT1}/projects/sales/2026-09-18_par"
mkdir -p "${P11B}/specs/001-a" "${P11B}/specs/002-b"
printf '%s\n' '---' 'status: active' '---' '' '# Par' >"${P11B}/README.md"
# shellcheck disable=SC2016  # literal markdown the assertion compares byte-for-byte
printf '%s\n' '# Roadmap: par' '' \
  '| ID | Sub-feature | Depends on | Status | Sub-spec |' \
  '|----|-------------|------------|--------|----------|' \
  '| R1 | a | — | planned | `specs/001-a/` |' \
  '| R2 | b | — | planned | `specs/002-b/` |' \
  '| R3 | c | — | blocked: vendor reply | — |' >"${P11B}/ROADMAP.md"
echo '# spec' >"${P11B}/specs/001-a/spec.md"; echo '# spec' >"${P11B}/specs/002-b/spec.md"
J="$(jf1 par)"
printf '%s\n' '---' 'date: 2026-09-13' 'time: "20:30"' 'slug: sales/2026-09-18_par' \
  'project: sales/2026-09-18_par' 'tags: []' '---' '' '### sales/2026-09-18_par' \
  '**Action:** specced' '' 'Two rows specced.' >"${J}"
OUT="$(as1 bash "${LAND}" "Spec par rows" 2>&1)"
is "the parallel close lands" "$?" "0"
# shellcheck disable=SC2016  # literal markdown the assertion compares byte-for-byte
has "two commands are two fenced blocks" "${OUT}" "$(printf '**Next:**\n\n```\n/implement par r1\n```\n\n```\n/implement par r2\n```')"
has "a comment line is escaped prose" "${OUT}" "$(printf '\n\\# par R3 is blocked: vendor reply\n')"
is "the proof remains the last line after several blocks" "$(printf '%s\n' "${OUT}" | tail -n 1)" \
  "origin/main is at $(git -C "${CODE}" rev-parse origin/main) — closing this tab loses nothing."

echo "── Case 11c: a one-off's \`project: null\` is no project ──────────────"

# The journal schema tells a one-off close to write \`project: null\`. That is
# YAML's null, not a folder named "null" — reading it as a path refused every
# one-off close written to the schema (2026-09-23).
fixture c11c
J="$(jf1 oneoff)"
printf '%s\n' '---' 'date: 2026-09-13' 'time: "20:45"' 'slug: one-off (a question)' \
  'project: null' 'tags: []' '---' '' '### one-off (a question)' \
  '**Action:** investigated' '' 'Answered a question.' >"${J}"
OUT="$(as1 bash "${LAND}" "Answer a question" 2>&1)"
is "a project: null close lands" "$?" "0"
hasnt "a project: null close prints no Next" "${OUT}" '**Next:**'

echo "── Case 12: the decision-record gate ────────────────────────────────"

# The checker is workbench's, and what is tested here is that land.sh finds it
# in a ledger worktree, runs it before the commit and honours its verdict — not
# the seven parts, which check-decision-records.test.sh owns. So a stand-in
# that rejects any changed record containing BAD, committed at the path land.sh
# resolves. It logs `<worktree>⇥<record>` for every record it sees to
# DR_STUB_LOG, so a row can prove WHERE it ran rather than only that the close
# passed — a stub run in the wrong worktree passes a clean record too.
dr_stub() {
  mkdir -p "$1/.agents/checks"
  cat >"$1/.agents/checks/check-decision-records.sh" <<'STUB'
#!/usr/bin/env bash
base=HEAD
if [ "${1:-}" = "--since" ]; then
  base="$(git merge-base HEAD "$2" 2>/dev/null)" || { echo "stub: no merge base with $2" >&2; exit 2; }
fi
rc=0
while read -r f; do
  [ -f "$f" ] || continue
  printf '%s\t%s\n' "$PWD" "$f" >>"${DR_STUB_LOG:-/dev/null}"
  if grep -q BAD "$f"; then echo "$f: (b) stub rejects it" >&2; rc=1; fi
done < <( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | grep -E '(^|/)decisions/')
[ "$rc" = 0 ] && echo "OK — stub"
exit "$rc"
STUB
  git -C "$1" add -A && git -C "$1" commit -q -m "checker"
}

# fixture + the stub's log in the thread's environment.
dr_fixture() {
  fixture "$1"
  DR_LOG="${S}/dr.log"
  ENV1+=("DR_STUB_LOG=${DR_LOG}")
}

# 1. A malformed record is refused, and nothing is committed.
dr_fixture c12a
dr_stub "${WT1}"
mkdir -p "${WT1}/decisions"
echo "BAD" >"${WT1}/decisions/0001-bad.md"
echo "BAD" >"${WT1}/decisions/0002-also-bad.md"
echo "one" >"${WT1}/one.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a malformed decision record exits 3" "$?" "3"
has "naming the check's first violation" "${OUT}" \
  "NOT CLOSED: decision record rejected in ${WT1}: decisions/0001-bad.md: (b) stub rejects it"
has "…and printing every other violation too" "${OUT}" "decisions/0002-also-bad.md: (b) stub rejects it"
is "the worktree is left uncommitted" \
  "$(git -C "${WT1}" status --porcelain -uall | grep -c 'decisions/\|one.txt')" "3"
is "so neither file reached main" \
  "$(on_main "${CODE}" decisions/0001-bad.md)$(on_main "${CODE}" one.txt)" "nono"

# 1b. The same record already COMMITTED in the worktree, as /implement commits
#     before its close. Against HEAD it differs from nothing; the gate must
#     measure from where the branch left the trunk. The first live close under
#     this gate counted 0 records for exactly this reason.
dr_fixture c12a2
dr_stub "${WT1}"
mkdir -p "${WT1}/decisions"
echo "BAD" >"${WT1}/decisions/0001-bad.md"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "a bad record, committed early"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a malformed record committed before the close exits 3" "$?" "3"
has "…naming it" "${OUT}" "decisions/0001-bad.md: (b) stub rejects it"
is "…and it did not reach main" "$(on_main "${CODE}" decisions/0001-bad.md)" "no"

# 2. No decision record: the gate runs, passes, and FALLS THROUGH to the commit.
#    A `return` in the gate would exit land_one here with one.txt uncommitted.
dr_fixture c12b
dr_stub "${WT1}"
echo "one" >"${WT1}/one.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close with no decision record lands" "$?" "0"
is "and its file is committed and on main" "$(on_main "${CODE}" one.txt)" "yes"
has "…with the safe-to-close line" "${OUT}" "— closing this tab loses nothing."

# 2a. origin/<trunk> named by origin/HEAD but not yet a local ref: only the
#     fetch creates it, so the gate must fetch before it measures from it, or
#     every close in that repo — records or none — is refused.
dr_fixture c12b1
dr_stub "${WT1}"
git -C "${CODE}" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
git -C "${CODE}" update-ref -d refs/remotes/origin/main
is "origin/main is absent locally before the close" \
  "$(git -C "${CODE}" rev-parse -q --verify refs/remotes/origin/main || echo absent)" "absent"
echo "one" >"${WT1}/one.txt"
mkdir -p "${WT1}/decisions"
echo "fine" >"${WT1}/decisions/0001-scoped.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a trunk ref only the fetch creates does not block the close" "$?" "0"
is "…and its file and record reached main" \
  "$(on_main "${CODE}" one.txt)$(on_main "${CODE}" decisions/0001-scoped.md)" "yesyes"
is "…with the record scoped from the fetched ref and checked" \
  "$(grep -c "decisions/0001-scoped.md$" "${DR_LOG}" 2>/dev/null)" "1"

# 2b. A well-formed record lands beside it.
dr_fixture c12b2
dr_stub "${WT1}"
mkdir -p "${WT1}/decisions"
echo "fine" >"${WT1}/decisions/0001-good.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close carrying a clean record lands" "$?" "0"
is "and the record is on main" "$(on_main "${CODE}" decisions/0001-good.md)" "yes"

# 3. A changed record with no checker anywhere in the ledger is refused, not
#    skipped — a silent `[ -f ]` would land the record unchecked.
dr_fixture c12c
mkdir -p "${WT1}/projects/x/decisions"
echo "fine" >"${WT1}/projects/x/decisions/0001-a.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a record with no resolvable checker exits 3" "$?" "3"
has "saying no worktree holds the checker" "${OUT}" \
  "no worktree this thread owns holds .agents/checks/check-decision-records.sh"
is "and it did not reach main" "$(on_main "${CODE}" projects/x/decisions/0001-a.md)" "no"

#    A README edit in a decisions/ folder is not a record: with no checker,
#    that close is not refused.
rm "${WT1}/projects/x/decisions/0001-a.md"
echo "# Decision records" >"${WT1}/projects/x/decisions/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a decisions/README.md alone needs no checker" "$?" "0"

#    The same with the record already COMMITTED: the no-checker question must
#    measure from the trunk too, or it asks HEAD and finds nothing to refuse.
fixture c12c2
mkdir -p "${WT1}/projects/x/decisions"
echo "fine" >"${WT1}/projects/x/decisions/0001-a.md"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "a record, committed early"
is "the record is committed and the index clean before the close" \
  "$(git -C "${WT1}" cat-file -e HEAD:projects/x/decisions/0001-a.md && echo in-head)$(git -C "${WT1}" status --porcelain)" "in-head"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a committed record with no resolvable checker exits 3" "$?" "3"
has "…saying no worktree holds the checker" "${OUT}" "no worktree this thread owns holds"
is "…and it stayed off main" "$(on_main "${CODE}" projects/x/decisions/0001-a.md)" "no"

# 4. The checker's own satellite lands BEFORE a repo whose records it must
#    check. Its removal is deferred to the end; removed in turn, the third repo
#    would find the resolved path gone and fail with no violation at all. The
#    checker's worktree is a satellite when the thread is on a product repo
#    and workbench is the satellite; the fixture gives the PROD satellite the
#    checker, which puts it in the same ledger position.
# third_repo <scenario> — a third main-trunk repo and this thread's satellite of
# it, registered AFTER the PROD satellite so it lands after the checker's.
# Sets TREPO, TSAT.
third_repo() {
  local bare="${S}/origins/land-$$-$1-third.git"
  TREPO="${S}/land-$$-$1-third"
  git init -q --bare -b main "${bare}"
  git init -q -b main "${TREPO}"
  git -C "${TREPO}" config user.email t@example.com
  git -C "${TREPO}" config user.name tester
  echo seed >"${TREPO}/seed.txt"
  git -C "${TREPO}" add seed.txt
  git -C "${TREPO}" commit -q -m seed
  git -C "${TREPO}" remote add origin "${bare}"
  git -C "${TREPO}" push -q -u origin main
  git -C "${TREPO}" remote set-head origin --auto >/dev/null 2>&1
  TSAT="$(as1 bash "${WRITE_ROOT}" "${TREPO}")"
}

dr_fixture c12d
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
dr_stub "${SAT1}"
third_repo c12d
mkdir -p "${TSAT}/decisions"
echo "fine" >"${TSAT}/decisions/0001-third.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a record in a repo landed after the checker's satellite lands" "$?" "0"
is "and reaches main" "$(on_main "${TREPO}" decisions/0001-third.md)" "yes"
is "the checker ran IN the third repo's worktree, on its record" \
  "$(grep -c "^${TSAT}"$'\t'"decisions/0001-third.md$" "${DR_LOG}" 2>/dev/null)" "1"
is "the checker's satellite is still removed, last" \
  "$([ -d "${SAT1}" ] && echo left || echo gone)" "gone"

# 5. The same shape, but the third repo's record is bad on the first run. The
#    checker's satellite has already landed when the close is refused, so its
#    deferred removal never ran; the retry finds it already landed and must
#    queue that removal again, or it is left on disk under the proof line.
dr_fixture c12e
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
dr_stub "${SAT1}"
third_repo c12e
mkdir -p "${TSAT}/decisions"
echo "BAD" >"${TSAT}/decisions/0001-third.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "the first run is refused on the third repo's record" "$?" "3"
is "…after the checker's satellite landed" \
  "$(git -C "${PROD}" log origin/main --format=%s | grep -c '^checker$')" "1"
echo "fine" >"${TSAT}/decisions/0001-third.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "the retry lands" "$?" "0"
is "the already-landed checker satellite is removed on the retry" \
  "$([ -d "${SAT1}" ] && echo left || echo gone)" "gone"

echo "── Case 13: the integration-manifest gate ───────────────────────────"

# The same shape as Case 12 for the second pre-commit checker. What is tested
# is that land.sh finds it, runs it with --since before the commit and honours
# its verdict; the schema's parts are check-integration-manifest.test.sh's.
im_stub() {
  mkdir -p "$1/.agents/checks"
  cat >"$1/.agents/checks/check-integration-manifest.sh" <<'STUB'
#!/usr/bin/env bash
base=HEAD
if [ "${1:-}" = "--since" ]; then
  base="$(git merge-base HEAD "$2" 2>/dev/null)" || { echo "stub: no merge base with $2" >&2; exit 2; }
fi
rc=0
while read -r f; do
  [ -f "$f" ] || continue
  if grep -q BAD "$f"; then echo "$f: (k) stub rejects it" >&2; rc=1; fi
done < <( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | grep -E '^integrations/[^/]+/README\.md$')
[ "$rc" = 0 ] && echo "OK — stub"
exit "$rc"
STUB
  git -C "$1" add -A && git -C "$1" commit -q -m "manifest checker"
}

# 1. A bad manifest is refused with every violation printed, nothing committed.
fixture c13a
im_stub "${WT1}"
mkdir -p "${WT1}/integrations/alpha" "${WT1}/integrations/beta"
echo "BAD" >"${WT1}/integrations/alpha/README.md"
echo "BAD" >"${WT1}/integrations/beta/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a bad integration manifest exits 3" "$?" "3"
has "naming the check's first violation" "${OUT}" \
  "NOT CLOSED: integration manifest rejected in ${WT1}: integrations/alpha/README.md: (k) stub rejects it"
has "…and printing every other violation too" "${OUT}" "integrations/beta/README.md: (k) stub rejects it"
is "…and it did not reach main" "$(on_main "${CODE}" integrations/alpha/README.md)" "no"

# 2. The same manifest COMMITTED before the close is still measured from the trunk.
fixture c13b
im_stub "${WT1}"
mkdir -p "${WT1}/integrations/alpha"
echo "BAD" >"${WT1}/integrations/alpha/README.md"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "a bad manifest, committed early"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a bad manifest committed before the close exits 3" "$?" "3"
has "…naming it" "${OUT}" "integrations/alpha/README.md: (k) stub rejects it"

# 3. A clean manifest lands.
fixture c13c
im_stub "${WT1}"
mkdir -p "${WT1}/integrations/alpha"
echo "fine" >"${WT1}/integrations/alpha/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close carrying a clean manifest lands" "$?" "0"
is "and the manifest is on main" "$(on_main "${CODE}" integrations/alpha/README.md)" "yes"

# 4. A changed manifest with no checker in the ledger is reported, not refused:
#    a workbench without that checker has no manifest schema to hold it to.
fixture c13d
mkdir -p "${WT1}/integrations/alpha"
echo "fine" >"${WT1}/integrations/alpha/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a manifest with no resolvable checker still lands" "$?" "0"
has "saying no checker looked at it" "${OUT}" \
  "note: integration manifests changed in ${WT1}; no .agents/checks/check-integration-manifest.sh to check them"

#    A manifest outside integrations/<name>/ is not one: no checker needed.
rm -rf "${WT1}/integrations"
mkdir -p "${WT1}/docs/integrations/alpha"
echo "fine" >"${WT1}/docs/integrations/alpha/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a README.md outside integrations/<name>/ needs no checker" "$?" "0"

echo "── Case 14: the skill-manifest gate ─────────────────────────────────"

# The third pre-commit checker, and the first that lives in the worktree it
# checks: the skills tree is `.agents/skills/` of the workbench, its checker is
# `.agents/checks/check-skills.sh`, and land.sh runs THAT copy over what the worktree
# changed under `.agents/skills/`. What is tested is that it is found, run with
# --since before the commit, and honoured — the rules themselves are
# check-skills.test.sh's. The stub writes a marker on every invocation (into
# the fixture HOME, which outlives the worktree), so "not invoked" is
# observable.
sk_stub() {
  mkdir -p "$1/.agents/checks"
  cat >"$1/.agents/checks/check-skills.sh" <<'STUB'
#!/usr/bin/env bash
: >"${HOME}/.skill-stub-invoked"
base=HEAD
if [ "${1:-}" = "--since" ]; then
  base="$(git merge-base HEAD "$2" 2>/dev/null)" || { echo "stub: no merge base with $2" >&2; exit 2; }
fi
rc=0
while read -r f; do
  [ -f "$f" ] || continue
  if grep -q BAD "$f"; then echo "$f: stub rejects it" >&2; rc=1; fi
done < <( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | grep -E '^\.agents/skills/[^/]+/SKILL\.md$')
[ "$rc" = 0 ] && echo "OK — stub"
exit "$rc"
STUB
  git -C "$1" add -A && git -C "$1" commit -q -m "skill checker"
}

# 1. A bad manifest is refused with the violation printed, nothing committed.
fixture c14a
sk_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/alpha"
echo "BAD" >"${WT1}/.agents/skills/alpha/SKILL.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a bad skill manifest exits 3" "$?" "3"
has "naming the check's violation" "${OUT}" \
  "NOT CLOSED: skill manifest rejected in ${WT1}: .agents/skills/alpha/SKILL.md: stub rejects it"
is "…and it did not reach main" "$(on_main "${CODE}" .agents/skills/alpha/SKILL.md)" "no"

# 2. A clean manifest lands, and the checker ran.
fixture c14b
sk_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/alpha"
echo "fine" >"${WT1}/.agents/skills/alpha/SKILL.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close carrying a clean skill manifest lands" "$?" "0"
is "and the manifest is on main" "$(on_main "${CODE}" .agents/skills/alpha/SKILL.md)" "yes"

# 3. A changed manifest in a worktree without the checker is refused, not skipped.
fixture c14c
mkdir -p "${WT1}/.agents/skills/alpha"
echo "fine" >"${WT1}/.agents/skills/alpha/SKILL.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a skill manifest with no checker in its worktree exits 3" "$?" "3"
has "saying the worktree holds no .agents/checks/check-skills.sh" "${OUT}" \
  "skill manifests changed in ${WT1}, but ${WT1} holds no .agents/checks/check-skills.sh"

# 4. Only a root-level file changed, or a path under a top-level folder that is
#    NOT .agents/skills/ — a journal entry, a project record — and the checker is not
#    invoked: the gate is scoped to `.agents/skills/`, not to "any top-level folder",
#    because in this repo every close changes paths under one. A file under a
#    skill folder that is NOT its SKILL.md (a state/ file) does invoke it —
#    within .agents/skills/ the gate selects by folder, not by manifest.
fixture c14d
sk_stub "${WT1}"
echo "edited" >"${WT1}/seed.txt"
mkdir -p "${WT1}/journal/2026-09-25" "${WT1}/projects/x"
echo "entry" >"${WT1}/journal/2026-09-25/1200-x.md"
echo "record" >"${WT1}/projects/x/README.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a change outside .agents/skills/ lands" "$?" "0"
is "…without invoking the skill checker" \
  "$([ -f "${HOME_DIR}/.skill-stub-invoked" ] && echo invoked || echo not)" "not"
fixture c14e
sk_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/alpha/state"
echo "learned" >"${WT1}/.agents/skills/alpha/state/notes.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a change under a skill folder lands when the checker passes" "$?" "0"
is "…and the skill checker was invoked for it" \
  "$([ -f "${HOME_DIR}/.skill-stub-invoked" ] && echo invoked || echo not)" "invoked"

#    A change that only DELETES a file under a skill folder (state/_doc.md)
#    still selects the folder: the checker decides what a missing file means.
fixture c14f
sk_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/alpha/state"
echo "fine" >"${WT1}/.agents/skills/alpha/SKILL.md"
echo "doc" >"${WT1}/.agents/skills/alpha/state/_doc.md"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "alpha with state"
# On the trunk already, so the deletion is the ONLY change since the base.
git -C "${WT1}" push -q origin HEAD:main
rm "${WT1}/.agents/skills/alpha/state/_doc.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a deletion under a skill folder lands when the checker passes" "$?" "0"
is "…and the skill checker was invoked for it" \
  "$([ -f "${HOME_DIR}/.skill-stub-invoked" ] && echo invoked || echo not)" "invoked"

echo "── Case 15: the secrets and standards gates ─────────────────────────"

# Both checkers sit in the workbench worktree's .agents/checks/. The secrets
# scan runs over every repo's change; the standards check over the workbench.
# What is tested is that each is found, run, and honoured.
checks_stub() {  # checks_stub <worktree> — a secrets and a standards stub
  mkdir -p "$1/.agents/checks"
  cat >"$1/.agents/checks/check-secrets.sh" <<'STUB'
#!/usr/bin/env bash
base=HEAD
[ "${1:-}" = "--since" ] && base="$(git merge-base HEAD "$2")"
rc=0
while read -r f; do
  pat="AK"; pat="${pat}IA"   # split, so the stub does not flag itself
  [ -f "$f" ] && grep -q "$pat" "$f" && { echo "$f: looks like a key" >&2; rc=1; }
done < <( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } )
exit "$rc"
STUB
  cat >"$1/.agents/checks/check-standards-refs.sh" <<'STUB'
#!/usr/bin/env bash
if grep -rq 'Standards → Nonexistent' --include='*.md' . 2>/dev/null; then
  echo "cites a bullet that does not exist: Nonexistent" >&2; exit 1
fi
exit 0
STUB
  git -C "$1" add -A && git -C "$1" commit -q -m "checks"
}

fixture c15a
checks_stub "${WT1}"
echo "key = AKIA0000" >"${WT1}/config.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a change carrying a secret exits 3" "$?" "3"
has "…naming the secret scan" "${OUT}" "NOT CLOSED: secret scan rejected in ${WT1}: config.txt: looks like a key"
is "…and nothing reached main" "$(on_main "${CODE}" config.txt)" "no"

fixture c15b
checks_stub "${WT1}"
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
echo "key = AKIA0000" >"${SAT1}/leak.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a secret in a product repo is refused by the workbench's scanner" "$?" "3"
has "…in that repo's worktree" "${OUT}" "secret scan rejected in ${SAT1}"

fixture c15c
checks_stub "${WT1}"
echo "See § Standards → Nonexistent." >"${WT1}/notes.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a citation of a missing standard exits 3" "$?" "3"
has "…naming the standards check" "${OUT}" "NOT CLOSED: standards citations rejected in ${WT1}"

fixture c15d
checks_stub "${WT1}"
echo "clean" >"${WT1}/notes.md"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a clean change passes both gates" "$?" "0"

# Each checker is found in whichever ledger worktree holds IT: a worktree with
# some of .agents/checks/ must not hide a checker only a later one carries.
fixture c15e
checks_stub "${WT1}"
git -C "${WT1}" rm -q .agents/checks/check-secrets.sh && git -C "${WT1}" commit -q -m "no scanner here"
SAT1="$(as1 bash "${WRITE_ROOT}" "${PROD}")"
checks_stub "${SAT1}"
echo "key = AKIA0000" >"${WT1}/config.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a scanner only a later ledger worktree holds still runs" "$?" "3"
has "…and refuses the secret" "${OUT}" "secret scan rejected in ${WT1}"

echo "── Case 16: a session outside T3 that started in the main checkout ──"

# No T3 database, a harness session id, the shell in the MAIN checkout: the
# journal allocation makes the session's worktree (a satellite of the
# workbench), and the close lands it and removes it — there is no harness
# worktree to keep.
fixture c16
NOT3=("HOME=${HOME_DIR}" "T3CODE_HOME=${S}/no-t3" "LAND_PUSH_SLEEP=0" "CONTEXTIUM_SESSION=cc-16")
J16="$(cd "${CODE}" && env ${NOT3[@]+"${NOT3[@]}"} bash "${CODE}/.agents/skills/close/scripts/journal-file.sh" "outside t3")"
case "${J16}" in "${HOME_DIR}/.cache/workbench/worktrees/"*/cc-16/journal/*) ok "the entry goes in a worktree made for the session" ;; *) bad "outside-T3 journal path: ${J16}" ;; esac
entry "${J16}" "outside-t3" "a session outside T3"
W16="${J16%%/journal/*}"
echo "work" >"${W16}/work.txt"
OUT="$(cd "${CODE}" && env ${NOT3[@]+"${NOT3[@]}"} bash "${CODE}/.agents/skills/close/scripts/land.sh" "outside t3" 2>&1)"
is "it lands" "$?" "0"
is "…with its work on main" "$(on_main "${CODE}" work.txt)" "yes"
is "…and the worktree the close made is removed" "$([ -d "${W16}" ] && echo kept || echo removed)" "removed"
has "…ending on the proof line" "$(printf '%s\n' "${OUT}" | tail -n 1)" "— closing this tab loses nothing."

echo "── Case 17: two threads land adjacent roadmap rows ──────────────────"

# Two sessions build two rows of one project in parallel and each flips its own
# row. The rows are adjacent lines, which git's line merge calls a conflict, so
# the second close used to stop with NOT CLOSED. land.sh wires roadmap-merge.sh
# in before it merges, and the table merges row by row.
fixture c17
RMP="projects/demo/2026-01-01_rows"
mkdir -p "${CODE}/${RMP}"
# shellcheck disable=SC2016  # table rows hold literal backticks
printf '%s\n' '# Roadmap: rows' '' \
  '| ID | Sub-feature | Depends on | Status | Sub-spec |' \
  '|----|-------------|------------|--------|----------|' \
  '| R1 | first | — | planned | `specs/001-first/` |' \
  '| R2 | second | — | planned | `specs/002-second/` |' \
  '| R3 | third | R1, R2 | planned | — |' >"${CODE}/${RMP}/ROADMAP.md"
printf -- '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n' >"${CODE}/${RMP}/README.md"
git -C "${CODE}" add -A && git -C "${CODE}" commit -q -m "roadmap" && git -C "${CODE}" push -q origin main
for wt in "${WT1}" "${WT2}"; do git -C "${wt}" fetch -q origin && git -C "${wt}" reset -q --hard origin/main; done
# Each session flips its own row and re-derives next: from its own table, as
# the close's project step does — so the two READMEs disagree.
RMSH="${HERE}/roadmap.sh"
bash "${RMSH}" "${WT1}/${RMP}" --set R1 "done" && bash "${RMSH}" "${WT1}/${RMP}" --sync-next
bash "${RMSH}" "${WT2}/${RMP}" --set R2 "done" && bash "${RMSH}" "${WT2}/${RMP}" --sync-next
J1="$(jf1 "row one")"; entry "${J1}" "row-one" "thread one's row"
J2="$(jf2 "row two")"; entry "${J2}" "row-two" "thread two's row"
OUT1="$(as1 bash "${LAND}" "row one" 2>&1)"
is "the first row lands" "$?" "0"
OUT2="$(as2 bash "${LAND}" "row two" 2>&1)"
RC2=$?
is "the second, adjacent row lands too — no conflict" "${RC2}" "0"
[ "${RC2}" = 0 ] || printf '%s\n' "${OUT2}" | tail -3
git -C "${CODE}" fetch -q origin
is "origin's roadmap has both rows done and R3 untouched" \
  "$(git -C "${CODE}" show "origin/main:${RMP}/ROADMAP.md" | grep '^| R' | awk -F'|' '{gsub(/ /,"",$2); gsub(/^ +| +$/,"",$5); printf "%s=%s ", $2, $5}')" \
  "R1=done R2=done R3=planned "
is "…and next: re-derived from the merged table, to R3" \
  "$(git -C "${CODE}" show "origin/main:${RMP}/README.md" | sed -n 's/^next: //p')" '"R3: third"'
has "the driver is registered in the repo's config" \
  "$(git -C "${CODE}" config merge.roadmap.driver)" "roadmap-merge.sh"

echo "── Case 17b: next: that cannot be re-derived stops the close ─────────"

# The merge changed the table, but the merged table no longer reads (here a
# row the trunk added was never filled in), so next: cannot be re-derived.
# Pushing then would ship a README whose next: names the wrong row.
fixture c17b
RMP="projects/demo/2026-01-01_rows"
mkdir -p "${CODE}/${RMP}"
# shellcheck disable=SC2016  # table rows hold literal backticks
printf '%s\n' '# Roadmap: rows' '' \
  '| ID | Sub-feature | Depends on | Status | Sub-spec |' \
  '|----|-------------|------------|--------|----------|' \
  '| R1 | first | — | planned | `specs/001-first/` |' \
  '| R2 | second | — | planned | `specs/002-second/` |' >"${CODE}/${RMP}/ROADMAP.md"
printf -- '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n' >"${CODE}/${RMP}/README.md"
git -C "${CODE}" add -A && git -C "${CODE}" commit -q -m "roadmap" && git -C "${CODE}" push -q origin main
git -C "${WT2}" fetch -q origin && git -C "${WT2}" reset -q --hard origin/main
printf '%s\n' '| R3 | <name> | — | planned | — |' >>"${CODE}/${RMP}/ROADMAP.md"
git -C "${CODE}" commit -qam "a row nobody filled in" && git -C "${CODE}" push -q origin main
sed 's/| R2 | second | — | planned |/| R2 | second | — | done |/' "${WT2}/${RMP}/ROADMAP.md" >"${S}/rm2" && mv "${S}/rm2" "${WT2}/${RMP}/ROADMAP.md"
J2="$(jf2 "row two")"; entry "${J2}" "row-two" "thread two's row"
OUT="$(as2 bash "${LAND}" "row two" 2>&1)"
is "a next: that cannot be re-derived stops the close" "$?" "3"
has "…naming why" "${OUT}" "NOT CLOSED: next: could not be re-derived"
git -C "${CODE}" fetch -q origin
is "…and nothing of it was pushed" \
  "$(git -C "${CODE}" show "origin/main:${RMP}/ROADMAP.md" | grep -c '| R2 | second | — | done |')" "0"
# The merge stays committed in the worktree. A re-run finds trunk already
# merged, and must still re-derive next: before it pushes, not skip it.
OUT="$(as2 bash "${LAND}" "row two" 2>&1)"
is "a re-run with the table still broken stops again" "$?" "3"
git -C "${CODE}" fetch -q origin
is "…and still pushes nothing" \
  "$(git -C "${CODE}" show "origin/main:${RMP}/ROADMAP.md" | grep -c '| R2 | second | — | done |')" "0"

echo "── Case 17c: a table only the trunk changed, a README only we changed ─"

# The trunk flipped a row and re-derived next:; this thread touched only the
# project's README body. The merged ROADMAP.md is the trunk's, but the README
# merge keeps OUR next: line — the old one — so the project must still be
# re-derived, because the push changes its README.
fixture c17c
RMP="projects/demo/2026-01-01_rows"
mkdir -p "${CODE}/${RMP}"
# shellcheck disable=SC2016  # table rows hold literal backticks
printf '%s\n' '# Roadmap: rows' '' \
  '| ID | Sub-feature | Depends on | Status | Sub-spec |' \
  '|----|-------------|------------|--------|----------|' \
  '| R1 | first | — | planned | `specs/001-first/` |' \
  '| R2 | second | — | planned | `specs/002-second/` |' >"${CODE}/${RMP}/ROADMAP.md"
printf -- '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n\nBody.\n' >"${CODE}/${RMP}/README.md"
git -C "${CODE}" add -A && git -C "${CODE}" commit -q -m "roadmap" && git -C "${CODE}" push -q origin main
git -C "${WT2}" fetch -q origin && git -C "${WT2}" reset -q --hard origin/main
bash "${HERE}/roadmap.sh" "${CODE}/${RMP}" --set R1 "done" && bash "${HERE}/roadmap.sh" "${CODE}/${RMP}" --sync-next
git -C "${CODE}" commit -qam "R1 done" && git -C "${CODE}" push -q origin main
sed 's/^Body\.$/Body, edited by thread two./' "${WT2}/${RMP}/README.md" >"${S}/rd2" && mv "${S}/rd2" "${WT2}/${RMP}/README.md"
J2="$(jf2 "readme only")"; entry "${J2}" "readme-only" "thread two's README"
OUT="$(as2 bash "${LAND}" "readme only" 2>&1)"
is "a README-only change over a trunk-only table change lands" "$?" "0"
git -C "${CODE}" fetch -q origin
is "…with next: derived from the table that landed" \
  "$(git -C "${CODE}" show "origin/main:${RMP}/README.md" | sed -n 's/^next: //p')" '"R2: second"'
has "…and thread two's edit" "$(git -C "${CODE}" show "origin/main:${RMP}/README.md")" "Body, edited by thread two."

echo "── Case 12x: a failed git read never reads as clean ────────────────"

# A git read that fails is not "nothing changed". A git whose untracked-file
#     listing fails would have hidden this record from the gate above, and the
#     close would have landed it unchecked.
dr_fixture c12x1
mkdir -p "${S}/failgit"
cat >"${S}/failgit/git" <<FAILGIT
#!/usr/bin/env bash
case " \$* " in *" ls-files -z --others "*) echo "fatal: simulated read failure" >&2; exit 128 ;; esac
exec "$(command -v git)" "\$@"
FAILGIT
chmod +x "${S}/failgit/git"
mkdir -p "${WT1}/projects/x/decisions"
echo "fine" >"${WT1}/projects/x/decisions/0001-a.md"
OUT="$(as1 env PATH="${S}/failgit:${PATH}" bash "${LAND}" "thread one" 2>&1)"
is "a failed git read of the change stops the close" "$?" "3"
has "…saying it could not list the change" "${OUT}" "could not list what ${WT1} changed"
is "…and the record did not reach main" "$(on_main "${CODE}" projects/x/decisions/0001-a.md)" "no"

# The same for the worktree's status: a failed read is not a clean tree.
#     Read as empty, the work was never committed and the proof line vouched
#     for a worktree still holding it.
dr_fixture c12x2
cat >"${S}/failgit-st" <<FAILGIT
#!/usr/bin/env bash
case " \$* " in *" status --porcelain "*) echo "fatal: simulated read failure" >&2; exit 128 ;; esac
exec "$(command -v git)" "\$@"
FAILGIT
mkdir -p "${S}/failst" && mv "${S}/failgit-st" "${S}/failst/git" && chmod +x "${S}/failst/git"
echo "work" >"${WT1}/work.txt"
OUT="$(as1 env PATH="${S}/failst:${PATH}" bash "${LAND}" "thread one" 2>&1)"
is "a failed status read stops the close" "$?" "3"
has "…saying so" "${OUT}" "NOT CLOSED: could not read the status of ${WT1}"
hasnt "…and prints no proof line" "${OUT}" "closing this tab loses nothing"

echo
echo "── Case 15: a repo retired into another still lists in the ledger ───"

# A repo merged into the workbench with its history, its checkout removed. A
# thread that had landed there before still carries that line, and the next
# close must account for the SHA on the surviving trunk, not refuse.
fixture c15
git init -q --bare -b main "${S}/origins/land-$$-c15-lib.git"
LIB="${S}/land-$$-c15-lib"
git init -q -b main "${LIB}"
git -C "${LIB}" config user.email t@example.com
git -C "${LIB}" config user.name tester
echo "record" >"${LIB}/record.md"
git -C "${LIB}" add record.md && git -C "${LIB}" commit -q -m "lib record"
LIB_SHA="$(git -C "${LIB}" rev-parse HEAD)"
git -C "${CODE}" fetch -q "${LIB}" main
git -C "${CODE}" merge -q --allow-unrelated-histories --no-edit FETCH_HEAD
git -C "${CODE}" push -q origin main
git -C "${WT1}" fetch -q origin main && git -C "${WT1}" merge -q --ff-only origin/main
rm -rf "${LIB}"

echo "one" >"${WT1}/one.txt"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "thread one lands before the stale line exists" "$?" "0"
LANDED_FILE="${HOME_DIR}/.cache/workbench/threads/${TID1}/landed"
printf '%s\t%s\n' "${LIB}" "${LIB_SHA}" >>"${LANDED_FILE}"
OUT="$(as1 bash "${LAND}" --check --verbose 2>&1)"
is "--check passes when a retired repo's SHA is on a surviving trunk" "$?" "0"
has "…and says where it found it" "${OUT}" "retired, ancestor-of-land-$$-c15-code"

printf '%s\t%s\n' "${LIB}" "0123456789abcdef0123456789abcdef01234567" >>"${LANDED_FILE}"
OUT="$(as1 bash "${LAND}" --check 2>&1)"
is "--check refuses a retired repo's SHA that is on no surviving trunk" "$?" "3"
has "…naming the repo and the SHA" "${OUT}" \
  "${LIB} is gone and 0123456789abcdef0123456789abcdef01234567 is on no surviving repo's trunk"

echo
echo "── Case 18: the script-tests gate ───────────────────────────────────"

# A pre-commit checker resolved from the ledger like the decision-record one.
# What is tested is that land.sh finds it, runs it with --since before the
# commit and honours its verdict; the parts themselves are check-scripts.test.sh's.
# The strict stub goes ON THE TRUNK before the case's own change, because the
# stub is itself a script under the checker's roots with no test beside it.
sc_stub() {
  mkdir -p "$1/.agents/checks"
  cat >"$1/.agents/checks/check-scripts.sh" <<'STUB'
#!/usr/bin/env bash
base=HEAD
if [ "${1:-}" = "--since" ]; then
  base="$(git merge-base HEAD "$2" 2>/dev/null)" || { echo "stub: no merge base with $2" >&2; exit 2; }
fi
rc=0
while read -r f; do
  [ -f "$f" ] || continue
  case "$f" in *.test.*) continue ;; esac
  stem="$(basename "$f")"; stem="${stem%.*}"
  if ! ls "$(dirname "$f")/$stem".test.* >/dev/null 2>&1; then
    echo "$f: (a) stub rejects it" >&2; rc=1
  fi
done < <( { git diff --name-only "$base"; git ls-files --others --exclude-standard; } \
  | grep -E '^\.agents/.*\.(sh|ts|mjs|js|py)$')
[ "$rc" = 0 ] && echo "OK — stub"
exit "$rc"
STUB
  git -C "$1" add -A && git -C "$1" commit -q -m "script checker"
  git -C "$1" push -q origin HEAD:main
}

# 1. A script with no test is refused with every violation printed, nothing committed.
fixture c18a
sc_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/y/scripts"
echo "echo new" >"${WT1}/.agents/skills/y/scripts/new.sh"
echo "process.argv" >"${WT1}/.agents/skills/y/scripts/other.ts"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a script with no test exits 3" "$?" "3"
has "naming the check's first violation" "${OUT}" \
  "NOT CLOSED: script tests rejected in ${WT1}: .agents/skills/y/scripts/new.sh: (a) stub rejects it"
has "…and printing every other violation too" "${OUT}" ".agents/skills/y/scripts/other.ts: (a) stub rejects it"
is "…and it did not reach main" "$(on_main "${CODE}" .agents/skills/y/scripts/new.sh)" "no"

# 2. The same script COMMITTED before the close is still measured from the trunk.
fixture c18b
sc_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/y/scripts"
echo "echo new" >"${WT1}/.agents/skills/y/scripts/new.sh"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "a script without a test, committed early"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "an untested script committed before the close exits 3" "$?" "3"
has "…naming it" "${OUT}" ".agents/skills/y/scripts/new.sh: (a) stub rejects it"

# 3. The same script with its test beside it lands.
fixture c18c
sc_stub "${WT1}"
mkdir -p "${WT1}/.agents/skills/y/scripts"
echo "echo new" >"${WT1}/.agents/skills/y/scripts/new.sh"
echo "bash new.sh" >"${WT1}/.agents/skills/y/scripts/new.test.sh"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close carrying a tested script lands" "$?" "0"
is "and the script is on main" "$(on_main "${CODE}" .agents/skills/y/scripts/new.sh)" "yes"

# 4. A changed script with no checker in any ledger worktree is refused, not skipped.
FIXTURE_SC_STUB=none fixture c18d
mkdir -p "${WT1}/.agents/skills/y/scripts"
echo "echo new" >"${WT1}/.agents/skills/y/scripts/new.sh"
echo "bash new.sh" >"${WT1}/.agents/skills/y/scripts/new.test.sh"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a script with no resolvable checker exits 3" "$?" "3"
has "saying no worktree holds the checker" "${OUT}" \
  "scripts changed in ${WT1}, but no worktree this thread owns holds .agents/checks/check-scripts.sh"

#    Removing a script's only TEST is a changed script too: the deleted path
#    selects the gate, so a worktree without the checker is refused for it.
FIXTURE_SC_STUB=none fixture c18e
mkdir -p "${WT1}/.agents/skills/y/scripts"
echo "echo old" >"${WT1}/.agents/skills/y/scripts/old.sh"
echo "bash old.sh" >"${WT1}/.agents/skills/y/scripts/old.test.sh"
git -C "${WT1}" add -A && git -C "${WT1}" commit -q -m "old with its test"
git -C "${WT1}" push -q origin HEAD:main
rm "${WT1}/.agents/skills/y/scripts/old.test.sh"
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "deleting a script's only test with no checker exits 3" "$?" "3"
has "…for want of the checker" "${OUT}" "scripts changed in ${WT1}, but no worktree this thread owns holds"

#    No checker and no script changed: a journal entry and a record land.
FIXTURE_SC_STUB=none fixture c18f
mkdir -p "${WT1}/journal/2026-09-29" "${WT1}/projects/x"
echo "entry" >"${WT1}/journal/2026-09-29/1200-x.md"
echo "record" >"${WT1}/projects/x/README.md"
mkdir -p "${WT1}/docs"
echo "prose" >"${WT1}/docs/notes.sh"   # a .sh outside .agents/ is not one
OUT="$(as1 bash "${LAND}" "thread one" 2>&1)"
is "a close that changes no script under .agents/ needs no checker" "$?" "0"

echo
echo "land.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
