#!/usr/bin/env bash
# Boundary rows for check-skill-format.sh: every rule it states, at 0 / 1 /
# empty / max / error, plus the two ways it is called (paths, and no args).
# Fixtures are throwaway skill folders under a temp dir; the script runs as a
# subprocess, never sourced.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-skill-format.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ROOT="$TMP/skills"
mkdir -p "$ROOT"

pass=0
fail=0

# expect <case> <want-rc> <needle-or-empty> <args...>
expect() {
  local name="$1" want="$2" needle="$3" out rc
  shift 3
  out="$(cd "$TMP" && bash "$SCRIPT" "$@" 2>&1)"
  rc=$?
  if [[ "$rc" != "$want" ]]; then
    fail=$((fail + 1))
    echo "FAIL: $name — expected rc=$want, got rc=$rc: $out" >&2
  elif [[ -n "$needle" && "$out" != *"$needle"* ]]; then
    fail=$((fail + 1))
    echo "FAIL: $name — output lacks '$needle': $out" >&2
  else
    pass=$((pass + 1))
  fi
}

# skill <folder> <frontmatter lines...> — writes $ROOT/<folder>/SKILL.md
skill() {
  local folder="$1"
  shift
  rm -rf "${ROOT:?}/$folder"
  mkdir -p "$ROOT/$folder"
  {
    echo '---'
    local l
    for l in "$@"; do printf '%s\n' "$l"; done
    echo '---'
    echo
    echo "# $folder"
  } >"$ROOT/$folder/SKILL.md"
}

repeat() { local i out=""; for ((i = 0; i < $2; i++)); do out="$out$1"; done; printf '%s' "$out"; }

NAME='name: alpha'
DESC='description: Does one thing. Use when that thing is asked for.'

# ── The minimal shape and every allowed key ──────────────────────────────
skill alpha "$NAME" "$DESC"
expect "minimal valid skill" 0 "" skills/alpha/SKILL.md
expect "a folder argument works like its SKILL.md" 0 "" skills/alpha
expect "a trailing slash on the folder" 0 "" skills/alpha/

skill alpha "$NAME" "$DESC" 'license: MIT' 'compatibility: Needs git and bash.' \
  'allowed-tools: Bash Read Edit' '# a comment line' 'metadata:' '  peers: "skills/alpha/scripts/x.sh .agents/rules/voice.md"'
expect "all six keys, a comment, peers as a quoted string" 0 "" skills/alpha

skill alpha "$NAME" 'description: >' '  Folded over' '  two lines.' 'metadata:' '  peers: >-' '    a.sh' '    b.sh'
expect "block scalars for description and peers" 0 "" skills/alpha

# ── Unknown and duplicate keys ───────────────────────────────────────────
for key in 'argument-hint: "[x]"' 'disable-model-invocation: false' 'enforces: []' 'peers: a.sh' 'when_to_use: x'; do
  skill alpha "$NAME" "$DESC" "$key"
  expect "retired key ${key%%:*}" 1 "unknown key ${key%%:*}" skills/alpha
done
skill alpha "$NAME" "$DESC" 'steps:' '  - id: one' '    kind: action'
expect "a steps: graph is an unknown key" 1 "unknown key steps" skills/alpha
skill alpha "$NAME" "$DESC" "$DESC"
expect "duplicate key" 1 "duplicate key description" skills/alpha

# ── name ─────────────────────────────────────────────────────────────────
skill alpha "$DESC"
expect "missing name" 1 "missing required key name" skills/alpha
skill alpha 'name: beta' "$DESC"
expect "name differs from folder" 1 "name 'beta' must equal the folder name 'alpha'" skills/alpha
skill Alpha 'name: Alpha' "$DESC"
expect "uppercase name" 1 "must be 1-64 characters" skills/Alpha
skill a--b 'name: a--b' "$DESC"
expect "doubled hyphen" 1 "must be 1-64 characters" skills/a--b
skill -ab 'name: -ab' "$DESC"
expect "leading hyphen" 1 "must be 1-64 characters" "$ROOT/-ab"
long64="$(repeat a 64)"
skill "$long64" "name: $long64" "$DESC"
expect "name of exactly 64" 0 "" "skills/$long64"
long65="$(repeat a 65)"
skill "$long65" "name: $long65" "$DESC"
expect "name of 65" 1 "must be 1-64 characters" "skills/$long65"
skill alpha 'name: "alpha"' "$DESC"
expect "a quoted name" 0 "" skills/alpha

# ── description ──────────────────────────────────────────────────────────
skill alpha "$NAME"
expect "missing description" 1 "missing required key description" skills/alpha
skill alpha "$NAME" 'description: ""'
expect "empty description" 1 "description is empty" skills/alpha
skill alpha "$NAME" "description: $(repeat x 1024)"
expect "description of exactly 1024" 0 "" skills/alpha
skill alpha "$NAME" "description: $(repeat x 1025)"
expect "description of 1025" 1 "description is 1025 characters" skills/alpha
skill alpha "$NAME" "description: $(repeat '—' 1024)"
expect "1024 multi-byte characters count as 1024" 0 "" skills/alpha
skill alpha "$NAME" 'description: >' "  $(repeat y 600)" "  $(repeat y 600)"
expect "a folded description is measured whole" 1 "description is 1201 characters" skills/alpha
skill alpha "$NAME" 'description: [a, b]'
expect "flow syntax in description" 1 "description uses flow syntax" skills/alpha

# ── quoting ──────────────────────────────────────────────────────────────
skill alpha "$NAME" 'description: "Does one thing.'
expect "an unclosed double quote" 1 "description has an unclosed quote" skills/alpha
skill alpha "name: 'alpha" "$DESC"
expect "an unclosed single quote on name" 1 "name has an unclosed quote" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata:' '  peers: "a.sh b.sh'
expect "an unclosed quote on metadata.peers" 1 "metadata.peers has an unclosed quote" skills/alpha
skill alpha "$NAME" 'description: "Does one thing,' '  over two lines."'
expect "a double-quoted description over two lines" 0 "" skills/alpha
skill alpha "$NAME" "description: '\"Quoted\" at the start, and fine.'"
expect "a single-quoted value that starts with a double quote" 0 "" skills/alpha

skill alpha "$NAME" 'description: "Ends on an escaped quote\"'
expect "an escaped closing double quote does not close it" 1 "description has an unclosed quote" skills/alpha
skill alpha "$NAME" 'description: "Ends on an escaped backslash\\"'
expect "an escaped backslash before the quote does close it" 0 "" skills/alpha
skill alpha "$NAME" 'description: "Does one thing." # a note'
expect "a comment after a closed quote" 0 "" skills/alpha
skill alpha "$NAME" 'description: "Does one thing." and more'
expect "text after a closed quote" 1 "description has text after its closing quote" skills/alpha
skill alpha "$NAME" "description: 'It''s one thing.'"
expect "a doubled single quote is an escape" 0 "" skills/alpha
skill alpha "$NAME" "description: 'It''"
expect "a doubled single quote does not close it" 1 "description has an unclosed quote" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata:' '  peers: "a.sh\"'
expect "an escaped closing quote on metadata.peers" 1 "metadata.peers has an unclosed quote" skills/alpha

# ── compatibility ────────────────────────────────────────────────────────
skill alpha "$NAME" "$DESC" "compatibility: $(repeat c 501)"
expect "compatibility of 501" 1 "compatibility is 501 characters" skills/alpha

# ── allowed-tools ────────────────────────────────────────────────────────
skill alpha "$NAME" "$DESC" 'allowed-tools:' '  - Bash' '  - Read'
expect "allowed-tools as a list" 1 "allowed-tools must be one space-separated string" skills/alpha
skill alpha "$NAME" "$DESC" 'allowed-tools: [Bash, Read]'
expect "allowed-tools in flow syntax" 1 "allowed-tools uses flow syntax" skills/alpha

# ── metadata ─────────────────────────────────────────────────────────────
skill alpha "$NAME" "$DESC" 'metadata:' '  author: someone'
expect "a metadata key other than peers" 1 "metadata.author is not allowed" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata:' '  peers:' '    - a.sh' '    - b.sh'
expect "peers as a list" 1 "metadata.peers must be a string" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata:' '  peers: ""'
expect "peers empty" 1 "metadata.peers is empty" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata: {peers: a.sh}'
expect "metadata in flow syntax" 1 "metadata uses flow syntax" skills/alpha
skill alpha "$NAME" "$DESC" 'metadata:' '  peers: a.sh' '  version: "1"'
expect "a second metadata key after peers" 1 "metadata.version is not allowed" skills/alpha

# ── frontmatter shape ────────────────────────────────────────────────────
mkdir -p "$ROOT/alpha"
printf '# alpha\n' >"$ROOT/alpha/SKILL.md"
expect "no frontmatter" 1 "missing frontmatter" skills/alpha
: >"$ROOT/alpha/SKILL.md"
expect "empty SKILL.md" 1 "missing frontmatter" skills/alpha
printf -- '---\nname: alpha\ndescription: x\n' >"$ROOT/alpha/SKILL.md"
expect "unclosed frontmatter" 1 "never closed" skills/alpha
printf -- '---\nname: alpha\njust words\n---\n' >"$ROOT/alpha/SKILL.md"
expect "a line that is not key: value" 1 "line 3 is not a key: value line" skills/alpha

# ── folders ──────────────────────────────────────────────────────────────
mkdir -p "$ROOT/empty"
expect "a skill folder with no SKILL.md" 1 "no SKILL.md" skills/empty
rmdir "$ROOT/empty"
skill alpha "$NAME" "$DESC"
mkdir -p "$ROOT/alpha/state"
touch "$ROOT/alpha/state/learned.json"
expect "state/ without _doc.md" 1 "state: no _doc.md" skills/alpha
echo "What this holds; scripts/learn.sh writes and reads it." >"$ROOT/alpha/state/_doc.md"
expect "state/ with _doc.md" 0 "" skills/alpha

expect "a folder that does not exist is a caller error" 2 "not a skill folder or SKILL.md: skills/nope" skills/nope
expect "a SKILL.md under a missing folder is a caller error" 2 "not a skill folder or SKILL.md" skills/nope/SKILL.md
expect "…even beside a real skill" 2 "skills/nope" skills/alpha skills/nope

# ── every violation is counted, across files ─────────────────────────────
skill beta 'name: gamma' "$DESC" 'enforces: []'
expect "two violations in one file, clean file beside it" 1 "2 skill-format violation(s)" skills/alpha skills/beta

# ── no arguments: every skill in both layouts of a git repo ──────────────
REPO="$TMP/repo"
mkdir -p "$REPO/templates/agents/skills/one" "$REPO/.agents/skills/two"
git -C "$REPO" init -q
printf -- '---\nname: one\ndescription: One.\n---\n' >"$REPO/templates/agents/skills/one/SKILL.md"
printf -- '---\nname: two\ndescription: Two.\nsteps: []\n---\n' >"$REPO/.agents/skills/two/SKILL.md"
out="$(cd "$REPO/templates" && bash "$SCRIPT" 2>&1)"
rc=$?
if [[ $rc == 1 && "$out" == *".agents/skills/two/SKILL.md: unknown key steps"* && "$out" != *"skills/one"* ]]; then
  pass=$((pass + 1))
else
  fail=$((fail + 1))
  echo "FAIL: no-args scan from a subdirectory — rc=$rc: $out" >&2
fi

echo "check-skill-format.test.sh: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
