#!/usr/bin/env bash
# Contextium v3 installer.
#
# Lays the Contextium AI layer (the .claude/ methodology layer plus a starter
# CLAUDE.md and skeleton data dirs) into a target project so Claude Code can
# drive the Think / Do / Wrap loop from the first session.
#
# Usage:
#   bash install.sh [TARGET_DIR] [--force] [--name "Your Name"]
#                   [--autonomy ask|autonomous] [--yes]
#
#   TARGET_DIR   where to install (default: prompted, falls back to current dir)
#   --force      back up and replace a customized CLAUDE.md (CLAUDE.md.bak)
#   --name       skip the name prompt
#   --autonomy   skip the autonomy prompt
#   --yes        non-interactive: accept all defaults, never prompt
#
# Idempotent and safe to re-run: it refreshes the .claude/ layer and never
# clobbers your data dirs or a customized CLAUDE.md (unless --force).
#
# bash 3.2 compatible (macOS default). No bash 4+ features.

set -euo pipefail

# --- Constants ---

VERSION="v3.0.0"

# The template's own AI layer + starter files this installer copies INTO a
# target. Resolved relative to the directory this script lives in (the clone).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# --- Self-bootstrap ---
# When run detached from the template payload (the `curl -sSL contextium.ai/install
# | bash` one-liner pipes only this script, with no .claude/ alongside it), clone
# the template to a temp dir and re-run from there. A normal `bash install.sh` from
# a clone skips this — .claude/ is already next to the script. The env guard stops
# the re-run from looping.
REPO_URL="${CONTEXTIUM_REPO:-https://github.com/Ashkaan/contextium.git}"
if [ ! -d "$SCRIPT_DIR/.claude" ] && [ -z "${CONTEXTIUM_BOOTSTRAPPED:-}" ]; then
  if ! command -v git >/dev/null 2>&1; then
    printf '%s\n' "Contextium needs git to install. Install git and re-run, or clone the repo and run: bash install.sh" >&2
    exit 1
  fi
  boot_tmp="$(mktemp -d "${TMPDIR:-/tmp}/contextium-XXXXXX")" || exit 1
  trap 'rm -rf "$boot_tmp"' EXIT INT TERM
  printf '%s\n' "Fetching Contextium..." >&2
  if ! git clone --depth 1 --quiet "$REPO_URL" "$boot_tmp/contextium"; then
    printf '%s\n' "Could not clone $REPO_URL — check your network and try again." >&2
    exit 1
  fi
  CONTEXTIUM_BOOTSTRAPPED=1 bash "$boot_tmp/contextium/install.sh" "$@"
  boot_status=$?
  rm -rf "$boot_tmp"
  trap - EXIT INT TERM
  exit "$boot_status"
fi

# Paths the installer refreshes on every run (the methodology layer + the
# template-owned apps). Whole-path refresh keeps user data dirs (named below)
# and any apps the user authored (other subdirs of apps/) untouched.
REFRESH_PATHS="
.claude/rules
.claude/skills
.claude/agents
.claude/hooks
.claude/templates
.claude/settings.json
.githooks
docs
templates
AGENTS.md
apps/README.md
apps/projector
apps/quality
apps/app-index
apps/project-index
apps/integration-index
apps/shared
"

# Skeleton data dirs laid down on a fresh install and never clobbered after.
# apps/ is NOT here: its template-owned subdirs refresh above; user-authored
# apps are their own subdirs and the targeted refreshes never touch them.
PROTECTED_DIRS="
integrations
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

# Interactive input source. Prefer real stdin; fall back to /dev/tty so the
# `curl … | bash` one-liner (whose stdin is the script pipe, not the keyboard)
# can still prompt. Empty when there's no terminal at all (CI) — callers then
# take their non-interactive default.
if [ -t 0 ]; then
  TTY_IN="/dev/stdin"
elif [ -r /dev/tty ]; then
  TTY_IN="/dev/tty"
else
  TTY_IN=""
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

is_tty() { [ -n "$TTY_IN" ]; }

# Prompt for a value with a default. Non-interactive (no TTY or --yes) returns
# the default without reading. Args: $1=prompt $2=default
ask() {
  local prompt="$1" default="$2" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s' "${BOLD}${prompt}${NC} ${DIM}[${default}]${NC} " >&2
  IFS= read -r answer <"$TTY_IN" || answer=""
  if [ -z "$answer" ]; then
    printf '%s\n' "$default"
  else
    printf '%s\n' "$answer"
  fi
}

# Ask a yes/no choice between two labels. Args: $1=prompt $2=default(1|2)
# $3=label1 $4=label2 — echoes the chosen label's short key (echoed by caller).
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
  IFS= read -r answer <"$TTY_IN" || answer=""
  case "$answer" in
    2) printf '%s\n' "autonomous" ;;
    *) printf '%s\n' "ask" ;;
  esac
}

# Copy a refresh path from the template into the target, replacing any prior
# copy of that same path. Args: $1=relpath
refresh_path() {
  local rel="$1" src="$SCRIPT_DIR/$1" dst="$TARGET/$1"
  if [ ! -e "$src" ]; then
    return 0
  fi
  if [ -d "$src" ]; then
    rm -rf "$dst"
    mkdir -p "$(dirname "$dst")"
    cp -R "$src" "$dst"
  else
    mkdir -p "$(dirname "$dst")"
    cp "$src" "$dst"
  fi
  ok "refreshed ${rel}"
}

# Lay down a skeleton data dir only if absent (never clobber user data).
# Args: $1=relpath
seed_dir() {
  local rel="$1" src="$SCRIPT_DIR/$1" dst="$TARGET/$1"
  if [ -e "$dst" ]; then
    ok "kept ${rel}/ (your data, untouched)"
    return 0
  fi
  if [ -d "$src" ]; then
    cp -R "$src" "$dst"
  else
    mkdir -p "$dst"
    cat > "$dst/README.md" <<EOF
# ${rel}

Starter directory. See \`docs/getting-started.md\` for how this fits the loop.
EOF
  fi
  ok "created ${rel}/"
}

# Write the starter CLAUDE.md. Prefer copying the template's root CLAUDE.md and
# substituting the name placeholder; fall back to a short inline starter.
# Honors protected (existing) CLAUDE.md unless --force.
# Args: $1=name $2=autonomy
install_claude_md() {
  local name="$1" autonomy="$2"
  local dst="$TARGET/CLAUDE.md" src="$SCRIPT_DIR/CLAUDE.md"
  local autonomy_line

  if [ "$autonomy" = "autonomous" ]; then
    autonomy_line="Act and report on routine work; only stop to ask when genuinely stuck."
  else
    autonomy_line="Ask before host or infrastructure changes; diagnose and propose freely, but get a yes before mutating shared infra."
  fi

  if [ -f "$dst" ]; then
    if [ "$FORCE" = "1" ]; then
      cp "$dst" "$dst.bak"
      ok "backed up existing CLAUDE.md -> CLAUDE.md.bak"
    else
      ok "kept your CLAUDE.md (use --force to replace)"
      return 0
    fi
  fi

  if [ -f "$src" ] && [ "$src" != "$dst" ]; then
    # Copy the template's root CLAUDE.md, substituting placeholders.
    sed -e "s/{{NAME}}/$name/g" \
        -e "s/{{AUTONOMY}}/$autonomy_line/g" \
        "$src" > "$dst"
    ok "installed CLAUDE.md (from template, personalized for ${name})"
    return 0
  fi

  # Fallback: short inline starter (kept minimal — full instructions live in
  # .claude/rules and docs/, not duplicated here).
  cat > "$dst" <<EOF
# CLAUDE.md

Working surface for ${name}. Read this first each session; the methodology
lives in \`.claude/rules/\` and the loop skills in \`.claude/skills/\`.

## The Loop

| Verb | Skill | Use when |
|---|---|---|
| Think | \`/project\` | starting or routing a piece of work |
| Do | \`/implement\` | executing an approved SPEC in fresh context |
| Wrap | \`/close\` | journaling, committing, pushing at session end |

## Operating preference

${autonomy_line}

## Where things live

| Directory | Purpose |
|---|---|
| \`.claude/\` | the AI layer: rules, skills, agents, hooks, templates |
| \`apps/\` | code you author |
| \`integrations/\` | external service connectors |
| \`knowledge/\` | reference data |
| \`projects/\` | multi-session work with status frontmatter |
| \`journal/\` | daily session logs |

See \`docs/getting-started.md\` to begin.
EOF
  ok "installed CLAUDE.md (starter, personalized for ${name})"
}

# Yes/no prompt. Non-interactive returns the default. Args: $1=prompt $2=default(y|n)
ask_yesno() {
  local prompt="$1" default="$2" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s' "${BOLD}${prompt}${NC} ${DIM}[${default}]${NC} " >&2
  IFS= read -r answer <"$TTY_IN" || answer=""
  case "$answer" in
    [Yy]*) printf 'y\n' ;;
    [Nn]*) printf 'n\n' ;;
    *) printf '%s\n' "$default" ;;
  esac
}

# Multi-select the tools to generate instruction files for. AGENTS.md is always
# generated (the cross-tool default). Echoes a space-separated list of tool keys.
choose_tools() {
  local answer="" out="agents" n
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$out"
    return 0
  fi
  printf '%s\n' "${BOLD}Which AI tools will use this repo?${NC} ${DIM}(AGENTS.md is always generated)${NC}" >&2
  printf '%s\n' "  ${CYAN}1${NC}) Cursor     ${CYAN}2${NC}) Gemini CLI   ${CYAN}3${NC}) GitHub Copilot" >&2
  printf '%s\n' "  ${CYAN}4${NC}) Windsurf   ${CYAN}5${NC}) Cline        ${CYAN}6${NC}) Aider" >&2
  printf '%s' "${DIM}Numbers, space-separated (Enter for AGENTS.md only)${NC} " >&2
  IFS= read -r answer <"$TTY_IN" || answer=""
  for n in $answer; do
    case "$n" in
      1) out="$out cursor" ;;
      2) out="$out gemini" ;;
      3) out="$out copilot" ;;
      4) out="$out windsurf" ;;
      5) out="$out cline" ;;
      6) out="$out aider" ;;
    esac
  done
  printf '%s\n' "$out"
}

# Turn on the tool-agnostic git hooks (commit-subject + secret scan) by pointing
# core.hooksPath at the tracked .githooks/ dir. No-op if the target isn't a git
# repo yet.
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
  --force               replace a customized CLAUDE.md (backs up to .bak first)
  --name "Your Name"    set the name without prompting
  --autonomy ask|autonomous   set autonomy without prompting
  --tools "cursor gemini ..."  generate these tool files (default: prompt; AGENTS.md always)
  --hooks / --no-hooks  wire (or skip) the tool-agnostic git hooks without prompting
  --yes                 non-interactive; accept defaults, never prompt
  -h, --help            show this help

Re-running refreshes the .claude/ AI layer + template apps and never clobbers
your data dirs or your own apps. Supported tool keys: cursor, gemini, copilot,
windsurf, cline, aider (AGENTS.md is always generated).
EOF
}

# --- Arg parsing ---

TARGET=""
FORCE="0"
NONINTERACTIVE="0"
ARG_NAME=""
ARG_AUTONOMY=""
ARG_TOOLS=""
ARG_HOOKS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="1"; shift ;;
    --yes|-y) NONINTERACTIVE="1"; shift ;;
    --name) ARG_NAME="${2:-}"; shift 2 ;;
    --autonomy) ARG_AUTONOMY="${2:-}"; shift 2 ;;
    --tools) ARG_TOOLS="${2:-}"; shift 2 ;;
    --hooks) ARG_HOOKS="y"; shift ;;
    --no-hooks) ARG_HOOKS="n"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unknown option: $1"; usage >&2; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done

# --- Main ---

banner

# Verify the template payload is present alongside this script.
if [ ! -d "$SCRIPT_DIR/.claude" ]; then
  err "Could not find the Contextium AI layer (.claude/) next to install.sh."
  err "Run this from a fresh clone of the template."
  exit 1
fi

# Resolve target directory.
DEFAULT_TARGET="$PWD"
if [ -z "$TARGET" ]; then
  TARGET="$(ask 'Install Contextium into which directory?' "$DEFAULT_TARGET")"
fi
# Expand a leading ~ without eval.
case "$TARGET" in
  "~") TARGET="$HOME" ;;
  "~/"*) TARGET="$HOME/${TARGET#~/}" ;;
esac
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

# Lay down / refresh the AI layer.
info "Installing the AI layer..."
for rel in $REFRESH_PATHS; do
  refresh_path "$rel"
done

# Seed protected data dirs (only when absent).
for rel in $PROTECTED_DIRS; do
  seed_dir "$rel"
done

# Starter CLAUDE.md (protected unless --force).
install_claude_md "$NAME" "$AUTONOMY"
printf '\n'

# Generate per-tool instruction files from one source (AGENTS.md always).
TOOLS="$ARG_TOOLS"
if [ -z "$TOOLS" ]; then
  TOOLS="$(choose_tools)"
fi
if [ -f "$TARGET/apps/projector/project-rules.sh" ]; then
  # shellcheck disable=SC2086
  if bash "$TARGET/apps/projector/project-rules.sh" $TOOLS >/dev/null 2>&1; then
    ok "generated agent instruction files: ${TOOLS}"
  else
    err "projector failed; run 'bash apps/projector/project-rules.sh' by hand."
  fi
fi

# Wire the tool-agnostic git hooks (commit-subject + secret scan).
HOOKS="$ARG_HOOKS"
if [ -z "$HOOKS" ]; then
  HOOKS="$(ask_yesno 'Wire git hooks so enforcement works under any tool?' y)"
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
printf '%s\n' "  2. In any other tool: it reads ${BOLD}AGENTS.md${NC} (and the tool file you generated)."
printf '%s\n' "  3. Read ${BOLD}CLAUDE.md${NC}, ${BOLD}AGENTS.md${NC}, and ${BOLD}docs/getting-started.md${NC}."
printf '%s\n' "  Regenerate tool files anytime: ${BOLD}bash apps/projector/project-rules.sh all${NC}"
printf '\n'
