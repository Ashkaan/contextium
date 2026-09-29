#!/usr/bin/env bash
# qa-targets.test.sh — the web-target enumerator, against hermetic temp repos.
#
# Each case builds a repo with real package.json files and lets the REAL
# detect-app.sh classify them — a stubbed detector would test this suite's idea
# of what web means rather than the one /qa actually uses. Only the crash cases
# swap in a stub, because a detector that fails on demand is the one thing the
# real one will not do.
#
# Run: bash .agents/skills/qa/scripts/tests/qa-targets.test.sh
#
# peers:
#   .agents/skills/qa/scripts/qa-targets.sh
#   .agents/skills/qa/scripts/detect-app.sh

set -uo pipefail
# `timeout` is GNU coreutils, absent on stock macOS. perl stands in, and like
# GNU timeout it runs the command in its own process group and kills the whole
# group at the deadline: a child left alive would hold the output pipe open.
tmo() {
  if command -v timeout >/dev/null 2>&1; then timeout "$@"; return; fi
  perl -e 'my $t = shift; my $p = fork; die "fork: $!" unless defined $p;
    if (!$p) { setpgrp(0, 0); exec @ARGV or exit 127 }
    $SIG{ALRM} = sub { kill "KILL", -$p; exit 124 }; alarm $t; waitpid($p, 0);
    exit($? & 127 ? 128 + ($? & 127) : $? >> 8)' "$@"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGETS="${SCRIPT_DIR}/../qa-targets.sh"

TMP="$(mktemp -d -t qa-targets-test-XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() {
  fail=$((fail + 1))
  echo "FAIL: $*" >&2
}
check_rc() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected rc=$expect, got rc=$got"; fi
}
check_eq() {
  local name="$1" expect="$2" got="$3"
  if [[ "$expect" == "$got" ]]; then ok; else bad "$name — expected '$expect', got '$got'"; fi
}
check_has() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then ok; else bad "$name — missing '$needle' in:"$'\n'"$hay"; fi
}
check_lacks() {
  local name="$1" needle="$2" hay="$3"
  if grep -qF -- "$needle" <<<"$hay"; then bad "$name — unexpected '$needle' in:"$'\n'"$hay"; else ok; fi
}

new_repo() {
  local dir="$TMP/$1"
  mkdir -p "$dir"
  git -C "$dir" init -q .
  git -C "$dir" config user.email t@t
  git -C "$dir" config user.name t
  printf '%s\n' "$dir"
}

# A directory detect-app.sh calls `astro` — a package.json naming astro is the
# whole signal, no config file needed.
make_astro() {
  mkdir -p "$1/src/pages"
  printf '{"name":"%s","private":true,"dependencies":{"astro":"^4.0.0"}}\n' "$(basename "$1")" >"$1/package.json"
  printf '<h1>hi</h1>\n' >"$1/src/pages/index.astro"
}

# A CLI: a `bin` and no web toolchain, which detect-app.sh exits 3 on.
make_cli() {
  mkdir -p "$1/src"
  printf '{"name":"%s","private":true,"bin":{"x":"./src/x.js"}}\n' "$(basename "$1")" >"$1/package.json"
  printf 'console.log(1)\n' >"$1/src/x.js"
}

echo "qa-targets.sh: the web-target enumerator"

# ── 0 targets ─────────────────────────────────────────────────────────

R0="$(new_repo zero)"
mkdir -p "$R0/apps/tools/toolchain/checks"
printf '#!/usr/bin/env bash\necho hi\n' >"$R0/apps/tools/toolchain/checks/thing.sh"
git -C "$R0" add apps
git -C "$R0" commit -qm init

rc=0
out="$(bash "$TARGETS" --repo "$R0" apps/tools/toolchain/checks/thing.sh 2>/dev/null)" || rc=$?
check_rc "a toolchain-only change exits 0" 0 "$rc"
check_eq "a toolchain-only change has no targets" "" "$out"

rc=0
out="$(bash "$TARGETS" --repo "$R0" 2>/dev/null)" || rc=$?
check_rc "a clean tree exits 0" 0 "$rc"
check_eq "a clean tree has no targets" "" "$out"

CLI="$R0/apps/media/cli-thing"
make_cli "$CLI"
rc=0
out="$(bash "$TARGETS" --repo "$R0" apps/media/cli-thing/src/x.js 2>/dev/null)" || rc=$?
check_rc "a CLI change exits 0" 0 "$rc"
check_eq "a CLI is not a target" "" "$out"

# ── 1 target, and the nesting that used to break the walk ─────────────

R1="$(new_repo one)"
make_astro "$R1/apps/web/portal"
git -C "$R1" add apps
git -C "$R1" commit -qm init

out="$(bash "$TARGETS" --repo "$R1" apps/web/portal/src/pages/index.astro 2>/dev/null)"
check_eq "a nested apps/<domain>/<app> resolves to the APP" "$R1/apps/web/portal" "$out"
check_eq "and not to the domain directory" "0" "$(grep -cx "$R1/apps/web" <<<"$out")"

# Two files in one app are one target, not two.
printf 'export const x = 1\n' >"$R1/apps/web/portal/src/util.ts"
out="$(bash "$TARGETS" --repo "$R1" apps/web/portal/src/pages/index.astro apps/web/portal/src/util.ts 2>/dev/null)"
check_eq "two files in one app are one target" "1" "$(grep -c . <<<"$out")"

# The worktree root itself can be the app — a standalone site repo has no
# apps/ layer at all.
RR="$(new_repo root-app)"
make_astro "$RR"
git -C "$RR" add package.json src
git -C "$RR" commit -qm init
out="$(bash "$TARGETS" --repo "$RR" src/pages/index.astro 2>/dev/null)"
check_eq "a web worktree root is itself a target" "$RR" "$out"

# ── 2 targets ─────────────────────────────────────────────────────────

R2="$(new_repo two)"
make_astro "$R2/apps/web/portal"
make_astro "$R2/apps/billing/dashboard"
make_cli "$R2/apps/media/cli-thing"
git -C "$R2" add apps
git -C "$R2" commit -qm init

out="$(bash "$TARGETS" --repo "$R2" \
  apps/web/portal/src/pages/index.astro \
  apps/billing/dashboard/src/pages/index.astro \
  apps/media/cli-thing/src/x.js 2>/dev/null)"
check_eq "two web apps are two targets" "2" "$(grep -c . <<<"$out")"
check_has "the first app is listed" "$R2/apps/web/portal" "$out"
check_has "the second app is listed" "$R2/apps/billing/dashboard" "$out"
check_lacks "the CLI beside them is not" "cli-thing" "$out"
check_eq "the list is sorted LC_ALL=C" "$(LC_ALL=C sort <<<"$out")" "$out"

# ── A shared package fans out to its consumers ────────────────────────
#
# The file itself lives in no app, so the walk-up finds nothing. Reporting "no
# UI changed" there is the failure this case exists for: both apps just changed
# what they render.

RS="$(new_repo shared)"
make_astro "$RS/apps/web/portal"
make_astro "$RS/apps/billing/dashboard"
mkdir -p "$RS/packages/ui"
printf 'export const Button = () => null\n' >"$RS/packages/ui/button.ts"
printf 'import { Button } from "../../../../packages/ui/button"\nexport const a = Button\n' \
  >"$RS/apps/web/portal/src/uses.ts"
printf 'import { Button } from "../../../../packages/ui/button"\nexport const b = Button\n' \
  >"$RS/apps/billing/dashboard/src/uses.ts"
git -C "$RS" add apps packages
git -C "$RS" commit -qm init

out="$(bash "$TARGETS" --repo "$RS" packages/ui/button.ts 2>/dev/null)"
check_eq "a shared package change reaches both consumers" "2" "$(grep -c . <<<"$out")"
check_has "consumer one" "$RS/apps/web/portal" "$out"
check_has "consumer two" "$RS/apps/billing/dashboard" "$out"
check_lacks "the package itself is not a target" "packages/ui" "$out"

# A shared file nobody imports pulls in nothing.
printf 'export const orphan = 1\n' >"$RS/packages/ui/orphan.ts"
out="$(bash "$TARGETS" --repo "$RS" packages/ui/orphan.ts 2>/dev/null)"
check_eq "an unimported shared file has no consumers" "" "$out"

# ── Deleted files, and the input plumbing ─────────────────────────────

# A DELETED page is a UI change. The walk-up only needs the path's directory
# chain, which survives the deletion — so the app is still a target. Asserting
# the opposite means a deletion-only UI change enumerates nothing and skips /qa
# entirely.
out="$(bash "$TARGETS" --repo "$R2" apps/web/portal/src/pages/gone.astro 2>/dev/null)"
check_eq "a DELETED page still targets its app" "$R2/apps/web/portal" "$out"

# A path whose whole app is gone has nothing to walk up to.
out="$(bash "$TARGETS" --repo "$R2" apps/vanished/app/src/pages/index.astro 2>/dev/null)"
check_eq "a path with no surviving app above it is no target" "" "$out"

printf 'apps/web/portal/src/pages/index.astro\n\napps/web/portal/src/pages/index.astro\n' >"$TMP/list"
out="$(bash "$TARGETS" --repo "$R2" --files-file "$TMP/list" 2>/dev/null)"
check_eq "--files-file dedupes" "1" "$(grep -c . <<<"$out")"

out="$(printf 'apps/billing/dashboard/src/pages/index.astro\n' | bash "$TARGETS" --repo "$R2" --files-file - 2>/dev/null)"
check_eq "--files-file - reads stdin" "$R2/apps/billing/dashboard" "$out"

# With no list at all, the changed set comes from the worktree itself.
printf 'export const fresh = 1\n' >"$R2/apps/web/portal/src/fresh.ts"
out="$(bash "$TARGETS" --repo "$R2" 2>/dev/null)"
check_has "an untracked edit is seen with no explicit list" "$R2/apps/web/portal" "$out"
rm -f "$R2/apps/web/portal/src/fresh.ts"

# ── --base: a UI change that is already COMMITTED ─────────────────────
#
# /implement-audit reviews BASE_SHA..HEAD *plus* uncommitted, so a session that
# committed its UI change has it in the review and nowhere in `git diff HEAD`.
# Without --base this enumerated nothing and answered "skipped-not-web" for a
# change that was all pixels.

RB="$(new_repo committed)"
make_astro "$RB/apps/web/portal"
mkdir -p "$RB/apps/tools/toolchain"
printf '#!/usr/bin/env bash\necho hi\n' >"$RB/apps/tools/toolchain/thing.sh"
git -C "$RB" add apps
git -C "$RB" commit -qm init
BASE_SHA="$(git -C "$RB" rev-parse HEAD)"

printf '<h1>changed</h1>\n' >"$RB/apps/web/portal/src/pages/index.astro"
git -C "$RB" add apps/web/portal
git -C "$RB" commit -qm "edit the page"

out="$(bash "$TARGETS" --repo "$RB" 2>/dev/null)"
check_eq "without --base a committed UI change is invisible" "" "$out"
out="$(bash "$TARGETS" --repo "$RB" --base "$BASE_SHA" 2>/dev/null)"
check_eq "with --base it is found" "$RB/apps/web/portal" "$out"

rc=0
errf="$TMP/badbase.err"
bash "$TARGETS" --repo "$RB" --base "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" >/dev/null 2>"$errf" || rc=$?
check_rc "an unresolvable --base is a HALT" 2 "$rc"
check_has "and says why" "would silently read as 'no UI changed'" "$(cat "$errf")"

# ── The fan-out is a WALK, not one hop ────────────────────────────────
#
# A shared component is usually not imported by the app directly — it goes
# through a barrel. A single-hop walk stops at that barrel, finds it is not web,
# and reports no target, so every barrel-exported shared change bypassed QA.

RH="$(new_repo hops)"
make_astro "$RH/apps/web/portal"
mkdir -p "$RH/packages/ui"
printf 'export const Button = () => null\n' >"$RH/packages/ui/button.ts"
printf 'export { Button } from "./button"\n' >"$RH/packages/ui/index.ts"
printf 'import { Button } from "../../../../packages/ui/index"\nexport const a = Button\n' \
  >"$RH/apps/web/portal/src/uses.ts"
git -C "$RH" add apps packages
git -C "$RH" commit -qm init

out="$(bash "$TARGETS" --repo "$RH" packages/ui/button.ts 2>/dev/null)"
check_eq "a change two hops from the app still reaches it" "$RH/apps/web/portal" "$out"

# A chain longer than any cap anyone would pick. The first version stopped at
# six hops and returned SUCCESS with importers still queued — a silent "no UI
# changed" for a change that had one. Termination comes from the visited set,
# not from a depth bound.
RD="$(new_repo deep)"
make_astro "$RD/apps/web/portal"
mkdir -p "$RD/packages/chain"
printf 'export const leaf = 1\n' >"$RD/packages/chain/hop00.ts"
for i in $(seq 1 9); do
  prev="$(printf 'hop%02d' $((i - 1)))"
  printf 'export { leaf } from "./%s"\n' "$prev" >"$RD/packages/chain/$(printf 'hop%02d' "$i").ts"
done
printf 'import { leaf } from "../../../../packages/chain/hop09"\nexport const deep = leaf\n' \
  >"$RD/apps/web/portal/src/deep.ts"
git -C "$RD" add apps packages
git -C "$RD" commit -qm init

out="$(tmo 120 bash "$TARGETS" --repo "$RD" packages/chain/hop00.ts 2>/dev/null)"
check_eq "a ten-hop chain still reaches the app" "$RD/apps/web/portal" "$out"

# A cycle must terminate rather than walk forever.
printf 'export { Button } from "./button"\nimport "./cycle"\n' >"$RH/packages/ui/index.ts"
printf 'import "./index"\nexport const cycle = 1\n' >"$RH/packages/ui/cycle.ts"
rc=0
out="$(tmo 60 bash "$TARGETS" --repo "$RH" packages/ui/button.ts 2>/dev/null)" || rc=$?
check_rc "a circular import graph terminates" 0 "$rc"
check_has "and still reaches the app" "$RH/apps/web/portal" "$out"

# ── Caller errors and the detector HALT ───────────────────────────────

rc=0
bash "$TARGETS" --repo "$TMP/nope" a.ts >/dev/null 2>&1 || rc=$?
check_rc "a missing --repo is a caller error" 2 "$rc"

rc=0
bash "$TARGETS" a.ts >/dev/null 2>&1 || rc=$?
check_rc "no --repo at all is a caller error" 2 "$rc"

rc=0
QA_DETECT_APP="$TMP/no-such-detector.sh" bash "$TARGETS" --repo "$R2" \
  apps/web/portal/src/pages/index.astro >/dev/null 2>&1 || rc=$?
check_rc "a missing detector is a HALT, not 'not web'" 2 "$rc"

# exit 2 is the detector FAILING. Reading that as "no UI here" is how a UI
# ships with no QA and a green run.
CRASH="$TMP/crashing-detector.sh"
printf '#!/usr/bin/env bash\necho "detector blew up" >&2\nexit 2\n' >"$CRASH"
chmod +x "$CRASH"
rc=0
errf="$TMP/crash.err"
QA_DETECT_APP="$CRASH" bash "$TARGETS" --repo "$R2" \
  apps/web/portal/src/pages/index.astro >/dev/null 2>"$errf" || rc=$?
check_rc "a detector exiting 2 is exit 2, not an empty list" 2 "$rc"
check_has "the halt says why" "Refusing to report 'no UI changed'" "$(cat "$errf")"

# exit 3 is the detector WORKING and saying "I cannot classify this". That is
# data, and it means not-web.
UNKNOWN="$TMP/unknown-detector.sh"
printf '#!/usr/bin/env bash\necho "TYPE=unknown"\nexit 3\n' >"$UNKNOWN"
chmod +x "$UNKNOWN"
rc=0
out="$(QA_DETECT_APP="$UNKNOWN" bash "$TARGETS" --repo "$R2" \
  apps/web/portal/src/pages/index.astro 2>/dev/null)" || rc=$?
check_rc "a detector exiting 3 is not a failure" 0 "$rc"
check_eq "a detector exiting 3 means not-web" "" "$out"

# Every web TYPE the detector can return is a target; cli/render/unknown are not.
for t in astro-cf astro next vite static node-server; do
  STUB="$TMP/type-$t.sh"
  printf '#!/usr/bin/env bash\necho "TYPE=%s"\nexit 0\n' "$t" >"$STUB"
  chmod +x "$STUB"
  out="$(QA_DETECT_APP="$STUB" bash "$TARGETS" --repo "$R2" \
    apps/web/portal/src/pages/index.astro 2>/dev/null)"
  check_eq "TYPE=$t is a web target" "$R2/apps/web/portal" "$out"
done
for t in cli render unknown; do
  STUB="$TMP/type-$t.sh"
  printf '#!/usr/bin/env bash\necho "TYPE=%s"\nexit 0\n' "$t" >"$STUB"
  chmod +x "$STUB"
  out="$(QA_DETECT_APP="$STUB" bash "$TARGETS" --repo "$R2" \
    apps/web/portal/src/pages/index.astro 2>/dev/null)"
  check_eq "TYPE=$t is not a web target" "" "$out"
done

echo "qa-targets: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
