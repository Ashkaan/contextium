#!/usr/bin/env bash
# staged-added-lines.sh — which lines the staged commit actually ADDED.
#
# Sourced by the line-level commit-time checks so each one blocks on the lines
# this commit wrote and stays quiet about the lines it inherited.
#
# WHY: a per-line check that scans the whole file blocks a commit over a line
# that commit never touched. An unattended automation has no human to clear
# that, so its approved work is dropped, and every old violation in the tree
# stands in front of every commit that touches its file.
#
# The checks each resolve a STAGED FILE LIST and then scan the whole file, which
# is the right shape for a document-structure check (journal frontmatter, rule
# format) and the wrong one for a per-line content check. This is the filter for
# the second kind.
#
# WHAT IT DOES NOT CHANGE
#   --all / explicit-file modes stay whole-file: a deliberate sweep wants every
#   violation in the tree, and only the commit gate cares whose line it is.
#
# Usage:
#   source "$(dirname "$0")/staged-added-lines.sh"
#   is_staged_added_line "$file" "$lineno" || continue
#
# FAILS OPEN. When the staged diff cannot be read at all — not a git repo, git
# itself errored — every line counts as added, so an unreadable diff loses the
# narrowing rather than the check.

# Sourced, so this sets options in the CALLER's shell — deliberate: every
# caller is expected to run under it already.
set -euo pipefail

# Line numbers (in the post-image, matching what the checks report) that the
# staged diff adds or changes for one file. Prints one per line, ascending.
# Returns 1 without printing when git could not produce a diff.
staged_added_lines() {
  local file="$1" diff
  diff="$(git diff --cached -U0 --diff-filter=ACMR -- "$file" 2>/dev/null)" || return 1
  printf '%s\n' "$diff" | awk '
    # @@ -12,3 +14,5 @@ — the + side is the post-image range this hunk writes.
    # A hunk with no comma is one line; a `+14,0` hunk is a pure deletion and
    # contributes nothing.
    /^@@/ {
      if (match($0, /\+[0-9]+(,[0-9]+)?/)) {
        spec = substr($0, RSTART + 1, RLENGTH - 1)
        n = split(spec, p, ",")
        start = p[1] + 0
        count = (n > 1) ? p[2] + 0 : 1
        for (i = 0; i < count; i++) print start + i
      }
    }
  ' | sort -n -u
}

# The CONTENT git is about to commit for one file, as a path a check can scan.
#
# WHY THIS EXISTS: the added-line numbers below come from the INDEX, and a check
# that greps the WORKING TREE is comparing them against a different document.
# With `git add -p`, or any edit made after staging, the two disagree — stage a
# violation at line 10, add five unstaged lines above it, and the working-tree
# match lands at line 15 while the staged set says 10. The filter then drops a
# violation this commit really is introducing. It is the one way this
# narrowing could make a gate quieter than it looks.
#
# SETS A GLOBAL rather than printing, and that is load-bearing: a `$(...)` form
# runs in a SUBSHELL, so the temp dir it created and the EXIT trap that cleans
# it both died with the subshell and every caller was handed a path that no
# longer existed. Every check then skipped every file and passed — the tests
# caught it, but a printing API cannot be made safe here.
#
#   staged_scan_path "$f"      # then read "$SAL_SCAN"
#
# SAL_SCAN falls back to the path as given when there is no index entry or git
# is unavailable, so a check keeps scanning something real rather than nothing.
# shellcheck disable=SC2034 # read by the sourcing check, not by this file
SAL_SCAN=""
_SAL_BLOB_DIR=""
_SAL_BLOB_FILE=""
_SAL_PREV_EXIT=""

_sal_cleanup() {
  [[ -n "$_SAL_BLOB_DIR" ]] && rm -rf "$_SAL_BLOB_DIR"
  # CHAINED, not replaced: a caller may already own an EXIT trap that removes
  # its own temp file, and clobbering it would leak that file instead.
  [[ -n "$_SAL_PREV_EXIT" ]] && eval "$_SAL_PREV_EXIT"
  return 0
}

_sal_install_cleanup() {
  local cur
  cur="$(trap -p EXIT)"
  if [[ -n "$cur" ]]; then
    cur="${cur#trap -- \'}"
    _SAL_PREV_EXIT="${cur%\' EXIT}"
  fi
  trap _sal_cleanup EXIT
}

staged_scan_path() {
  local file="$1" flat dest
  if [[ "$file" == "$_SAL_BLOB_FILE" ]]; then
    return 0
  fi
  _SAL_BLOB_FILE="$file"
  SAL_SCAN="$file"

  if [[ -z "$_SAL_BLOB_DIR" ]]; then
    # Outside the repo: a scratch file inside it would be a write the harness
    # may stop to approve, and would show up as untracked.
    _SAL_BLOB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/staged-blob-XXXXXX")" || {
      _SAL_BLOB_DIR=""
      return 0
    }
    _sal_install_cleanup
  fi

  flat="$(printf '%s' "$file" | tr '/' '_')"
  dest="$_SAL_BLOB_DIR/$flat"
  if git show ":$file" > "$dest" 2>/dev/null; then
    # shellcheck disable=SC2034 # read by the sourcing check, not by this file
    SAL_SCAN="$dest"
  fi
  return 0
}

# One file's set, memoised — the checks call this once per violation and a SPEC
# can carry dozens.
_SAL_FILE=""
_SAL_SET=""

# True when <file>:<lineno> is a line the staged commit added or changed, and
# true for every line when the diff could not be read (fail open).
is_staged_added_line() {
  local file="$1" lineno="$2" lines
  if [[ "$file" != "$_SAL_FILE" ]]; then
    _SAL_FILE="$file"
    # Space-delimited on BOTH ends, so the ` $lineno ` test below cannot miss the
    # last entry — an unterminated set silently dropped every real violation
    # while the check still exited 0, which is the one wrong answer that looks
    # exactly like a pass.
    if lines="$(staged_added_lines "$file")"; then
      _SAL_SET=" $(printf '%s' "$lines" | tr '\n' ' ') "
    else
      _SAL_SET="ALL"
    fi
  fi
  [[ "$_SAL_SET" == "ALL" ]] && return 0
  [[ "$_SAL_SET" == *" $lineno "* ]]
}
