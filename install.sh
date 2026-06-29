#!/usr/bin/env bash
# Contextium v3 installer.
#
# Lays the Contextium AI layer into a target project so Claude Code can drive the
# Think / Do / Wrap loop from the first session. The layer's source lives in this
# repo under templates/claude/ (a normal, non-dotted folder); the installer
# materializes it as a real .claude/ in YOUR project, with CLAUDE.md inside it.
#
# Usage:
#   bash install.sh [TARGET_DIR] [--force] [--name "Your Name"]
#                   [--autonomy ask|autonomous]
#                   [--integrations "github todoist ..." | --no-integrations]
#                   [--yes]
#
#   TARGET_DIR   where to install (default: prompted, falls back to current dir)
#   --force      back up and replace a customized CLAUDE.md (CLAUDE.md.bak)
#   --name       skip the name prompt
#   --autonomy   skip the autonomy prompt
#   --integrations  copy these integration starters (space-separated names)
#   --no-integrations  start with an empty integrations/ (README stub only)
#   --yes        non-interactive: accept all defaults, never prompt
#
# Idempotent and safe to re-run: it refreshes the .claude/ layer and never
# clobbers your data dirs or a customized CLAUDE.md (unless --force).
#
# bash 3.2 compatible (macOS default). No bash 4+ features.

set -euo pipefail

# --- Constants ---

VERSION="v3.2.0"

# This repo (the clone). The layer source is templates/claude/; integration
# starters are templates/integrations/. Resolved relative to this script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# Items of the AI layer, copied from templates/claude/<item> INTO the target's
# .claude/<item> on every run (whole-path refresh). CLAUDE.md is handled
# separately (protected unless --force).
LAYER_ITEMS="rules skills agents hooks templates settings.json"

# Non-.claude template-owned paths refreshed on every run (same relative path in
# source and target). User-authored apps are their own subdirs and untouched.
REFRESH_PATHS="
.githooks
apps/README.md
apps/quality
apps/app-index
apps/project-index
apps/integration-index
apps/shared
"

# Skeleton data dirs laid down on a fresh install and never clobbered after.
# integrations/ is handled by the picker, not here.
PROTECTED_DIRS="
knowledge
journal
projects
"

# --- Colors (disabled when not a TTY) ---

if [ -t 1 ]; then
  GREEN=$'\033[0;32m'; BLUE=$'\033[0;34m'; CYAN=$'\033[0;36m'
  YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; BOLD=$'\033[1m'; NC=$'\033[0m'
else
  GREEN=''; BLUE=''; CYAN=''; YELLOW=''; DIM=''; BOLD=''; NC=''
fi

# --- Helpers (functions before code) ---

err() { printf '%s\n' "${YELLOW}$*${NC}" >&2; }
ok()  { printf '  %s\n' "${GREEN}+${NC} $*"; }
info() { printf '%s\n' "${BLUE}$*${NC}"; }

banner() {
  printf '\n'
  printf '%s\n' "${BLUE}+-----------------------------------------+${NC}"
  printf '%s\n' "${BLUE}|         ${CYAN}Contextium${BLUE}                      |${NC}"
  printf '%s\n' "${BLUE}|    Give your AI an operating system     |${NC}"
  printf '%s\n' "${BLUE}|              ${DIM}${VERSION}${NC}${BLUE}                     |${NC}"
  printf '%s\n' "${BLUE}+-----------------------------------------+${NC}"
  printf '\n'
}

is_tty() { [ -t 0 ]; }

# Prompt for a value with a default. Non-interactive returns the default.
# Args: $1=prompt $2=default
ask() {
  local prompt="$1" default="$2" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s' "${BOLD}${prompt}${NC} ${DIM}[${default}]${NC} " >&2
  IFS= read -r answer || answer=""
  if [ -z "$answer" ]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$answer"
  fi
}

# Ask the autonomy preference. Echoes "ask" or "autonomous".
choose_autonomy() {
  local default="$1" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s\n' "${BOLD}How should your AI operate?${NC}" >&2
  printf '%s\n' "  ${CYAN}1${NC}) ask        ${DIM}ask before host/infra changes (recommended)${NC}" >&2
  printf '%s\n' "  ${CYAN}2${NC}) autonomous ${DIM}act and report, only ask when stuck${NC}" >&2
  printf '%s' "${DIM}Choose 1 or 2${NC} ${DIM}[1]${NC} " >&2
  IFS= read -r answer || answer=""
  case "$answer" in
    2) printf '%s\n' "autonomous" ;;
    *) printf '%s\n' "ask" ;;
  esac
}

# Yes/no prompt. Non-interactive returns the default. Args: $1=prompt $2=default(y|n)
ask_yesno() {
  local prompt="$1" default="$2" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s' "${BOLD}${prompt}${NC} ${DIM}[${default}]${NC} " >&2
  IFS= read -r answer || answer=""
  case "$answer" in
    [Yy]*) printf 'y\n' ;;
    [Nn]*) printf 'n\n' ;;
    *) printf '%s\n' "$default" ;;
  esac
}

# Copy a same-relative-path item from the template into the target, replacing any
# prior copy. Args: $1=relpath
refresh_path() {
  local rel="$1" src="$SCRIPT_DIR/$1" dst="$TARGET/$1"
  [ -e "$src" ] || return 0
  if [ -d "$src" ]; then
    rm -rf "$dst"; mkdir -p "$(dirname "$dst")"; cp -R "$src" "$dst"
  else
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
  fi
  ok "refreshed ${rel}"
}

# Copy from an explicit source into an explicit destination (paths differ).
# Args: $1=src-abs $2=dst-abs $3=label
copy_into() {
  local src="$1" dst="$2" label="$3"
  [ -e "$src" ] || return 0
  if [ -d "$src" ]; then
    rm -rf "$dst"; mkdir -p "$(dirname "$dst")"; cp -R "$src" "$dst"
  else
    mkdir -p "$(dirname "$dst")"; cp "$src" "$dst"
  fi
  ok "refreshed ${label}"
}

# Lay down a skeleton data dir only if absent (never clobber user data).
# Args: $1=relpath
seed_dir() {
  local rel="$1" dst="$TARGET/$1"
  if [ -e "$dst" ]; then
    ok "kept ${rel}/ (your data, untouched)"
    return 0
  fi
  mkdir -p "$dst"
  cat > "$dst/README.md" <<EOF
# ${rel}

Starter directory. See the Contextium docs for how this fits the loop.
EOF
  ok "created ${rel}/"
}

# Materialize the AI layer: templates/claude/<item> -> TARGET/.claude/<item>.
install_ai_layer() {
  local item
  mkdir -p "$TARGET/.claude"
  for item in $LAYER_ITEMS; do
    copy_into "$SCRIPT_DIR/templates/claude/$item" "$TARGET/.claude/$item" ".claude/$item"
  done
}

# Write the starter CLAUDE.md into TARGET/.claude/CLAUDE.md, substituting the
# name + autonomy placeholders. Protected (kept) unless --force.
# Args: $1=name $2=autonomy
install_claude_md() {
  local name="$1" autonomy="$2"
  local src="$SCRIPT_DIR/templates/claude/CLAUDE.md" dst="$TARGET/.claude/CLAUDE.md"
  local autonomy_line

  if [ "$autonomy" = "autonomous" ]; then
    autonomy_line="Act and report on routine work; only stop to ask when genuinely stuck."
  else
    autonomy_line="Ask before host or infrastructure changes; diagnose and propose freely, but get a yes before mutating shared infra."
  fi

  if [ -f "$dst" ]; then
    if [ "$FORCE" = "1" ]; then
      cp "$dst" "$dst.bak"
      ok "backed up existing .claude/CLAUDE.md -> CLAUDE.md.bak"
    else
      ok "kept your .claude/CLAUDE.md (use --force to replace)"
      return 0
    fi
  fi

  mkdir -p "$TARGET/.claude"
  if [ -f "$src" ]; then
    sed -e "s/{{NAME}}/$name/g" \
        -e "s/{{AUTONOMY}}/$autonomy_line/g" \
        "$src" > "$dst"
    ok "installed .claude/CLAUDE.md (personalized for ${name})"
  else
    cat > "$dst" <<EOF
# CLAUDE.md

Working surface for ${name}. Read this first each session; the methodology
lives in \`.claude/rules/\` and the loop skills in \`.claude/skills/\`.

## The Loop

| Verb | Skill | Use when |
|---|---|---|
| Think | \`/project\` -> \`/spec\` | starting or routing a piece of work |
| Do | \`/implement\` | executing an approved SPEC in fresh context |
| Wrap | \`/close\` | journaling, committing, pushing at session end |

## Operating preference

${autonomy_line}
EOF
    ok "installed .claude/CLAUDE.md (starter, personalized for ${name})"
  fi
}

# List available integration starters (one name per line).
list_integrations() {
  local d
  for d in "$SCRIPT_DIR"/templates/integrations/*/; do
    [ -d "$d" ] || continue
    basename "$d"
  done
}

# Prompt for which integration starters to install. Echoes space-separated names
# (empty = none). Non-interactive uses ARG_INTEGRATIONS verbatim.
choose_integrations() {
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$ARG_INTEGRATIONS"
    return 0
  fi
  local names i n answer out=""
  names=$(list_integrations)
  [ -n "$names" ] || { printf '%s\n' ""; return 0; }
  printf '%s\n' "${BOLD}Which integration starters do you want?${NC} ${DIM}(Enter for none)${NC}" >&2
  i=1
  for n in $names; do
    printf '  %s) %s\n' "${CYAN}${i}${NC}" "$n" >&2
    i=$((i + 1))
  done
  printf '%s' "${DIM}Numbers, space-separated${NC} " >&2
  IFS= read -r answer || answer=""
  for n in $answer; do
    i=1
    local m
    for m in $names; do
      if [ "$n" = "$i" ]; then out="$out $m"; fi
      i=$((i + 1))
    done
  done
  # shellcheck disable=SC2086
  printf '%s\n' $out
}

# Copy the selected integration starters into TARGET/integrations/. Always leaves
# integrations/ present; if it ends up empty, drop a README stub.
install_integrations() {
  local selected="$1" name src dst
  mkdir -p "$TARGET/integrations"
  for name in $selected; do
    src="$SCRIPT_DIR/templates/integrations/$name"
    [ -d "$src" ] || { err "no such integration starter: $name"; continue; }
    dst="$TARGET/integrations/$name"
    if [ -e "$dst" ]; then
      ok "kept integrations/${name} (yours, untouched)"
    else
      cp -R "$src" "$dst"
      ok "added integrations/${name}"
    fi
  done
  if [ -z "$(ls -A "$TARGET/integrations" 2>/dev/null)" ]; then
    cat > "$TARGET/integrations/README.md" <<EOF
# integrations

External service connectors. Add one folder per product you wrap (README with
\`hosts:\` + the typed client). Starter examples ship in the Contextium repo under
\`templates/integrations/\` — re-run install.sh to pull any in.
EOF
    ok "created integrations/ (empty starter)"
  fi
}

# Turn on the tool-agnostic git hooks by pointing core.hooksPath at .githooks/.
wire_git_hooks() {
  if [ ! -d "$TARGET/.git" ]; then
    info "Not a git repo yet — skipping hooks. After 'git init', run: git -C \"$TARGET\" config core.hooksPath .githooks"
    return 0
  fi
  if [ -d "$TARGET/.githooks" ]; then
    chmod +x "$TARGET/.githooks/"* 2>/dev/null || true
    git -C "$TARGET" config core.hooksPath .githooks
    ok "wired git hooks (core.hooksPath=.githooks): commit-subject + secret scan"
  fi
}

usage() {
  cat <<EOF
Usage: bash install.sh [TARGET_DIR] [options]

  TARGET_DIR            install location (default: prompted, else current dir)

Options:
  --force                 replace a customized CLAUDE.md (backs up to .bak first)
  --name "Your Name"      set the name without prompting
  --autonomy ask|autonomous   set autonomy without prompting
  --integrations "a b c"  install these integration starters without prompting
  --no-integrations       start with an empty integrations/ (README stub only)
  --hooks / --no-hooks    wire (or skip) the git hooks without prompting
  --yes                   non-interactive; accept defaults, never prompt
  -h, --help              show this help

Re-running refreshes the .claude/ AI layer + template apps and never clobbers
your data dirs or your own apps.
EOF
}

# --- Arg parsing ---

TARGET=""
FORCE="0"
NONINTERACTIVE="0"
ARG_NAME=""
ARG_AUTONOMY=""
ARG_INTEGRATIONS=""
ARG_HOOKS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="1"; shift ;;
    --yes|-y) NONINTERACTIVE="1"; shift ;;
    --name) ARG_NAME="${2:-}"; shift 2 ;;
    --autonomy) ARG_AUTONOMY="${2:-}"; shift 2 ;;
    --integrations) ARG_INTEGRATIONS="${2:-}"; shift 2 ;;
    --no-integrations) ARG_INTEGRATIONS=""; shift ;;
    --hooks) ARG_HOOKS="y"; shift ;;
    --no-hooks) ARG_HOOKS="n"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unknown option: $1"; usage >&2; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done

# --- Main ---

banner

# Verify the layer payload is present alongside this script.
if [ ! -d "$SCRIPT_DIR/templates/claude" ]; then
  err "Could not find the Contextium AI layer (templates/claude/) next to install.sh."
  err "Run this from a fresh clone of the template."
  exit 1
fi

# Resolve target directory.
DEFAULT_TARGET="$PWD"
if [ -z "$TARGET" ]; then
  TARGET="$(ask 'Install Contextium into which directory?' "$DEFAULT_TARGET")"
fi
if [ "$TARGET" = "~" ]; then
  TARGET="$HOME"
elif [ "${TARGET#"~/"}" != "$TARGET" ]; then
  TARGET="$HOME/${TARGET#"~/"}"
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

# Refuse to install into the template clone itself.
if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  err "Target is the template itself. Choose a different project directory."
  exit 1
fi

# Detect fresh vs re-run.
if [ -d "$TARGET/.claude" ]; then
  MODE="refresh"
  info "Existing .claude/ found in ${TARGET} — refreshing the AI layer."
else
  MODE="fresh"
  info "Fresh install into ${TARGET}."
fi
printf '\n'

# Gather minimal profile.
NAME="$ARG_NAME"
if [ -z "$NAME" ]; then
  NAME="$(ask "What's your name?" "${USER:-developer}")"
fi

AUTONOMY="$ARG_AUTONOMY"
case "$AUTONOMY" in
  ask|autonomous) : ;;
  "") AUTONOMY="$(choose_autonomy ask)" ;;
  *) err "Invalid --autonomy '$AUTONOMY' (use ask|autonomous); defaulting to ask."; AUTONOMY="ask" ;;
esac
printf '\n'

# Lay down / refresh the AI layer (.claude/), then CLAUDE.md inside it.
info "Installing the AI layer..."
install_ai_layer
install_claude_md "$NAME" "$AUTONOMY"

# Refresh non-.claude template-owned paths.
for rel in $REFRESH_PATHS; do
  refresh_path "$rel"
done

# Seed protected data dirs (only when absent).
for rel in $PROTECTED_DIRS; do
  seed_dir "$rel"
done

# Integration starters: pick, then copy the selected ones.
SELECTED_INTEGRATIONS="$(choose_integrations)"
install_integrations "$SELECTED_INTEGRATIONS"
printf '\n'

# Wire the tool-agnostic git hooks (commit-subject + secret scan).
HOOKS="$ARG_HOOKS"
if [ -z "$HOOKS" ]; then
  HOOKS="$(ask_yesno 'Wire git hooks so enforcement works at commit time?' y)"
fi
if [ "$HOOKS" = "y" ]; then
  wire_git_hooks
else
  info "Skipped git hooks. Turn them on later: git config core.hooksPath .githooks"
fi
printf '\n'

# --- Next steps ---

printf '%s\n' "${GREEN}=========================================${NC}"
printf '%s\n' "${GREEN}  Contextium ${VERSION} ready in ${TARGET}${NC}"
printf '%s\n' "${GREEN}=========================================${NC}"
printf '\n'

if [ "$MODE" = "refresh" ]; then
  printf '%s\n' "Refreshed the .claude/ AI layer. Your data dirs and CLAUDE.md were left as-is."
else
  printf '%s\n' "Next steps:"
fi
printf '%s\n' "  1. In Claude Code: ${BOLD}cd ${TARGET} && claude${NC}, then try ${BOLD}/project${NC}."
printf '%s\n' "  2. Read ${BOLD}.claude/CLAUDE.md${NC} to see how the loop works."
printf '\n'
