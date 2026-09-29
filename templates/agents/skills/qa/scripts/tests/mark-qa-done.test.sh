#!/usr/bin/env bash
# mark-qa-done.test.sh — pin mark-qa-done.sh's two markers in a sandbox
# QA_DONE_DIR against fixture repos: the change-set marker is always written
# (even for a non-git directory), `--marker-path` prints the tree marker's path
# and writes nothing, `--tree` on a served web target refuses (3) until the
# interaction stamp for that tree exists, and cli/render targets need no stamp.
# The script is run as a subprocess, never sourced.
#
# peers: ../mark-qa-done.sh

# shellcheck disable=SC2015  # pass||fail assert idiom; ok() never fails
set -uo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT="$DIR/mark-qa-done.sh"
TMP="$(mktemp -d -t mark-qa-done-test-XXXXXX)" || exit 1
trap 'rm -rf "$TMP"' EXIT

pass=0; fail=0; rc=0; out=""
ok() { echo "ok: $1"; pass=$((pass + 1)); }
no() { echo "FAIL: $1 — $2" >&2; fail=$((fail + 1)); }
run() { rc=0; out="$("$@" 2>&1)" || rc=$?; }

export QA_DONE_DIR="$TMP/done"
TREE="0123456789abcdef0123456789abcdef01234567"

# fixture: a git repo that detect-app calls `static` (a dist/ dir, no package.json)
WEB="$TMP/webapp"; mkdir -p "$WEB/dist"
git -C "$WEB" init -q && git -C "$WEB" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# fixture: a cli target
CLI="$TMP/clitool"; mkdir -p "$CLI"
printf '{"scripts":{"qa:cmd":"node ."}}' > "$CLI/package.json"
# fixture: a render target
RENDER="$TMP/renderer"; mkdir -p "$RENDER"
printf '{"scripts":{"qa:render":"node render.js"}}' > "$RENDER/package.json"

# ── usage ──
run bash "$SCRIPT"
[[ "$rc" == 2 && "$out" == *"usage: mark-qa-done.sh"* ]] && ok "no repo → 2" || no "no repo" "rc=$rc $out"
run bash "$SCRIPT" "$TMP/nope"
[[ "$rc" == 2 ]] && ok "repo not a dir → 2" || no "not a dir" "rc=$rc $out"
run bash "$SCRIPT" --bogus "$WEB"
[[ "$rc" == 2 && "$out" == *"unknown flag: --bogus"* ]] && ok "unknown flag → 2" || no "unknown flag" "rc=$rc $out"
run bash "$SCRIPT" "$WEB" --tree
[[ "$rc" == 2 && "$out" == *"--tree needs a sha"* ]] && ok "--tree without sha → 2" || no "--tree bare" "rc=$rc $out"
run bash "$SCRIPT" --marker-path "$WEB"
[[ "$rc" == 2 && "$out" == *"--marker-path needs --tree"* ]] && ok "--marker-path without --tree → 2" || no "--marker-path bare" "rc=$rc $out"
run bash "$SCRIPT" --help
[[ "$rc" == 0 && "$out" == *"TWO MARKERS"* ]] && ok "--help → 0, prints the header" || no "--help" "rc=$rc"

# ── --marker-path: prints, writes nothing ──
run bash "$SCRIPT" --marker-path --tree "$TREE" "$WEB"
MARKER="$out"
[[ "$rc" == 0 && "$MARKER" == "$QA_DONE_DIR/webapp-"*"-$TREE" ]] && ok "--marker-path → <done>/<basename>-<hash>-<tree>" \
  || no "--marker-path" "rc=$rc $out"
[[ ! -e "$QA_DONE_DIR" ]] && ok "--marker-path writes nothing" || no "--marker-path wrote" "$(ls "$QA_DONE_DIR")"
SLUG="$(basename "${MARKER%-"$TREE"}")"
# same basename, different path → different slug
OTHER="$TMP/other/webapp"; mkdir -p "$OTHER"
run bash "$SCRIPT" --marker-path --tree "$TREE" "$OTHER"
[[ "$out" != "$MARKER" && "$out" == "$QA_DONE_DIR/webapp-"* ]] && ok "same basename elsewhere → distinct tree slug" \
  || no "slug collision" "$out"

# ── change-set marker only ──
run bash "$SCRIPT" "$WEB"
hash="$(git -C "$WEB" status --porcelain | cksum | cut -d' ' -f1)"
[[ "$rc" == 0 && -f "$QA_DONE_DIR/webapp-$hash" && "$out" == *"marked webapp QA'd for current change-set"* ]] \
  && ok "change-set marker written as <basename>-<cksum of git status>" || no "change-set marker" "rc=$rc $out $(ls "$QA_DONE_DIR")"
if ! find "$QA_DONE_DIR" -mindepth 1 -maxdepth 1 -printf '%f\n' | grep -qv "^webapp-$hash$"; then ok "no tree marker without --tree"; else no "extra marker" "$(find "$QA_DONE_DIR" -mindepth 1 -printf '%f ')"; fi

# a non-git directory: best-effort hash, still exits 0 and writes a marker.
# (Only the prefix is pinned: with pipefail the failed `git status | cksum`
# yields the empty-input cksum AND the `|| echo unknown` fallback, so the
# marker's suffix is not a value worth locking in.)
run bash "$SCRIPT" "$CLI"
[[ "$rc" == 0 && "$out" == *"marked clitool QA'd for current change-set"* && -n "$(find "$QA_DONE_DIR" -name 'clitool-*')" ]] \
  && ok "non-git repo → change-set marker still written, exit 0" \
  || no "non-git" "rc=$rc $out $(ls "$QA_DONE_DIR")"

# ── --tree on a served web target: refused until the interaction stamp exists ──
run bash "$SCRIPT" --tree "$TREE" "$WEB"
[[ "$rc" == 3 && "$out" == *"refusing — no clean interaction check for tree ${TREE:0:12}"* && "$out" == *"interaction-check.sh"* ]] \
  && ok "web target, no stamp → 3 with the step-3.7 hint" || no "no stamp" "rc=$rc $out"
[[ ! -e "$MARKER" ]] && ok "refusal writes no tree marker" || no "refusal wrote" "$MARKER"
# the stamp path is the one lib.sh's formula names: interaction-<slug>-<tree>
touch "$QA_DONE_DIR/interaction-$SLUG-$TREE"
run bash "$SCRIPT" --tree "$TREE" "$WEB"
[[ "$rc" == 0 && -f "$MARKER" && "$out" == *"marked $SLUG QA'd for tree ${TREE:0:12}"* ]] \
  && ok "web target with stamp → tree marker at the --marker-path path" || no "with stamp" "rc=$rc $out"
# a different tree is a different stamp: refused again
run bash "$SCRIPT" --tree "${TREE//0/f}" "$WEB"
[[ "$rc" == 3 ]] && ok "another tree without its own stamp → 3" || no "other tree" "rc=$rc $out"

# ── cli / render targets need no stamp ──
run bash "$SCRIPT" --tree "$TREE" "$CLI"
[[ "$rc" == 0 && -n "$(find "$QA_DONE_DIR" -mindepth 1 -maxdepth 1 -name "clitool-*-$TREE")" ]] && ok "cli target → tree marker without a stamp" \
  || no "cli" "rc=$rc $out $(ls "$QA_DONE_DIR")"
run bash "$SCRIPT" --tree "$TREE" "$RENDER"
[[ "$rc" == 0 && -n "$(find "$QA_DONE_DIR" -mindepth 1 -maxdepth 1 -name "renderer-*-$TREE")" ]] && ok "render target → tree marker without a stamp" \
  || no "render" "rc=$rc $out $(ls "$QA_DONE_DIR")"

# QA_DONE_DIR unset falls back to /tmp/qa-done — only the path is checked, nothing written
run env -u QA_DONE_DIR bash "$SCRIPT" --marker-path --tree "$TREE" "$WEB"
[[ "$rc" == 0 && "$out" == "/tmp/qa-done/$SLUG-$TREE" ]] && ok "default DONE_DIR is /tmp/qa-done" || no "default dir" "$out"

echo
echo "mark-qa-done.sh: ${pass} passed, ${fail} failed"
[[ $fail -eq 0 ]]
