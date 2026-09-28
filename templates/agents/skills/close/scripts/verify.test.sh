#!/usr/bin/env bash
# shellcheck disable=SC2016  # fixtures are literal markdown; backticks are not expansions
# verify.test.sh — peer of verify.sh: which units run for which changes, and
# that a red suite is a FAIL. Run: bash verify.test.sh
set -uo pipefail

SUT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0
ok()  { pass=$((pass + 1)); echo "ok: $1"; }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }
has() { case "$2" in *"$3"*) ok "$1" ;; *) bad "$1 — output lacks '$3':"; printf '%s\n' "$2" >&2 ;; esac; }
lacks() { case "$2" in *"$3"*) bad "$1 — output has '$3':"; printf '%s\n' "$2" >&2 ;; *) ok "$1" ;; esac; }
is()  { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1: got '$2', wanted '$3'"; fi; }

R="$TMP/repo"
fresh() {
  rm -rf "$R"; mkdir -p "$R"
  git -C "$R" init -q
  git -C "$R" config user.email t@example.com
  git -C "$R" config user.name t
  echo seed >"$R/README.md"
  git -C "$R" add -A && git -C "$R" commit -q -m seed
}
run() { OUT="$(cd "$R" && env -u CLAUDE_PROJECT_DIR bash "$SUT" "$@" 2>/dev/null)"; RC=$?; }

# Nothing changed
fresh; run
is "clean tree says so" "$OUT" "nothing changed"
is "…and exits 0" "$RC" "0"

# A changed skill runs its suites; green → ok
fresh
mkdir -p "$R/.agents/skills/demo/scripts"
printf '#!/usr/bin/env bash\nexit 0\n' >"$R/.agents/skills/demo/scripts/a.test.sh"
echo x >"$R/.agents/skills/demo/SKILL.md"
run
has "a green skill suite is ok" "$OUT" "ok .agents/skills/demo"
is "…and exits 0" "$RC" "0"

# A red suite is a FAIL with a rerun command, and exit 1
printf '#!/usr/bin/env bash\necho boom >&2\nexit 1\n' >"$R/.agents/skills/demo/scripts/b.test.sh"
run
has "a red suite is a FAIL" "$OUT" "FAIL .agents/skills/demo"
has "…naming the suite" "$OUT" "b.test.sh"
has "…with a rerun command" "$OUT" "rerun:"
lacks "…and the unit is not also ok" "$OUT" "ok .agents/skills/demo"
is "…and exits 1" "$RC" "1"
ERR="$(cd "$R" && bash "$SUT" 2>&1 >/dev/null)"
has "the suite's own output goes to stderr" "$ERR" "boom"

# The source copy under templates/agents/skills counts too; a skill with no
# suites is unverified, not failed
fresh
mkdir -p "$R/templates/agents/skills/bare"
echo x >"$R/templates/agents/skills/bare/SKILL.md"
run
has "a skill with no suites is unverified" "$OUT" "unverified templates/agents/skills/bare — no test suites"
is "…and exits 0" "$RC" "0"

# A committed change is seen only with --base
fresh
base="$(git -C "$R" rev-parse HEAD)"
mkdir -p "$R/.agents/skills/demo/scripts"
printf '#!/usr/bin/env bash\nexit 1\n' >"$R/.agents/skills/demo/scripts/a.test.sh"
git -C "$R" add -A && git -C "$R" commit -q -m "skill"
run
is "without --base a committed change is not seen" "$OUT" "nothing changed"
run --base "$base"
has "with --base it is" "$OUT" "FAIL .agents/skills/demo"
run --base not-a-commit
is "a bad --base is a usage error" "$RC" "2"
run --base
is "--base with no value is a usage error, not \"no base\"" "$RC" "2"
run --base ""
is "--base with an empty value is a usage error" "$RC" "2"

# Decision records go to the MADR checker, which is found by path
fresh
mkdir -p "$R/decisions" "$R/.githooks/checks"
echo x >"$R/decisions/0001-use-postgres.md"
echo x >"$R/decisions/README.md"
run
has "no checker → unverified" "$OUT" "unverified decisions — no .githooks/checks/check-decision-records.sh"
printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$@" > "%s/checked"\nexit 0\n' "$R" >"$R/.githooks/checks/check-decision-records.sh"
run
has "a passing checker is ok" "$OUT" "ok decisions (1 record(s))"
is "…handed only the numbered record" "$(cat "$R/checked")" "decisions/0001-use-postgres.md"
mkdir -p "$R/projects/web/2026-01-10_checkout-flow/decisions"
echo x >"$R/projects/web/2026-01-10_checkout-flow/decisions/0002-retry-once.md"
run
is "…project decisions too" "$(cat "$R/checked" | LC_ALL=C sort | paste -s -d' ' -)" \
  "decisions/0001-use-postgres.md projects/web/2026-01-10_checkout-flow/decisions/0002-retry-once.md"
printf '#!/usr/bin/env bash\nexit 1\n' >"$R/.githooks/checks/check-decision-records.sh"
run
has "a failing checker is a FAIL" "$OUT" "FAIL decisions"
is "…and exits 1" "$RC" "1"

# Code: the nearest package.json's check and test; records and docs never trigger it
fresh
echo x >"$R/notes.md"
mkdir -p "$R/journal/2026-01-12"; echo x >"$R/journal/2026-01-12/1200-x.md"
run
lacks "markdown and records run no code unit" "$OUT" "code"
echo "x" >"$R/tool.py"
run
has "code under no package.json is unverified" "$OUT" "unverified code"
if command -v npm >/dev/null 2>&1; then
  fresh
  mkdir -p "$R/apps/api/src"
  printf '{"name":"api","scripts":{"test":"exit 0"}}\n' >"$R/apps/api/package.json"
  echo x >"$R/apps/api/src/a.js"
  run
  has "a green package test is ok" "$OUT" "ok apps/api"
  printf '{"name":"api","scripts":{"check":"exit 0","test":"exit 3"}}\n' >"$R/apps/api/package.json"
  run
  has "a red package test is a FAIL" "$OUT" "FAIL apps/api npm run test"
  is "…and exits 1" "$RC" "1"
  printf '{"name":"api","scripts":{}}\n' >"$R/apps/api/package.json"
  run
  has "a package with neither script is unverified" "$OUT" "unverified apps/api — no check or test script"
else
  echo "SKIP: npm not installed — package.json cases"
fi

# Not a repo
OUT="$(cd "$TMP" && env -u CLAUDE_PROJECT_DIR bash "$SUT" 2>&1)"; RC=$?
is "outside a repo exits 2" "$RC" "2"

echo "verify.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
