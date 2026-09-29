#!/usr/bin/env bash
# session-write-root.sh — SSOT for "where does THIS session write repo files?"
#
# The problem this ends: a skill's first action is often a scaffold script, and
# a scaffold script derived its own repo root from its own location. Every
# script under .agents/skills/ is READ FROM THE MAIN CHECKOUT — the harness's
# skills folder is a home link to the workbench's .agents/skills/ — so an
# import.meta.url- or BASH_SOURCE-relative root can only ever resolve to the
# main checkout, never to the session worktree. The scaffold wrote there, the
# session's next write was refused by the shared-checkout guard, and the whole
# scaffolded directory had to be moved by hand.
#
# The fix is not "detect the worktree" — at scaffold time there is usually no
# worktree yet, because nothing has tripped the edit guard. The fix is that a
# scaffold resolves its write root through the SAME creator the edit guard uses,
# so the worktree exists before the first byte is written and every later edit
# is already compliant.
#
# RECORDS AND CODE ARE ONE ANSWER. `knowledge/`, `journal/` and `projects/`
# live in this repo, so a script writing a record asks the same question as a
# script writing code and gets the same root: this thread's worktree of this
# repo, else the checkout the script itself lives in.
#
# Modes:
#   session-write-root.sh                 — print the write root, CREATING this
#                                           session's worktree if it has none
#   session-write-root.sh --no-create     — print the existing write root
#                                           (session worktree if one exists,
#                                           else the main checkout); never
#                                           creates
#   session-write-root.sh --slug          — print this session's worktree slug
#                                           (SSOT for the `session-<key>` rule;
#                                           a caller reads it instead of
#                                           rebuilding it)
#   session-write-root.sh --main          — print the MAIN checkout root
#
# Env:
#   CLAUDE_SESSION_ID    — session identity, preferred when a caller passes it.
#   CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID
#                        — the same identity under the names a harness exports
#                          into an ordinary shell call (harness.sh reads them).
#                          Read as a fallback; see the block below for why
#                          omitting them would defeat the entire script.
#                          With none set there is no session to isolate, so
#                          every mode degrades to the main checkout — which is
#                          what keeps a script runnable from its own test suite.
#   CLAUDE_PROJECT_DIR   — main checkout. Optional; derived from git when unset.
#   CONTEXT_WRITE_ROOT   — hard override, wins over everything that prints a
#                          write root. The test suites set it so a test cannot
#                          create a real worktree.
#   CLAUDE_WORKTREE_HOME — passed through to setup-worktree.sh, which owns the
#                          worktree LOCATION. Never re-derived here.
#
# peers:
#   .agents/skills/implement/scripts/session-write-root.test.sh
#   .agents/skills/implement/scripts/setup-worktree.sh   (owns creation + location)
#   .agents/skills/implement/scripts/session-key.sh      (owns id sanitization)
#   .agents/skills/close/scripts/write-root.sh           (this thread's worktree)
#   .agents/skills/close/scripts/harness.sh              (the harness's session id)
#
# Exit: 0 ok · 1 unusable context (not a git repo, creator failed)

set -euo pipefail

err() { echo "session-write-root: $*" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETUP_SCRIPT="${SETUP_WORKTREE_SCRIPT:-$SCRIPT_DIR/setup-worktree.sh}"
SESSION_KEY_SCRIPT="${SESSION_KEY_SCRIPT:-$SCRIPT_DIR/session-key.sh}"
HARNESS_LIB="$SCRIPT_DIR/../../close/scripts/harness.sh"
if [[ -f "$HARNESS_LIB" ]]; then
  # shellcheck disable=SC1090,SC1091  # a sibling skill's file, resolved at run time
  source "$HARNESS_LIB"
else
  # A copy outside the skills tree (a test fixture): the ids harness.sh reads.
  harness_session_id() { printf '%s' "${CONTEXTIUM_SESSION:-${CLAUDE_CODE_SESSION_ID:-}}"; }
fi

# Is there a thread at all? T3 Code's, or any harness session thread.sh can
# name. The answer decides whether a resolver failure is fatal (inside a thread
# there is no acceptable second answer) or expected (a copy of this script
# outside every repo, a test suite — neither has a close to land anything, so
# the shared checkout is right).
THREAD_HELPER="${THREAD_SCRIPT:-$SCRIPT_DIR/../../close/scripts/thread.sh}"
in_t3_thread() {
  [[ -f "$THREAD_HELPER" ]] || return 1
  bash "$THREAD_HELPER" --id >/dev/null 2>&1
}

# The worktree this thread ALREADY has for a shared checkout, read straight out
# of the ledger. Creates nothing — which is the whole point: `--no-create` is
# documented side-effect-free and `sessionWriteRoot({create:false})` relies on
# it, so that mode may look the answer up but must never bring it into being.
ledger_lookup() {
  local repo="$1" tid ledger hit t3 common
  tid=$(bash "$THREAD_HELPER" --id 2>/dev/null) || return 1

  ledger="$HOME/.cache/workbench/threads/$tid/worktrees"
  if [[ -f "$ledger" ]]; then
    hit=$(awk -F'\t' -v s="$repo" '$2 == s { print $1; exit }' "$ledger")
    # A LEDGER LINE OUTLIVES ITS WORKTREE. `land.sh` removes each satellite
    # once its merge SHA is persisted and deliberately keeps the line as the
    # record of that, so a hit is an answer only while it is still on disk —
    # otherwise this hands back a path that was deleted at the last close.
    if [[ -n "$hit" && -d "$hit" ]]; then
      printf '%s' "$hit"
      return 0
    fi
  fi

  # NO LEDGER YET IS NOT NO ANSWER. Nothing has needed the resolver in this
  # thread, so no line exists — but the thread's own worktree is still where this
  # session's changes are, and asking for it creates nothing. Without this a
  # reader falls through to the shared checkout and inspects a tree that has
  # none of the session's work in it.
  t3=$(bash "$THREAD_HELPER" --worktree 2>/dev/null) || return 1
  [[ -n "$t3" && -d "$t3" ]] || return 1
  # …but only when it is a worktree OF THE REPO BEING ASKED ABOUT. A caller
  # that pointed CLAUDE_PROJECT_DIR at some other repo must not be told this one.
  common=$(git -C "$t3" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  [[ -d "$common" ]] || return 1
  [[ "$(cd "$common/.." && pwd -P)" == "$repo" ]] || return 1
  printf '%s' "$t3"
}

mode="root"
case "${1:-}" in
  --no-create) mode="no-create" ;;
  --slug)      mode="slug" ;;
  --main)      mode="main" ;;
  "")          mode="root" ;;
  *)
    err "usage: session-write-root.sh [--no-create | --slug | --main]"
    exit 1
    ;;
esac

# Hard override wins over every other branch below, so a test never reaches the
# real creator. Not applied to --slug: the slug is an identity, not a path, and
# a caller needs the real one; nor to --main, which names the shared checkout
# rather than a write root.
#
# IT SITS ABOVE EVERY RESOLVING BRANCH, and that placement is the whole point:
# a mode that answered out of its own branch below this check would hand a test
# the REAL worktree no matter what the test set, and the test's fixtures would
# land in the real records. That includes the main-checkout resolution just
# below, which refuses outright from a copy of this script outside every repo.
# The docblock above claims this wins over everything; keep it literally true
# for any mode that prints a write root.
if [[ -n "${CONTEXT_WRITE_ROOT:-}" && "$mode" != "slug" && "$mode" != "main" ]]; then
  printf '%s\n' "$CONTEXT_WRITE_ROOT"
  exit 0
fi

# ── Main checkout ─────────────────────────────────────────────────────────
# `--git-common-dir` is the load-bearing choice over `--show-toplevel`. Inside a
# worktree, toplevel is the WORKTREE; the common dir is always the main
# checkout's .git, so its parent is the main checkout from anywhere. Without
# this, invoking a script from inside a worktree would report that worktree as
# "main" and the marker search below would look in the wrong place.
# Order is CLAUDE_PROJECT_DIR, then THIS SCRIPT'S OWN REPO, then the CALLER'S
# CWD. The script's repo comes before the cwd because every caller of this file
# writes into the repo this file lives in — a record under `knowledge/` or
# `projects/`, a skill scaffold, a roadmap flip — and the cwd is only ever a
# different repo when a skill is run from a product checkout, where "the repo
# you are standing in" is the wrong answer for all of them: the records would
# go into the product repo. The cwd rung stays for a copy of this file that
# sits in no repo, which is what a test fixture is.
# Same `--git-common-dir` reasoning on every rung: this file lives under
# `.agents/skills/` in a worktree or the main checkout and either way the common
# dir's parent is the main checkout.
resolve_main() {
  if [[ -n "${CLAUDE_PROJECT_DIR:-}" ]]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"
    return 0
  fi
  local common
  for common in \
    "$(git -C "$SCRIPT_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)" \
    "$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"; do
    if [[ -n "$common" && -d "$common" ]]; then
      printf '%s' "$(cd "$common/.." && pwd)"
      return 0
    fi
  done
  return 1
}

MAIN_ROOT=$(resolve_main) || {
  err "not inside a git repo and CLAUDE_PROJECT_DIR unset"
  exit 1
}
MAIN_ROOT=$(cd "$MAIN_ROOT" 2>/dev/null && pwd) || {
  err "repo root does not exist: $MAIN_ROOT"
  exit 1
}

if [[ "$mode" == "main" ]]; then
  printf '%s\n' "$MAIN_ROOT"
  exit 0
fi

# ── One worktree per repo per thread ──────────────────────────────────────
#
# Below this point is the per-session mechanism: `setup-worktree.sh` makes a
# worktree keyed on the session id. Beside the ledger's, that is a SECOND
# isolation mechanism, and a worktree only the second one knows about is one
# `land.sh` never commits — the close would report success over code still
# sitting in it.
#
# So inside a thread, the answer comes from the same resolver everything else
# uses (write-root.sh, which records it in the ledger): a worktree the thread
# already has is the answer in every mode, and the default mode makes one —
# but only for a session that is really there: one whose harness exports an id
# (harness.sh), or one standing in a worktree its harness gave it (T3 Code,
# `claude -w`). thread.sh also NAMES an id-less session, generating an id so
# the close can land it, and a read (detect-stage.sh, find-project.sh) must not
# make that session a worktree; with no id there is no session to isolate, and
# this falls through to the main checkout below, as it always has.
#
# `CLAUDE_PROJECT_DIR` unset is the production tell, and the same one the gate
# further down already relies on: an ordinary shell call has none, while every
# suite below points it at a `mktemp` fixture. Delegating for a fixture would
# ask the resolver to build a worktree of a throwaway directory.
session_is_present() {
  [[ -n "$(harness_session_id)" ]] && return 0
  bash "$THREAD_HELPER" --worktree >/dev/null 2>&1
}
if [[ "$mode" != "slug" && -z "${CLAUDE_PROJECT_DIR:-}" ]] && in_t3_thread; then
  # Answer from the ledger if this thread already has a worktree for this
  # repo. Creates nothing.
  if _root=$(ledger_lookup "$MAIN_ROOT") && [[ -n "$_root" ]]; then
    printf '%s\n' "$_root"
    exit 0
  fi
  if [[ "$mode" == "root" ]] && session_is_present; then
    WRITE_ROOT_HELPER="${WRITE_ROOT_SCRIPT:-$SCRIPT_DIR/../../close/scripts/write-root.sh}"
    if [[ -f "$WRITE_ROOT_HELPER" ]]; then
      if ! _root=$(bash "$WRITE_ROOT_HELPER" "$MAIN_ROOT"); then
        err "in a thread but could not resolve a worktree for $MAIN_ROOT (above)"
        err "refusing to fall back to the shared checkout — nothing would land it"
        exit 1
      fi
      printf '%s\n' "$_root"
      exit 0
    fi
  fi
fi

# ── Does session isolation even apply to this root? ───────────────────────
# Only when the caller's target root IS the repo this script lives in. A caller
# that points CLAUDE_PROJECT_DIR at some OTHER directory means it, and the
# session's worktree is not in that tree — every existing test suite for the
# migrated scripts does exactly this, pointing at a `mktemp -d` fixture that is
# often not a git repo at all. Overriding those is both wrong and loud: the
# fixture has no worktree to find, so creation is attempted in a non-repo and
# the caller dies with a resolver error instead of writing its file.
#
# In a real session this branch does NOT trigger: an ordinary shell call has
# no CLAUDE_PROJECT_DIR at all, so MAIN_ROOT is derived from this script's own
# git dir and matches by construction. A harness that passes the real main
# checkout also matches.
#
# HOW A REAL CHECKOUT IS TOLD FROM A FIXTURE. Not by FILE IDENTITY (is the copy
# of this script under that root this very file?): the skills a harness reads
# are a home link, so no repo is guaranteed to hold a copy at a known path, and
# that test would answer "not my repo" for the real checkouts as well — sending
# every /implement session's writes into main, the exact bug this script exists
# to end.
#
# It asks instead whether MAIN_ROOT is a real checkout: a git work tree
# with at least one configured REMOTE. A fixture built with `mktemp -d` +
# `git init` has none, and the suites that need isolation anyway set
# CONTEXT_WRITE_ROOT, which returns above this block. It is a weaker signal than
# file identity and it is named as such: a fixture that adds a remote reads as
# real here, so a suite that does that must set the override.
SCRIPT_REPO=""
if git -C "$MAIN_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 \
   && [[ -n "$(git -C "$MAIN_ROOT" remote 2>/dev/null)" ]]; then
  SCRIPT_REPO="$MAIN_ROOT"
fi

# `--slug` is exempt: it answers "who is this session?", which has no dependency
# on which root the caller targets.
if [[ "$mode" != "slug" ]] && [[ -z "$SCRIPT_REPO" || "$MAIN_ROOT" != "$SCRIPT_REPO" ]]; then
  printf '%s\n' "$MAIN_ROOT"
  exit 0
fi

# ── Session key ───────────────────────────────────────────────────────────
# No session id means no session to isolate: a plain-terminal run or a test.
# Degrade to the main checkout rather than inventing an identity — a fabricated
# key would create a worktree nobody ever merges.
#
# SEVERAL env vars, and reading only the first one silently breaks the whole
# fix. CLAUDE_SESSION_ID is what setup-worktree.sh's callers pass explicitly —
# but it is NOT in the environment of an ordinary shell call. There a harness
# exports its own name for the id instead (harness.sh knows them). Since a
# scaffold script IS invoked by an ordinary shell call, reading only
# CLAUDE_SESSION_ID would degrade every scaffold to the main checkout — the
# precise bug this script exists to end, reintroduced silently.
RAW_SESSION="${CLAUDE_SESSION_ID:-$(harness_session_id)}"
SESSION_KEY=""
if [[ -n "$RAW_SESSION" && -x "$SESSION_KEY_SCRIPT" ]]; then
  SESSION_KEY=$("$SESSION_KEY_SCRIPT" "$RAW_SESSION" 2>/dev/null || true)
fi

if [[ -z "$SESSION_KEY" ]]; then
  if [[ "$mode" == "slug" ]]; then
    err "no usable session id (CLAUDE_SESSION_ID, CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID); no slug exists"
    exit 1
  fi
  printf '%s\n' "$MAIN_ROOT"
  exit 0
fi

# The `session-<key>` rule lives HERE and nowhere else.
SLUG="session-$SESSION_KEY"

if [[ "$mode" == "slug" ]]; then
  printf '%s\n' "$SLUG"
  exit 0
fi

# ── Already inside a worktree? ────────────────────────────────────────────
# A script invoked with cwd inside a worktree writes there, whoever owns it.
# Checked before the marker search because it needs no marker to be right, and
# it keeps a script that /implement invokes from its own worktree working even
# if the marker was removed.
# The worktree list is read ONCE and checked: read through `|| true`, a git
# that failed listed nothing, and a session with a worktree was answered the
# main checkout — its writes then went where no close lands them.
if ! WT_LIST="$(git -C "$MAIN_ROOT" worktree list --porcelain 2>&1)"; then
  err "could not list the worktrees of $MAIN_ROOT: ${WT_LIST##*$'\n'}"
  exit 1
fi
CWD_NOW=$(pwd -P)
while IFS= read -r line; do
  [[ "$line" == worktree\ * ]] || continue
  wt="${line#worktree }"
  [[ "$wt" == "$MAIN_ROOT" ]] && continue
  if [[ "$CWD_NOW" == "$wt" || "$CWD_NOW" == "$wt/"* ]]; then
    printf '%s\n' "$wt"
    exit 0
  fi
done <<<"$WT_LIST"

# ── This session's existing worktree ──────────────────────────────────────
# Discovery is by marker file, the one setup-worktree.sh writes. The path is
# never rebuilt here.
matches=()
while IFS= read -r line; do
  [[ "$line" == worktree\ * ]] || continue
  wt="${line#worktree }"
  [[ "$wt" == "$MAIN_ROOT" ]] && continue
  [[ -d "$wt" ]] || continue
  [[ -f "$wt/.claude-session-$SESSION_KEY" ]] && matches+=("$wt")
done <<<"$WT_LIST"

if (( ${#matches[@]} == 1 )); then
  printf '%s\n' "${matches[0]}"
  exit 0
fi

if (( ${#matches[@]} > 1 )); then
  err "${#matches[@]} worktrees claim session $SESSION_KEY:"
  for m in ${matches[@]+"${matches[@]}"}; do err "  $m"; done
  err "Not guessing which is yours. Remove the stale marker(s), then retry."
  exit 1
fi

# ── No worktree yet ───────────────────────────────────────────────────────
if [[ "$mode" == "no-create" ]]; then
  printf '%s\n' "$MAIN_ROOT"
  exit 0
fi

if ! CREATE_OUT=$(CLAUDE_PROJECT_DIR="$MAIN_ROOT" \
                  CLAUDE_SESSION_ID="$RAW_SESSION" \
                  "$SETUP_SCRIPT" "$SLUG" 2>&1); then
  # Fail LOUD, never fall back to the main checkout. Falling back is precisely
  # the bug this script exists to end: the scaffold would land in the main tree,
  # and the session's next write would be refused by the shared-checkout guard,
  # so the caller is not stranded by refusing — it is stranded by succeeding in
  # the wrong place.
  err "could not create this session's worktree; refusing to write to the main checkout."
  while IFS= read -r line; do
    [[ -n "$line" ]] && err "  $line"
  done <<<"$CREATE_OUT"
  err "Diagnose with:  git -C $MAIN_ROOT worktree list   |   df -h $MAIN_ROOT"
  exit 1
fi

CREATED_DIR=$(printf '%s' "$CREATE_OUT" | sed -n 's/^WORKTREE_DIR=//p' | tail -1)
if [[ -z "$CREATED_DIR" ]]; then
  err "creator succeeded but printed no WORKTREE_DIR= line; refusing to guess."
  exit 1
fi

printf '%s\n' "$CREATED_DIR"
