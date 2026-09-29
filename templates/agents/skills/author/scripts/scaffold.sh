#!/usr/bin/env bash
# scaffold.sh — Step 2 (`scaffold`) of /author. Deterministic skeleton
# emitter: validates <type> + kebab <name>, computes the surface path,
# refuses on collision, copies the type's template with `{{name}}`
# substituted, and prints the written path.
#
# Names are rejected, never normalized — a silent rename would surprise
# the author (the name contract).
#
# peers: verify.sh, .agents/skills/author/SKILL.md,
#        .agents/skills/author/references/templates/
#
# Usage:
#   scaffold.sh <type> <name> [placement]
#     <type>      skill | hook | agent | output-style
#     <name>      kebab-case slug (^[a-z][a-z0-9-]*$)
#     [placement] hook only: `checks` → .agents/checks/<name>.sh
#                 plus <name>.test.sh beside it (default → .agents/hooks/<name>.sh)
#
# Output (stdout): the written path.
# Exit:
#   0  scaffold written
#   1  reject (non-kebab name, collision, missing template)
#   2  usage error (bad/missing type, empty name)

set -euo pipefail

err() { echo "$@" >&2; }

VALID_TYPES="skill hook agent output-style"
NAME_RE='^[a-z][a-z0-9-]*$'

# ── Where this session writes ─────────────────────────────────────────────
# Self-location USED to set REPO_ROOT here, with a comment claiming it was
# "robust against worktree vs CLAUDE_PROJECT_DIR mismatch, so files land in the
# repo the script lives in." That reasoning is backwards: this script is always
# READ FROM THE MAIN CHECKOUT, so "the repo the script lives in" is only ever
# the main checkout — never the session's worktree. Scaffolded hooks and skills
# landed in the main tree and the session's next Write was refused by the edit
# guard. The resolver creates the worktree if
# needed, so the scaffold lands where the rest of the session's edits go.
#
# TEMPLATE_DIR stays self-located: templates are READ, and reading them from the
# checkout this script was invoked from is correct.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$("$SCRIPT_DIR/../../implement/scripts/session-write-root.sh")"
TEMPLATE_DIR="$SCRIPT_DIR/../references/templates"

# ── Arg parse ─────────────────────────────────────────────────────────────
type="${1:-}"
name="${2:-}"
placement="${3:-}"

if [[ -z "$type" ]]; then
  err "usage: $(basename "$0") <type> <name> [placement]"
  err "valid types: $VALID_TYPES"
  exit 2
fi

# Exact-match the type via case — `grep -qw` would accept a multi-token arg
# like "skill hook" (word-matches inside the whole-string pattern). Aligns with
# verify.sh's case dispatch (code-reviewer finding).
case "$type" in
  skill|hook|agent|output-style) ;;
  *)
    err "unknown type: $type"
    err "valid types: $VALID_TYPES"
    exit 2 ;;
esac

# Empty name is the "no name" boundary → the skill prompts.
if [[ -z "$name" ]]; then
  err "name required (empty) — prompt the author for a $type name"
  exit 2
fi

# Non-kebab name → reject, never normalize.
if ! [[ "$name" =~ $NAME_RE ]]; then
  err "invalid name: '$name' — must match $NAME_RE (kebab-case)"
  exit 1
fi

substitute() {
  # $1 template, $2 dest. Copy with {{name}} → name. name is kebab-validated
  # so it is sed-safe.
  local tmpl="$1" dest="$2"
  if [[ ! -f "$tmpl" ]]; then
    err "template missing: $tmpl"
    exit 1
  fi
  sed "s/{{name}}/$name/g" "$tmpl" > "$dest"
}

case "$type" in
  skill)
    # Skills live under `.agents/skills/` of the workbench, so the destination
    # is REPO_ROOT — the session's own worktree, the same root the hook and
    # agent branches write to — and the close lands it like any other file.
    #
    # SKILLS_ROOT stays, and stays FIRST, for the reason it was added: without
    # it this script's own suite would scaffold into the live tree and rely on
    # a cleanup trap to take it back out again.
    skills_root="${SKILLS_ROOT:-$REPO_ROOT/.agents/skills}"
    dest_dir="$skills_root/$name"
    dest="$dest_dir/SKILL.md"
    if [[ -e "$dest_dir" ]]; then
      err "exists: $dest_dir — never overwrites; rename"
      exit 1
    fi
    mkdir -p "$dest_dir"
    substitute "$TEMPLATE_DIR/skill.template.md" "$dest"
    echo "$dest"
    ;;

  hook)
    # Placement decides BOTH the path AND which correct-by-construction template:
    #   default → .agents/hooks/<name>.sh : PreToolUse/PostToolUse, blocks with exit 2
    #   checks  → .agents/checks/<name>.sh : a check, fails with
    #             exit 1, with <name>.test.sh beside it. What fires a check is
    #             whatever calls it, not this script's question.
    if [[ "$placement" == "checks" ]]; then
      rel=".agents/checks/$name.sh"
      tmpl="$TEMPLATE_DIR/hook-precommit.template.sh"
    else
      rel=".agents/hooks/$name.sh"
      tmpl="$TEMPLATE_DIR/hook-tooluse.template.sh"
    fi
    dest="$REPO_ROOT/$rel"
    if [[ -e "$dest" ]]; then
      err "exists: $rel — never overwrites; rename"
      exit 1
    fi
    if [[ "$placement" == "checks" && -e "${dest%.sh}.test.sh" ]]; then
      err "exists: ${rel%.sh}.test.sh — never overwrites; rename"
      exit 1
    fi
    substitute "$tmpl" "$dest"
    chmod +x "$dest"
    if [[ "$placement" == "checks" ]]; then
      substitute "$TEMPLATE_DIR/check-test.template.sh" "${dest%.sh}.test.sh"
    fi
    echo "$rel"
    ;;

  output-style)
    # Body is APPENDED TO THE SYSTEM PROMPT, so it is in force every turn of
    # every session that selects it. Single file, no registration side effects:
    # existing does NOT select it (settings.json `outputStyle`) and does NOT
    # reach subagents (a SubagentStart hook's allowlist). Both are register-step
    # work per references/output-style.md. Output styles are Claude Code's
    # alone; the file goes in the shared layer, which the installer links from
    # ~/.claude/output-styles (there is no in-repo .claude/).
    rel=".agents/output-styles/$name.md"
    dest="$REPO_ROOT/$rel"
    if [[ -e "$dest" ]]; then
      err "exists: $rel — never overwrites; rename"
      exit 1
    fi
    mkdir -p "$(dirname "$dest")"
    substitute "$TEMPLATE_DIR/output-style.template.md" "$dest"
    echo "$rel"
    err "note: keep-coding-instructions defaults to FALSE — omitting it strips"
    err "      Claude Code's software-engineering instructions. Template sets it"
    err "      true; change it deliberately, never by deletion."
    ;;

  agent)
    rel=".agents/agents/$name.md"
    dest="$REPO_ROOT/$rel"
    if [[ -e "$dest" ]]; then
      err "exists: $rel — never overwrites; rename"
      exit 1
    fi
    substitute "$TEMPLATE_DIR/agent.template.md" "$dest"
    echo "$rel"
    # verb-form reminder (non-blocking): agents are not slash-invocable.
    if grep -qE '^(run|make|build|create|fix|update|do|get|set|check)(-|$)' <<<"$name"; then
      err "note: '$name' reads like a verb — agents are NOT slash-invocable"
      err "      If you want a /command, author a skill."
    fi
    ;;
esac
