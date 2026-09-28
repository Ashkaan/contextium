#!/usr/bin/env bash
# Rows for install.sh's upgrade handling: what a v6 install leaves behind is
# removed only when it is still ours, and decisions/README.md is seeded
# whenever it is missing and never overwritten. Each row installs into a fresh
# temp target laid out the way the row needs.
#
# The v6 SPEC template is read from this repo's v6.0.0 tag, so run it from a
# clone that has its tags.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
ok() { pass=$((pass + 1)); }
bad() { fail=$((fail + 1)); echo "FAIL: $1" >&2; }

V6_LEAN="$TMP/v6-spec-lean.md"
git -C "$HERE" show v6.0.0:templates/agents/templates/spec-lean.md >"$V6_LEAN" 2>/dev/null || {
  echo "FAIL: cannot read v6.0.0:templates/agents/templates/spec-lean.md — run from a clone with its tags" >&2
  exit 1
}

n=0
# v6target — a target with a v6 layer's leftovers. Sets T.
v6target() {
  n=$((n + 1))
  T="$TMP/t$n"
  mkdir -p "$T/.agents/templates" "$T/.claude"
  cp "$V6_LEAN" "$T/.agents/templates/spec-lean.md"
  ln -s ../.agents/templates "$T/.claude/templates"
}
install() { bash "$HERE/install.sh" "$T" --yes --no-integrations --no-hooks >"$TMP/out" 2>&1; }

# ── the v6 SPEC template ─────────────────────────────────────────────────
v6target
install || bad "install into a v6 target exited non-zero: $(tail -5 "$TMP/out")"
if [[ ! -e "$T/.agents/templates" ]]; then ok; else bad "an untouched v6 spec-lean.md is removed with its folder"; fi
if [[ ! -e "$T/.claude/templates" && ! -L "$T/.claude/templates" ]]; then ok; else bad "our .claude/templates link is removed"; fi

v6target
echo "My own section." >>"$T/.agents/templates/spec-lean.md"
install || bad "install over an edited spec-lean.md exited non-zero"
if [[ ! -e "$T/.agents/templates/spec-lean.md" ]]; then ok; else bad "an edited spec-lean.md is moved out of the way"; fi
if grep -q "My own section." "$T/.agents/templates/spec-lean.md.pre-v7" 2>/dev/null; then ok; else bad "the edited copy is kept as spec-lean.md.pre-v7"; fi
if grep -q "spec-lean.md.pre-v7" "$TMP/out"; then ok; else bad "the install says where the edited copy went"; fi

v6target
echo "An earlier rescue." >"$T/.agents/templates/spec-lean.md.pre-v7"
echo "A later edit." >>"$T/.agents/templates/spec-lean.md"
install || bad "install over a second edited spec-lean.md exited non-zero"
if [[ "$(cat "$T/.agents/templates/spec-lean.md.pre-v7")" == "An earlier rescue." ]]; then ok; else bad "an existing spec-lean.md.pre-v7 is never overwritten"; fi
if grep -q "A later edit." "$T/.agents/templates/spec-lean.md.pre-v7.2" 2>/dev/null; then ok; else bad "the second rescue takes the next free name, spec-lean.md.pre-v7.2"; fi
if grep -q "spec-lean.md.pre-v7.2" "$TMP/out"; then ok; else bad "the install names the file it actually wrote"; fi

v6target
rm "$T/.claude/templates"
ln -s ../my-templates "$T/.claude/templates"
install || bad "install with a user's own .claude/templates link exited non-zero"
if [[ "$(readlink "$T/.claude/templates")" == "../my-templates" ]]; then ok; else bad "a .claude/templates link that is not ours is left alone"; fi

# ── decisions/README.md ──────────────────────────────────────────────────
v6target
mkdir -p "$T/decisions"
printf -- '---\nstatus: proposed\ndate: 2026-01-10\ndecision-makers: Pat Doe\n---\n# x\n' >"$T/decisions/0001-x.md"
install || bad "install with a decisions/ lacking its README exited non-zero"
if grep -q "^# Decision records" "$T/decisions/README.md" 2>/dev/null; then ok; else bad "a missing decisions/README.md is seeded into an existing folder"; fi
if [[ -f "$T/decisions/0001-x.md" ]]; then ok; else bad "the user's record is untouched"; fi

echo "# Our own decision rules" >"$T/decisions/README.md"
install || bad "re-install exited non-zero"
if [[ "$(cat "$T/decisions/README.md")" == "# Our own decision rules" ]]; then ok; else bad "an existing decisions/README.md is never overwritten"; fi

echo "install.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
