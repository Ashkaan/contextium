#!/usr/bin/env bash
# check-skills.test.sh — the boundary rows of check-skills.sh: the validator
# relayed, the three local rules (metadata, a folder without SKILL.md, the
# state/ convention), the scan modes land.sh calls, and the two caller errors.
#
# Run: bash templates/agents/checks/check-skills.test.sh
#      VALIDATOR=<path to agentskills> bash … to run the rows against the
#      published validator instead of the built-in reading (the default here,
#      because it is what a machine without Python runs).
#
# Fixtures are throwaway skill trees under a temp dir; the scan-mode rows use
# a real `git init`-ed tree, because those modes read `git diff` and
# `git ls-files --others`. The script is run as a subprocess, never sourced.
# The rows assert the validator's own wording, so they hold for either one.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="${HERE}/check-skills.sh"
VALIDATOR="${VALIDATOR:-builtin}"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() { rm -rf "${TMP}"; }
trap cleanup EXIT

ok()  { PASS=$((PASS + 1)); echo "ok   $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL $1"; }

ROOT="${TMP}/skills"
mkdir -p "${ROOT}"

# make_skill <name> <frontmatter-body> [body-text] — writes $ROOT/<name>/SKILL.md
make_skill() {
  local name="$1" fm="$2" body="${3:-# ${1}}"
  mkdir -p "${ROOT}/${name}"
  { echo "---"; printf '%s\n' "${fm}"; echo "---"; printf '%s\n' "${body}"; } >"${ROOT}/${name}/SKILL.md"
}

# expect <ok|violation|caller-error> <case> <needle-or-empty> <args…>
# Runs the check with SKILLS_ROOT=$ROOT (override ROOT before calling),
# asserts the exit code (0 / 1 / 2) and, when a needle is given, that the
# combined output mentions it.
expect() {
  local want="$1" case_name="$2" needle="$3"; shift 3
  local out rc=0 got
  out="$(cd "${ROOT}" && SKILLS_ROOT="${ROOT}" SKILLS_REF_BIN="${VALIDATOR}" bash "${CHECK}" "$@" 2>&1)" || rc=$?
  case "${rc}" in
    0) got="ok" ;;
    1) got="violation" ;;
    2) got="caller-error" ;;
    *) got="exit ${rc}" ;;
  esac
  if [ "${got}" != "${want}" ]; then
    bad "${case_name}: expected ${want}, got ${got}: ${out}"
    return
  fi
  if [ -n "${needle}" ] && [[ "${out}" != *"${needle}"* ]]; then
    bad "${case_name}: output lacks \"${needle}\": ${out}"
    return
  fi
  ok "${case_name}"
}

MINIMAL='name: alpha
description: Does one thing, and is used when that thing is asked for.'

# 1. A minimal valid skill.
make_skill alpha "${MINIMAL}"
expect ok "minimal valid skill" "OK — 1 skill(s) checked" alpha

# 2. A retired key is relayed from the validator.
make_skill alpha "${MINIMAL}
argument-hint: \"[x]\""
expect violation "argument-hint is an unexpected field" "alpha/SKILL.md: Unexpected fields in frontmatter: argument-hint" alpha

# 3. name ≠ folder, relayed.
make_skill alpha "name: beta
description: Does one thing."
expect violation "name must equal the folder name" "alpha/SKILL.md:" alpha

# 3b. The validator's own rules, one row each, in its wording — what the
#     built-in reading must reproduce where the published validator is absent.
rows_skill() { rm -rf "${ROOT:?}/$1"; make_skill "$1" "$2"; expect "$3" "$4" "$5" "$1"; rm -rf "${ROOT:?}/$1"; }
rows_skill Alpha "name: Alpha
description: x" violation "an uppercase name" "must be lowercase"
rows_skill a--b "name: a--b
description: x" violation "a doubled hyphen" "consecutive hyphens"
rows_skill ab- "name: ab-
description: x" violation "a trailing hyphen" "cannot start or end with a hyphen"
rows_skill a_b "name: a_b
description: x" violation "an underscore" "contains invalid characters"
LONG="$(printf 'a%.0s' $(seq 1 65))"
rows_skill "${LONG}" "name: ${LONG}
description: x" violation "a 65-character name" "exceeds 64 character limit (65 chars)"
rows_skill alpha "name: alpha" violation "no description" "Missing required field in frontmatter: description"
rows_skill alpha "description: x" violation "no name" "Missing required field in frontmatter: name"
rows_skill alpha "name: alpha
description: \"\"" violation "an empty description" "Field 'description' must be a non-empty string"
rows_skill alpha "name: alpha
description: $(printf 'x%.0s' $(seq 1 1025))" violation "a 1025-character description" "Description exceeds 1024 character limit (1025 chars)"
rows_skill alpha "name: alpha
description: $(printf 'x%.0s' $(seq 1 1024))" ok "a 1024-character description" "OK — 1 skill(s) checked"
rows_skill alpha "name: alpha
description: x
compatibility: $(printf 'x%.0s' $(seq 1 501))" violation "a 501-character compatibility" "Compatibility exceeds 500 character limit (501 chars)"
rows_skill alpha "name: alpha
description: \"unclosed" violation "an unclosed quote" "Invalid YAML in frontmatter"
rows_skill alpha "name: alpha
description: x
metadata:
  peers: \"unclosed" violation "an unclosed quote in a metadata value" "Invalid YAML in frontmatter"
rows_skill alpha "name: alpha
description: x
metadata:
  peers: \"a b\" trailing" violation "text after a metadata value's closing quote" "Invalid YAML in frontmatter"
rows_skill alpha "name: alpha
description: x
allowed-tools:
  - Bash
  - Read" ok "allowed-tools as a block list" "OK — 1 skill(s) checked"
mkdir -p "${ROOT}/alpha"; printf '# no frontmatter\n' >"${ROOT}/alpha/SKILL.md"
expect violation "no frontmatter" "must start with YAML frontmatter" alpha
printf -- '---\nname: alpha\ndescription: x\n' >"${ROOT}/alpha/SKILL.md"
expect violation "frontmatter never closed" "not properly closed" alpha
rm -rf "${ROOT:?}/alpha"

# 4. metadata.peers as a string is fine.
make_skill alpha "${MINIMAL}
metadata:
  peers: \"a/b.sh c/d.md\""
expect ok "metadata.peers string" "OK — 1 skill(s) checked" alpha
# The published validator reads strictyaml, which rejects flow syntax
# outright — so an inline `{…}` map is a validator violation before the local
# rule ever sees it. The block form above is the only one a skill may use.
make_skill alpha "${MINIMAL}
metadata: {peers: \"a b\"}"
expect violation "metadata inline map is rejected by the validator" "flow mapping" alpha

# 5. A metadata key other than peers — inline and block forms alike.
make_skill alpha "${MINIMAL}
metadata: {version: \"1\"}"
expect violation "metadata.version inline" "metadata.version" alpha
make_skill alpha "${MINIMAL}
metadata:
  version: \"1\""
expect violation "metadata.version block" "metadata.version" alpha

# 6. peers as a YAML list.
make_skill alpha "${MINIMAL}
metadata:
  peers:
    - a/b.sh"
expect violation "metadata.peers list" "must be a string" alpha

# 7. peers as an empty string.
make_skill alpha "${MINIMAL}
metadata: {peers: \"\"}"
expect violation "metadata.peers empty" "metadata.peers" alpha

# 8. --all: a top-level folder without SKILL.md; .git, node_modules, .trash ignored.
make_skill alpha "${MINIMAL}"
mkdir -p "${ROOT}/stray/scripts" "${ROOT}/.git" "${ROOT}/node_modules/x" "${ROOT}/.trash/old"
: >"${ROOT}/stray/scripts/x.sh"
expect violation "--all flags a folder without SKILL.md" "stray: no SKILL.md" --all
rm -rf "${ROOT}/stray"
expect ok "--all ignores .git, node_modules and .trash" "OK — 1 skill(s) checked" --all
rm -rf "${ROOT}/.git" "${ROOT}/node_modules" "${ROOT}/.trash"

# 9. state/ without _doc.md.
make_skill alpha "${MINIMAL}"
mkdir -p "${ROOT}/alpha/state"
echo "x" >"${ROOT}/alpha/state/notes.md"
expect violation "state/ without _doc.md" "_doc.md" alpha

# 10. _doc.md present but SKILL.md links into state/.
echo "doc" >"${ROOT}/alpha/state/_doc.md"
make_skill alpha "${MINIMAL}" "# alpha

See [notes](state/notes.md)."
expect violation "SKILL.md linking into state/" "never loaded at activation" alpha

# 11. _doc.md present and no link → ok; the other spellings of a self link
#     are violations; another tree's state/ is not one.
make_skill alpha "${MINIMAL}"
expect ok "state/ with _doc.md and no link" "OK — 1 skill(s) checked" alpha
make_skill alpha "${MINIMAL}" "# alpha

read ./state/notes.md"
expect violation "./state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read ~/code/workbench/.agents/skills/alpha/state/notes.md"
expect violation "home-path skills/<name>/state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read alpha/state/notes.md"
expect violation "<name>/state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read ../alpha/state/notes.md"
expect violation "../<name>/state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read /home/someone/.t3/worktrees/workbench/t3code-0000/.agents/skills/alpha/state/notes.md"
expect violation "an absolute path into another checkout's skills/<name>/state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read ${ROOT}/alpha/state/notes.md"
expect violation "an absolute path that resolves into this skill's state/ is a self link" "never loaded at activation" alpha
make_skill alpha "${MINIMAL}" "# alpha

read ~/knowledge/alpha/state/notes.md and /tmp/knowledge/alpha/state/notes.md"
expect ok "a home-rooted or absolute path into ANOTHER tree's <name>/state/ is not a self link" "OK — 1 skill(s) checked" alpha
make_skill alpha "${MINIMAL}" "# alpha

read knowledge/state/notes.md, ~/.local/state/x and knowledge/alpha/state/notes.md"
expect ok "another tree's state/ is not a self link, even under a folder of the same name" "OK — 1 skill(s) checked" alpha
make_skill alpha "${MINIMAL}"
rm -rf "${ROOT}/alpha/state"

# 11b. A skill that keeps state: state/entity-map.json is
#      refused until _doc.md sits beside it, passes with it, and SKILL.md may
#      not name the file.
make_skill notes "${MINIMAL/alpha/notes}"
mkdir -p "${ROOT}/notes/state"
echo "{}" >"${ROOT}/notes/state/entity-map.json"
expect violation "notes/state/entity-map.json without _doc.md" "_doc.md" notes
echo "doc" >"${ROOT}/notes/state/_doc.md"
expect ok "notes/state/ with _doc.md" "OK — 1 skill(s) checked" notes
make_skill notes "${MINIMAL/alpha/notes}" "# notes

labels persist to \`state/entity-map.json\`."
expect violation "SKILL.md naming state/entity-map.json" "never loaded at activation" notes
rm -rf "${ROOT}/notes"

# 12. --all over 0 skills.
EMPTY="${TMP}/empty"
mkdir -p "${EMPTY}"
SAVED_ROOT="${ROOT}"
ROOT="${EMPTY}"
expect ok "--all over an empty root" "OK — 0 skill(s) checked" --all
ROOT="${SAVED_ROOT}"

# 13. The validator missing → exit 2 naming the install line.
out="$(cd "${ROOT}" && SKILLS_ROOT="${ROOT}" SKILLS_REF_BIN="${TMP}/no-such-validator" bash "${CHECK}" alpha 2>&1)"; rc=$?
if [ "${rc}" = 2 ] && [[ "${out}" == *"pip install skills-ref==0.1.1"* ]]; then
  ok "missing validator exits 2 with the install line"
else
  bad "missing validator: got exit ${rc}: ${out}"
fi

# 14. An unknown flag; and a scan asked of a root that is not a git tree.
expect caller-error "unknown flag" "" --bogus
NOGIT="${TMP}/nogit"
mkdir -p "${NOGIT}/alpha"
SAVED_ROOT="${ROOT}"
ROOT="${NOGIT}"
expect caller-error "no-args scan outside a git tree exits 2" "not inside a git work tree"
ROOT="${SAVED_ROOT}"

# 15. Scan modes, in a git repo.
REPO="${TMP}/repo"
mkdir -p "${REPO}"
git -C "${REPO}" init -q -b main
git -C "${REPO}" config user.email t@example.com
git -C "${REPO}" config user.name tester
ROOT="${REPO}"
make_skill alpha "${MINIMAL}"
make_skill gamma "name: gamma
description: Does another thing."
echo "# skills" >"${REPO}/AGENTS.md"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m seed

# nothing changed
expect ok "no args, nothing changed" "OK — 0 skill(s) checked"
# one SKILL.md edited
make_skill alpha "${MINIMAL}
argument-hint: \"[x]\""
expect violation "no args, one SKILL.md edited" "alpha/SKILL.md: Unexpected fields" 
out="$(cd "${REPO}" && SKILLS_ROOT="${REPO}" SKILLS_REF_BIN="${VALIDATOR}" bash "${CHECK}" 2>/dev/null)"
if [[ "${out}" == "FAIL — 1 skill(s) checked, 1 violation(s)" ]]; then ok "…and only that skill is counted"; else bad "…count line: ${out}"; fi
make_skill alpha "${MINIMAL}"
# an untracked new skill
make_skill delta "name: delta
description: New and untracked."
expect ok "an untracked new skill is checked" "OK — 1 skill(s) checked"
rm -rf "${REPO}/delta"
# a change only under alpha/state/
mkdir -p "${REPO}/alpha/state"
echo "x" >"${REPO}/alpha/state/notes.md"
expect violation "a change only under state/ selects the skill" "alpha/SKILL.md:" 
out="$(cd "${REPO}" && SKILLS_ROOT="${REPO}" SKILLS_REF_BIN="${VALIDATOR}" bash "${CHECK}" 2>&1 >/dev/null)"
if [[ "${out}" == *"_doc.md"* ]]; then ok "…and reports the missing _doc.md"; else bad "…state violation: ${out}"; fi
rm -rf "${REPO}/alpha/state"
# a new untracked folder holding only scripts/x.sh
mkdir -p "${REPO}/beta/scripts"
: >"${REPO}/beta/scripts/x.sh"
expect violation "a new folder without SKILL.md is checked" "beta: no SKILL.md"
rm -rf "${REPO}/beta"
# a root-level file change selects nothing
echo "# skills, edited" >"${REPO}/AGENTS.md"
expect ok "a root-level file change selects nothing" "OK — 0 skill(s) checked"
git -C "${REPO}" checkout -q -- AGENTS.md
# --since catches a change committed on the branch; no-args does not
git -C "${REPO}" checkout -q -b feature
make_skill gamma "name: gamma
description: Does another thing.
steps:
  - id: one"
git -C "${REPO}" add -A && git -C "${REPO}" commit -q -m "a bad skill, committed"
expect ok "no args misses a change already committed" "OK — 0 skill(s) checked"
expect violation "--since <ref> catches it" "gamma/SKILL.md: Unexpected fields in frontmatter: steps" --since main
# a deleted skill folder is skipped
git -C "${REPO}" rm -rq gamma && git -C "${REPO}" commit -q -m "gamma removed"
expect ok "a deleted skill folder is skipped" "OK — 0 skill(s) checked" --since main
# --since with a bad ref
expect caller-error "--since with an unknown ref" "" --since no-such-ref

echo
echo "check-skills.test.sh: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" -eq 0 ]
