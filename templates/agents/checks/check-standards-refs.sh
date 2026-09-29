#!/usr/bin/env bash
# check-standards-refs.sh — every citation of a standard names one that exists.
#
# The standards are the bold-led bullets of AGENTS.md (`- **<Name>.** …`, or
# `- **<Name>** …` where the bold runs into the sentence), Contextium's under
# § Standards and any a user adds in a section of their own. A file cites one
# as `AGENTS.md § Standards → <Name>`. A citation naming no bullet is invisible
# until someone follows it and finds nothing, so land.sh runs this before each
# commit and it names the file and line.
#
# WHAT IT CHECKS
#   - each `§ Standards → <Name>` in a tracked file names a bullet: the text
#     after the arrow begins with a bullet's name, compared without case, and
#     the name ends at a word boundary. `<name>` placeholders are not
#     citations.
#   - no `@rule:<id>` remains: that form cited the retired .agents/rules/ files.
#   - no two bullets share a name.
#   journal/ and projects/ are records of what was true then: a stale citation
#   there is counted and reported, never refused.
#
# WHERE AGENTS.md IS: .agents/AGENTS.md in a repo that installed the layer,
# templates/agents/AGENTS.md in the repo that authors it; both when both exist.
#
# Usage:
#   check-standards-refs.sh              tracked files, as in the working tree
#   check-standards-refs.sh --cached     the staged copies
#   check-standards-refs.sh [--cached] <path>...   only those paths
#
# Output: `OK — N citation(s) checked` on stdout, or one line per violation on
# stderr and `FAIL — …` on stdout.
# Exit: 0 clean · 1 a violation · 2 caller error
#
# bash 3.2 compatible (macOS): no mapfile, no declare -A, no grep -P.
set -euo pipefail

err() { echo "$@" >&2; }

cached=0
if [[ "${1:-}" == "--cached" ]]; then cached=1; shift; fi
case "${1:-}" in -*) err "check-standards-refs: unknown option $1"; exit 2 ;; esac

root="$(git rev-parse --show-toplevel 2>/dev/null)" || { err "check-standards-refs: not inside a git work tree"; exit 2; }
cd "$root"

# Both modes read the index (git grep searches tracked files; --cached reads
# the staged copies). One git cannot read must fail the check, not look like a
# repo with nothing in it.
if ! idx_err="$(git ls-files 2>&1 >/dev/null)"; then
  err "check-standards-refs: git cannot read the index: $idx_err"
  exit 2
fi

ARROW='→'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Read one AGENTS.md, staged or on disk. Args: $1=path
read_agents_md() {
  if [[ $cached -eq 1 ]]; then git show ":$1" 2>/dev/null; else cat "$1" 2>/dev/null; fi
}

: >"$TMP/names"
found=0
violations=0
for src in .agents/AGENTS.md templates/agents/AGENTS.md; do
  if [[ $cached -eq 1 ]]; then
    git cat-file -e ":$src" 2>/dev/null || continue
  else
    [[ -f "$src" ]] || continue
  fi
  found=1
  read_agents_md "$src" | awk '
    /^- \*\*[^*]+\*\*/ {
      name = substr($0, 5); name = substr(name, 1, index(name, "**") - 1)
      sub(/[.:]$/, "", name)
      print tolower(name)
    }
  ' >"$TMP/these"
  while IFS= read -r dup; do
    err "$src: two bullets named '$dup' — a citation could mean either"
    violations=$((violations + 1))
  done < <(sort "$TMP/these" | uniq -d)
  cat "$TMP/these" >>"$TMP/names"
done

if [[ $found -eq 0 ]]; then
  echo "OK — no AGENTS.md standards here, nothing to check"
  exit 0
fi

grep_args=(-n -I -F -e "Standards $ARROW " -e "@rule:")
[[ $cached -eq 1 ]] && grep_args=(--cached "${grep_args[@]}")
# git grep exits 1 for "no match", which is a clean answer; anything above 1 is
# a grep that did not happen.
grep_rc=0
git grep "${grep_args[@]}" -- "$@" >"$TMP/hits" 2>"$TMP/grep.err" || grep_rc=$?
if [[ $grep_rc -gt 1 ]]; then
  err "check-standards-refs: git grep failed: $(cat "$TMP/grep.err")"
  exit 2
fi

# One line per finding: `bad<TAB>file:line: message`, `hist<TAB>…` or `ok`.
awk -v sq="'" -v key="Standards $ARROW " -v names="$TMP/names" '
  BEGIN { while ((getline n < names) > 0) known[n] = 1 }
  function hist(f) { return f ~ /^(journal|projects)\// }
  function report(f, l, msg) { print (hist(f) ? "hist" : "bad") "\t" f ":" l ": " msg }
  # The text after the arrow names a standard when it begins with one, the
  # name ending at a word boundary: a name may hold commas and still be cited.
  function resolves(text,   t, n, nx) {
    t = tolower(text)
    for (n in known) {
      if (index(t, n) != 1) continue
      nx = substr(t, length(n) + 1, 1)
      if (nx == "" || nx !~ /[a-z0-9]/) return 1
    }
    return 0
  }
  {
    p1 = index($0, ":"); f = substr($0, 1, p1 - 1); rest = substr($0, p1 + 1)
    p2 = index(rest, ":"); l = substr(rest, 1, p2 - 1); line = substr(rest, p2 + 1)
    s = line
    while ((p = index(s, key)) > 0) {
      s = substr(s, p + length(key))
      if (s == "" || substr(s, 1, 1) == "<") continue
      if (resolves(s)) { print "ok"; continue }
      shown = s; if (match(shown, /[`)]/)) shown = substr(shown, 1, RSTART - 1)
      if (length(shown) > 60) shown = substr(shown, 1, 60) "…"
      sub(/[ .,;:]+$/, "", shown)
      report(f, l, "cites " sq shown sq ", which is no bullet in AGENTS.md § Standards")
    }
    s = line
    while (match(s, /@rule:[a-z][a-z0-9-]*/)) {
      report(f, l, substr(s, RSTART, RLENGTH) " is retired — cite AGENTS.md § Standards " "\342\206\222" " <name> instead")
      s = substr(s, RSTART + RLENGTH)
    }
  }
' "$TMP/hits" >"$TMP/found"

checked="$(grep -c '' "$TMP/found" || true)"
historical="$(grep -c '^hist' "$TMP/found" || true)"
while IFS=$'\t' read -r kind msg; do
  [[ "$kind" == "bad" ]] || continue
  err "$msg"
  violations=$((violations + 1))
done <"$TMP/found"

if [[ "$historical" -gt 0 ]]; then
  err "ℹ $historical stale citation(s) in journal/ and projects/ — records of what was true then, not refused"
fi
if [[ $violations -gt 0 ]]; then
  echo "FAIL — $checked citation(s) checked, $violations violation(s)"
  exit 1
fi
echo "OK — $checked citation(s) checked"
