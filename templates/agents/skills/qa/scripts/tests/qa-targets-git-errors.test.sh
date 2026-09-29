#!/usr/bin/env bash
# qa-targets-git-errors.test.sh — a git read that FAILS inside qa-targets.sh must
# halt (exit 2), never read as "no web app changed". Each git subcommand the
# script reads is failed in turn by a shim on PATH that exits 128 for that one
# subcommand and runs the real git for everything else.
#
# Run: bash .agents/skills/qa/scripts/tests/qa-targets-git-errors.test.sh
#
# peers:
#   .agents/skills/qa/scripts/qa-targets.sh

set -uo pipefail
TARGETS="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/qa-targets.sh"
pass=0; fail=0
t() { # t <label> <expected> <actual>
  if [[ "$2" == "$3" ]]; then pass=$((pass + 1)); else
    fail=$((fail + 1)); echo "FAIL: $1"; echo "  expected: [$2]"; echo "  actual  : [$3]"; fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/qa-targets-git.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
REAL_GIT="$(command -v git)"
mkdir -p "$TMP/shim"
cat >"$TMP/shim/git" <<SHIM
#!/usr/bin/env bash
if [[ -n "\${FAIL_GIT:-}" && "\$1" == "\$FAIL_GIT" ]]; then
  echo "fatal: simulated \$1 failure" >&2
  exit 128
fi
exec "$REAL_GIT" "\$@"
SHIM
chmod +x "$TMP/shim/git"

astro() { mkdir -p "$1/src/pages"; printf '{"name":"%s","private":true,"dependencies":{"astro":"^4.0.0"}}\n' "$(basename "$1")" >"$1/package.json"; printf '<h1>hi</h1>\n' >"$1/src/pages/index.astro"; }

# A shared package imported by one web app; the change is in the package, so
# only the import fan-out (git grep) can find the app.
R="$TMP/repo"; mkdir -p "$R"
git -C "$R" init -q . && git -C "$R" config user.email t@example.com && git -C "$R" config user.name t
astro "$R/apps/web/site"
mkdir -p "$R/packages/ui"
printf '{"name":"@acme/ui","private":true}\n' >"$R/packages/ui/package.json"
printf 'export const b = 1\n' >"$R/packages/ui/button.ts"
printf 'import { b } from "../../../../packages/ui/button"\n' >"$R/apps/web/site/src/uses.ts"
git -C "$R" add -A && git -C "$R" commit -qm base

run() { PATH="$TMP/shim:$PATH" FAIL_GIT="${1:-}" bash "$TARGETS" --repo "$R" "${@:2}" >"$TMP/out" 2>"$TMP/err"; echo $?; }

t "control: the fan-out finds the app" "0 $R/apps/web/site" "$(rc="$(run "" packages/ui/button.ts)"; echo "$rc $(cat "$TMP/out")")"
t "a failed git grep in the fan-out is exit 2" "2" "$(run grep packages/ui/button.ts)"
t "and prints no targets" "" "$(cat "$TMP/out")"
t "and says git failed" "1" "$(grep -c 'git grep failed' "$TMP/err")"

echo "change" >>"$R/apps/web/site/src/pages/index.astro"
t "control: an uncommitted edit is found" "0" "$(run "")"
t "a failed git diff is exit 2" "2" "$(run diff)"
t "a failed git ls-files is exit 2" "2" "$(run ls-files)"
# A git error from `rev-parse --verify HEAD` (exit 128) is not "no commit yet":
# reading it as unborn scans the staged set only and misses this unstaged edit.
t "a failed git rev-parse is exit 2, not an unborn repo" "2" "$(run rev-parse)"
t "and prints no targets" "" "$(cat "$TMP/out")"
git -C "$R" checkout -q -- .

# A repo with no commit yet: `git diff HEAD` cannot run, and must not be taken
# for a failure — the new files are all untracked and still counted.
U="$TMP/unborn"; mkdir -p "$U"; git -C "$U" init -q .
astro "$U/apps/web/site"
t "a repo with no commit still lists its untracked app" "0 $U/apps/web/site" \
  "$(PATH="$TMP/shim:$PATH" bash "$TARGETS" --repo "$U" >"$TMP/out" 2>"$TMP/err"; echo "$? $(cat "$TMP/out")")"
git -C "$U" add -A
t "and its staged app" "0 $U/apps/web/site" \
  "$(PATH="$TMP/shim:$PATH" bash "$TARGETS" --repo "$U" >"$TMP/out" 2>"$TMP/err"; echo "$? $(cat "$TMP/out")")"

# Unborn, with an unstaged edit on top of a staged file, and an untracked app:
# staged, unstaged and untracked are all read.
astro "$U/apps/web/other"
echo "edit" >>"$U/apps/web/site/src/pages/index.astro"
t "no commit: staged, unstaged and untracked apps are all listed" "0 $U/apps/web/other $U/apps/web/site" \
  "$(PATH="$TMP/shim:$PATH" bash "$TARGETS" --repo "$U" >"$TMP/out" 2>"$TMP/err"; echo "$? $(tr '\n' ' ' <"$TMP/out" | sed 's/ $//')")"
# An app edited only in the working tree and never staged: `git add -N`
# (intent to add) puts its paths in the index with no content, so the staged
# read and `ls-files --others` both skip them — only the unstaged read sees it.
astro "$U/apps/web/intent"
git -C "$U" add -N apps/web/intent
t "no commit: an app only in the working tree (never staged) is listed" "1" \
  "$(PATH="$TMP/shim:$PATH" bash "$TARGETS" --repo "$U" 2>/dev/null | grep -cxF "$U/apps/web/intent")"
t "no commit: a failed unstaged read is exit 2" "2" \
  "$(PATH="$TMP/shim:$PATH" FAIL_GIT=diff bash "$TARGETS" --repo "$U" >/dev/null 2>&1; echo $?)"

echo "qa-targets-git-errors.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
