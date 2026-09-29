#!/usr/bin/env bash
# shellcheck disable=SC2016  # stub bodies and fixtures are single-quoted on purpose: they expand when the stub runs, not here
# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
# Boundary rows for check-scripts.sh: both parts, the script definition, the
# six pairing shapes, the library carve-out with its specifier resolution, the
# no-args / --since scans land.sh actually calls, --all, explicit paths and
# caller errors.
#
# Every fixture lives in a real `git init`-ed repo, because the incremental
# modes read `git diff` and `git ls-files --others`; a bare scratch directory
# cannot reach them. The script is run as a subprocess, never sourced.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-scripts.sh"
TMP="$(mktemp -d)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0

check() {
  local name="$1" expected_rc="$2" actual_rc="$3"
  if [[ "$expected_rc" == "$actual_rc" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $name — expected rc=$expected_rc, got rc=$actual_rc" >&2
  fi
}

# is <name> <actual> <expected> — exact match.
is() {
  if [[ "$2" == "$3" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — got '$2', wanted '$3'" >&2
  fi
}

# has <name> <haystack> <needle> — the output names the part the test claims.
has() {
  if [[ "$2" == *"$3"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output lacks '$3':" >&2
    printf '%s\n' "$2" | sed 's/^/    /' >&2
  fi
}

hasnt() {
  if [[ "$2" != *"$3"* ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — output should not contain '$3'" >&2
  fi
}

# A fresh repo with one baseline commit. Sets REPO.
n=0
newrepo() {
  n=$((n + 1))
  REPO="$TMP/repo$n"
  mkdir -p "$REPO"
  git -C "$REPO" init -q -b main
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name tester
  echo seed >"$REPO/seed.txt"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m seed
}

commit_all() { git -C "$REPO" add -A && git -C "$REPO" commit -q -m "$1"; }

# f <path> [content] — a file under $REPO, folders made.
f() {
  mkdir -p "$REPO/$(dirname "$1")"
  printf '%s\n' "${2-# a file}" >"$REPO/$1"
}

# run [args...] — runs the check from $REPO. Sets OUT, ERR, RC.
run() {
  OUT="$(cd "$REPO" && bash "$SCRIPT" "$@" 2>"$TMP/err")"
  RC=$?
  ERR="$(cat "$TMP/err")"
}

lines() { printf '%s' "$1" | grep -c '' || true; }

# ── (1)(2) Part (a): a script with no test, then with one ────────────────

newrepo
f .agents/skills/x/scripts/a.sh '#!/usr/bin/env bash'
run --all
check "uncovered .sh fails" 1 "$RC"
is "…with the one-line FAIL summary" "$OUT" "FAIL — 1 script(s) checked, 1 violation(s)"
is "…and the (a) line naming the six shapes" "$ERR" \
  ".agents/skills/x/scripts/a.sh: (a) no test — expected a.test.sh or a.test.ts beside it, or tests/a.test.* in its folder or parent"

f .agents/skills/x/scripts/a.test.sh 'bash "$(dirname "$0")/a.sh"'
run --all
check "a sibling .test.sh covers it" 0 "$RC"
is "…and the summary counts one" "$OUT" "OK — 1 script(s) checked"
is "…with nothing on stderr" "$ERR" ""

# ── (3)(4) Pairing shapes: cross-extension, tests/, ../tests/ ────────────

newrepo
f .agents/skills/x/scripts/a.sh
f .agents/skills/x/scripts/a.test.ts 'spawnSync("bash", ["a.sh"])'
f .agents/skills/x/scripts/b.ts 'process.argv'
f .agents/skills/x/scripts/tests/b.test.sh 'bash ../b.ts'
f .agents/skills/x/scripts/c.ts 'process.argv'
f .agents/skills/x/tests/c.test.ts 'spawnSync'
f .agents/skills/y/scripts/d.sh
f .agents/skills/y/tests/d.test.ts 'spawnSync'
run --all
check ".test.ts pairs a .sh, tests/ and ../tests/ pair" 0 "$RC"
is "…four scripts counted (the tests are not scripts)" "$OUT" "OK — 4 script(s) checked"

# ── (5)(6)(6b) Part (b): a program's test imports it; then it is a library ─

newrepo
f .agents/skills/x/scripts/b.ts 'export const f = 1;'
f .agents/skills/x/scripts/b.test.ts 'import { f } from "./b.ts";'
run --all
check "a program test that imports its subject fails" 1 "$RC"
is "…one violation" "$OUT" "FAIL — 1 script(s) checked, 1 violation(s)"
is "…naming the test and the subject" "$ERR" \
  ".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts — run it as a subprocess"

f .agents/skills/x/scripts/c.ts 'import { f } from "./b.ts";'
f .agents/skills/x/scripts/c.test.sh 'node c.ts'
run --all
check "once a non-test file imports it, b.ts is a library and its import test passes" 0 "$RC"
is "…two scripts counted" "$OUT" "OK — 2 script(s) checked"

# (6b) Another file with the same stem, imported from a different folder.
newrepo
f .agents/skills/x/scripts/b.ts 'export const f = 1;'
f .agents/skills/x/scripts/b.test.ts 'import { f } from "./b.ts";'
f .agents/skills/y/scripts/b.ts 'export const g = 2;'
f .agents/skills/y/scripts/b.test.sh 'node b.ts'
f .agents/skills/y/scripts/c.ts 'import { g } from "./b.ts";'
f .agents/skills/y/scripts/c.test.sh 'node c.ts'
run --all
check "an import of a same-stem file elsewhere does not make this one a library" 1 "$RC"
has "…the x one is still a program" "$ERR" ".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts"
hasnt "…the y one is a library" "$ERR" ".agents/skills/y/scripts/b.test.ts"

# (6c) The only importer is deleted in a worktree: --since catches it although
# neither the subject nor its test changed.
newrepo
f .agents/skills/x/scripts/b.ts 'export const f = 1;'
f .agents/skills/x/scripts/b.test.ts 'import { f } from "./b.ts";'
f .agents/skills/x/scripts/c.ts 'import { f } from "./b.ts";'
f .agents/skills/x/scripts/c.test.sh 'node c.ts'
commit_all "library and importer"
run --since main
check "clean at the trunk" 0 "$RC"
git -C "$REPO" checkout -q -b work
git -C "$REPO" rm -q .agents/skills/x/scripts/c.ts .agents/skills/x/scripts/c.test.sh
git -C "$REPO" commit -q -m "drop the importer"
run --since main
check "deleting the only importer turns the import test into a (b) violation" 1 "$RC"
has "…naming b.test.ts" "$ERR" ".agents/skills/x/scripts/b.test.ts: (b) imports its subject .agents/skills/x/scripts/b.ts"
is "…while the deleted script is skipped and nothing else changed" "$OUT" "FAIL — 0 script(s) checked, 1 violation(s)"

# ── (7) Shell source, sibling-library import, comments ───────────────────

newrepo
f .agents/skills/x/scripts/p.sh 'echo program'
f .agents/skills/x/scripts/p.test.sh 'source "$(dirname "$0")/p.sh"'
run --all
check "a test that sources a program .sh fails (b)" 1 "$RC"
has "…naming it" "$ERR" ".agents/skills/x/scripts/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

newrepo
f .agents/skills/x/scripts/lib.sh 'helper() { :; }'
f .agents/skills/x/scripts/lib.test.sh 'source "$(dirname "$0")/lib.sh"; helper'
f .agents/skills/x/scripts/p.sh 'source "$(dirname "$0")/lib.sh"; helper'
f .agents/skills/x/scripts/p.test.sh '. "$(dirname "$0")/lib.sh"
bash "$(dirname "$0")/p.sh"'
run --all
check "a test that spawns its subject and sources a sibling library passes" 0 "$RC"
is "…two scripts" "$OUT" "OK — 2 script(s) checked"

newrepo
f .agents/skills/x/scripts/p.sh 'echo program'
f .agents/skills/x/scripts/p.test.sh '# see p.sh for the contract; source p.sh is NOT what we do
bash "$(dirname "$0")/p.sh"'
f .agents/skills/x/scripts/q.ts 'process.argv'
f .agents/skills/x/scripts/q.test.ts '// this test used to `import { x } from "./q.ts"` — it spawns now
spawnSync("node", ["q.ts"]);'
run --all
check "a comment mentioning the file is not an import" 0 "$RC"

newrepo
f .agents/skills/x/scripts/q.ts 'process.argv'
f .agents/skills/x/scripts/q.test.ts 'import { x } from "./q.ts";
spawnSync("node", ["q.ts"]);'
run --all
check "a test that both imports and spawns its subject is still (b)" 1 "$RC"

# A tests/ subfolder test importing ../subject resolves to the subject.
newrepo
f .agents/skills/x/scripts/r.ts 'process.argv'
f .agents/skills/x/scripts/tests/r.test.ts 'import { r } from "../r.ts";'
run --all
check "tests/<stem>.test.ts importing ../<stem>.ts is (b)" 1 "$RC"
has "…naming the tests/ path" "$ERR" ".agents/skills/x/scripts/tests/r.test.ts: (b) imports its subject .agents/skills/x/scripts/r.ts"

# A library source built at run time from a tests/ folder: `$HERE/../lib.sh`.
newrepo
f .agents/skills/x/scripts/lib.sh 'helper() { :; }'
f .agents/skills/x/scripts/tests/lib.test.sh 'source "$DIR/../lib.sh"'
f .agents/skills/x/scripts/user.sh 'source "$SCRIPT_DIR/lib.sh"'
f .agents/skills/x/scripts/tests/user.test.sh 'bash ../user.sh'
run --all
check "a run-time-built source from a sibling makes lib.sh a library" 0 "$RC"

# A run-time-built source from a tests/ folder up to its program: still (b).
newrepo
f .agents/skills/x/scripts/p.sh 'echo program'
f .agents/skills/x/scripts/tests/p.test.sh 'source "$(dirname "$0")/../p.sh"'
run --all
check "tests/<stem>.test.sh sourcing ../<stem>.sh at run time is (b)" 1 "$RC"
has "…naming the tests/ path" "$ERR" ".agents/skills/x/scripts/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

# Two paired tests: the clean one does not excuse the importing one.
newrepo
f .agents/skills/x/scripts/q.ts 'process.argv'
f .agents/skills/x/scripts/q.test.sh 'bash "$(dirname "$0")/../../run.sh" x/scripts/q.ts'
f .agents/skills/x/scripts/q.test.ts 'import { q } from "./q.ts";'
run --all
check "a clean .test.sh beside an importing .test.ts is still (b)" 1 "$RC"
has "…naming the importing one" "$ERR" ".agents/skills/x/scripts/q.test.ts: (b) imports its subject .agents/skills/x/scripts/q.ts"

# ── (8)(9) The script definition ─────────────────────────────────────────

newrepo
f .agents/skills/x/references/x.sh
f .agents/skills/x/scripts/x.template.sh
f .agents/skills/x/scripts/x.test.sh
f .agents/skills/x/scripts/tests/helper.sh
f .agents/skills/x/templates/t.sh
f .agents/skills/x/node_modules/m/bin.sh
run --all
check "references/, templates, tests, node_modules and .test. are not scripts" 0 "$RC"
is "…zero counted" "$OUT" "OK — 0 script(s) checked"

newrepo
f .agents/skills/x/scripts/a.py '#!/usr/bin/env python3'
f .agents/skills/x/scripts/b.mjs '#!/usr/bin/env node'
f .agents/skills/x/scripts/c.ts 'process.argv'
f .agents/skills/x/lib/d.ts 'export const d = 1;'
f .agents/skills/x/e.py '#!/usr/bin/env python3'
f .agents/skills/x/g.js 'module.exports = 1;'
f .agents/checks/h.ts 'process.argv'
f .agents/hooks/i.ts 'process.argv'
f .agents/generators/j.ts 'process.argv'
f .agents/skills/x/hooks/k.ts 'process.argv'
f apps/other/scripts/outside.sh
run --all
check "shebang or scripts-folder files are scripts; lib/ and shebang-less root files are not" 1 "$RC"
is "…eight scripts counted, none outside the roots" "$OUT" "FAIL — 8 script(s) checked, 8 violation(s)"
hasnt "…lib/d.ts is not a script" "$ERR" "lib/d.ts"
hasnt "…g.js without a shebang outside a scripts folder is not a script" "$ERR" "g.js"
hasnt "…apps/other is outside the universe" "$ERR" "apps/other"
has "…e.py with a shebang at the skill root is one" "$ERR" ".agents/skills/x/e.py: (a)"
has "…hooks/ is a scripts folder" "$ERR" ".agents/skills/x/hooks/k.ts: (a)"

# ── Review round: sibling tests/, unreadable tests, absolute paths ───────

# A test in <skill>/tests/ pairs a script in any sibling folder of it
# (find_tests' `../tests/` shape), so deleting that only test selects the script.
newrepo
f .agents/skills/x/scripts/c.sh '#!/usr/bin/env bash'
f .agents/skills/x/tests/c.test.sh 'bash ../scripts/c.sh'
commit_all "c with its test in the skill's tests/"
git -C "$REPO" rm -q .agents/skills/x/tests/c.test.sh
run
check "deleting a script's only ../tests/ test fails (a)" 1 "$RC"
has "…naming the script in the sibling folder" "$ERR" ".agents/skills/x/scripts/c.sh: (a)"

# A test that cannot be read is an error, never a clean scan.
newrepo
f .agents/skills/x/scripts/u.sh '#!/usr/bin/env bash'
f .agents/skills/x/scripts/u.test.sh 'bash u.sh'
chmod 000 "$REPO/.agents/skills/x/scripts/u.test.sh"
run --all
chmod 644 "$REPO/.agents/skills/x/scripts/u.test.sh"
check "an unreadable paired test is rc 2" 2 "$RC"
has "…naming it" "$ERR" "cannot read .agents/skills/x/scripts/u.test.sh"

# A <skill>/tests/ test sourcing its program through $HERE/../scripts/ is (b).
newrepo
f .agents/skills/x/scripts/p.sh '#!/usr/bin/env bash'
f .agents/skills/x/tests/p.test.sh 'source "$HERE/../scripts/p.sh"'
run --all
check "a ../tests/ test sourcing ../scripts/<stem>.sh at run time is (b)" 1 "$RC"
has "…naming it" "$ERR" ".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

# A run-time path names its folder: sourcing ../other/c.sh is not ../scripts/c.sh.
newrepo
f .agents/skills/x/scripts/c.sh '#!/usr/bin/env bash'
f .agents/skills/x/other/c.sh '#!/usr/bin/env bash'
f .agents/skills/x/tests/c.test.sh 'source "$HERE/../other/c.sh"'
run --all
hasnt "a ../tests/ test sourcing ../other/<stem>.sh does not import scripts/<stem>.sh" "$ERR" "imports its subject .agents/skills/x/scripts/c.sh"
has "…it imports other/<stem>.sh, which it names" "$ERR" "imports its subject .agents/skills/x/other/c.sh"

# The usual spelling nests one substitution in another; its tail is `/p.sh`.
newrepo
f .agents/skills/x/scripts/p.sh '#!/usr/bin/env bash'
f .agents/skills/x/scripts/p.test.sh 'source "$(dirname "${BASH_SOURCE[0]}")/p.sh"'
run --all
check "a test sourcing \$(dirname \"\${BASH_SOURCE[0]}\")/<stem>.sh is (b)" 1 "$RC"
has "…naming it" "$ERR" ".agents/skills/x/scripts/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

newrepo
f .agents/skills/x/scripts/q.sh '#!/usr/bin/env bash'
f .agents/skills/x/scripts/tests/q.test.sh 'source "$(dirname "${BASH_SOURCE[0]}")/../q.sh"'
run --all
has "…and from tests/ through ../<stem>.sh" "$ERR" ".agents/skills/x/scripts/tests/q.test.sh: (b) imports its subject .agents/skills/x/scripts/q.sh"

# A `)` in a literal folder name is part of the path, not the end of a
# substitution: `../other)/p.sh` is not `scripts/p.sh`.
newrepo
f .agents/skills/x/scripts/p.sh '#!/usr/bin/env bash'
f ".agents/skills/x/other)/p.sh" '#!/usr/bin/env bash'
f .agents/skills/x/tests/p.test.sh 'source "$HERE/../other)/p.sh"'
run --all
hasnt "a literal ) in a folder name is kept in the path" "$ERR" "imports its subject .agents/skills/x/scripts/p.sh"

# A quoted ) inside a substitution does not close it.
newrepo
f .agents/skills/x/scripts/p.sh '#!/usr/bin/env bash'
f .agents/skills/x/tests/p.test.sh 'source "$(dirname "$0" | tr -d ")")/../scripts/p.sh"'
run --all
has "a quoted ) inside \$( ) does not end it" "$ERR" ".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

# A substitution nested inside a double-quoted one, with quoted parens of its own.
newrepo
f .agents/skills/x/scripts/p.sh '#!/usr/bin/env bash'
f .agents/skills/x/tests/p.test.sh 'source "$(dirname "$(echo "$0" | tr -d ")(")")/../scripts/p.sh"'
run --all
has "a nested, quoted substitution is skipped whole" "$ERR" ".agents/skills/x/tests/p.test.sh: (b) imports its subject .agents/skills/x/scripts/p.sh"

# An explicit path given absolute is the same file as its relative form.
newrepo
f .agents/skills/y/scripts/b.sh
run "$REPO/.agents/skills/y/scripts/b.sh"
check "an absolute explicit path is checked" 1 "$RC"
is "…and counted" "$OUT" "FAIL — 1 script(s) checked, 1 violation(s)"

# ── Contextium's own scripts: tested in its repo, until edited here ──────

newrepo
f .agents/skills/x/scripts/ours.sh '#!/usr/bin/env bash'
f .agents/skills/x/scripts/mine.sh '#!/usr/bin/env bash'
f .agents/hooks/guard.sh '#!/usr/bin/env bash'
{ echo "# Written by the Contextium installer"
  printf '%s\t%s\n' .agents/skills/x/scripts/ours.sh "$(cksum <"$REPO/.agents/skills/x/scripts/ours.sh" | awk '{print $1, $2}')"
} >"$REPO/.agents/skills/.contextium-manifest"
# the hooks manifest lists guard.sh with a checksum it does not have
printf '%s\t%s\n' .agents/hooks/guard.sh "1 2" >"$REPO/.agents/hooks/.contextium-manifest"
run --all
check "a shipped script, unchanged, needs no test here" 1 "$RC"
hasnt "…ours.sh passes (a)" "$ERR" "ours.sh"
has "…a script the manifest does not list is yours" "$ERR" ".agents/skills/x/scripts/mine.sh: (a)"
has "…and one that no longer matches its checksum is yours too" "$ERR" ".agents/hooks/guard.sh: (a)"
echo "# my edit" >>"$REPO/.agents/skills/x/scripts/ours.sh"
run --all
has "an edited shipped script is yours, test included" "$ERR" ".agents/skills/x/scripts/ours.sh: (a)"

# ── (15) Empty test file passes both parts ───────────────────────────────

newrepo
f .agents/skills/x/scripts/a.sh
: >"$REPO/.agents/skills/x/scripts/a.test.sh"
run --all
check "an empty test file passes (a) and (b)" 0 "$RC"

# ── (10) No-args mode ────────────────────────────────────────────────────

newrepo
f .agents/skills/x/scripts/old.sh
f .agents/skills/x/scripts/old.test.sh 'bash old.sh'
f .agents/skills/x/scripts/gone.sh
f .agents/skills/x/scripts/gone.test.sh 'bash gone.sh'
f .agents/skills/x/scripts/orphan.sh
f .agents/skills/x/scripts/orphan.test.sh 'bash orphan.sh'
f .agents/skills/x/scripts/untested.sh
commit_all "baseline with an untested script"
run
check "no-args with nothing changed is clean" 0 "$RC"
is "…and counts nothing (the untested committed script is not selected)" "$OUT" "OK — 0 script(s) checked"

f .agents/skills/x/scripts/new.sh                      # untracked, no test
rm "$REPO/.agents/skills/x/scripts/gone.sh"            # script deleted, test stays
rm "$REPO/.agents/skills/x/scripts/orphan.test.sh"     # test deleted, script stays
echo "# touched" >>"$REPO/.agents/skills/x/scripts/old.sh"  # changed, covered
run
check "no-args: untracked and orphaned scripts fail" 1 "$RC"
is "…three selected: new, orphan and old (gone is skipped)" "$OUT" "FAIL — 3 script(s) checked, 2 violation(s)"
has "…the untracked one" "$ERR" ".agents/skills/x/scripts/new.sh: (a)"
has "…the one whose test was deleted" "$ERR" ".agents/skills/x/scripts/orphan.sh: (a)"
hasnt "…not the deleted script" "$ERR" "gone.sh"
hasnt "…not the covered change" "$ERR" "old.sh"
hasnt "…not the untested script nothing touched" "$ERR" "untested.sh"

# A script whose only test lives under tests/ — deleting that test must select
# the script, although tests/ is an excluded segment for SCRIPTS.
newrepo
f .agents/skills/x/scripts/deep.sh
f .agents/skills/x/scripts/tests/deep.test.sh 'bash ../deep.sh'
commit_all "a script tested from tests/"
rm "$REPO/.agents/skills/x/scripts/tests/deep.test.sh"
run
check "no-args: deleting a script's only test under tests/ fails (a)" 1 "$RC"
has "…naming the script" "$ERR" ".agents/skills/x/scripts/deep.sh: (a)"

# The change listing failing is a caller error, never an empty change set.
run --since no-such-ref
check "--since a ref git cannot resolve is rc 2" 2 "$RC"

# A universe listing that cannot be completed is rc 2, never a shorter OK: a
# folder find cannot enter makes find fail, and every mode reads the universe.
newrepo
f .agents/skills/x/scripts/p.sh
f .agents/skills/x/scripts/p.test.sh 'bash p.sh'
mkdir -p "$REPO/.agents/skills/y/scripts/locked"
chmod 000 "$REPO/.agents/skills/y/scripts/locked"
run --all
chmod 755 "$REPO/.agents/skills/y/scripts/locked"
check "--all with an unreadable folder under a root is rc 2" 2 "$RC"
has "…naming find" "$ERR" "check-scripts: find failed under .agents"
hasnt "…and prints no OK" "$OUT" "OK"
chmod 000 "$REPO/.agents/skills/y/scripts/locked"
run
chmod 755 "$REPO/.agents/skills/y/scripts/locked"
check "no-args mode reads the universe for part (b), so it is rc 2 too" 2 "$RC"

# ── (11) --since ─────────────────────────────────────────────────────────

newrepo
f .agents/skills/x/scripts/a.sh
f .agents/skills/x/scripts/a.test.sh 'bash a.sh'
commit_all "trunk"
git -C "$REPO" checkout -q -b work
f .agents/skills/x/scripts/b.sh
commit_all "committed on the branch, no test"
run
check "no-args misses a change already committed" 0 "$RC"
run --since main
check "--since main sees it" 1 "$RC"
has "…naming it" "$ERR" ".agents/skills/x/scripts/b.sh: (a)"
is "…one selected" "$OUT" "FAIL — 1 script(s) checked, 1 violation(s)"

git -C "$REPO" checkout -q --orphan lonely
git -C "$REPO" rm -rqf .
echo alone >"$REPO/alone.txt"
commit_all "no shared history"
run --since main
check "--since a ref with no merge base is a caller error" 2 "$RC"
has "…and says so" "$ERR" "cannot find where HEAD left main"
git -C "$REPO" checkout -q -f work

# ── (12)(13) --all counts everything; explicit paths; caller errors ──────

newrepo
f .agents/skills/x/scripts/a.sh
f .agents/skills/x/scripts/a.test.sh 'bash a.sh'
f .agents/skills/y/scripts/b.sh
f .agents/checks/c.sh
f .agents/hooks/d.sh
f .agents/generators/e.sh
f .agents/generators/g.ts 'process.argv'
f apps/web/src/h.ts 'process.argv'
f apps/web/scripts/outside.sh
commit_all "the roots"
run --all
check "--all walks all of .agents/" 1 "$RC"
is "…six scripts, five violations" "$OUT" "FAIL — 6 script(s) checked, 5 violation(s)"
hasnt "…an app's src/ is outside the universe" "$ERR" "src/h.ts"
hasnt "…and so is an app's scripts/" "$ERR" "apps/web/scripts"

run .agents/skills/x/scripts/a.sh
check "an explicit covered file" 0 "$RC"
is "…counts one" "$OUT" "OK — 1 script(s) checked"
run .agents/skills/y/scripts/b.sh .agents/hooks/d.sh
check "explicit uncovered files" 1 "$RC"
is "…count two" "$OUT" "FAIL — 2 script(s) checked, 2 violation(s)"
run .agents/checks
check "a directory argument walks it for scripts" 1 "$RC"
is "…one script beneath it" "$OUT" "FAIL — 1 script(s) checked, 1 violation(s)"
run .agents/skills/x/scripts/a.test.sh
check "an explicit path that is not a script counts nothing" 0 "$RC"
is "…zero" "$OUT" "OK — 0 script(s) checked"

run --all .agents/skills/x/scripts/a.sh
check "--all with paths is a caller error" 2 "$RC"
run --bogus
check "an unknown flag is a caller error" 2 "$RC"
run --since
check "--since with no ref is a caller error" 2 "$RC"
run --since main skills
check "--since with paths is a caller error" 2 "$RC"

outside="$TMP/not-a-repo"
mkdir -p "$outside"
(cd "$outside" && bash "$SCRIPT" >/dev/null 2>&1)
check "no-args outside a git work tree" 2 "$?"

# ── (14) stdout is exactly one line in every mode ────────────────────────

newrepo
f .agents/skills/x/scripts/a.sh
f .agents/skills/y/scripts/b.ts 'export const b = 1;'
f .agents/skills/y/scripts/b.test.ts 'import { b } from "./b.ts";'
run --all
is "--all: one stdout line" "$(lines "$OUT")" "1"
run
is "no-args: one stdout line" "$(lines "$OUT")" "1"
run .agents/skills/x/scripts/a.sh
is "paths: one stdout line" "$(lines "$OUT")" "1"
commit_all "all"
run --since main
is "--since: one stdout line" "$(lines "$OUT")" "1"

echo "check-scripts.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
