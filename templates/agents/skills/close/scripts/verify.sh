#!/usr/bin/env bash
# verify.sh — run the checks for what this session changed, before anything is
# recorded. /close runs it first: a fix forced by a red check would otherwise
# post-date the journal entry describing the session.
#
# WHAT CHANGED. Commits since --base (when given), plus uncommitted and
# untracked files. The checks run over that set only:
#
#   skills     every *.test.sh under a changed skill folder
#              (.agents/skills/<name>/ or templates/agents/skills/<name>/) —
#              a skill's scripts are code, and their tests are how it is checked
#   decisions  .githooks/checks/check-decision-records.sh on every changed
#              decision record (any `decisions/NNNN-*.md`)
#   code       the `check` and `test` scripts of the nearest package.json above
#              each changed code file (not *.md, not under journal/, projects/,
#              knowledge/ or a skill folder), run from that package's folder
#
# Output, one line per unit:
#   ok <unit>
#   unverified <unit> — <why nothing could run>
#   FAIL <unit> <what> — rerun: <command>
#   nothing changed
# A FAIL's own output goes to stderr. `unverified` is a gap to report, not a
# failure: a package with no test script did not break this session.
#
# Usage: verify.sh [--base <commit>]
# Exit: 0 no FAIL · 1 any FAIL · 2 usage or not a repo
#
# peers:
#   .agents/skills/close/scripts/verify.test.sh
#   .agents/skills/close/SKILL.md

set -uo pipefail

err() { echo "verify: $*" >&2; }
BASE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --base)
      [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || { err "--base needs a commit"; exit 2; }
      BASE="$2"; shift 2 ;;
    *) err "usage: verify.sh [--base <commit>]"; exit 2 ;;
  esac
done

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$ROOT" && -e "$ROOT/.git" ]] || { err "not a git repo: ${ROOT:-(unset)}"; exit 2; }
cd "$ROOT" || exit 2

if [[ -n "$BASE" ]] && ! git rev-parse --verify -q "${BASE}^{commit}" >/dev/null; then
  err "--base is not a commit: $BASE"; exit 2
fi

changed="$(
  { [[ -n "$BASE" ]] && git diff --name-only "$BASE" HEAD
    git diff --name-only HEAD 2>/dev/null
    git ls-files --others --exclude-standard
  } | grep -v '^[[:space:]]*$' | LC_ALL=C sort -u
)"
if [[ -z "$changed" ]]; then echo "nothing changed"; exit 0; fi

failed=0
run_unit() { # run_unit <unit> <what> <dir> <command...>
  local unit="$1" what="$2" dir="$3"; shift 3
  local out
  if out="$(cd "$dir" && "$@" 2>&1)"; then return 0; fi
  echo "FAIL $unit $what — rerun: (cd $dir && $*)"
  { echo "--- $unit $what ---"; printf '%s\n' "$out"; } >&2
  failed=1
  return 1
}

# ── skills ─────────────────────────────────────────────────────────────
skill_dirs="$(printf '%s\n' "$changed" \
  | sed -nE 's#^((\.agents|templates/agents)/skills/[^/]+)/.*#\1#p' | LC_ALL=C sort -u)"
while IFS= read -r sd; do
  [[ -n "$sd" && -d "$sd" ]] || continue
  suites="$(find "$sd" -name '*.test.sh' -type f | LC_ALL=C sort)"
  if [[ -z "$suites" ]]; then echo "unverified $sd — no test suites"; continue; fi
  unit_ok=1
  while IFS= read -r suite; do
    run_unit "$sd" "$suite" "$ROOT" bash "$suite" || unit_ok=0
  done <<<"$suites"
  [[ "$unit_ok" -eq 1 ]] && echo "ok $sd"
done <<<"$skill_dirs"

# ── decision records ───────────────────────────────────────────────────
records=()
while IFS= read -r f; do
  [[ -n "$f" && -f "$f" ]] && records+=("$f")
done < <(printf '%s\n' "$changed" | grep -E '(^|/)decisions/[0-9]{4}-[^/]*\.md$' || true)
if [[ ${#records[@]} -gt 0 ]]; then
  checker=".githooks/checks/check-decision-records.sh"
  if [[ ! -f "$checker" ]]; then
    echo "unverified decisions — no $checker"
  elif run_unit decisions "${#records[@]} record(s)" "$ROOT" bash "$checker" "${records[@]}"; then
    echo "ok decisions (${#records[@]} record(s))"
  fi
fi

# ── code: the nearest package.json's check and test ────────────────────
pkgs="$(printf '%s\n' "$changed" | while IFS= read -r f; do
  case "$f" in
    *.md|journal/*|projects/*|knowledge/*|.agents/skills/*|templates/agents/skills/*) continue ;;
  esac
  d="$(dirname "$f")"
  while :; do
    if [[ -f "$d/package.json" ]]; then echo "$d"; break; fi
    if [[ "$d" == "." || "$d" == "/" ]]; then echo "-"; break; fi
    d="$(dirname "$d")"
  done
done | LC_ALL=C sort -u)"
while IFS= read -r p; do
  [[ -n "$p" ]] || continue
  if [[ "$p" == "-" ]]; then
    echo "unverified code — changed files under no package.json; run the spec's Validation Commands"
    continue
  fi
  unit="${p#./}"; [[ "$p" == "." ]] && unit="(root)"
  ran=0 unit_ok=1
  for script in check test; do
    grep -qE "\"$script\"[[:space:]]*:" "$p/package.json" || continue
    ran=1
    run_unit "$unit" "npm run $script" "$p" npm run "$script" --silent || unit_ok=0
  done
  if [[ "$ran" -eq 0 ]]; then echo "unverified $unit — no check or test script in package.json"
  elif [[ "$unit_ok" -eq 1 ]]; then echo "ok $unit"; fi
done <<<"$pkgs"

exit "$failed"
