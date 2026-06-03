#!/usr/bin/env bash
# Block destructive git commands at the Bash PreToolUse boundary.
# Makes a git-safety guard a real mechanism rather than prose
# (per @rule:mechanisms-not-prose — prose-only guards fail under pressure).
# Blocks strictly by default; relax only where the harm is provably absent.
#
# Blocks (exit 2, hard-refuse):
#   reset --hard | push --force/-f/--force-with-lease | clean -*f*/--force |
#   checkout . / checkout -- <path> | restore (worktree) |
#   reflog expire | gc --prune=now/all | update-ref -d |
#   filter-branch/filter-repo | stash drop/clear |
#   rebase (except --abort/--continue/--skip/--quit/--edit-todo recovery)
#
# State-aware (conditional) — these two name a harm checkable from repo state,
# so they pass when the harm provably does not exist, block otherwise
# (fail-closed on any ambiguity):
#   branch -D            → pass iff every named tip is on a remote-tracking ref
#                          (delete cannot orphan commits); else block.
#   worktree remove -f   → pass iff target is clean except a disposable
#                          per-session marker file; else block.
#
# Passes through: status, add, commit, push (no force), checkout -b,
#   checkout <branch>, restore --staged (unstage only), branch -d (safe
#   delete), clean -n (dry run), gc (default), worktree remove (no --force),
#   merge, fetch, pull, log, diff, stash (push/list/show/pop/apply),
#   rebase --abort/--continue/--skip/--quit.
#
# AUTHORIZED ROUTE-AROUND: the hook reads only the literal command text — it
#   cannot see git verbs inside a script. When the user authorizes a
#   destructive op THIS turn, the operator routes around by writing the command
#   into a script file and running `bash <file>` (or an alternate transport),
#   then executes it end-to-end — it does not hand the user a one-liner to run.
#   The hook is the backstop for the UNAUTHORIZED case; user authorization this
#   turn is the gate it protects.

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

[ -z "$COMMAND" ] && exit 0

block() {
  local verb="$1" destroys="$2" tier="${3:-standard}"
  cat >&2 <<MSG
BLOCKED: destructive git op "$verb" — refused by check-destructive-git.sh.

What it would destroy: $destroys
Tier: $tier

This guard hard-refuses uniformly (it cannot read session intent). If the
user authorized this THIS turn, the operator routes around by writing the
command into a script file and running \`bash <file>\` and executing it
end-to-end — not by handing the user a one-liner. Otherwise: stop and ask.

Command:
  $COMMAND
MSG
  exit 2
}

# --- state-aware safety checks (the "is the harm real?" relaxation) ---------
# Two verbs — branch -D and worktree remove --force — name a harm that is
# mechanically checkable from repo state ("unique commits become unreachable" /
# "uncommitted changes lost"). For ONLY these two, query git and pass when the
# harm provably does not exist. Every check FAILS CLOSED: any parse ambiguity,
# git error, or non-repo cwd returns non-zero → the caller blocks, exactly as
# before. The irrecoverable verbs (clean -f, stash drop/clear, gc --prune,
# reflog expire, filter-branch, push --force) get NO relaxation.

# Isolate the SINGLE statement containing a git verb from a compound/multi-line
# command. Splits $COMMAND on the shell statement separators (; && || | and
# newlines) and returns the first segment matching $1 (an ERE). Without this, a
# `git branch -D` / `git worktree remove -f` buried among other statements (e.g.
# a /close cleanup block) defeats the arg-tokenizer below — the whole blob gets
# ingested, the verb's operands can't be isolated, and the state-aware check
# fails closed even when the op is provably safe. Prints empty if no match.
_isolate_git_segment() {
  local pattern="$1" line
  printf '%s\n' "$COMMAND" \
    | sed -E 's/&&/\n/g; s/\|\|/\n/g; s/;/\n/g; s/\|/\n/g' \
    | while IFS= read -r line; do
        if printf '%s' "$line" | grep -qE "$pattern"; then
          printf '%s\n' "$line"
          return 0
        fi
      done
}

# Tokenize a single git statement into bare arguments, dropping the git word,
# any -flags, and any token carrying a shell redirection/operator char. Globbing
# disabled so a branch/path token can never expand. Operates on the segment
# passed as $1 (the isolated statement from _isolate_git_segment); falls back to
# the legacy "leading statement of $COMMAND" behaviour when called with no arg.
# Result lands in the global array ARGS_OUT.
_tokenize_git_args() {
  local seg tok
  if [ "$#" -ge 1 ]; then
    seg="$1"
  else
    seg=${COMMAND%%|*}
    seg=${seg%%;*}
  fi
  ARGS_OUT=()
  set -f
  for tok in $seg; do
    case "$tok" in
      git) continue ;;
      -*) continue ;;
      *[\<\>\&\|\;]*) continue ;; # redirections (2>&1, >) / stray operators
      *) ARGS_OUT+=("$tok") ;;
    esac
  done
  set +f
}

# branch -D is safe when EVERY named branch tip is reachable from at least one
# remote-tracking ref — its unique commits already live on a remote, so the
# delete cannot make them unreachable. `branch -d` (safe form) refuses this case
# whenever local HEAD lags the remote, which is the exact gap that forces -D.
branch_delete_is_safe() {
  local b tip remotes seg
  seg=$(_isolate_git_segment 'git[[:space:]]+branch\b')
  [ -z "$seg" ] && return 1 # verb statement not isolable → fail closed
  _tokenize_git_args "$seg"
  # Drop the literal "branch" subcommand word; the rest are branch names.
  [ "${ARGS_OUT[0]:-}" = "branch" ] && ARGS_OUT=("${ARGS_OUT[@]:1}")
  [ "${#ARGS_OUT[@]}" -eq 0 ] && return 1 # nothing parsed → fail closed
  for b in "${ARGS_OUT[@]}"; do
    tip=$(git rev-parse --verify --quiet "${b}^{commit}" 2>/dev/null) || return 1
    remotes=$(git branch -r --contains "$tip" 2>/dev/null) || return 1
    [ -z "$remotes" ] && return 1 # tip on no remote → unique commits → block
  done
  return 0
}

# worktree remove --force is safe when the target's working tree is clean except
# for the disposable per-session marker (.claude-session-<id>) — --force then
# discards nothing of value. Any real uncommitted change → block.
worktree_remove_is_safe() {
  local path porcelain leftover seg
  seg=$(_isolate_git_segment 'git[[:space:]]+worktree[[:space:]]+remove\b')
  [ -z "$seg" ] && return 1 # verb statement not isolable → fail closed
  _tokenize_git_args "$seg"
  # Drop the literal "worktree" + "remove" words; first survivor is the path.
  [ "${ARGS_OUT[0]:-}" = "worktree" ] && ARGS_OUT=("${ARGS_OUT[@]:1}")
  [ "${ARGS_OUT[0]:-}" = "remove" ] && ARGS_OUT=("${ARGS_OUT[@]:1}")
  path="${ARGS_OUT[0]:-}"
  [ -z "$path" ] && return 1
  [ -d "$path" ] || return 1
  porcelain=$(git -C "$path" status --porcelain 2>/dev/null) || return 1
  leftover=$(printf '%s\n' "$porcelain" | grep -vE '\.claude-session-[a-f0-9-]+' || true)
  [ -z "$leftover" ] && return 0
  return 1
}

# --- push --force / -f / --force-with-lease (strictest on main/master) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+([^|;&]*[[:space:]])?push\b[^|;&]*(--force\b|--force-with-lease|[[:space:]]-f\b)'; then
  if echo "$COMMAND" | grep -qE '\b(main|master)\b'; then
    block "push --force to main/master" "overwrites published main/master history for every consumer" "STRICTEST"
  fi
  block "push --force" "overwrites remote history; orphaned commits recoverable only via reflog before gc"
fi

# --- reset --hard ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+([^|;&]*[[:space:]])?reset\b[^|;&]*--hard\b'; then
  block "reset --hard" "discards ALL uncommitted working-tree + index changes; moves branch ref (prior commits reflog-only)"
fi

# --- clean -f / --force (force-delete untracked) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+([^|;&]*[[:space:]])?clean\b[^|;&]*([[:space:]]-[a-zA-Z]*f|--force\b)'; then
  block "clean -f" "permanently deletes untracked files/dirs — NOT recoverable (never staged)"
fi

# --- checkout . | checkout -- <path> (discard working tree) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+checkout\b[^|;&]*([[:space:]]\.([[:space:]]|$)|[[:space:]]--([[:space:]]|$))'; then
  block "checkout . / checkout -- <path>" "discards uncommitted changes in the named paths"
fi

# --- restore (worktree) — allow --staged-only (unstage, non-destructive) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+restore\b'; then
  if echo "$COMMAND" | grep -qE '[[:space:]]--staged\b' && ! echo "$COMMAND" | grep -qE '[[:space:]]--worktree\b'; then
    : # restore --staged only = unstage → pass
  else
    block "restore (worktree)" "discards uncommitted working-tree changes in the named paths (use --staged to only unstage)"
  fi
fi

# --- branch -D (force delete, even if unmerged) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+branch\b[^|;&]*([[:space:]]-D\b|--delete[[:space:]]+--force|--force[[:space:]]+--delete)'; then
  # State-aware: pass when every named tip is already on a remote (delete cannot
  # orphan commits). Fail-closed otherwise — including the unmerged case.
  if ! branch_delete_is_safe; then
    block "branch -D" "force-deletes a branch even if unmerged; its unique commits become unreachable"
  fi
fi

# --- reflog expire ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+reflog[[:space:]]+expire\b'; then
  block "reflog expire" "purges reflog entries — removes the recovery net for reset/rebase/branch-delete"
fi

# --- gc --prune=now/all ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+([^|;&]*[[:space:]])?gc\b[^|;&]*--prune=(now|all)'; then
  block "gc --prune=now" "immediately drops unreachable objects — finalizes loss of reflog-only commits"
fi

# --- update-ref -d (delete ref directly) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+update-ref\b[^|;&]*[[:space:]]-d\b'; then
  block "update-ref -d" "deletes a ref directly, bypassing branch-delete safety"
fi

# --- filter-branch / filter-repo (history rewrite) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+filter-(branch|repo)\b'; then
  block "filter-branch/filter-repo" "rewrites entire history non-reversibly"
fi

# --- stash drop / clear ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+stash[[:space:]]+(drop|clear)\b'; then
  block "stash drop/clear" "permanently removes stashed changes"
fi

# --- worktree remove --force ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+worktree[[:space:]]+remove\b[^|;&]*(--force\b|[[:space:]]-f\b)'; then
  # State-aware: pass when the target worktree is clean except the disposable
  # .claude-session marker. Fail-closed on any real uncommitted change.
  if ! worktree_remove_is_safe; then
    block "worktree remove --force" "removes a worktree even with uncommitted or locked changes"
  fi
fi

# --- rebase (allow in-progress recovery flags) ---
if echo "$COMMAND" | grep -qE 'git[[:space:]]+([^|;&]*[[:space:]])?rebase\b'; then
  if echo "$COMMAND" | grep -qE 'rebase[[:space:]]+([^|;&]*[[:space:]])?--(abort|continue|skip|quit|edit-todo)\b'; then
    : # in-progress rebase control = recovery, non-initiating → pass
  else
    block "rebase" "rewrites commit history on the current branch (reflog-recoverable, but a re-derivation hazard)"
  fi
fi

exit 0
