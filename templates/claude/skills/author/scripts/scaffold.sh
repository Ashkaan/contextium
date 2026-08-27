#!/usr/bin/env bash
# scaffold.sh — Step 2 (`scaffold`) of /author. Deterministic skeleton
# emitter: validates <type> + kebab <name>, computes the surface path,
# refuses on collision, copies the type's template with `{{name}}`
# substituted, and prints the written path.
#
# The `rule` type is the one intentional exception: a rule is an inline
# `## <slug>` section appended to an existing .claude/rules/*.md file, not
# a standalone file. So `scaffold.sh rule <slug>` writes nothing — it
# validates the slug + checks collision against existing rule IDs
# (@rule:rule-stable-id) and prints insertion guidance.
#
# Names are rejected, never normalized — a silent rename would surprise
# the author (SPEC § 2 name contract).
#
# peers: verify.sh, .claude/skills/author/SKILL.md,
#        .claude/skills/author/references/templates/
#
# Usage:
#   scaffold.sh <type> <name> [placement]
#     <type>      rule | skill | hook | agent | output-style
#     <name>      kebab-case slug (^[a-z][a-z0-9-]*$)
#     [placement] hook only: `checks` → .claude/hooks/checks/<name>.sh
#                 (default → .claude/hooks/<name>.sh)
#
# Output (stdout): the written path (skill|hook|agent), or insertion
#   guidance (rule).
# Exit:
#   0  scaffold written / rule validated
#   1  reject (non-kebab name, collision, missing template)
#   2  usage error (bad/missing type, empty name)

set -euo pipefail

err() { echo "$@" >&2; }

VALID_TYPES="rule skill hook agent output-style"
NAME_RE='^[a-z][a-z0-9-]*$'

# ── Where this writes ─────────────────────────────────────────────────────
# The scaffold lands in the repo you are working in. TEMPLATE_DIR is
# self-located because templates are READ, and reading them from the checkout
# this script was invoked from is correct.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
if [[ -z "$REPO_ROOT" ]]; then
  err "not inside a git repo, and CLAUDE_PROJECT_DIR is unset"
  exit 2
fi
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
# like "rule skill" (word-matches inside the whole-string pattern). Aligns with
# verify.sh's case dispatch (code-reviewer finding).
case "$type" in
  rule|skill|hook|agent|output-style) ;;
  *)
    err "unknown type: $type"
    err "valid types: $VALID_TYPES"
    exit 2 ;;
esac

# Empty name is the "no name" boundary (SPEC § 4) → the skill prompts.
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
  rule)
    # Collision check against every existing `## <slug>` in .claude/rules/.
    # Both layouts: .claude/rules/ where the layer is installed, and
    # templates/claude/rules/ where it is authored. Checking only the first lets
    # a slug that already exists sail through in the repo that ships it.
    rule_dirs=()
    [[ -d "$REPO_ROOT/.claude/rules" ]] && rule_dirs+=("$REPO_ROOT/.claude/rules")
    [[ -d "$REPO_ROOT/templates/claude/rules" ]] && rule_dirs+=("$REPO_ROOT/templates/claude/rules")
    existing=""
    if [[ ${#rule_dirs[@]} -gt 0 ]]; then
      existing="$(
        find "${rule_dirs[@]}" -type f -name '*.md' ! -name 'README.md' -print0 2>/dev/null \
          | xargs -0 grep -hE '^## [a-z][a-z0-9-]*$' 2>/dev/null \
          | sed 's/^## //' \
          | sort -u || true
      )"
    fi
    if grep -Fxq "$name" <<<"$existing"; then
      err "rule slug collides with an existing rule: '## $name'"
      err "rule IDs are immutable per @rule:rule-stable-id — pick a more specific slug"
      exit 1
    fi
    echo "rule scaffolds inline; see references/rule.md"
    echo "insert '## $name' in topic order into the chosen .claude/rules/*.md,"
    echo "then run: scripts/verify.sh rule <path-to-that-rule-file>"
    ;;

  skill)
    dest_dir="$REPO_ROOT/.claude/skills/$name"
    dest="$dest_dir/SKILL.md"
    if [[ -e "$dest_dir" ]]; then
      err "exists: .claude/skills/$name — never overwrites; rename"
      exit 1
    fi
    mkdir -p "$dest_dir"
    substitute "$TEMPLATE_DIR/skill.template.md" "$dest"
    echo ".claude/skills/$name/SKILL.md"
    ;;

  hook)
    # Placement decides BOTH the path AND which correct-by-construction template:
    #   default → .claude/hooks/<name>.sh   : PreToolUse/PostToolUse, blocks with exit 2
    #   checks  → .claude/hooks/checks/<name>.sh : pre-commit, fails with exit 1
    # A typo like `check` used to fall through to the top-level branch, writing
    # the wrong file from the wrong template and exiting 0.
    case "$placement" in
      ""|checks) ;;
      *) err "unknown hook placement: '$placement' — use 'checks' or omit it"; exit 2 ;;
    esac
    if [[ "$placement" == "checks" ]]; then
      rel=".claude/hooks/checks/$name.sh"
      tmpl="$TEMPLATE_DIR/hook-precommit.template.sh"
    else
      rel=".claude/hooks/$name.sh"
      tmpl="$TEMPLATE_DIR/hook-tooluse.template.sh"
    fi
    dest="$REPO_ROOT/$rel"
    if [[ -e "$dest" ]]; then
      err "exists: $rel — never overwrites; rename"
      exit 1
    fi
    substitute "$tmpl" "$dest"
    chmod +x "$dest"
    echo "$rel"
    ;;

  output-style)
    # Body is APPENDED TO THE SYSTEM PROMPT, so it is in force every turn of
    # every session that selects it. Single file, no registration side effects:
    # existing does NOT select it (settings.json `outputStyle`) and does NOT
    # reach subagents. Both are register-step work per
    # references/output-style.md.
    rel=".claude/output-styles/$name.md"
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
    rel=".claude/agents/$name.md"
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
      err "      (@rule:tiebreaker-skill-vs-agent). If you want a /command, author a skill."
    fi
    ;;
esac
