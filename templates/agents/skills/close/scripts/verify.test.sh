#!/usr/bin/env bash
# verify.test.sh — which apps get verified, and what each outcome prints.
#
# Run: bash .agents/skills/close/scripts/verify.test.sh
#
# The runner is stubbed. `VERIFY_RUNNER` points at a script that does what
# `npm run` does — look the name up in ./package.json's scripts and execute it —
# so the fixtures exercise the real "did this half pass" path without needing
# npm, a node_modules tree, or the toolchain wrapper.

set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT

PASS=0
FAIL=0
ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }
is()  { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1: '$2' lacks '$3'" ;; esac; }
hasnt() { case "$2" in *"$3"*) bad "$1: '$2' should not mention '$3'" ;; *) ok "$1" ;; esac; }

FAKE_HOME="${TMP}/home"
TID=eeeeeeee-1111-2222-3333-666666666666
LEDGER_DIR="${FAKE_HOME}/.cache/workbench/threads/${TID}"
mkdir -p "${LEDGER_DIR}"
LEDGER="${LEDGER_DIR}/worktrees"

RUNNER="${TMP}/fake-npm.sh"
cat >"${RUNNER}" <<'RUNNER_EOF'
#!/usr/bin/env bash
# Stands in for `npm run <name>`: look the script up where npm looks, run it
# where npm runs it, exit with what it exits with.
set -uo pipefail
CMD="$(node -e '
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync("package.json", "utf8")).scripts || {};
process.stdout.write(s[process.argv[1]] || "");
' "$1")"
[ -n "${CMD}" ] || { echo "missing script: $1" >&2; exit 1; }
sh -c "${CMD}"
RUNNER_EOF

E=("HOME=${FAKE_HOME}" "WORKBENCH_THREAD_ID=${TID}" "VERIFY_RUNNER=bash ${RUNNER}")

# ── A workbench-shaped worktree with a bare origin ─────────────────────────

BARE="${TMP}/origin.git"
WT="${TMP}/wt"
git init -q --bare -b main "${BARE}"
git init -q -b main "${WT}"
git -C "${WT}" config user.email t@example.com
git -C "${WT}" config user.name tester

# app <domain/name> <check-script-or-> <test-script-or->
app() {
  local dir="${WT}/apps/$1" scripts=""
  mkdir -p "${dir}/src"
  [ "$2" != "-" ] && scripts="\"check\": \"$2\""
  [ "$3" != "-" ] && scripts="${scripts}${scripts:+, }\"test\": \"$3\""
  printf '{ "name": "%s", "scripts": { %s } }\n' "$(basename "$1")" "${scripts}" \
    >"${dir}/package.json"
  echo "// code" >"${dir}/src/index.ts"
}

app health/green      "true"  "true"
app health/red-test   "true"  "exit 1"
app health/red-check  "exit 1" "true"
app tools/bare      "-"     "-"
app tools/test-only "-"     "true"
app health/untouched  "true"  "true"

# `integrations/` and `packages/` hold shared code the importer pass reads, and
# `.agents/skills/` is here so this worktree answers the prove-check that finds
# the WORKBENCH row for the skills pass below. Empty directories are invisible
# to git, so each carries a file.
mkdir -p "${WT}/integrations" "${WT}/packages" "${WT}/.agents/skills"
echo "// shared" >"${WT}/integrations/.keep"
echo "// shared" >"${WT}/packages/.keep"
echo "# skills" >"${WT}/.agents/skills/.keep"

git -C "${WT}" add apps integrations packages .agents
git -C "${WT}" commit -q -m seed
git -C "${WT}" remote add origin "${BARE}"
git -C "${WT}" push -q -u origin main

# A product-repo-shaped worktree: no apps/ at all. The records live in the
# workbench itself, so a row without apps/ can only be a product repo's.
PRODWT="${TMP}/prodwt"
mkdir -p "${PRODWT}/src"
git init -q -b main "${PRODWT}"
git -C "${PRODWT}" config user.email t@example.com
git -C "${PRODWT}" config user.name tester
echo x >"${PRODWT}/src/seed.ts"
git -C "${PRODWT}" add src
git -C "${PRODWT}" commit -q -m seed

printf '%s\t%s\t%s\n' "${WT}" "${TMP}/shared" "t3/${TID}" >"${LEDGER}"
printf '%s\t%s\t%s\n' "${PRODWT}" "${TMP}/prodshared" "t3/${TID}" >>"${LEDGER}"
printf '%s\t%s\t%s\n' "${TMP}/deleted-worktree" "${TMP}/x" "t3/${TID}" >>"${LEDGER}"

run() { OUT="$(env "${E[@]}" bash "${SCRIPT}" 2>&1)"; RC=$?; }

# ── Nothing changed yet: every app is at origin/main ───────────────────────

run
is "a thread that changed nothing exits 0" "${RC}" "0"
has "and says there was nothing to verify" "${OUT}" "no app files changed"

# ── An uncommitted edit brings exactly one app into scope ──────────────────

echo "// edited" >>"${WT}/apps/health/green/src/index.ts"
run
is "a green app exits 0" "${RC}" "0"
has "and is reported ok" "${OUT}" "ok health/green"
hasnt "an app nobody touched is not verified" "${OUT}" "health/untouched"
hasnt "a worktree with no apps/ contributes nothing" "${OUT}" "prodwt"

# ── An untracked file counts as a change ───────────────────────────────────

echo "// new" >"${WT}/apps/tools/test-only/src/new.ts"
run
has "an untracked file brings its app into scope" "${OUT}" "tools/test-only"
has "an app missing one half is unverified, not failed" "${OUT}" \
  "unverified tools/test-only — no check script"
is "…and that does not fail the close" "${RC}" "0"

# ── A committed change counts too, via origin/main...HEAD ──────────────────

echo "// committed" >>"${WT}/apps/tools/bare/src/index.ts"
git -C "${WT}" add apps/tools/bare/src/index.ts
git -C "${WT}" commit -q -m "an app with neither script"
run
has "a committed change is in scope" "${OUT}" "tools/bare"
has "an app with neither script names both" "${OUT}" \
  "unverified tools/bare — no check or test script"
is "…and still does not fail the close" "${RC}" "0"

# ── An app directly under apps/ (a flat layout) is its own unit ────────────
mkdir -p "${WT}/apps/flatapp/src"
printf '{ "name": "flatapp", "scripts": { "check": "true", "test": "true" } }\n' >"${WT}/apps/flatapp/package.json"
echo "// flat" >"${WT}/apps/flatapp/src/index.ts"
run
has "a flat apps/<name>/ app is found by its package.json" "${OUT}" "ok flatapp"
rm -rf "${WT}/apps/flatapp"

# ── A red half halts, names the half, and hands back the exact command ─────

echo "// edited" >>"${WT}/apps/health/red-test/src/index.ts"
run
is "a red test exits 1" "${RC}" "1"
has "naming the app and the half" "${OUT}" "FAIL health/red-test test"
has "with the rerun command" "${OUT}" \
  "rerun: cd ${WT}/apps/health/red-test && bash ${RUNNER} test"
hasnt "a failing app is not also reported ok" "${OUT}" "ok health/red-test"
has "the green app is still reported" "${OUT}" "ok health/green"

echo "// edited" >>"${WT}/apps/health/red-check/src/index.ts"
run
has "a red check is caught too" "${OUT}" "FAIL health/red-check check"
is "and still exits 1" "${RC}" "1"

# ── The log is where the line says it is ───────────────────────────────────

LOGFILE="${LEDGER_DIR}/verify/health-red-test-test.log"
if [ -f "${LOGFILE}" ]; then ok "a failing half leaves a log behind"
  else bad "no log at ${LOGFILE}"; fi
has "and the line points at it" "${OUT}" "log: ${LOGFILE}"

# ── A ledger worktree that no longer exists is skipped, not fatal ──────────

hasnt "a removed worktree does not crash the verify" "${OUT}" "deleted-worktree"

# ── No ledger at all ───────────────────────────────────────────────────────

OUT2="$(env "HOME=${TMP}/empty-home" "WORKBENCH_THREAD_ID=${TID}" \
  "VERIFY_RUNNER=bash ${RUNNER}" bash "${SCRIPT}" 2>&1)"
RC2=$?
is "a thread with no ledger exits 0" "${RC2}" "0"
has "saying it owns no worktrees" "${OUT2}" "owns no worktrees"

# ── No thread ──────────────────────────────────────────────────────────────

OUT3="$(cd "${TMP}" && env "HOME=${FAKE_HOME}" "T3CODE_HOME=${TMP}/nowhere" \
  bash "${SCRIPT}" 2>&1)"
RC3=$?
is "no thread exits 2" "${RC3}" "2"
has "and says so rather than verifying nothing silently" "${OUT3}" "not in a thread"

# ── A manifest that cannot be parsed is a failure, not "unverified" ───────

cat >"${WT}/apps/health/green/package.json" <<'BROKEN'
{ "name": "green", "scripts": { "check": "true", }
BROKEN
run
is "an unparseable package.json fails the close" "${RC}" "1"
has "naming the manifest" "${OUT}" "could not be parsed"
hasnt "and does not pass it off as merely unverified" "${OUT}" "unverified health/green"

# ── A session confined to shared code verifies the apps that import it ─────
#
# The importer hole: a fix in `integrations/` with two consuming apps would run
# no check at all and report "no app files changed". The importer pass is reached
# ONLY when no app's own files moved, so every assertion above still holds.

CLEAN="${TMP}/clean"
git clone -q "${BARE}" "${CLEAN}"
git -C "${CLEAN}" config user.email t@example.com
git -C "${CLEAN}" config user.name tester
# Repair the manifest the previous block broke — this fixture is about scope.
printf '{ "name": "green", "scripts": { "check": "true", "test": "true" } }\n' \
  >"${CLEAN}/apps/health/green/package.json"
# Two importers of one shared file, one non-importer.
mkdir -p "${CLEAN}/integrations/komodo"
echo "export const x = 1;" >"${CLEAN}/integrations/komodo/komodo.ts"
echo 'import { x } from "../../../../integrations/komodo/komodo.ts";' \
  >"${CLEAN}/apps/health/green/src/uses.ts"
echo 'import { x } from "../../../../integrations/komodo/komodo.ts";' \
  >"${CLEAN}/apps/tools/test-only/src/uses.ts"
git -C "${CLEAN}" add -A
git -C "${CLEAN}" commit -q -m wiring
git -C "${CLEAN}" push -q origin main

CLEDGER="${LEDGER_DIR}/worktrees"
cp "${CLEDGER}" "${TMP}/ledger.bak"
printf '%s\t%s\t%s\n' "${CLEAN}" "${TMP}/cshared" "t3/${TID}" >"${CLEDGER}"

# Now change ONLY the shared file.
echo "export const y = 2;" >>"${CLEAN}/integrations/komodo/komodo.ts"

run
is "a shared-only change exits 0 when its importers are green" "${RC}" "0"
has "it says why it widened the scope" "${OUT}" "no app files changed — verifying"
has "the first importer is verified" "${OUT}" "ok health/green"
# This fixture app declares no `check`, so being pulled into scope correctly
# reports the app's own gap rather than a pass.
has "the second importer is pulled in too" "${OUT}" "unverified tools/test-only — no check script"
hasnt "an app that imports nothing is left alone" "${OUT}" "health/untouched"
hasnt "and it no longer claims there was nothing to verify" "${OUT}" "no app files changed in this thread"

# ── A red importer fails the close ─────────────────────────────────────────

printf '{ "name": "green", "scripts": { "check": "exit 1", "test": "true" } }\n' \
  >"${CLEAN}/apps/health/green/package.json"
git -C "${CLEAN}" add -A && git -C "${CLEAN}" commit -q -m red && git -C "${CLEAN}" push -q origin main
echo "export const z = 3;" >>"${CLEAN}/integrations/komodo/komodo.ts"
run
is "a broken importer fails the close" "${RC}" "1"
has "naming the app and half" "${OUT}" "FAIL health/green check"
printf '{ "name": "green", "scripts": { "check": "true", "test": "true" } }\n' \
  >"${CLEAN}/apps/health/green/package.json"
git -C "${CLEAN}" add -A && git -C "${CLEAN}" commit -q -m fixed && git -C "${CLEAN}" push -q origin main

# ── Past the cap the importers are named, not run ──────────────────────────

echo "export const w = 4;" >>"${CLEAN}/integrations/komodo/komodo.ts"
OUT="$(env "${E[@]}" VERIFY_IMPORTER_CAP=1 bash "${SCRIPT}" 2>&1)"; RC=$?
is "past the cap the close still exits 0" "${RC}" "0"
has "the apps are named rather than run" "${OUT}" "past the cap"
hasnt "and none of them is reported ok" "${OUT}" "ok health/green"

# ── An app edit keeps the narrow scope, cap or no cap ──────────────────────

echo "// touched" >>"${CLEAN}/apps/health/green/src/index.ts"
run
has "an app edit is verified directly" "${OUT}" "ok health/green"
hasnt "and the importer pass never runs" "${OUT}" "no app files changed — verifying"
hasnt "so a co-importer stays out of scope" "${OUT}" "tools/test-only"

# ── An integration that owns a suite is verified in pass 1 ────────────────
#
# The integration hole, and it is NOT the importer one above: pass 2 fires only
# when pass 1 verified nothing, so a session that touched an app AND an
# integration would verify the app and skip the integration entirely —
# harmless until an integration owns a suite, then its tests run on no close.

mkdir -p "${CLEAN}/integrations/withsuite" "${CLEAN}/integrations/nosuite"
printf '{ "name": "withsuite", "scripts": { "check": "true", "test": "true" } }\n' \
  >"${CLEAN}/integrations/withsuite/package.json"
printf '{ "name": "nosuite" }\n' >"${CLEAN}/integrations/nosuite/package.json"
echo "export const a = 1;" >"${CLEAN}/integrations/withsuite/lib.ts"
echo "export const b = 1;" >"${CLEAN}/integrations/nosuite/lib.ts"
git -C "${CLEAN}" add -A
git -C "${CLEAN}" commit -q -m integrations && git -C "${CLEAN}" push -q origin main

# An app AND both integrations move, so pass 1 is non-empty and pass 2 is out.
echo "// touched" >>"${CLEAN}/apps/health/green/src/index.ts"
echo "export const a2 = 2;" >>"${CLEAN}/integrations/withsuite/lib.ts"
echo "export const b2 = 2;" >>"${CLEAN}/integrations/nosuite/lib.ts"
run
is "an app plus an integration exits 0 when both are green" "${RC}" "0"
has "the app is still verified directly" "${OUT}" "ok health/green"
has "and the integration that declares a suite is too" "${OUT}" "ok integrations/withsuite"
hasnt "an integration with no scripts is silent, not unverified" "${OUT}" "integrations/nosuite"
hasnt "and pass 2 is still not reached" "${OUT}" "no app files changed — verifying"

# A red integration half fails the close, exactly like a red app half.
printf '{ "name": "withsuite", "scripts": { "check": "true", "test": "exit 1" } }\n' \
  >"${CLEAN}/integrations/withsuite/package.json"
run
is "a red integration test fails the close" "${RC}" "1"
has "naming the integration and the half" "${OUT}" "FAIL integrations/withsuite test"
printf '{ "name": "withsuite", "scripts": { "check": "true", "test": "true" } }\n' \
  >"${CLEAN}/integrations/withsuite/package.json"

# An integration alone, with no app touched at all: pass 1 still verifies it,
# and pass 2 also runs because SEEN holds no APP — the importer fallback must
# not be suppressed by an integration having verified itself.
git -C "${CLEAN}" add -A && git -C "${CLEAN}" commit -q -m green && git -C "${CLEAN}" push -q origin main
echo "export const a3 = 3;" >>"${CLEAN}/integrations/withsuite/lib.ts"
run
is "an integration-only session exits 0" "${RC}" "0"
has "the integration verifies itself" "${OUT}" "ok integrations/withsuite"

cp "${TMP}/ledger.bak" "${CLEDGER}"

# ── The skills tree ────────────────────────────────────────────────────────
#
# Built last and on its own ledger. The skills live at `.agents/skills/` of
# the WORKBENCH row — the ledger row whose worktree holds .agents/skills/ — so
# the fixtures below sit in the SAME row as the apps,
# not in a repo of their own. Until the code fixture carries a `.agents/skills/` change
# the pass finds no unit and prints nothing, which is what keeps every assertion
# above about apps only.

# A PRISTINE clone for the workbench row. `${WT}` by now carries every edit the
# app cases above made, two of them deliberately red, and an app FAIL would land
# in the exit code of every skills assertion below.
WBCLEAN="${TMP}/wb-clean"
git clone -q "${BARE}" "${WBCLEAN}"
git -C "${WBCLEAN}" config user.email t@example.com
git -C "${WBCLEAN}" config user.name tester
SK="${WBCLEAN}/.agents/skills"

suite() { # <path relative to .agents/skills/> <body>
  mkdir -p "$(dirname "${SK}/$1")"
  printf '#!/usr/bin/env bash\n%s\n' "$2" >"${SK}/$1"
}

# A skills tree: an AGENTS.md at its root, folders that carry suites and one
# that does not, and a root-level suite for the launcher.
echo "# skills" >"${SK}/AGENTS.md"
# A launcher that actually launches. It was `echo "# launcher"` while only
# `*.test.sh` ran, and a stub would have reported every `*.test.ts` green whatever
# it contained — the one outcome a suite runner must not have. Minimal on purpose:
# the real run.sh's flag handling is run.test.sh's subject, and what is under
# test here is discovery, the workbench-row gate, and the red/green reporting
# around it.
cat >"${SK}/run.sh" <<'LAUNCH'
#!/usr/bin/env bash
set -euo pipefail
CHECKOUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
REL="$1"; shift
exec node --experimental-strip-types "${CHECKOUT}/${REL}" "$@"
LAUNCH

# node:test suites — the shape nine real skill folders use and no `*.test.sh`
# beside them, which this function used to report as `no test suites`.
mkdir -p "${SK}/tsgreen/scripts" "${SK}/tsred/scripts"
cat >"${SK}/tsgreen/scripts/ok.test.ts" <<'TSOK'
import { strict as assert } from "node:assert";
import { test } from "node:test";
test("a passing node:test suite", () => {
  const n: number = 1;
  assert.equal(n, 1);
});
TSOK
cat >"${SK}/tsred/scripts/bad.test.ts" <<'TSBAD'
import { strict as assert } from "node:assert";
import { test } from "node:test";
test("a failing node:test suite", () => {
  assert.equal(1, 2, "the node:test assertion that failed");
});
TSBAD
suite "run.test.sh"             'exit 0'
suite "alpha/verify.test.sh"    'exit 0'
suite "alpha/scripts/deep.test.sh" 'exit 0'
suite "beta/verify.test.sh"     'exit 0'
# The shape of .agents/skills/review: a flat folder of `*.test.sh` beside the
# scripts they test, plus an `evals/` file that is NOT a suite and must not run.
suite "review/code-review.test.sh"  'exit 0'
suite "review/policy-chain.test.sh" 'exit 0'
suite "review/evals/caller-contract.eval.sh" 'echo "the eval ran as a suite" >&2; exit 1'
mkdir -p "${SK}/gamma"
echo "# no suites here" >"${SK}/gamma/README.md"
suite "red/bad.test.sh"         'echo "the assertion that failed" >&2; exit 1'
suite "slow/slow.test.sh"       'sleep 30'
# Reads the export the pass makes. cwd is the workbench worktree itself now, so
# a suite could also ask git — this pins that the export still names that tree.
suite "cpd/cpd.test.sh" "[ -z \"\${CLAUDE_PROJECT_DIR:-}\" ] || { echo \"CLAUDE_PROJECT_DIR=[\${CLAUDE_PROJECT_DIR:-}] leaked into a suite\" >&2; exit 1; }"

git -C "${WBCLEAN}" add -- .agents
git -C "${WBCLEAN}" commit -q -m "skills seed"
git -C "${WBCLEAN}" push -q origin main

# The SHARED checkout of the workbench row — the tree a write through the
# `~/.agents/skills` link lands in when it never reached a worktree.
WB_SHARED="${TMP}/wb-shared"
git clone -q "${BARE}" "${WB_SHARED}"
git -C "${WB_SHARED}" config user.email t@example.com
git -C "${WB_SHARED}" config user.name tester
WB_CANON="$(cd "${WB_SHARED}" && pwd -P)"

SKLEDGER="${LEDGER}"
# What `land.sh` writes, and what verify reads to tell a landed row from a lost
# one. Beside the ledger, under the same thread directory.
LANDED_FILE="$(dirname "${LEDGER}")/landed"
printf '%s\t%s\t%s\n' "${WBCLEAN}" "${WB_CANON}" "t3/${TID}" >"${SKLEDGER}"

# Every case touches ONE path and cleans up after itself, so the unit under test
# is the only one in scope.
sk() { # <path relative to .agents/skills/ to touch>
  git -C "${WBCLEAN}" checkout -q -- . 2>/dev/null
  echo "// touched" >"${SK}/$1"
  run
}

sk "alpha/scratch.md"
is "a skill folder whose suites pass exits 0" "${RC}" "0"
has "and is reported ok" "${OUT}" "ok .agents/skills/alpha"
hasnt "a folder nobody touched is not verified" "${OUT}" ".agents/skills/beta"
hasnt "and the unit is the folder under .agents/skills/, not .agents/skills/ itself" "${OUT}" ".agents/skills/skills"
rm -f "${SK}/alpha/scratch.md"

# A change OUTSIDE .agents/skills/ in the same worktree is not a skill unit. The records
# live flat at the root of this repo, so a journal write is the common
# case: it must map to no unit at all rather than to a unit named `journal`.
mkdir -p "${WBCLEAN}/journal/2026-09-25"
echo "// touched" >"${WBCLEAN}/journal/2026-09-25/0100-scratch.md"
run
is "a records-only change exits 0" "${RC}" "0"
hasnt "and maps to no skill unit" "${OUT}" ".agents/skills/"
has "so the apps line is the whole story" "${OUT}" "no app files changed in this thread's worktrees"
rm -rf "${WBCLEAN}/journal"

sk "gamma/scratch.md"
is "a folder with no suites does not fail the close" "${RC}" "0"
has "and says so rather than passing silently" "${OUT}" \
  "unverified .agents/skills/gamma — no test suites"
rm -f "${SK}/gamma/scratch.md"

sk "tsgreen/scratch.md"
is "a folder whose only suites are *.test.ts exits 0" "${RC}" "0"
has "and is reported ok" "${OUT}" "ok .agents/skills/tsgreen"
hasnt "and is NOT reported as having no test suites" "${OUT}" \
  "unverified .agents/skills/tsgreen — no test suites"
rm -f "${SK}/tsgreen/scratch.md"

sk "tsred/scratch.md"
is "a red *.test.ts fails the close" "${RC}" "1"
has "naming the folder and the suite" "${OUT}" "FAIL .agents/skills/tsred .agents/skills/tsred/scripts/bad.test.ts"
has "and gives a rerun line that names run.sh" "${OUT}" "run.sh tsred/scripts/bad.test.ts"
rm -f "${SK}/tsred/scratch.md"

sk "red/scratch.md"
is "a red suite fails the close" "${RC}" "1"
has "naming the folder and the suite" "${OUT}" "FAIL .agents/skills/red .agents/skills/red/bad.test.sh"
has "with the rerun command" "${OUT}" "rerun: cd ${WBCLEAN} && bash .agents/skills/red/bad.test.sh"
hasnt "and a failing folder is not also reported ok" "${OUT}" "ok .agents/skills/red"
has "the log is where the line says" "${OUT}" "log: ${LEDGER_DIR}/verify/skills-red-bad.test.sh.log"
if grep -q "the assertion that failed" "${LEDGER_DIR}/verify/skills-red-bad.test.sh.log" 2>/dev/null
  then ok "and the suite's own output is in it"; else bad "the log does not carry the suite output"; fi
rm -f "${SK}/red/scratch.md"

# A changed file directly under .agents/skills/ is its own unit. Without it the launcher
# every other script depends on would be the one ungated file.
sk "run.sh"
has "a root-level change maps to the root unit" "${OUT}" "ok .agents/skills/(root)"
hasnt "and does not drag in a folder" "${OUT}" ".agents/skills/alpha"
git -C "${WBCLEAN}" checkout -q -- .agents/skills/run.sh

# Suites recurse and filenames repeat, so the WHOLE repo-relative path is
# flattened into the log name — two `verify.test.sh` files must not write one log.
sk "alpha/scratch.md"
echo "// touched" >"${SK}/beta/scratch.md"
run
has "two folders each with a verify.test.sh both pass" "${OUT}" "ok .agents/skills/alpha"
has "…and both are reported" "${OUT}" "ok .agents/skills/beta"
if [ -f "${LEDGER_DIR}/verify/skills-alpha-verify.test.sh.log" ] \
  && [ -f "${LEDGER_DIR}/verify/skills-beta-verify.test.sh.log" ]
  then ok "each gets its own log file"; else bad "the two verify.test.sh logs collided"; fi
if [ -f "${LEDGER_DIR}/verify/skills-alpha-scripts-deep.test.sh.log" ]
  then ok "a nested suite runs too"; else bad ".agents/skills/alpha/scripts/deep.test.sh never ran"; fi
rm -f "${SK}/alpha/scratch.md" "${SK}/beta/scratch.md"

# A change under .agents/skills/review/ runs every suite in that flat folder and not
# its eval (the close's skills pass is what collects those suites).
sk "review/code-review.sh"
is "a change under .agents/skills/review exits 0" "${RC}" "0"
has "and the folder is reported ok" "${OUT}" "ok .agents/skills/review"
if [ -f "${LEDGER_DIR}/verify/skills-review-code-review.test.sh.log" ] \
  && [ -f "${LEDGER_DIR}/verify/skills-review-policy-chain.test.sh.log" ]
  then ok "both review suites ran"; else bad "a .agents/skills/review suite never ran"; fi
if [ -f "${LEDGER_DIR}/verify/skills-review-evals-caller-contract.eval.sh.log" ]
  then bad "the eval ran as a suite"; else ok "the eval is not a suite"; fi
rm -f "${SK}/review/code-review.sh"

# The export the debate and author resolvers list as a rung.
sk "cpd/scratch.md"
has "CLAUDE_PROJECT_DIR is not exported to a suite (session-write-root would skip its T3 branch)" "${OUT}" "ok .agents/skills/cpd"
rm -f "${SK}/cpd/scratch.md"

# A hung suite must not hang the close — the one step that must not hang.
# Staged WITHOUT `sk`, which would run the 30-second suite once at the default
# 180s timeout before the assertion below runs it again at 1s — half a minute on
# every run of this file, spent proving nothing.
git -C "${WBCLEAN}" checkout -q -- . 2>/dev/null
echo "// touched" >"${SK}/slow/scratch.md"
OUT="$(env "${E[@]}" VERIFY_SKILLS_TIMEOUT=1 bash "${SCRIPT}" 2>&1)"; RC=$?
is "a suite past the timeout fails the close" "${RC}" "1"
has "and is reported as a timeout, not a generic red" "${OUT}" \
  "FAIL .agents/skills/slow .agents/skills/slow/slow.test.sh — timed out after 1s"
rm -f "${SK}/slow/scratch.md"

# The same bound where no timeout(1) exists (stock macOS): the watchdog.
git -C "${WBCLEAN}" checkout -q -- . 2>/dev/null
echo "// touched" >"${SK}/slow/scratch.md"
OUT="$(env "${E[@]}" VERIFY_SKILLS_TIMEOUT=1 VERIFY_WATCHDOG=1 bash "${SCRIPT}" 2>&1)"; RC=$?
is "without timeout(1) a hung suite still fails the close" "${RC}" "1"
has "…as a timeout" "${OUT}" "FAIL .agents/skills/slow .agents/skills/slow/slow.test.sh — timed out after 1s"
rm -f "${SK}/slow/scratch.md"

# A workbench without the run.sh launcher runs a node:test suite with node.
mv "${SK}/run.sh" "${TMP}/run.sh.aside"
git -C "${WBCLEAN}" checkout -q -- . 2>/dev/null
echo "// touched" >"${SK}/tsgreen/scratch.md"
run
has "with no launcher a node:test suite still runs" "${OUT}" "ok .agents/skills/tsgreen"
rm -f "${SK}/tsgreen/scratch.md"
mv "${TMP}/run.sh.aside" "${SK}/run.sh"

# A deleted folder is the intent of the change; there is nothing to run.
git -C "${WBCLEAN}" rm -q -r .agents/skills/beta
run
is "deleting a folder does not fail the close" "${RC}" "0"
hasnt "and says nothing about it" "${OUT}" ".agents/skills/beta"
git -C "${WBCLEAN}" checkout -q HEAD -- .agents/skills/beta

# ── The workbench row's worktree is gone: landed, or lost ──────────────────
#
# `land.sh` removes each worktree after landing it and does NOT prune the
# ledger, so after ANY successful close the rows outlive the directories. Read
# naively, that makes every SECOND close of a thread halt here — `FAIL skills —
# ledger worktree ... is missing` — with nothing wrong. `land.sh` reads the same
# state and treats a landed row as spent; these two cases are the agreement.
# With no LIVE workbench row, the gone rows are the only evidence there is.

printf '%s\t%s\t%s\n' "${TMP}/wb-gone" "${WB_CANON}" "t3/${TID}" >"${SKLEDGER}"

# LOST: no landing recorded for this repo, so the directory went without its
# work. This is the case the check was written for and it still halts.
rm -f "${LANDED_FILE}"
run
is "a workbench worktree that vanished unlanded halts" "${RC}" "1"
has "and names the path" "${OUT}" "wb-gone"
has "and calls it missing" "${OUT}" "is missing"

# LANDED: `land.sh` put this repo on its trunk and then removed the directory.
printf '%s\t%s\n' "${WB_CANON}" "deadbeef" >"${LANDED_FILE}"
run
is "a workbench worktree removed by a completed landing does not halt" "${RC}" "0"
has "and says so rather than going silent" "${OUT}" "already landed and was removed"
hasnt "and is not reported as a failure" "${OUT}" "FAIL skills"

# ANOTHER repo's landing is not this one's. Keyed on the shared path, so a
# `landed` file with rows in it cannot excuse an unrelated missing worktree.
printf '%s\t%s\n' "${TMP}/some-other-repo" "deadbeef" >"${LANDED_FILE}"
run
is "a landing of a DIFFERENT repo does not excuse this row" "${RC}" "1"
has "and it is still called missing" "${OUT}" "is missing"
rm -f "${LANDED_FILE}"

# Put the live workbench row back for the cases below.
printf '%s\t%s\t%s\n' "${WBCLEAN}" "${WB_CANON}" "t3/${TID}" >"${SKLEDGER}"

# ── The backstop ───────────────────────────────────────────────────────────
#
# A write that never reached a worktree — through the `~/.agents/skills` link
# into `.agents/skills/` of the shared checkout. When this worktree changed .agents/skills/ it is
# attributable to this session and halts; when it did not, it is somebody else's
# and must not stop an unrelated close.

echo "// touched" >"${SK}/alpha/scratch.md"
echo "// stray" >"${WB_SHARED}/.agents/skills/stray.md"
run
is "a stray file under .agents/skills/ of the shared checkout halts a skills session" "${RC}" "1"
has "naming it" "${OUT}" "stray.md"
has "and saying why it matters" "${OUT}" "in no ledger"
rm -f "${SK}/alpha/scratch.md"

# The same dirt, with nothing under .agents/skills/ changed in this worktree: another
# session's work.
run
is "the same dirt does not halt a close that never touched skills" "${RC}" "0"
has "but it is still reported" "${OUT}" "owner unknown"
hasnt "and it is not called a failure" "${OUT}" "FAIL skills"

# Dirt OUTSIDE .agents/skills/ in the shared checkout is not this pass's business: the
# link exposes .agents/skills/ alone, and land.sh reports the rest of that tree.
rm -f "${WB_SHARED}/.agents/skills/stray.md"
echo "// stray" >"${WB_SHARED}/apps/stray.md"
echo "// touched" >"${SK}/alpha/scratch.md"
run
is "shared dirt outside .agents/skills/ does not halt" "${RC}" "0"
hasnt "and is not reported here" "${OUT}" "stray.md"
rm -f "${WB_SHARED}/apps/stray.md" "${SK}/alpha/scratch.md"

# A path the worktree DOES account for is not stray — it is this session's own
# work, mid-flight, and halting on it would halt every close.
echo "// touched" >"${SK}/alpha/scratch.md"
cp "${SK}/alpha/scratch.md" "${WB_SHARED}/.agents/skills/alpha/scratch.md"
run
is "a dirty path this thread's worktree accounts for does not halt" "${RC}" "0"
hasnt "and is not reported as stray" "${OUT}" "does not account for"
rm -f "${WB_SHARED}/.agents/skills/alpha/scratch.md" "${SK}/alpha/scratch.md"

# A DIFFERENT edit at a path the worktree also changed is still stray: the
# worktree's version is what lands, and nothing will ever land the shared one.
echo "// worktree version" >"${SK}/alpha/scratch.md"
echo "// a DIFFERENT shared edit" >"${WB_SHARED}/.agents/skills/alpha/scratch.md"
run
is "a same-path, different-content shared edit halts" "${RC}" "1"
has "and is named" "${OUT}" "alpha/scratch.md"
rm -f "${WB_SHARED}/.agents/skills/alpha/scratch.md" "${SK}/alpha/scratch.md"

# ── No workbench row at all ────────────────────────────────────────────────
#
# Everything in this pass keys off that one row, so swallowing its absence
# closed a skills session having verified nothing and said nothing. A ledger
# holding only a product repo's row — live, but with no apps/ — is the shape.
NOWB="${TMP}/no-workbench-home"
mkdir -p "${NOWB}/.cache/workbench/threads/${TID}"
printf '%s\t%s\t%s\n' "${PRODWT}" "${TMP}/prodshared" "t3/${TID}" \
  >"${NOWB}/.cache/workbench/threads/${TID}/worktrees"
OUT4="$(env "HOME=${NOWB}" "WORKBENCH_THREAD_ID=${TID}" \
  "VERIFY_RUNNER=bash ${RUNNER}" bash "${SCRIPT}" 2>&1)"
RC4=$?
is "a ledger with no workbench row does not halt the close" "${RC4}" "0"
has "but it says so rather than checking nothing in silence" "${OUT4}" \
  "no skill folder was checked"
has "and names the trees it looked for" "${OUT4}" ".agents/skills/"

# ── A folder whose suites cannot be listed ────────────────────────────────
#
# Discovery that FAILED is not discovery that found nothing.
if [ "$(id -u)" != 0 ]; then
  mkdir -p "${SK}/locked/inner"
  printf '#!/usr/bin/env bash\nexit 0\n' >"${SK}/locked/inner/x.test.sh"
  echo "// touched" >"${SK}/locked/scratch.md"
  chmod 000 "${SK}/locked/inner"
  run
  chmod 755 "${SK}/locked/inner"
  is "an unlistable folder fails the close" "${RC}" "1"
  has "rather than reading as a folder with no suites" "${OUT}" \
    "could not list its test suites"
  hasnt "and is not reported as a gap" "${OUT}" "unverified .agents/skills/locked"
  rm -rf "${SK}/locked"
else
  ok "an unlistable folder fails the close (skipped: running as root)"
  ok "rather than reading as a folder with no suites (skipped: running as root)"
  ok "and is not reported as a gap (skipped: running as root)"
fi

# ── Found by the machine reviewer, round 2 ────────────────────────────────

# A suite that TRAPS the timeout signal and exits 0 has still not finished. Any
# exit-code scheme can be forged by the suite; the clock cannot. Each of these
# two folders is PUSHED, not just committed: a commit ahead of origin/main is a
# change, and an unpushed `own124` would fail every case after it.
suite "trapper/trap.test.sh" 'trap "exit 0" TERM; sleep 30'
git -C "${WBCLEAN}" add -- .agents/skills/trapper && git -C "${WBCLEAN}" commit -q -m trapper \
  && git -C "${WBCLEAN}" push -q origin main
echo "// touched" >"${SK}/trapper/scratch.md"
OUT="$(env "${E[@]}" VERIFY_SKILLS_TIMEOUT=1 bash "${SCRIPT}" 2>&1)"; RC=$?
is "a suite that traps the kill and exits 0 still fails the close" "${RC}" "1"
has "and is still reported as a timeout" "${OUT}" \
  "FAIL .agents/skills/trapper .agents/skills/trapper/trap.test.sh — timed out after 1s"
hasnt "and is never reported ok" "${OUT}" "ok .agents/skills/trapper"
rm -f "${SK}/trapper/scratch.md"

# A suite that exits 124 of its OWN accord finished; it is red, not hung.
suite "own124/x.test.sh" 'exit 124'
git -C "${WBCLEAN}" add -- .agents/skills/own124 && git -C "${WBCLEAN}" commit -q -m own124 \
  && git -C "${WBCLEAN}" push -q origin main
echo "// touched" >"${SK}/own124/scratch.md"
run
is "a suite that exits 124 by itself fails the close" "${RC}" "1"
hasnt "but is not called a timeout" "${OUT}" "timed out"
has "it gets the rerun line instead" "${OUT}" "rerun: cd ${WBCLEAN} && bash .agents/skills/own124/x.test.sh"
rm -f "${SK}/own124/scratch.md"

# Git records the executable bit, so equal bytes are not the same file. A
# shared `chmod +x` that nothing will land must not read as accounted for.
echo "// touched" >"${SK}/alpha/scratch.md"
cp "${SK}/alpha/scratch.md" "${WB_SHARED}/.agents/skills/alpha/scratch.md"
chmod +x "${WB_SHARED}/.agents/skills/alpha/scratch.md"
run
is "equal bytes with a different mode still halts" "${RC}" "1"
has "and the file is named" "${OUT}" "alpha/scratch.md"
rm -f "${WB_SHARED}/.agents/skills/alpha/scratch.md" "${SK}/alpha/scratch.md"

# ── A gone row beside a LIVE workbench row ─────────────────────────────────
#
# With the workbench row present, a product repo's row whose worktree is gone is
# pass 1's business (skipped there) and not this pass's: the skills were never
# in that worktree, so its loss says nothing about them.
{
  printf '%s\t%s\t%s\n' "${WBCLEAN}" "${WB_CANON}" "t3/${TID}"
  printf '%s\t%s\t%s\n' "${TMP}/gone-product-wt" "${TMP}/gone-shared" "t3/${TID}"
} >"${SKLEDGER}"
echo "// touched" >"${SK}/alpha/scratch.md"
run
is "a gone product row beside a live workbench row does not halt" "${RC}" "0"
has "and the skills are still verified" "${OUT}" "ok .agents/skills/alpha"
hasnt "and the gone row is not mentioned here" "${OUT}" "gone-product-wt"
rm -f "${SK}/alpha/scratch.md"

echo
echo "verify.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
