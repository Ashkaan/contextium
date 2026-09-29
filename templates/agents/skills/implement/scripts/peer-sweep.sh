#!/usr/bin/env bash
# peer-sweep.sh — before changing a shared pattern, find every place that uses it.
#
# WHY BEFORE, NOT AFTER
#
# The expensive version of this mistake is fixing one call site, shipping, and
# leaving three siblings on the old behavior — two of which nobody notices until
# they misbehave in a way that looks unrelated. A reviewer catches some of those
# afterwards. Running the sweep BEFORE the edit turns "did I get them all?" into
# a list you work through.
#
# It prints the command it ran as well as the matches, so the sweep is evidence
# someone else can re-run and check, not a claim that one happened.
#
# USAGE
#   peer-sweep.sh --pattern <extended-regex> [--scope <pathspec>] [--exclude <pathspec>]
#
# OUTPUT (stdout)
#   # git grep -nE '<pattern>' -- <scope>
#   <file>:<line>:<content>
#   ...
#   MATCHES: N
#
# READ THE WHOLE OUTPUT. A sweep whose output you skimmed to the first few lines
# is a sweep that did not happen; the peer you missed is usually not near the top.
#
# EXIT: 0 on a valid search (including zero matches); 1 on a bad pattern, a scope
# matching no files, or not being in a git repo.

set -euo pipefail

err() { echo "$@" >&2; }

PATTERN=""
SCOPE=""
EXCLUDE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --pattern) PATTERN="${2:-}"; shift; [[ $# -gt 0 ]] && shift ;;
    --scope)   SCOPE="${2:-}";   shift; [[ $# -gt 0 ]] && shift ;;
    --exclude) EXCLUDE="${2:-}"; shift; [[ $# -gt 0 ]] && shift ;;
    -h|--help) sed -n '2,30p' "$0" >&2; exit 0 ;;
    *) err "unknown flag: $1"; exit 1 ;;
  esac
done

[[ -n "$PATTERN" ]] || { err "--pattern <extended-regex> required"; exit 1; }

REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$REPO_DIR" ]] || { err "not inside a git repo, and CLAUDE_PROJECT_DIR is unset"; exit 1; }
# `.git` is a DIRECTORY in a normal clone and a FILE (a gitdir pointer) in a
# linked worktree, so `-d` would reject every worktree — including one an
# implementation session may be running in.
[[ -e "$REPO_DIR/.git" ]] || { err "not a git repo: $REPO_DIR"; exit 1; }

cd "$REPO_DIR"

if [[ -n "$SCOPE" ]] && ! compgen -G "$SCOPE" >/dev/null 2>&1; then
  err "scope matches no files: $SCOPE"
  err "A scope that matches nothing produces an empty sweep that reads like a clean one."
  exit 1
fi

# --untracked so a file this session just created is swept too. Without it
# git grep sees only tracked files, and a brand-new peer reads as "no match".
cmd_display="git grep -nE --untracked '$PATTERN'"
pathspec=()
if [[ -n "$SCOPE" ]]; then
  pathspec+=("$SCOPE")
  cmd_display="$cmd_display -- $SCOPE"
fi
if [[ -n "$EXCLUDE" ]]; then
  pathspec+=(":^$EXCLUDE")
  cmd_display="$cmd_display :^$EXCLUDE"
fi

echo "# $cmd_display"

rc=0
if [[ ${#pathspec[@]} -gt 0 ]]; then
  out="$(git grep -nE --untracked "$PATTERN" -- ${pathspec[@]+"${pathspec[@]}"} 2>&1)" || rc=$?
else
  out="$(git grep -nE --untracked "$PATTERN" 2>&1)" || rc=$?
fi

# git grep exits 1 for "no matches" and 128+ for a malformed pattern. Only the
# second is an error; a zero-match sweep is a real answer.
if [[ $rc -ge 128 ]]; then
  err "invalid pattern: $PATTERN"
  err "$out"
  exit 1
fi

if [[ -n "$out" ]]; then
  printf '%s\n' "$out"
  match_count="$(grep -c . <<<"$out" || true)"
else
  match_count=0
fi

printf 'MATCHES: %d\n' "$match_count"
