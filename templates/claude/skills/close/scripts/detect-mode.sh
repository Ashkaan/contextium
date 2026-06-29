#!/usr/bin/env bash
# detect-mode.sh — confirm the session's working-tree context and emit a
# shell-safe key=value line describing the close mode.
#
# The shipped repo layout is a single working tree: /close runs directly in the
# repo it is closing. There is no separate side checkout to detect, so this
# script's job is the minimal one — verify we are inside a git repo and report
# the resolved repo root. Its stdout is consumed by .claude/skills/close/SKILL.md
# via a key=value reader loop (NOT eval — the value is printf %q-quoted to
# survive spaces / shell metacharacters in the path).
#
# peers: .claude/skills/close/scripts/detect-mode.test.sh, .claude/skills/close/SKILL.md
#
# Usage:
#   detect-mode.sh
#
# Environment:
#   CLAUDE_PROJECT_DIR  — repo root. Optional; falls back to
#                         `git rev-parse --show-toplevel` when unset.
#
# Output (stdout):
#   mode=direct
#   repo_root=<printf-%q-quoted absolute path>
#
# stderr:
#   Diagnostic when not inside a git repo and CLAUDE_PROJECT_DIR is unset.
#
# Exit:
#   0  inside a resolvable repo
#   1  CLAUDE_PROJECT_DIR unset and not inside a git repo

set -euo pipefail

err() { echo "$@" >&2; }

# CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall back to git
# when it is unset (every /close runs inside the repo by definition).
repo_root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$repo_root" ]] || { err "CLAUDE_PROJECT_DIR unset and not inside a git repo"; exit 1; }

printf 'mode=direct\n'
printf 'repo_root=%q\n' "$repo_root"
