#!/usr/bin/env bash
# Rows for the pre-commit hook: the checks it runs judge the STAGED content,
# which is what the commit records — not the working copy, which may differ.
# Each row stages one version of a file, leaves another in the working tree,
# and asserts whether `git commit` is refused. Runs in throwaway repos.
set -uo pipefail

HOOKS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

pass=0
fail=0
n=0

newrepo() {
  n=$((n + 1))
  REPO="$TMP/repo$n"
  mkdir -p "$REPO/.agents/rules" "$REPO/.agents/skills/alpha"
  git -C "$REPO" init -q
  git -C "$REPO" config user.email t@example.com
  git -C "$REPO" config user.name tester
  cp -R "$HOOKS" "$REPO/.githooks"
  rm -f "$REPO/.githooks/pre-commit.test.sh"
  git -C "$REPO" config core.hooksPath .githooks
  printf -- '---\npaths: null\n---\n\n# Voice\n\n## voice\nBe plain. [2026-01-01]\n' >"$REPO/.agents/rules/voice.md"
  # The hooks' own comments cite this rule; without it the rule-refs check refuses.
  printf -- '---\npaths: null\n---\n\n# M\n\n## mechanisms-not-prose\nWire it. [2026-01-01]\n' >"$REPO/.agents/rules/m.md"
  printf -- '---\nname: alpha\ndescription: Does one thing.\n---\n\n# alpha\n' >"$REPO/.agents/skills/alpha/SKILL.md"
  git -C "$REPO" add -A
  git -C "$REPO" commit -q -m "add the layer" || { echo "FAIL: baseline commit refused" >&2; exit 1; }
}

# commit_expect <case> <0|1> — commits what is staged; 0 = accepted, 1 = refused.
commit_expect() {
  local out rc got
  out="$(git -C "$REPO" commit -q -m "update the records" 2>&1)"
  rc=$?
  if [[ $rc -eq 0 ]]; then got=0; else got=1; fi
  if [[ "$got" == "$2" ]]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $1 — expected $([[ $2 == 0 ]] && echo accepted || echo refused), got rc=$rc: $out" >&2
  fi
  git -C "$REPO" reset -q --hard; git -C "$REPO" clean -qfd
}

GOOD_REC='---
status: proposed
date: 2026-01-10
decision-makers: Pat Doe
---

# Retry once'
BAD_REC="${GOOD_REC/proposed/decided}"

# ── decision records ─────────────────────────────────────────────────────
newrepo
mkdir -p "$REPO/decisions"
printf '%s\n' "$BAD_REC" >"$REPO/decisions/0001-retry-once.md"
git -C "$REPO" add -A
printf '%s\n' "$GOOD_REC" >"$REPO/decisions/0001-retry-once.md"
commit_expect "a bad staged record behind a fixed working copy" 1

mkdir -p "$REPO/decisions"
printf '%s\n' "$GOOD_REC" >"$REPO/decisions/0001-retry-once.md"
git -C "$REPO" add -A
printf '%s\n' "$BAD_REC" >"$REPO/decisions/0001-retry-once.md"
commit_expect "a good staged record behind a broken working copy" 0

mkdir -p "$REPO/decisions"
printf '%s\n' "$GOOD_REC" >"$REPO/decisions/0001-retry-once.md"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m "add a record"
printf '%s\n' "$GOOD_REC" >"$REPO/decisions/0001-other.md"
git -C "$REPO" add decisions/0001-other.md
commit_expect "a new record whose number a committed sibling already uses" 1

# ── skills ───────────────────────────────────────────────────────────────
newrepo
printf -- '---\nname: alpha\ndescription: Does one thing.\nsteps: []\n---\n' >"$REPO/.agents/skills/alpha/SKILL.md"
git -C "$REPO" add -A
printf -- '---\nname: alpha\ndescription: Does two things.\n---\n' >"$REPO/.agents/skills/alpha/SKILL.md"
commit_expect "a bad staged SKILL.md behind a fixed working copy" 1

newrepo
mkdir -p "$REPO/.agents/skills/alpha/state"
echo '{}' >"$REPO/.agents/skills/alpha/state/learned.json"
git -C "$REPO" add -A
echo "What it holds." >"$REPO/.agents/skills/alpha/state/_doc.md"
commit_expect "a staged state/ whose _doc.md exists only in the working tree" 1

# ── rules ────────────────────────────────────────────────────────────────
newrepo
printf -- '---\npaths: null\n---\n\n# Voice\n\n## voice\nBe plain.\n' >"$REPO/.agents/rules/voice.md"
git -C "$REPO" add -A
printf -- '---\npaths: null\n---\n\n# Voice\n\n## voice\nBe plainer. [2026-01-02]\n' >"$REPO/.agents/rules/voice.md"
commit_expect "a staged rule without its evidence date behind a fixed working copy" 1

echo "pre-commit.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
