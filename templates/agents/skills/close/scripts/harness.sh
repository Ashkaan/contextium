#!/usr/bin/env bash
# harness.sh — everything that differs by harness, in one place. Sourced, not run.
#
#   source harness.sh
#   harness_name <repo>             the harness this repo was installed for
#   harness_worktree_root <repo>    the folder a NEW session worktree goes under
#   harness_worktree_branch <name>  the branch a new session worktree gets
#   harness_session_id              this session's id, when the harness exports one
#
# The harness is the installer's recorded answer: the `harness=` line of
# `<repo>/.agents/harness` (t3 · claude · codex · cursor · vscode · gemini ·
# antigravity · grok), overridable per shell with CONTEXTIUM_HARNESS. An absent
# file or key means the default. Every other
# script asks these functions and never tests a harness name itself, so a new
# harness is one row here.
#
# A session already standing in a linked worktree — a T3 Code thread, Claude
# Code / Gemini / Grok started with -w, a Codex app thread — never reaches these:
# write-root.sh adopts that worktree. They decide only where a worktree goes for
# a session that started in the main checkout, and they put it where that
# harness itself would, so its own worktree tools see it.
#
# peers:
#   .agents/skills/close/scripts/harness.test.ts
#   .agents/skills/close/scripts/thread.ts      (asks harness_session_id through bash)
#   .agents/skills/close/scripts/write-root.sh

harness_name() {
  local h="${CONTEXTIUM_HARNESS:-}" f="${1:-.}/.agents/harness"
  [[ -n "$h" || ! -f "$f" ]] || h="$(sed -n 's/^[[:space:]]*harness[[:space:]]*=[[:space:]]*\([A-Za-z0-9_-]*\).*/\1/p' "$f" | head -n 1)"
  printf '%s\n' "${h:-default}"
}

# harness_worktree_root <repo-main-checkout> — absolute folder, no trailing slash.
# In-repo roots (claude, gemini) must be git-ignored; the installer adds them.
harness_worktree_root() {
  local repo="${1%/}"
  case "$(harness_name "$repo")" in
    claude) printf '%s/.claude/worktrees\n' "$repo" ;;
    gemini) printf '%s/.gemini/worktrees\n' "$repo" ;;
    grok)   printf '%s/.grok/worktrees/%s\n' "$HOME" "$(basename "$repo")" ;;
    codex)  printf '%s/worktrees\n' "${CODEX_HOME:-$HOME/.codex}" ;;
    # t3 (a main checkout opened in T3's local mode), cursor, vscode,
    # antigravity and anything unrecorded: beside the repo, not inside it — a
    # worktree inside the checkout is a second copy of every file the harness
    # indexes.
    *)      printf '%s/%s.worktrees\n' "$(dirname "$repo")" "$(basename "$repo")" ;;
  esac
}

# harness_worktree_branch <name> — Claude Code names its worktree branches
# `worktree-<name>`; the rest get `session/<name>`.
harness_worktree_branch() {
  case "$(harness_name "${2:-.}")" in
    claude) printf 'worktree-%s\n' "$1" ;;
    *)      printf 'session/%s\n' "$1" ;;
  esac
}

# harness_session_id — the session's own id, or nothing. Used only to NAME a
# worktree created for a session that started in the main checkout. T3 Code
# exports no thread id, and its threads always start in a worktree of their own.
harness_session_id() {
  local id="${CONTEXTIUM_SESSION:-${CLAUDE_CODE_SESSION_ID:-${CLAUDE_SESSION_ID:-}}}"
  printf '%s' "$id" | tr -c 'A-Za-z0-9_-' '-' | cut -c1-64
}
