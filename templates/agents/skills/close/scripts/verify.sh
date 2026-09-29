#!/usr/bin/env bash
# verify.sh — run the checks of every app this thread touched, before anything
# is recorded.
#
# Verify comes first in the close — before the project update, the journal, the
# landing and the report — so a fix it forces lands before anything records the
# session. A red check found after the journal is written means the entry
# describes a session that did not happen the way it says.
#
# WHICH APPS. The ones whose own files moved in one of this thread's worktrees —
# not the ones that import them. Chasing importers fans out: a single edit can
# pull in ten apps, so the narrow scope is the rule.
#
# AN APP is the nearest folder under `apps/` that holds a package.json, above a
# changed file — `apps/<name>/` or `apps/<domain>/<name>/`, whichever the
# workbench uses — and its label is that path without `apps/`.
#
# THE ONE EXCEPTION: a session that changed NO app files at all. The narrow rule
# is about an edit touching an app AND a shared file, where the app's own checks
# already cover the change. A session confined to `integrations/` or `packages/`
# is a different animal — the narrow rule yields NOTHING, prints "no app files
# changed", and exits 0 having verified precisely nothing, while the apps that
# consume the change go unchecked. So when, and only when, the direct set is
# empty, this falls back to the apps that import the changed files. The fan-out
# is still capped — past IMPORTER_CAP the apps are NAMED as unverified rather
# than run, because a close that takes ten minutes is its own kind of failure.
#
# WHAT COUNTS AS VERIFIED. An app's own `check` and `test` scripts, run from its
# own directory, because that is where its package.json resolves its toolchain
# from. An app missing one is reported `unverified` rather than `FAIL`: a
# missing script is a gap in the app, not a defect this session introduced, and
# halting the close on it would make every session that brushed that app
# unclosable.
#
# WHICH INTEGRATIONS. The ones whose own files moved AND which declare a
# `check` or `test` of their own — verified in pass 1 beside the apps, on the
# same narrow rule. This is not the importer fallback: pass 2 fires only when
# pass 1 verified NOTHING, so a session touching an app AND an integration would
# otherwise verify the app and skip the integration's own suite. An integration
# that declares neither half prints nothing at all, rather than `unverified`: by
# convention an integration has no typecheck target of its own, so its silence
# is the norm and not a gap.
#
# Usage:
#   verify.sh              — verify every app this thread touched
#
# WHICH SKILLS. The same question, asked of the skills tree: every top-level
# folder under `.agents/skills/` whose files moved in this thread's WORKBENCH
# worktree — the ledger row holding the code, the records and the skills
# together — with a `(root)` unit for a changed file directly under
# `.agents/skills/`. Every `*.test.sh` AND every `*.test.ts` beneath such a
# folder runs — the shell suites directly, the node:test suites through
# `.agents/skills/run.sh` when the workbench has one, else `node` — and a red
# one halts the close exactly as a red app half
# does. See pass 3 below for why the unit is the folder rather than the file,
# and for the backstop that catches a write which never reached a worktree.
#
# Output, one line per app:
#   ok <app>
#   unverified <app> — no <check|test|check or test> script
#   unverified <app> — imports <path>, and N importers is past the cap
#   FAIL <app> <half> — rerun: cd <dir> && npm run <half>
#
# and one line per skill unit:
#   ok .agents/skills/<unit>
#   unverified .agents/skills/<unit> — no test suites
#   unverified skills — no worktree this thread owns holds .agents/skills/, so no
#                       skill folder was checked
#   unverified skills — ledger worktree <path> already landed and was removed
#   unverified skills — N uncommitted file(s) under .agents/skills/ in the shared
#                       checkout, owner unknown
#   FAIL .agents/skills/<unit> <suite> — rerun: cd <worktree> && bash <suite>
#   FAIL .agents/skills/<unit> <suite> — timed out after <N>s
#   FAIL skills — ledger worktree <path> is missing
#   FAIL skills — N uncommitted file(s) under .agents/skills/ in the shared checkout
#                 this thread's worktree does not account for
#
# Env:
#   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.sh.
#   VERIFY_RUNNER — the command used to run a script, default `npm run`. The
#                   test suite replaces it; nothing in production does.
#   VERIFY_IMPORTER_CAP — how many importer apps may be RUN in the fallback pass
#                   before they are named unverified instead. Default 8.
#   VERIFY_SKILLS_TIMEOUT — seconds one skill suite may take. Default 180.
#                   Enforced with timeout(1) or gtimeout(1), or a watchdog where
#                   neither exists (stock macOS). VERIFY_WATCHDOG=1 forces the
#                   watchdog; the test suite sets it, nothing in production does.
#
# peers:
#   .agents/skills/close/scripts/verify.test.sh
#   .agents/skills/close/scripts/write-root.sh   (writes the ledger walked here)
#
# Exit: 0 all green (or nothing to verify) · 1 at least one FAIL · 2 no thread

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
THREAD="${SCRIPT_DIR}/thread.sh"
WRITE_ROOT="${SCRIPT_DIR}/write-root.sh"
RUNNER="${VERIFY_RUNNER:-npm run}"

TID="$(bash "${THREAD}" --id 2>&1)" || { echo "verify: ${TID#thread: }" >&2; exit 2; }

# REGISTER THE THREAD'S OWN WORKTREE BEFORE READING THE LEDGER. A session that
# edited only app code has never called the resolver — nothing asked it where
# to write, because the harness had already put it in the right tree. Its ledger is
# therefore empty, and a verify that just reads the ledger prints "nothing to
# verify" and exits 0. The journal step then registers that worktree anyway,
# and Land commits app changes no check ever ran against — a case fixtures that
# pre-seed a ledger never see. The resolver is idempotent, so this is free on
# every later close.
T3_WT="$(bash "${THREAD}" --worktree 2>/dev/null || true)"
if [ -n "${T3_WT}" ] && [ -d "${T3_WT}" ]; then
  bash "${WRITE_ROOT}" "${T3_WT}" >/dev/null 2>&1 || true
fi

LEDGER="${HOME}/.cache/workbench/threads/${TID}/worktrees"
# What `land.sh` has already put on a trunk, one `<shared-path>\t<sha>` row per
# landing. Read here for one question only: is a ledger row whose worktree is
# gone a LOSS or a completed landing?
LANDED="${HOME}/.cache/workbench/threads/${TID}/landed"
LOGS="${HOME}/.cache/workbench/threads/${TID}/verify"

if [ ! -f "${LEDGER}" ]; then
  echo "verify: this thread owns no worktrees yet — nothing to verify"
  exit 0
fi

mkdir -p "${LOGS}"

FAILED=0

# Every path this worktree changed, committed or not. Deliberately three
# questions rather than one `git status --porcelain` parse: porcelain's rename
# rows (`R old -> new`) and its quoting of unusual filenames both need a real
# parser, and getting either wrong silently drops an app from the verify set.
changed_paths() {
  local wt="$1"
  {
    # The trunk is asked for per repo rather than spelled `main`: a repo whose
    # trunk is `master` would otherwise fall through to the untracked-only
    # branch below and verify NOTHING it had committed.
    vtrunk="$(bash "${SCRIPT_DIR}/trunk.sh" "${wt}" 2>/dev/null || true)"
    if [ -n "${vtrunk}" ] && git -C "${wt}" rev-parse --verify -q "origin/${vtrunk}" >/dev/null 2>&1; then
      git -C "${wt}" diff "origin/${vtrunk}...HEAD" --name-only 2>/dev/null
    fi
    git -C "${wt}" diff HEAD --name-only 2>/dev/null
    git -C "${wt}" ls-files --others --exclude-standard 2>/dev/null
  } | sed '/^$/d' | sort -u
}

# The app a repo-relative path belongs to: the nearest folder under `apps/`
# holding a package.json, printed without `apps/` — `<name>` in a flat layout,
# `<domain>/<name>` in a grouped one. Nothing for a path in no such folder.
app_of() {
  local wt="$1" d
  d="$(dirname "$2")"
  while [ "${d}" != "apps" ] && [ "${d}" != "." ] && [ "${d}" != "/" ]; do
    case "${d}" in apps/*) ;; *) return 0 ;; esac
    if [ -f "${wt}/${d}/package.json" ]; then
      printf '%s\n' "${d#apps/}"
      return 0
    fi
    d="$(dirname "${d}")"
  done
}

# `apps/…` and nothing else. A row with no `apps/` — a product repo's —
# contributes no lines and is silently skipped.
app_dirs_for() {
  local wt="$1" p
  changed_paths "${wt}" | while IFS= read -r p; do
    case "${p}" in apps/*) app_of "${wt}" "${p}" ;; esac
  done | sort -u
}

# `integrations/<name>/…`, for the ones that declare their own check or test.
#
# WHY THIS EXISTS. Pass 1 mapped `apps/` alone, and pass 2's importer fallback
# fires only when pass 1 verified NOTHING — so a session that touched an app AND
# an integration verified the app and nothing else. That is harmless while no
# integration owns a suite, and stops being harmless the day one does: its tests
# would run on no close at all.
#
# NARROW, on purpose, and the same rule pass 1 applies to an app: only folders
# whose OWN files moved, and only the halves they declare. An integration with
# no scripts contributes nothing and is not even reported — it is not a gap in
# the integration, which by convention has no tsc target of its own.
integration_dirs_for() {
  local wt="$1"
  changed_paths "${wt}" \
    | awk -F/ '$1 == "integrations" && NF >= 2 { print $1 "/" $2 }' \
    | sort -u
}

# Does this app declare the script? Read with node rather than grep: a
# package.json where "test" appears in a dependency name would match a grep and
# then fail to run.
#
# THREE ANSWERS, NOT TWO. 0 declared, 1 absent, 2 the manifest could not be
# read at all. Collapsing 2 into 1 reported a syntactically broken package.json
# as "unverified" and let the close through — a manifest that cannot be parsed
# is a defect this session may well have just introduced, and it is exactly the
# case where running no checks is least safe.
# shellcheck disable=SC2016  # the JS below must reach node unexpanded —
# bash interpolating `$` inside it is the bug, not the quoting.
has_script() {
  node -e '
const fs = require("node:fs");
let scripts;
try {
  scripts = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).scripts || {};
} catch {
  process.exit(2);
}
process.exit(typeof scripts[process.argv[2]] === "string" && scripts[process.argv[2]] ? 0 : 1);
' "$1" "$2" 2>/dev/null
}

# Shared changed files that an app could import: `integrations/…`, `packages/…`.
# The importer pass below asks who reads these.
shared_paths_for() {
  local wt="$1"
  changed_paths "${wt}" | awk -F/ '($1 == "integrations" || $1 == "packages") && NF >= 2'
}

# Which apps import this path? Imports in this repo are relative and carry the
# extension (`../../../../integrations/komodo/komodo.ts` from an app's `src/`,
# four levels below the root), so the repo-relative path is a literal substring
# of the import specifier. A fixed-string grep is therefore both sufficient and
# immune to the path's dots being read as regex.
importers_of() {
  local wt="$1" rel="$2" p
  [ -d "${wt}/apps" ] || return 0
  grep -rlF --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.js' \
    -- "${rel}" "${wt}/apps" 2>/dev/null \
    | sed "s|^${wt}/||" \
    | while IFS= read -r p; do app_of "${wt}" "${p}"; done \
    | sort -u
}

SEEN=""

# Verify one unit. $2 is its repo-relative DIRECTORY (`apps/sales/sync`,
# `integrations/github`); $3 is the LABEL its result lines carry. The two are
# separate on purpose: an app has always printed `ok <domain>/<app>` with no
# `apps/` prefix, and the result lines are what `/close` quotes and what this
# suite asserts on, so generalizing the directory must not rename the unit.
# `verify_app` below is the `apps/<domain>/<app>` caller's shorthand.
verify_unit() {
  local WT="$1" REL="$2" APP="$3" NOTE="${4:-}"
  local DIR="${WT}/${REL}" PKG MISSING="" APP_FAILED=0 HALF LOG
  PKG="${DIR}/package.json"
  [ -f "${PKG}" ] || return 0

  for HALF in check test; do
    has_script "${PKG}" "${HALF}"
    case $? in
      0) ;;
      1)
        MISSING="${MISSING}${MISSING:+ or }${HALF}"
        continue
        ;;
      *)
        echo "FAIL ${APP} ${HALF} — ${PKG} could not be parsed"
        APP_FAILED=1
        FAILED=1
        continue
        ;;
    esac
    LOG="${LOGS}/$(printf '%s' "${APP}" | tr / -)-${HALF}.log"
    if (cd "${DIR}" && ${RUNNER} "${HALF}") >"${LOG}" 2>&1; then
      continue
    fi
    echo "FAIL ${APP} ${HALF} — rerun: cd ${DIR} && ${RUNNER} ${HALF}"
    echo "     log: ${LOG}"
    APP_FAILED=1
    FAILED=1
  done

  [ "${APP_FAILED}" = 1 ] && return 0
  if [ -n "${MISSING}" ]; then
    echo "unverified ${APP} — no ${MISSING} script"
  else
    echo "ok ${APP}${NOTE}"
  fi
}

# The two `apps/<domain>/<app>` call sites keep their short unit name, so the
# result lines and the SEEN keys they compare against are unchanged.
verify_app() {
  verify_unit "$1" "apps/$2" "$2" "${3:-}"
}

# ── Pass 1: apps whose own files moved ─────────────────────────────────────

while IFS=$'\t' read -r WT _SHARED _BRANCH; do
  [ -n "${WT:-}" ] || continue
  [ -d "${WT}" ] || continue

  while read -r APP; do
    [ -n "${APP}" ] || continue
    # A worktree per repo means one app can only come from one of them, but a
    # rename across worktrees would otherwise verify it twice.
    case " ${SEEN} " in *" ${APP} "*) continue ;; esac
    SEEN="${SEEN} ${APP}"
    verify_app "${WT}" "${APP}"
  done <<EOF
$(app_dirs_for "${WT}")
EOF

  # The integrations whose own files moved AND which declare a half to run.
  # Kept out of SEEN: SEEN is what pass 2 tests for "did pass 1 verify an APP",
  # and an integration verifying itself must not suppress the importer fallback
  # for the apps that read it.
  while read -r INTEG; do
    [ -n "${INTEG}" ] || continue
    has_script "${WT}/${INTEG}/package.json" test && HAS=1 || HAS=0
    has_script "${WT}/${INTEG}/package.json" check && HAS=1
    [ "${HAS}" = 1 ] || continue
    verify_unit "${WT}" "${INTEG}" "${INTEG}"
  done <<EOF
$(integration_dirs_for "${WT}")
EOF
done <"${LEDGER}"

# ── Pass 2: nothing moved in any app, but shared code did ──────────────────
#
# Only reached when pass 1 verified nothing, so the narrow scope is untouched
# for every session that edited an app.

if [ -z "${SEEN}" ]; then
  CAP="${VERIFY_IMPORTER_CAP:-8}"
  CANDIDATES=""
  while IFS=$'\t' read -r WT _SHARED _BRANCH; do
    [ -n "${WT:-}" ] || continue
    [ -d "${WT}" ] || continue
    while read -r REL; do
      [ -n "${REL}" ] || continue
      while read -r APP; do
        [ -n "${APP}" ] || continue
        case " ${CANDIDATES} " in *" ${WT}|${APP} "*) continue ;; esac
        CANDIDATES="${CANDIDATES} ${WT}|${APP}"
      done <<EOF2
$(importers_of "${WT}" "${REL}")
EOF2
    done <<EOF3
$(shared_paths_for "${WT}")
EOF3
  done <"${LEDGER}"

  COUNT=0
  for _C in ${CANDIDATES}; do COUNT=$((COUNT + 1)); done

  if [ "${COUNT}" -gt 0 ]; then
    echo "verify: no app files changed — verifying ${COUNT} app(s) that import the shared code this thread touched"
    for C in ${CANDIDATES}; do
      WT="${C%%|*}"
      APP="${C#*|}"
      SEEN="${SEEN} ${APP}"
      if [ "${COUNT}" -gt "${CAP}" ]; then
        # Named, not run. Silence would be the real failure here; a close that
        # takes ten minutes is its own kind of failure.
        echo "unverified ${APP} — imports shared code, and ${COUNT} importers is past the cap of ${CAP}"
      else
        verify_app "${WT}" "${APP}" " (imports shared code this thread changed)"
      fi
    done
  fi
fi


# ── Pass 3: the skills tree ────────────────────────────────────────────────
#
# A skill is code, and without this pass it is the only code that closes with
# nothing run against it: `app_dirs_for` maps `apps/…` and nothing else, so a
# change under the skills tree contributes zero lines and the close says "no
# app files changed" over a rewritten `land.sh`.
#
# THE UNIT IS THE TOP-LEVEL FOLDER UNDER `.agents/skills/`, not the file. A change to a
# skill's SKILL.md or its references would otherwise run nothing at all, and
# those are exactly the changes that break the scripts beneath them. A changed
# path directly under `.agents/skills/` — `.agents/skills/run.sh`, `.agents/skills/AGENTS.md` — is its
# own unit, `(root)`, whose suites are the ones at `.agents/skills/` itself: the
# launcher every other script depends on was otherwise the single ungated file
# in the tree. A changed path outside `.agents/skills/` is no unit at all.
#
# WHICH WORKTREE. The WORKBENCH row. The skills live at `.agents/skills/` of the
# same repo as the code, so the row to read is the one whose worktree holds
# `.agents/skills/` — proven by its tree, in `workbench_worktree` below, rather
# than matched on a SHARED column. A row without it is a product repo's and
# carries no skills.
#
# COST. A suite runs only for a folder that changed, so a session touching one
# skill pays for that skill's suites. There is no folder cap — the per-suite
# timeout is the only bound, and a hung suite hanging the close is the failure
# that bound exists to prevent.

SKILLS_SEEN=""
SKILLS_TIMEOUT="${VERIFY_SKILLS_TIMEOUT:-180}"

# timeout(1) is GNU coreutils; stock macOS has neither it nor gtimeout, so a
# watchdog stands in. The clock below, not this exit code, decides "timed out".
with_timeout() {
  local secs="$1" pid dog rc
  shift
  if [ -z "${VERIFY_WATCHDOG:-}" ]; then
    if command -v timeout >/dev/null 2>&1; then timeout "${secs}" "$@"; return; fi
    if command -v gtimeout >/dev/null 2>&1; then gtimeout "${secs}" "$@"; return; fi
  fi
  "$@" &
  pid=$!
  ( sleep "${secs}" && kill -TERM "${pid}" 2>/dev/null ) &
  dog=$!
  wait "${pid}"; rc=$?
  kill "${dog}" 2>/dev/null; wait "${dog}" 2>/dev/null
  return "${rc}"
}

# The segment after `.agents/skills/` of every changed path under it, plus `(root)` for
# a file directly under `.agents/skills/`. Paths anywhere else in the repo — `apps/`,
# `journal/`, `knowledge/` — are not units. Never an empty unit name.
skill_units_for() {
  local wt="$1"
  changed_paths "${wt}" \
    | awk -F/ '$1 != ".agents" || $2 != "skills" || NF < 3 { next } NF == 3 { print "(root)"; next } { print $3 }' \
    | sort -u
}

# Which of this thread's worktrees is the WORKBENCH row — the one holding the
# skills? Proven by its tree rather than by its ledger position or its SHARED
# column: `.agents/skills/` is the tree this pass reads. Asking write-root.sh
# which checkout is the workbench would need a cwd inside it, and matching the
# SHARED column would need to know that path first.
workbench_worktree() {
  local wt
  while IFS=$'\t' read -r wt _ _; do
    [ -n "${wt:-}" ] || continue
    if [ -d "${wt}/.agents/skills" ]; then
      printf '%s\n' "${wt}"
      return 0
    fi
  done <"${LEDGER}"
  return 1
}

# Two paths holding the same FILE — bytes, type, and the one permission bit git
# records. Bytes alone called a shared `chmod +x` accounted for, so a mode
# change that nothing would ever land was reported as this session's own work.
same_file() {
  local a="$1" b="$2"
  [ -e "${a}" ] && [ -e "${b}" ] || return 1
  if [ -L "${a}" ] || [ -L "${b}" ]; then
    [ -L "${a}" ] && [ -L "${b}" ] || return 1
    [ "$(readlink "${a}")" = "$(readlink "${b}")" ] || return 1
    return 0
  fi
  if [ -x "${a}" ]; then [ -x "${b}" ] || return 1; else [ -x "${b}" ] && return 1; fi
  cmp -s "${a}" "${b}" 2>/dev/null
}

# Every `*.test.sh` beneath one unit. Prints its own result line(s) and sets
# FAILED on a red suite. Mirrors verify_app's vocabulary exactly — two output
# formats in one verify is one too many.
#
# NO CLAUDE_PROJECT_DIR IS EXPORTED TO A SUITE. Skill scripts that need the
# repo climb from their own real directory, which lands on this worktree, so
# none needs it — and it is not harmless: `session-write-root.sh` takes the T3
# branch only when CLAUDE_PROJECT_DIR is unset, so with it set a suite asking
# for the session's write root would be handed a Claude-session worktree keyed
# on the harness session — a stale tree — and fail here while passing from a
# shell.
verify_skill_unit() {
  local WT="$1" UNIT="$2"
  local DIR UNIT_FAILED=0 FOUND=0 SUITE REL LOG RC START ELAPSED
  local -a FIND_ARGS

  if [ "${UNIT}" = "(root)" ]; then
    DIR="${WT}/.agents/skills"
    FIND_ARGS=(-maxdepth 1)
  else
    DIR="${WT}/.agents/skills/${UNIT}"
    FIND_ARGS=()
    # A path naming a directory that no longer exists is a DELETED skill folder,
    # and the deletion is the intent. Nothing to run, nothing to say.
    [ -d "${DIR}" ] || return 0
  fi

  local SUITES FIND_RC=0
  SUITES="$(find "${DIR}" ${FIND_ARGS[@]+"${FIND_ARGS[@]}"} -type f -name '*.test.sh' 2>/dev/null \
    | sort)" || FIND_RC=$?
  if [ "${FIND_RC}" != 0 ]; then
    # Discovery that FAILED is not discovery that found nothing. Swallowing it
    # reported an unreadable folder as `no test suites`, which reads as a gap
    # in the folder rather than as the close having looked and been unable to.
    echo "FAIL .agents/skills/${UNIT} — could not list its test suites (find exited ${FIND_RC})"
    FAILED=1
    return 0
  fi

  while IFS= read -r SUITE; do
    [ -n "${SUITE}" ] || continue
    FOUND=1
    REL="${SUITE#"${WT}"/}"
    # The WHOLE repo-relative path is flattened, not the filename taken: suites
    # recurse (`.agents/skills/qa/scripts/tests/lib.test.sh`) and two folders can each
    # hold a `verify.test.sh`, which would otherwise write one log over the
    # other. It begins `skills-` (the `.agents/` prefix dropped), so it cannot
    # collide with an app's
    # `<domain>-<app>-<half>.log`.
    LOG="${LOGS}/$(printf '%s' "${REL#.agents/}" | tr / -).log"
    RC=0
    # THE CLOCK, not the exit code, says whether it finished. Every exit-code
    # scheme tried here can be forged by the suite: plain `timeout` returns 124
    # both when it kills a suite and when a suite exits 124 by itself, and
    # `--preserve-status` hands back 0 for a suite that traps TERM and exits
    # cleanly — which would report a hung suite as green, the one outcome this
    # bound exists to prevent. Wall time cannot be forged. A suite that takes
    # the whole budget is called a timeout whatever it returned; at 180s that
    # is a suite worth looking at either way.
    START="$(date +%s)"
    (cd "${WT}" && with_timeout "${SKILLS_TIMEOUT}" bash "${REL}") >"${LOG}" 2>&1 || RC=$?
    ELAPSED=$(( $(date +%s) - START ))

    if [ "${ELAPSED}" -ge "${SKILLS_TIMEOUT}" ]; then
      # "It never finished" and "it finished and failed" are different problems.
      echo "FAIL .agents/skills/${UNIT} ${REL} — timed out after ${SKILLS_TIMEOUT}s"
    elif [ "${RC}" != 0 ]; then
      echo "FAIL .agents/skills/${UNIT} ${REL} — rerun: cd ${WT} && bash ${REL}"
    else
      continue
    fi
    echo "     log: ${LOG}"
    UNIT_FAILED=1
    FAILED=1
  done <<EOF6
${SUITES}
EOF6

  # ── node:test suites (`*.test.ts`) ───────────────────────────────────
  #
  # A skill folder may keep its suites as `*.test.ts` and carry no `*.test.sh`
  # at all; discovering only shell suites would report it `unverified ... no
  # test suites`, which reads as a folder with no tests rather than as a close
  # that could not see the tests it has.
  #
  # They run out of the SAME worktree, through `.agents/skills/run.sh` when the
  # workbench has that launcher (it owns the type-stripping flag some Node
  # versions need), else with `node` directly. A skill script that needs repo
  # code climbs `../../..` from its own directory to `<repo>/…`; the script's
  # real path is inside the repo, so the climb lands on the code under test.
  #
  # A node:test file run directly executes its tests and exits non-zero if any
  # failed, so each file reports for itself and needs no `--test` flag.
  local TS_SUITES TS_FIND_RC=0 SK_REL
  TS_SUITES="$(find "${DIR}" ${FIND_ARGS[@]+"${FIND_ARGS[@]}"} -type f -name '*.test.ts' 2>/dev/null \
    | sort)" || TS_FIND_RC=$?
  if [ "${TS_FIND_RC}" != 0 ]; then
    echo "FAIL .agents/skills/${UNIT} — could not list its node:test suites (find exited ${TS_FIND_RC})"
    FAILED=1
    return 0
  fi

  while IFS= read -r SUITE; do
    [ -n "${SUITE}" ] || continue
    FOUND=1
    REL="${SUITE#"${WT}"/}"
    SK_REL="${REL#.agents/skills/}"
    LOG="${LOGS}/$(printf '%s' "${REL#.agents/}" | tr / -).log"
    RC=0
    START="$(date +%s)"
    if [ -f "${WT}/.agents/skills/run.sh" ]; then
      (cd "${WT}" && with_timeout "${SKILLS_TIMEOUT}" \
        bash ".agents/skills/run.sh" "${SK_REL}") >"${LOG}" 2>&1 || RC=$?
    else
      (cd "${WT}" && with_timeout "${SKILLS_TIMEOUT}" node "${REL}") >"${LOG}" 2>&1 || RC=$?
    fi
    ELAPSED=$(( $(date +%s) - START ))

    if [ "${ELAPSED}" -ge "${SKILLS_TIMEOUT}" ]; then
      echo "FAIL .agents/skills/${UNIT} ${REL} — timed out after ${SKILLS_TIMEOUT}s"
    elif [ "${RC}" != 0 ]; then
      echo "FAIL .agents/skills/${UNIT} ${REL} — rerun: cd ${WT} && bash .agents/skills/run.sh ${SK_REL}"
    else
      continue
    fi
    echo "     log: ${LOG}"
    UNIT_FAILED=1
    FAILED=1
  done <<EOF7
${TS_SUITES}
EOF7

  [ "${UNIT_FAILED}" = 1 ] && return 0
  if [ "${FOUND}" = 0 ]; then
    # Most of the 40 folders carry no suites of either kind, so this is the
    # COMMON case and must not
    # halt — the same reasoning that reports an app with no `check` unverified.
    echo "unverified .agents/skills/${UNIT} — no test suites"
  else
    echo "ok .agents/skills/${UNIT}"
  fi
}

WB_WT="$(workbench_worktree || true)"

if [ -z "${WB_WT}" ]; then
  # NO LIVE WORKBENCH ROW. SILENCE HERE WAS A FALSE SUCCESS: everything below
  # keys off this one row, so without it a session that edited skills closes
  # having verified none of it and exits 0 saying nothing.
  #
  # A LANDED ROW IS NOT A LOST ONE. `land.sh` removes each worktree after it
  # lands and does NOT prune the ledger — so after any successful close the rows
  # outlive the directories, and a SECOND close of the same thread halted here
  # every time with nothing actually wrong. `land.sh` itself reads the same
  # state and treats those rows as spent; this said they were missing. The two
  # now agree, and on the same evidence: the repo's own row in `landed`. A row
  # that vanished WITHOUT landing took uncommitted or unpushed work with it, and
  # `land.sh` refuses that too (`worktree missing before landing`).
  #
  # The apps pass skips an unreadable row (line 287). Here that silence would
  # suppress the only evidence left, in exactly the case that needs noise.
  while IFS=$'\t' read -r WT SHARED _BRANCH; do
    [ -n "${WT:-}" ] || continue
    [ -d "${WT}" ] && continue
    if [ -f "${LANDED}" ] && cut -f1 "${LANDED}" 2>/dev/null | grep -qxF "${SHARED}"; then
      echo "unverified skills — ledger worktree ${WT} already landed and was removed"
      SKILLS_SEEN="${SKILLS_SEEN} (landed)"
    else
      echo "FAIL skills — ledger worktree ${WT} is missing"
      SKILLS_SEEN="${SKILLS_SEEN} (ledger)"
      FAILED=1
    fi
  done <"${LEDGER}"
  if [ -z "${SKILLS_SEEN//[[:space:]]/}" ]; then
    # Every row is live and none is the workbench. Reported in the vocabulary a
    # gap already has — `unverified`, not `FAIL` — because a thread with no
    # workbench row is not a defect this session introduced, and halting every
    # such close would be the same over-reach the backstop's attribution rule
    # exists to avoid.
    echo "unverified skills — no worktree this thread owns holds .agents/skills/, so no skill folder was checked"
    SKILLS_SEEN="${SKILLS_SEEN} (unresolved)"
  fi
else
  # The SHARED column of the workbench row: the checkout the `~/.agents/skills`
  # link points into, read by the backstop below.
  WB_SHARED="$(awk -F'\t' -v wt="${WB_WT}" '$1 == wt { print $2; exit }' "${LEDGER}")"
  SKILLS_OWNED="$(changed_paths "${WB_WT}")"$'\n'
  SKILLS_TOUCHED=0

  while read -r UNIT; do
    [ -n "${UNIT}" ] || continue
    SKILLS_TOUCHED=1
    SKILLS_SEEN="${SKILLS_SEEN} ${UNIT}"
    verify_skill_unit "${WB_WT}" "${UNIT}"
  done <<EOF4
$(skill_units_for "${WB_WT}")
EOF4

  # ── The backstop ─────────────────────────────────────────────────────────
  #
  # The write guard fails OPEN on any Bash form it cannot parse, and the
  # `~/.agents/skills` link still points into `.agents/skills/` of the landed checkout,
  # so a write through it lands in the SHARED checkout of the workbench row — in
  # no worktree, where no close will ever commit it. Only `.agents/skills/` is asked:
  # that is the tree the link exposes, and the rest of that checkout is
  # land.sh's report (`shared checkout ... not advanced`), not this pass's.
  #
  # ATTRIBUTION decides what happens next, because the shared checkout cannot
  # say who wrote what. If this worktree changed something under `.agents/skills/`, a
  # dirty path there it does not account for is a write that escaped the guard
  # IN A SESSION ALREADY EDITING SKILLS, and it halts. If it changed nothing
  # under `.agents/skills/`, there is no evidence this session touched skills at all —
  # another session's uncommitted work must not stop an unrelated close.
  DIRT="$(git -C "${WB_SHARED}" status --porcelain -- .agents/skills 2>/dev/null \
    | sed -E 's/^.{3}//; s/^.* -> //' | sed '/^$/d' | sort -u)"

  if [ -n "${DIRT}" ]; then
    if [ "${SKILLS_TOUCHED}" = 1 ]; then
      STRAY=""
      while IFS= read -r P; do
        [ -n "${P}" ] || continue
        # SAME PATH IS NOT THE SAME FILE. Exempting on the path alone let a
        # DIFFERENT edit at that path sit in the shared checkout unmentioned:
        # the worktree's version lands, the shared one is stranded, and the
        # close reports neither. Only identical content is this session's own
        # work showing up twice — and a path the worktree DELETED never matches,
        # which is right, because then nothing will land the shared copy.
        if case $'\n'"${SKILLS_OWNED}" in *$'\n'"${P}"$'\n'*) true ;; *) false ;; esac \
          && same_file "${WB_SHARED}/${P}" "${WB_WT}/${P}"; then
          continue
        fi
        STRAY="${STRAY}${P}"$'\n'
      done <<EOF5
${DIRT}
EOF5
      if [ -n "${STRAY//[[:space:]]/}" ]; then
        N="$(printf '%s' "${STRAY}" | sed '/^$/d' | wc -l)"
        echo "FAIL skills — ${N} uncommitted file(s) under .agents/skills/ in the shared checkout this thread's worktree does not account for"
        # Line by line, not word by word: a path with a space in it would
        # otherwise be listed as two files that do not exist.
        printf '%s' "${STRAY}" | sed '/^$/d; s/^/       /'
        echo "     they are in no ledger, so nothing will commit them — move them under ${WB_WT}/.agents/skills"
        SKILLS_SEEN="${SKILLS_SEEN} (shared)"
        FAILED=1
      fi
    else
      N="$(printf '%s\n' "${DIRT}" | sed '/^$/d' | wc -l)"
      echo "unverified skills — ${N} uncommitted file(s) under .agents/skills/ in the shared checkout, owner unknown"
      printf '%s\n' "${DIRT}" | sed '/^$/d; s/^/       /'
      SKILLS_SEEN="${SKILLS_SEEN} (shared)"
    fi
  fi
fi

# The apps line is about APPS. A session that changed only skills has verified
# something real, and telling it "no app files changed" as the whole story read
# as "nothing ran" — which was true before pass 3 existed and is not now.
if [ -z "${SEEN}" ] && [ -z "${SKILLS_SEEN//[[:space:]]/}" ]; then
  echo "verify: no app files changed in this thread's worktrees"
elif [ -z "${SEEN}" ]; then
  echo "verify: no app files changed in this thread's worktrees — skills units above"
fi

exit "${FAILED}"
