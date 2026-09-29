#!/usr/bin/env bash
# run-automated-checks.sh — Step 1 of /implement-audit. Run the 5 deterministic
# checks against the diff between $BASE_SHA and HEAD; emit structured
# pass/fail lines the step-2 reviewer can consume verbatim.
#
# Owns the check block that would otherwise sit inline in
# .agents/skills/implement-audit/SKILL.md.
#
# peers: .agents/skills/implement-audit/scripts/run-automated-checks.test.sh,
#        .agents/skills/implement-audit/SKILL.md,
#        .agents/skills/implement/scripts/layer-1.sh (check 1),
#        .agents/checks/check-standards-refs.sh (check 3),
#        .agents/skills/review/find-peers.sh (check 4),
#        .agents/checks/check-secrets.sh (check 5)
#
# Usage:
#   run-automated-checks.sh --session-base <SHA> [--repo-dir <path>]
#
# Flags:
#   --session-base <SHA>  git rev-parsable start of the session's commits (REQUIRED)
#   --repo-dir <path>     absolute repo path (defaults to $CLAUDE_PROJECT_DIR,
#                         then falls back to `git rev-parse --show-toplevel`)
#
# Output (stdout, one TAP-ish line per check):
#   PASS: lint (3 files)
#   FAIL: shellcheck apps/foo/bar.sh:12 SC2086 quote to prevent globbing
#   PASS: standards-refs (0 dangling)
#   PASS: find-peers (0 left-behind)
#   PASS: secrets (clean)
#   SUMMARY: 4 PASS, 1 FAIL
#
# stderr: per-check verbose output on failure (capped at 10KB; overflow
# routed to /tmp/implement-audit-checks-<session>.log with a line-pointer).
#
# Exit:
#   0  all PASS or WARN
#   1  any FAIL

set -euo pipefail

err() { echo "$@" >&2; }

# ── Argument parsing ─────────────────────────────────────────────────
SESSION_BASE=""
# Fix B: CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall
# back to git when unset (some callers leave it unset). Applied at the
# default only; a later --repo-dir flag still overrides. Keep `|| true` inside
# the substitution so a failing rev-parse outside a repo doesn't trip `set -e`
# (exit 128) before the guard surfaces the documented exit code.
REPO_DIR="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-base)
      SESSION_BASE="$2"
      shift 2
      ;;
    --repo-dir)
      REPO_DIR="$2"
      shift 2
      ;;
    -h|--help)
      sed -n '2,30p' "$0" >&2
      exit 0
      ;;
    *)
      err "unknown flag: $1"
      exit 1
      ;;
  esac
done

[[ -n "$SESSION_BASE" ]] || { err "--session-base <SHA> required"; exit 1; }
[[ -n "$REPO_DIR" ]] || { err "--repo-dir or CLAUDE_PROJECT_DIR required (and not inside a git repo)"; exit 1; }
[[ -e "$REPO_DIR/.git" ]] || { err "not a git repo: $REPO_DIR"; exit 1; }  # -e accepts both dir (normal repo) and file (worktree pointer)

# ── Where the check programs live ──────────────────────────────────────────
#
# The workbench has no git hooks at all, so the check programs live in its
# tree: `find-peers.sh` with the review chain at .agents/skills/review/, the
# standards-citation and secrets checks land.sh runs at .agents/checks/. A repo
# without those folders (a product repo) gets the missing-tool WARN each check
# below already uses, never a FAIL for a missing file.
#
# Lint is the package's own: layer-1.sh, beside this skill, runs each touched
# package's lint and typecheck by convention, so a repo's rules stay its own.
CHECKS_DIR="$REPO_DIR/.agents/skills/review"
GATE_DIR="$REPO_DIR/.agents/checks"
LAYER1="${AUTOMATED_CHECKS_LAYER1:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../../implement/scripts/layer-1.sh}"

cd "$REPO_DIR"

git rev-parse --verify "${SESSION_BASE}^{commit}" >/dev/null 2>&1 \
  || { err "unparseable session-base: $SESSION_BASE"; exit 1; }

# ── Collect changed files (committed + staged + unstaged + UNTRACKED) ────
#
# The `ls-files --others` line is load-bearing. None of the three `git diff`
# forms sees a file that has never been added, so a session whose new work is
# entirely new FILES would get "PASS: lint (0 files)", "PASS: shellcheck
# (0 files)" — a green that had reviewed nothing. `.agents/skills/review/
# code-review.sh` builds its diff the same way, for the same reason.
#
# A read loop, not `mapfile`, which bash 3.2 (macOS) does not have.
# Each read checked: inside a process substitution a failed git listed
# nothing, and every check below then reported PASS over an empty change.
changed_list="$(mktemp)"
untracked_list="$(mktemp)"
if ! { git diff --name-only "$SESSION_BASE" HEAD \
       && git diff --name-only --cached \
       && git diff --name-only; } >"$changed_list" 2>/dev/null \
   || ! git ls-files --others --exclude-standard >"$untracked_list" 2>/dev/null; then
  rm -f "$changed_list" "$untracked_list"
  err "could not list the change since $SESSION_BASE — git failed; nothing was checked"
  exit 1
fi
changed_files=()
while IFS= read -r f; do
  changed_files+=("$f")
done < <(sort -u "$changed_list" "$untracked_list" | grep -v '^$' || true)
untracked=()
while IFS= read -r u; do [[ -n "$u" && -f "$u" ]] && untracked+=("$u"); done <"$untracked_list"
rm -f "$changed_list" "$untracked_list"

code_files=()
sh_files=()
present_files=()
for f in ${changed_files[@]+"${changed_files[@]}"}; do
  # A deleted file still selects its package for lint — deleting a file is
  # exactly when its package should be re-checked. Markdown selects none.
  case "$f" in *.md) ;; *) code_files+=("$f") ;; esac
  [[ -f "$f" ]] || continue
  present_files+=("$f")
  case "$f" in
    *.sh) sh_files+=("$f") ;;
  esac
done

# ── Output capture (cap stderr at 10KB; overflow → /tmp/implement-audit-checks-*.log) ──
SESSION_TAG="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-$$}}"
OVERFLOW_LOG="/tmp/implement-audit-checks-${SESSION_TAG}.log"
: > "$OVERFLOW_LOG"

PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

pass() {
  echo "PASS: $*"
  PASS_COUNT=$((PASS_COUNT + 1))
}
fail() {
  echo "FAIL: $*"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}
warn() {
  echo "WARN: $*"
  WARN_COUNT=$((WARN_COUNT + 1))
}

# ── Check 1: lint (and typecheck) of each touched package ────────────
#
# By convention, not by a config this script knows: layer-1.sh finds the
# package that owns each file and runs its own `lint` then `typecheck`/`check`
# script or make target. A package that declares none is a WARN line inside
# layer-1's output, never a FAIL — a lint run on defaults the repo never
# adopted fails valid code, and a check that cannot come back clean carries no
# information.
if [[ ${#code_files[@]} -eq 0 ]]; then
  pass "lint (0 files)"
elif [[ ! -f "$LAYER1" ]]; then
  warn "lint missing — no layer-1.sh at $LAYER1"
elif lint_out=$(printf '%s\n' ${code_files[@]+"${code_files[@]}"} \
    | CLAUDE_PROJECT_DIR="$REPO_DIR" bash "$LAYER1" 2>&1); then
  # A step layer-1 skipped (the package declares no lint or typecheck) is not a
  # step that passed: say which, and do not call the change linted.
  skipped=0
  while IFS= read -r line; do
    [[ "$line" == "WARN: layer-1 "* ]] || continue
    warn "${line#WARN: layer-1 }"
    skipped=$((skipped + 1))
  done <<<"$lint_out"
  if [[ "$skipped" -eq 0 ]]; then
    pass "lint (${#code_files[@]} files)"
  else
    pass "lint (${#code_files[@]} files, ${skipped} step(s) skipped — see the WARN lines)"
  fi
else
  fail "lint (${#code_files[@]} files) — see stderr"
  echo "$lint_out" | head -c 10240 >&2
  echo "$lint_out" > "$OVERFLOW_LOG"
fi

# ── Check 2: shellcheck on changed .sh ──────────────────────────────
if [[ ${#sh_files[@]} -eq 0 ]]; then
  pass "shellcheck (0 files)"
elif ! command -v shellcheck >/dev/null 2>&1; then
  warn "shellcheck missing — skip"
else
  if sc_out=$(shellcheck ${sh_files[@]+"${sh_files[@]}"} </dev/null 2>&1); then
    pass "shellcheck (${#sh_files[@]} files)"
  else
    fail "shellcheck (${#sh_files[@]} files) — see stderr"
    echo "$sc_out" | head -c 10240 >&2
    echo "$sc_out" >> "$OVERFLOW_LOG"
  fi
fi

# ── Check 3: standards citations in changed files ─────────────────────
# The same script land.sh runs before it commits, over only this change's files.
refs_script="$GATE_DIR/check-standards-refs.sh"
if [[ ${#present_files[@]} -eq 0 ]]; then
  pass "standards-refs (nothing-to-check)"
elif [[ ! -f "$refs_script" ]]; then
  warn "check-standards-refs.sh missing"
else
  # The checker reads files through git, and git ignores an untracked path even
  # when it is named, so a new file's citations were never seen. A throwaway
  # copy of the index marks the untracked files intent-to-add for this one run;
  # the real index is not touched.
  refs_idx="$(mktemp)"
  # Each step checked: an index that did not copy, or untracked files that did
  # not mark, would hide files from the checker and read as "0 dangling".
  refs_ready=1
  cp "$(git rev-parse --path-format=absolute --git-path index)" "$refs_idx" 2>/dev/null || refs_ready=0
  if [[ "$refs_ready" -eq 1 && ${#untracked[@]} -gt 0 ]]; then
    GIT_INDEX_FILE="$refs_idx" git add -N -- ${untracked[@]+"${untracked[@]}"} 2>/dev/null || refs_ready=0
  fi
  if [[ "$refs_ready" -eq 0 ]]; then
    rm -f "$refs_idx"
    fail "standards-refs — could not prepare the files for the checker (git failed)"
  elif refs_out=$(GIT_INDEX_FILE="$refs_idx" bash "$refs_script" ${present_files[@]+"${present_files[@]}"} </dev/null 2>&1); then
    rm -f "$refs_idx"
    pass "standards-refs (0 dangling)"
  else
    rm -f "$refs_idx"
    fail "standards-refs — see stderr"
    echo "$refs_out" | head -c 10240 >&2
    echo "$refs_out" >> "$OVERFLOW_LOG"
  fi
fi

# ── Check 4: find-peers.sh on changed files ──────────────────────────
peers_script="$CHECKS_DIR/find-peers.sh"
if [[ ${#changed_files[@]} -eq 0 ]]; then
  pass "find-peers (nothing-to-check)"
elif [[ ! -f "$peers_script" ]]; then
  warn "find-peers.sh missing"
else
  if peers_out=$(bash "$peers_script" ${changed_files[@]+"${changed_files[@]}"} </dev/null 2>&1); then
    # Default mode is warn-only: it exits 0 and names each left-behind peer on
    # a `PEER:` line. Swallowing those printed a clean sweep over a class fix
    # that was not finished.
    peers_left="$(printf '%s\n' "$peers_out" | grep -c 'PEER:' || true)"
    if [[ "$peers_left" -gt 0 ]]; then
      warn "find-peers (${peers_left} left-behind) — see below"
      printf '%s\n' "$peers_out" | grep 'PEER:'
      echo "$peers_out" >> "$OVERFLOW_LOG"
    else
      pass "find-peers (0 left-behind)"
    fi
  else
    fail "find-peers — see stderr"
    echo "$peers_out" | head -c 10240 >&2
    echo "$peers_out" >> "$OVERFLOW_LOG"
  fi
fi

# ── Check 5: secrets in the change ────────────────────────────────────
#
# The same scan land.sh runs before it commits, over the same span: everything
# this branch changed since the session base, committed or not, plus untracked
# files. It exists to give the same answer the close will, early — a check that
# disagrees with the gate it previews stops being read.
#
# A repo with no .agents/checks (a product repo) gets the missing-tool WARN the
# other checks use; a stock scan with some other ruleset would report what the
# close never refuses, which is the same uninformative FAIL in a different coat.
secrets_script="$GATE_DIR/check-secrets.sh"
if [[ ${#changed_files[@]} -eq 0 ]]; then
  pass "secrets (nothing-to-check)"
elif [[ ! -f "$secrets_script" ]]; then
  warn "check-secrets.sh missing — skip"
elif sec_out=$(bash "$secrets_script" --since "$SESSION_BASE" </dev/null 2>&1); then
  pass "secrets (clean)"
else
  fail "secrets — see stderr"
  echo "$sec_out" | head -c 10240 >&2
  echo "$sec_out" >> "$OVERFLOW_LOG"
fi

# ── Summary ──────────────────────────────────────────────────────────
printf 'SUMMARY: %d PASS, %d FAIL' "$PASS_COUNT" "$FAIL_COUNT"
[[ $WARN_COUNT -gt 0 ]] && printf ', %d WARN' "$WARN_COUNT"
printf '\n'

if [[ -s "$OVERFLOW_LOG" ]]; then
  err "full output captured at: $OVERFLOW_LOG"
fi

[[ $FAIL_COUNT -eq 0 ]]
