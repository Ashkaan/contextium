#!/usr/bin/env bash
# Contextium installer.
#
# Lays the Contextium layer into your WORKBENCH — the one repo that holds every
# project, its records and the skills — so the AI tool you drive it with runs
# the Think / Do / Wrap loop from the first session.
#
# ONE canonical copy, in .agents/, and nothing generated per tool: the working
# agreement is AGENTS.md at the root (a link to .agents/AGENTS.md) and the
# skills are .agents/skills/, which most tools read natively. There is no
# in-repo .claude/ and no .githooks/: the skills and agents reach the harness
# homes through links (~/.agents/skills, ~/.claude/skills, ~/.claude/agents,
# ~/.gemini/config/skills), each picked harness's hook location is a link to
# the one manifest for its format in .agents/ (or has the guards merged into a
# settings file of yours), and land.ts runs the checks before every commit a
# close makes.
#
# The first question is which tool you drive the workbench with (T3 Code is the
# recommended one). The answer goes to .agents/harness, which decides where each
# session's git worktree goes, and which model writes the code, which the
# reviewer chain skips.
#
# Usage:
#   bash install.sh [TARGET_DIR] [options]      (bash install.sh --help lists them)
#
# Idempotent and safe to re-run: it refreshes what the layer ships and keeps
# what you added beside it, replaces only the Contextium blocks of AGENTS.md,
# merges its hooks into harness settings without removing yours, and never
# clobbers your data dirs. A target that is not a git repo is made one, with
# the installed tree as its first commit, and one with no origin is asked for
# one: land.ts pushes there.
#
# bash 3.2 compatible (macOS default). No bash 4+ features.

set -euo pipefail

# --- Constants ---

VERSION="v9.0.0"

# The tools the installer knows, in menu order. The first is the recommended one.
HARNESSES="t3 claude codex cursor vscode gemini antigravity grok"

# This repo (the clone). The canonical layer source is templates/agents/ and
# integration starters are templates/integrations/. Resolved relative to this
# script.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# The canonical layer: templates/agents/<item> -> TARGET/.agents/<item>, without
# the tests, fixtures and evals that live beside the scripts in this repo (they
# run here, not in your workbench). A file item is replaced on every run. A
# folder item is refreshed ENTRY BY ENTRY: each skill folder, agent, hook or
# check Contextium ships is replaced whole, and anything else in the folder is
# yours and stays (see refresh_layer_dir). AGENTS.md is handled separately (its
# Contextium blocks are replaced, the rest kept). An item missing from the clone
# is skipped. output-styles/ ships empty: /author writes your styles there.
# packages/ holds the helpers the TypeScript scripts import (cli-exit/).
# The per-harness manifests (.agents/hooks.json for Antigravity,
# .agents/gemini-settings.json for Gemini CLI) are not layer items: each ships
# only while its harness is among the workbench's tools (harness_file).
AGENTS_ITEMS="skills agents hooks checks generators packages package.json output-styles"

# In each folder item: what this release installed there, as
# <path from the workbench root>TAB<cksum CRC> <byte count>, the format of
# install-legacy.tsv. The next run reads it to know what it may remove.
LAYER_MANIFEST=".contextium-manifest"

# The layer's scripts are TypeScript, run by Node's type stripping: Node 22.6
# or later, with --experimental-strip-types (an older node refuses the flag).
# The installer itself needs no Node; the steps that run one of those scripts
# ask have_node first and, without it, keep what they would have changed and say
# why. Asked once, the answer kept in NODE_OK.
NODE_OK=""
have_node() {
  if [ -z "$NODE_OK" ]; then
    if command -v node >/dev/null 2>&1 && node --experimental-strip-types -e '' >/dev/null 2>&1; then
      NODE_OK=1
    else
      NODE_OK=0
    fi
  fi
  [ "$NODE_OK" = "1" ]
}

# Claude Code reads a root AGENTS.md from this version on.
CLAUDE_AGENTS_MD_MIN="2.1.277"

# Skeleton dirs laid down when absent and never clobbered after. apps/ is
# yours from the first commit: the template seeds a README and nothing else, and
# the index generator (.agents/generators/) rewrites that README in place
# as you add apps. decisions/ gets only its README, which states the record
# format; it is seeded on an upgrade too, because the standards point at it.
# integrations/ is handled by the picker, not here.
PROTECTED_DIRS="
apps
knowledge
journal
projects
decisions
"

# Where each tool keeps a session worktree inside the repo, ignored by git.
GITIGNORE_LINES=".claude/worktrees/ .gemini/worktrees/"

# Files earlier releases installed into places v8 no longer writes, with their
# checksums: removed only while they still match (see the file's header).
LEGACY_LIST="$SCRIPT_DIR/install-legacy.tsv"

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

# `curl -sSL contextium.ai/install | bash` is the install command on the front
# page, and it leaves stdin pointing at the pipe feeding bash the script itself.
# A `read` there eats script text and every question silently takes its default,
# so the whole interview never happens. Bind the terminal on fd 3 when one exists
# and read from that; only a run with no terminal at all falls back to defaults.
TTY_FD_OPEN=0
# CONTEXTIUM_PROMPT_STDIN=1 asks every question on stdin even when it is not a
# terminal — how the installer's tests answer the interview.
PROMPT_STDIN="${CONTEXTIUM_PROMPT_STDIN:-0}"
if [ "$PROMPT_STDIN" != "1" ] && ( : </dev/tty ) 2>/dev/null; then
  exec 3</dev/tty
  TTY_FD_OPEN=1
fi

is_tty() { [ "$TTY_FD_OPEN" = "1" ] || [ "$PROMPT_STDIN" = "1" ] || [ -t 0 ]; }

# Read one line into the caller's `answer` local, from the terminal when we have
# one. Never fails the script: an EOF leaves answer empty and the caller defaults.
read_answer() {
  if [ "$TTY_FD_OPEN" = "1" ]; then
    IFS= read -r answer <&3 || answer=""
  else
    IFS= read -r answer || answer=""
  fi
}

# Prompt for a value with a default. Non-interactive returns the default.
# Args: $1=prompt $2=default
ask() {
  local prompt="$1" default="$2" answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s' "${BOLD}${prompt}${NC} ${DIM}[${default}]${NC} " >&2
  read_answer
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
  read_answer
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
  read_answer
  case "$answer" in
    [Yy]*) printf 'y\n' ;;
    [Nn]*) printf 'n\n' ;;
    *) printf '%s\n' "$default" ;;
  esac
}

# Lay down a skeleton dir only if absent (never clobber user data). Prefers the
# template's own skeleton README when one exists, so apps/ arrives with the shape
# the index generator expects and knowledge/journal/projects arrive with the
# guidance the docs assume.
# Args: $1=relpath
seed_dir() {
  local rel="$1" dst="$TARGET/$1" skel="$SCRIPT_DIR/$1/README.md"
  if [ -e "$dst" ]; then
    # decisions/README.md is the one README the layer depends on: it states the
    # record format the rules and the pre-commit check point at. Seed it into
    # an existing folder when missing; never overwrite one that is there.
    if [ "$rel" = "decisions" ] && [ -d "$dst" ] && [ ! -e "$dst/README.md" ] && [ -f "$skel" ]; then
      cp "$skel" "$dst/README.md"
      ok "added decisions/README.md (the record format; your records untouched)"
      return 0
    fi
    ok "kept ${rel}/ (your data, untouched)"
    return 0
  fi
  mkdir -p "$dst"
  if [ -f "$skel" ]; then
    cp "$skel" "$dst/README.md"
  else
    cat > "$dst/README.md" <<EOF
# ${rel}

Starter directory. See the Contextium docs for how this fits the loop.
EOF
  fi
  ok "created ${rel}/"
}

# `cksum` of the SPEC template v5.0.0 through v6.0.0 shipped, unchanged
# between them. migrate_v6_layout deletes that file only when it still matches.
V6_SPEC_LEAN_CKSUM="4214426014 1851"

# Up to v3.4.0 the template shipped its own machinery INTO the user's apps/:
# three index generators, a quality/ folder, and a shared/ folder of helpers.
# That machinery now lives with its callers (.agents/generators/, .agents/scripts/
# and .agents/checks/), so on an upgrade those folders are dead weight pointing at
# a layout that no longer exists.
#
# Remove them, but only when untouched: every file in the folder must match a
# checksum install-legacy.tsv records for it. The old apps/quality/README
# invited people to add their own checks there and to edit the ones shipped, and
# an edited check keeps its shipped name, so a file name proves nothing. A
# folder holding anything else — a file added or changed, a link — is now the
# user's: leave it alone and say so.
migrate_legacy_layout() {
  local dir kept=0
  for dir in app-index project-index integration-index quality shared; do
    [ -d "$TARGET/apps/$dir" ] || [ -L "$TARGET/apps/$dir" ] || continue
    if layer_entry_unchanged "apps/$dir" "$LEGACY_LIST"; then
      rm -rf "${TARGET:?}/apps/$dir"
      ok "removed apps/${dir}/ (template machinery, now shipped inside the AI layer)"
    else
      err "kept apps/${dir}/ — not everything in it is a file Contextium shipped, unchanged."
      err "  The template's copies moved to .agents/generators/ and .agents/checks/."
      kept=1
    fi
  done
  [ "$kept" = "1" ] && err "  Move what you want to keep, then delete the leftovers."

  # apps/README.md is a generated index, and the pre-v4 one lists the five
  # folders we just deleted — including a `node apps/<name>/generate.ts` command
  # that no longer resolves. It is the first file someone opens in apps/, so
  # leaving it stale hands an upgrading user a README that lies. Rebuild it:
  # regenerate from their actual apps when a generator is on hand, else lay down
  # the skeleton (and say so if their app list can't be rebuilt without one).
  local readme="$TARGET/apps/README.md"
  local gen="$TARGET/.agents/generators/app-index.generate.ts"
  if [ ! -f "$readme" ]; then
    cp "$SCRIPT_DIR/apps/README.md" "$readme"
    ok "created apps/README.md"
  elif grep -qE 'app-index/|apps/<name>/generate\.ts|Generated by apps/' "$readme" 2>/dev/null; then
    if [ -f "$gen" ] && have_node &&
       (cd "$TARGET" && node --experimental-strip-types "$gen" >/dev/null 2>&1); then
      ok "rebuilt apps/README.md from your apps"
    else
      cp "$SCRIPT_DIR/apps/README.md" "$readme"
      ok "reset apps/README.md (it described the old layout)"
      if [ -n "$(find "$TARGET/apps" -mindepth 1 -maxdepth 1 -type d 2>/dev/null)" ]; then
        err "  Your apps are still there, but the index now reads empty."
        err "  Regenerate it with: node --experimental-strip-types .agents/generators/app-index.generate.ts"
      fi
    fi
  fi
  return 0
}

# v6 -> v7 (v8 still runs it, for a v6 install upgraded directly). The layer's refresh replaces what it still ships, but a path it
# stopped shipping stays behind unless something removes it:
#   - .agents/templates/spec-lean.md, the four-section SPEC template. Specs are
#     spec folders now, and their templates live beside /spec.
#   - .claude/templates, our symlink to that folder.
# Only our own files go. A .agents/templates/ holding anything else is the
# user's, and so is a .claude/templates that is not our link.
migrate_v6_layout() {
  local dir="$TARGET/.agents/templates" link="$TARGET/.claude/templates"
  if [ -f "$dir/spec-lean.md" ]; then
    # `cksum` (CRC and byte count) is POSIX, so it reads the same on macOS and
    # Linux. The value is the file every v5 and v6 release shipped; anything
    # else was edited, and an edit is the user's work.
    if [ "$(cksum < "$dir/spec-lean.md" | awk '{print $1, $2}')" = "$V6_SPEC_LEAN_CKSUM" ]; then
      rm -f "$dir/spec-lean.md"
      ok "removed .agents/templates/spec-lean.md (specs are spec folders now; /spec carries their templates)"
    else
      # Never over an earlier rescue: take the first free name.
      local kept="spec-lean.md.pre-v7" n=2
      while [ -e "$dir/$kept" ] || [ -L "$dir/$kept" ]; do
        kept="spec-lean.md.pre-v7.$n"
        n=$((n + 1))
      done
      mv "$dir/spec-lean.md" "$dir/$kept"
      err "You had edited .agents/templates/spec-lean.md, so it was kept as"
      err "  .agents/templates/$kept. Nothing reads it any more: specs are spec"
      err "  folders now, with their templates beside /spec. Move what you need, then delete it."
    fi
  fi
  if [ -d "$dir" ] && [ ! -L "$dir" ] && [ -z "$(ls -A "$dir" 2>/dev/null)" ]; then
    rmdir "$dir"
  fi
  if [ -L "$link" ] && [ "$(readlink "$link")" = "../.agents/templates" ]; then
    rm -f "$link"
    ok "removed .claude/templates (it linked to the old template folder)"
  fi
  return 0
}

# Copy one layer item without what only this repo runs: `*.test.*` files and
# `tests/`, `fixtures/` and `evals/` folders. tar's --exclude is on GNU and BSD
# tar alike. Args: $1=src $2=dst $3=label
copy_layer_item() {
  local src="$1" dst="$2" label="$3"
  [ -e "$src" ] || return 0
  rm -rf "$dst"
  mkdir -p "$(dirname "$dst")"
  if [ -d "$src" ]; then
    mkdir -p "$dst"
    (cd "$src" && tar cf - --exclude='*.test.*' --exclude=tests --exclude=fixtures --exclude=evals .) |
      (cd "$dst" && tar xf -)
  else
    cp "$src" "$dst"
  fi
  ok "refreshed ${label}"
}

# Materialize the canonical layer: templates/agents/<item> -> TARGET/.agents/<item>.
install_agents_layer() {
  local item
  mkdir -p "$TARGET/.agents"
  for item in $AGENTS_ITEMS; do
    if [ -d "$SCRIPT_DIR/templates/agents/$item" ]; then
      refresh_layer_dir "$item"
    else
      copy_layer_item "$SCRIPT_DIR/templates/agents/$item" "$TARGET/.agents/$item" ".agents/$item"
    fi
  done
}

# The top-level entries a layer folder ships: its files and folders, dotfiles
# included, less the tests, fixtures and evals. Args: $1=source folder
shipped_entries() {
  # grep exits 1 when it selects nothing (a folder that ships no entry, or only
  # tests), which pipefail would make this function's failure; only 2 is one.
  find "$1" -mindepth 1 -maxdepth 1 2>/dev/null | sed 's|.*/||' |
    { grep -v -e '\.test\.' -e '^tests$' -e '^fixtures$' -e '^evals$' || [ "$?" -eq 1 ]; } | LC_ALL=C sort
}

# Refresh one layer folder without touching what is not Contextium's. Each
# entry this release ships is replaced whole. An entry an earlier release
# shipped (its manifest, or install-legacy.tsv) and this one does not is
# removed only while every file in it still matches its recorded checksum, and
# said when it is kept. Everything else — a skill you added, a check of your
# own — is never looked at. Args: $1=item
refresh_layer_dir() {
  local item="$1" src="$SCRIPT_DIR/templates/agents/$1" dst="$TARGET/.agents/$1"
  local old name shipped kept="" gone=""
  old="$(mktemp)"
  {
    [ ! -f "$dst/$LAYER_MANIFEST" ] || grep -v '^#' "$dst/$LAYER_MANIFEST"
    grep "^\.agents/$item/" "$LEGACY_LIST" 2>/dev/null
  } >"$old" || true
  shipped="$(shipped_entries "$src")"
  mkdir -p "$dst"
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    rm -rf "${dst:?}/$name"
    if [ -d "$src/$name" ]; then
      mkdir -p "$dst/$name"
      (cd "$src/$name" && tar cf - --exclude='*.test.*' --exclude=tests --exclude=fixtures --exclude=evals .) |
        (cd "$dst/$name" && tar xf -)
    else
      cp "$src/$name" "$dst/$name"
    fi
  done <<EOF
$shipped
EOF
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if printf '%s\n' "$shipped" | grep -qxF "$name"; then continue; fi
    [ -e "$dst/$name" ] || [ -L "$dst/$name" ] || continue
    if layer_entry_unchanged ".agents/$item/$name" "$old"; then
      rm -rf "${dst:?}/$name"
      gone="$gone .agents/$item/$name"
    else
      kept="$kept .agents/$item/$name"
    fi
  done <<EOF
$(cut -f1 "$old" | sed "s|^\.agents/$item/||; s|/.*||" | LC_ALL=C sort -u)
EOF
  rm -f "$old"
  write_layer_manifest "$item"
  ok "refreshed .agents/${item}"
  [ -z "$gone" ] || ok "removed what Contextium no longer ships:${gone}"
  if [ -n "$kept" ]; then
    err "kept${kept} — an earlier Contextium shipped it and this one does not, but it has"
    err "  changed since. Nothing uses it now; delete it when you no longer need it."
  fi
}

# True when <rel> holds at least one file, every file under it matches a
# checksum row in <list>, and nothing else is there: <rel> itself a link, or a
# link or anything but a file or folder inside it, is not a file the list
# recorded, and neither is a scan that failed or found no file at all.
# Args: $1=path from the workbench root $2=list file
layer_entry_unchanged() {
  local rel="$1" list="$2" f frel sum files others
  [ ! -L "$TARGET/$rel" ] || return 1
  files="$(find "$TARGET/$rel" -type f 2>/dev/null)" || return 1
  others="$(find "$TARGET/$rel" ! -type f ! -type d 2>/dev/null)" || return 1
  [ -n "$files" ] && [ -z "$others" ] || return 1
  while IFS= read -r f; do
    frel="${f#"$TARGET"/}"
    sum="$(cksum <"$f" | awk '{print $1, $2}')"
    grep -qxF "${frel}	${sum}" "$list" || return 1
  done <<EOF
$files
EOF
  return 0
}

# Record what this release installed in one layer folder. Run again for hooks/
# once its manifest is rendered, so the checksum is of the file as installed.
# Args: $1=item
write_layer_manifest() {
  local item="$1" dst="$TARGET/.agents/$1" name f
  {
    printf '# Written by the Contextium installer: what it installed here. A re-run\n'
    printf '# removes a file listed here that a later release no longer ships, and only\n'
    printf '# while it still matches. Anything not listed is yours.\n'
    shipped_entries "$SCRIPT_DIR/templates/agents/$item" | while IFS= read -r name; do
      [ -n "$name" ] || continue
      find "$dst/$name" -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
        printf '%s\t%s\n' "${f#"$TARGET"/}" "$(cksum <"$f" | awk '{print $1, $2}')"
      done
    done
  } >"$dst/$LAYER_MANIFEST"
}

# Move a path out of the way without ever destroying an earlier rescue. The
# first migration writes <path>.pre-agents; a second conflict would have deleted
# that and put the NEWER file there, losing the original the installer promised
# to keep. Find a free suffix instead. Echoes the path it moved to.
# Args: $1=path to move aside
move_aside() {
  local src="$1" dst="$1.pre-agents" n=2
  while [ -e "$dst" ] || [ -L "$dst" ]; do
    dst="$1.pre-agents.$n"
    n=$((n + 1))
  done
  mv "$src" "$dst"
  printf '%s' "$dst"
}

# Link the working agreement to the repo root as AGENTS.md, where every
# supported tool looks for it.
link_root_agents_md() {
  local dst="$TARGET/AGENTS.md"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = ".agents/AGENTS.md" ]; then
    # Already ours. Anything else pointing somewhere of the user's choosing —
    # AGENTS.md -> docs/agents.md, say — is their wiring, and deleting it would
    # silently unhook their instructions.
    rm -f "$dst"
  elif [ -f "$dst" ] && grep -q 'Generated from .agents/AGENTS.md\|Generated by scripts/projector' "$dst" 2>/dev/null; then
    # An older version's projector wrote it. The marker says who wrote it
    # first, not that nobody added to it since, so it is moved aside, not
    # deleted: what the user added under it is theirs.
    local gen
    gen="$(move_aside "$dst")"
    err "The AGENTS.md an earlier Contextium generated was moved to $(basename "$gen"); anything you added to it is there."
    err "  AGENTS.md is now the Contextium working agreement (.agents/AGENTS.md). Delete $(basename "$gen") when you have what you need."
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    # A real AGENTS.md we did not write — the user's, or another tool's, or a
    # symlink pointing somewhere that no longer exists (`-e` is false for a
    # dangling link, which used to drop it past every branch and abort the
    # install on `ln -s` with "File exists"). It is
    # NOT adopted as the working agreement: doing that would install a layer
    # whose Loop and rules are whatever that file happened to say. Move it aside
    # so nothing is lost, install ours, and say plainly that the merge is theirs.
    local kept
    kept="$(move_aside "$dst")"
    err "Your existing AGENTS.md was moved to $(basename "$kept")."
    err "  AGENTS.md is now the Contextium working agreement (.agents/AGENTS.md)."
    err "  Merge anything you want to keep from the .pre-agents copy into it."
  fi
  ln -s ".agents/AGENTS.md" "$dst"
  ok "linked AGENTS.md -> .agents/AGENTS.md"
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
  if [ "$NONINTERACTIVE" = "1" ] || [ "$INTEGRATIONS_GIVEN" = "1" ] || ! is_tty; then
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
  read_answer
  for n in $answer; do
    i=1
    local m
    for m in $names; do
      if [ "$n" = "$i" ]; then out="$out $m"; fi
      i=$((i + 1))
    done
  done
  printf '%s\n' "$out"
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
  # The folder's README carries the manifest schema every integration README
  # is checked against (.agents/checks/check-integration-manifest.ts). Laid
  # down when absent, never overwritten.
  if [ ! -e "$TARGET/integrations/README.md" ] && [ -f "$SCRIPT_DIR/integrations/README.md" ]; then
    cp "$SCRIPT_DIR/integrations/README.md" "$TARGET/integrations/README.md"
    ok "added integrations/README.md (the manifest every integration README follows)"
  fi
}

# --- The tool you drive the repo with ---

# Human label for a harness key (the picker and the summary).
harness_label() {
  case "$1" in
    t3)          echo "T3 Code         desktop/web app running Claude Code or Codex, a git worktree per thread (recommended)" ;;
    claude)      echo "Claude Code" ;;
    codex)       echo "Codex" ;;
    cursor)      echo "Cursor" ;;
    vscode)      echo "VS Code + Copilot" ;;
    gemini)      echo "Gemini CLI" ;;
    antigravity) echo "Antigravity" ;;
    grok)        echo "Grok Build" ;;
    *)           echo "$1" ;;
  esac
}

# The model family that writes code under a harness. T3 Code runs another
# agent, so its answer comes from the agent question instead.
harness_agent() {
  case "$1" in
    vscode) echo "copilot" ;;
    t3)     echo "claude" ;;
    *)      echo "$1" ;;
  esac
}

# Map a v7 --tools key or a harness name to a harness key; empty if unknown.
harness_key() {
  case "$1" in
    copilot|vscode) echo "vscode" ;;
    t3|claude|codex|cursor|gemini|antigravity|grok) echo "$1" ;;
    *) echo "" ;;
  esac
}

# True when a tool is installed for this user. Args: $1=tool key
tool_installed() {
  case "$1" in
    t3)          command -v t3 >/dev/null 2>&1 || [ -x "${T3CODE_HOME:-$HOME/.t3}/bin/t3" ] ||
                 [ -e "$HOME/.local/bin/t3" ] || [ -d "/Applications/T3 Code.app" ] ;;
    claude)      command -v claude >/dev/null 2>&1 ;;
    codex)       command -v codex >/dev/null 2>&1 ;;
    cursor)      command -v agent >/dev/null 2>&1 || command -v cursor >/dev/null 2>&1 ;;
    vscode)      command -v code >/dev/null 2>&1 ;;
    gemini)      command -v gemini >/dev/null 2>&1 ;;
    antigravity) command -v agy >/dev/null 2>&1 ;;
    grok)        command -v grok >/dev/null 2>&1 ;;
    *)           return 1 ;;
  esac
}

# The vendor's own non-interactive install command, or nothing when there is no
# single command to run (VS Code: an OS package plus a signed-in extension).
tool_install_cmd() {
  case "$1" in
    t3)          echo "curl -fsSL https://t3.codes/install.sh | sh" ;;
    claude)      echo "curl -fsSL https://claude.ai/install.sh | bash" ;;
    codex)       echo "curl -fsSL https://chatgpt.com/codex/install.sh | CODEX_NON_INTERACTIVE=1 sh" ;;
    cursor)      echo "curl -fsS https://cursor.com/install | bash" ;;
    gemini)      echo "npm install -g @google/gemini-cli" ;;
    antigravity) echo "curl -fsSL https://antigravity.google/cli/install.sh | bash" ;;
    grok)        echo "curl -fsSL https://x.ai/cli/install.sh | bash" ;;
    *)           echo "" ;;
  esac
}

# Offer to install a missing tool. Interactive: a y/N question, default no.
# Non-interactive: install only with --install-missing; otherwise print the
# command. Never fails the install. Args: $1=tool key
offer_install() {
  local t="$1" cmd label yn
  tool_installed "$t" && return 0
  label="$(harness_label "$t" | awk '{ sub(/  +.*/, ""); print }')"
  cmd="$(tool_install_cmd "$t")"
  if [ -z "$cmd" ]; then
    err "${label} is not installed. Get it from https://code.visualstudio.com/download, then add the Copilot extension."
    return 0
  fi
  if [ "$INSTALL_MISSING" = "1" ]; then
    yn="y"
  elif [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    err "${label} is not installed. Install it with:"
    err "  ${cmd}"
    err "  (or re-run with --install-missing)"
    return 0
  else
    yn="$(ask_yesno "${label} is not installed. Install it now? (runs: ${cmd})" n)"
  fi
  [ "$yn" = "y" ] || { info "Skipped installing ${label}. Later: ${cmd}"; return 0; }
  info "Installing ${label}: ${cmd}"
  if ! sh -c "$cmd"; then
    err "Installing ${label} failed. Run it yourself: ${cmd}"
    return 0
  fi
  if tool_installed "$t"; then
    ok "installed ${label}"
  else
    err "${label} was installed but is not on your PATH yet — open a new terminal."
  fi
  return 0
}

# The harness question — the installer's first. Echoes a harness key. The
# default is what .agents/harness already says, else T3 Code.
choose_harness() {
  local default="$1" i h answer=""
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s\n' "${BOLD}Which tool will you drive this repo with?${NC}" >&2
  i=1
  for h in $HARNESSES; do
    printf '  %s) %s\n' "${CYAN}${i}${NC}" "$(harness_label "$h")" >&2
    i=$((i + 1))
  done
  i=1
  for h in $HARNESSES; do
    [ "$h" = "$default" ] && break
    i=$((i + 1))
  done
  printf '%s' "${DIM}Choose a number${NC} ${DIM}[${i}]${NC} " >&2
  read_answer
  i=1
  for h in $HARNESSES; do
    if [ "$answer" = "$i" ]; then printf '%s\n' "$h"; return 0; fi
    i=$((i + 1))
  done
  printf '%s\n' "$default"
}

# Which agents T3 Code runs. Echoes space-separated keys, the first being the
# one that writes the code.
choose_t3_agents() {
  local default="$1" answer="" out="" n
  if [ "$NONINTERACTIVE" = "1" ] || ! is_tty; then
    printf '%s\n' "$default"
    return 0
  fi
  printf '%s\n' "${BOLD}Which agent will T3 Code run?${NC} ${DIM}(space-separated for both)${NC}" >&2
  printf '%s\n' "  ${CYAN}1${NC}) Claude Code ${DIM}(recommended)${NC}" >&2
  printf '%s\n' "  ${CYAN}2${NC}) Codex" >&2
  printf '%s' "${DIM}Numbers${NC} ${DIM}[1]${NC} " >&2
  read_answer
  for n in $answer; do
    case "$n" in
      1) out="$out claude" ;;
      2) out="$out codex" ;;
    esac
  done
  if [ -n "$out" ]; then printf '%s\n' "${out# }"; else printf '%s\n' "$default"; fi
}

# Read one key from an existing .agents/harness. Args: $1=key
harness_file_value() {
  local f="$TARGET/.agents/harness"
  [ -f "$f" ] || return 0
  sed -n "s/^$1=\\([a-z0-9-]*\\)\$/\\1/p" "$f" | head -n 1
}

# Record the answer. Two lines, read by the worktree lookup (harness=) and the
# reviewer chain (agent=, the model to keep off its own review).
write_harness_file() {
  mkdir -p "$TARGET/.agents"
  printf 'harness=%s\nagent=%s\ntools=%s\n' "$1" "$2" "$3" >"$TARGET/.agents/harness"
  ok "recorded .agents/harness (harness=$1, agent=$2, tools=$3)"
}

# The tools an earlier run wired, from the tools= line of .agents/harness. A v8
# file from before that line was written has the set read off disk instead:
# its harness= and agent=, and each tool whose wiring is there (Gemini CLI's
# settings, Antigravity's manifest, Grok Build's and Codex's links to this
# workbench's manifest, Claude Code's settings naming its hooks) — links and
# merged entries only, never a file's presence. No file: none.
recorded_tools() {
  local f="$TARGET/.agents/harness" line t="" k
  [ -f "$f" ] || return 0
  if line="$(grep -m 1 '^tools=' "$f")"; then
    printf '%s\n' "${line#tools=}"
    return 0
  fi
  for k in "$(harness_file_value harness)" "$(harness_file_value agent)"; do
    k="$(harness_key "$k")"
    [ -z "$k" ] || t="$t $k"
  done
  # Links only: v8.0.0 shipped .agents/hooks.json and gemini-settings.json for
  # every tool, so a file's presence says nothing about what was wired.
  [ "$(readlink "$TARGET/.gemini/settings.json" 2>/dev/null)" != "../.agents/gemini-settings.json" ] || t="$t gemini"
  if [ "$(readlink "$HOME/.agents/skills" 2>/dev/null)" = "$TARGET/.agents/skills" ] &&
     [ "$(readlink "$HOME/.gemini/config/skills" 2>/dev/null)" = "$HOME/.agents/skills" ]; then
    t="$t antigravity"
  fi
  [ "$(readlink "$HOME/.grok/hooks/contextium.json" 2>/dev/null)" != "$TARGET/.agents/hooks/claude-hooks.json" ] || t="$t grok"
  case "$(readlink "$HOME/.codex/hooks.json" 2>/dev/null)" in
    "$TARGET/.agents/hooks/claude-hooks.json" | "$TARGET/.agents/codex-hooks.json") t="$t codex" ;;
  esac
  ! grep -qF "$TARGET/.agents/hooks/" "$HOME/.claude/settings.json" 2>/dev/null || t="$t claude"
  printf '%s\n' "$t"
}

# Add a tool to TOOLS once, in order. Args: $1=tool
add_tool() {
  [ -n "$1" ] || return 0
  case " $TOOLS " in *" $1 "*) ;; *) TOOLS="${TOOLS:+$TOOLS }$1" ;; esac
}

# True when version $1 >= $2, both dotted numbers.
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    na = split(a, x, "."); nb = split(b, y, ".")
    for (i = 1; i <= (na > nb ? na : nb); i++) {
      if ((x[i] + 0) > (y[i] + 0)) exit 0
      if ((x[i] + 0) < (y[i] + 0)) exit 1
    }
    exit 0
  }'
}

# Claude Code reads AGENTS.md itself only from CLAUDE_AGENTS_MD_MIN on, and this
# layer ships no CLAUDE.md to fall back on. Say so when it is older.
check_claude_version() {
  local v
  command -v claude >/dev/null 2>&1 || return 0
  v="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1 || true)"
  if [ -z "$v" ]; then
    err "Could not read the Claude Code version. It needs ${CLAUDE_AGENTS_MD_MIN} or later to read AGENTS.md."
  elif ! version_ge "$v" "$CLAUDE_AGENTS_MD_MIN"; then
    err "Claude Code ${v} does not read AGENTS.md; ${CLAUDE_AGENTS_MD_MIN} or later does. Update it: claude update"
  fi
  return 0
}

# --- Tool wiring (only what a tool cannot read from the standard) ---

# The guards in Claude Code's and Codex's shape, for this workbench: the
# template's entries with its path filled in, then your own from
# .agents/user-hooks.json (never written by the installer). Every command is
# marked with a leading `: contextium;` so a merge into a harness file can find
# and replace the entries it made before, and leave everything else alone.
# Rendered IN PLACE, over the template install_agents_layer just copied, so the
# file Codex and Grok Build link to is the one the layer ships. Needs jq for
# the user half.
render_hook_manifest() {
  local m="$TARGET/.agents/hooks/claude-hooks.json" user="$TARGET/.agents/user-hooks.json"
  [ -f "$m" ] || return 1
  fill_workbench "$m" || return 1
  if [ -f "$user" ] && ! command -v jq >/dev/null 2>&1; then
    # The layer refresh has just put the template here: without jq the user's
    # entries cannot be merged back, so the last run's manifest (theirs in it)
    # is kept rather than one without them.
    keep_last_good "$m" "$PREV_HOOK_MANIFEST" ".agents/user-hooks.json" nojq
  elif [ -f "$user" ]; then
    # EVERY event in the user's file — PreToolUse, PostToolUse, Stop,
    # SubagentStart, … — appended after the template's own for that event, in
    # the user's order, each group once.
    if jq --slurpfile u "$user" '
        ($u[0].hooks // {}) as $uh
        | .hooks = reduce ($uh | keys_unsorted[]) as $ev (.hooks;
            .[$ev] = ((.[$ev] // []) + [ $uh[$ev][] | .hooks = [ .hooks[]? | .command = ": contextium; " + (.command // "") ] ]
              | reduce .[] as $g ([]; if any(.[]; . == $g) then . else . + [$g] end)))
      ' "$m" >"$m.tmp" 2>/dev/null; then
      mv "$m.tmp" "$m"
    else
      rm -f "$m.tmp"
      keep_last_good "$m" "$PREV_HOOK_MANIFEST" ".agents/user-hooks.json"
    fi
  fi
  write_layer_manifest hooks
}

# A file of the user's the installer merges in could not be read, or (nojq)
# could not be merged. The manifest from the last run — their entries in it —
# is put back rather than one without them, and said: only while it was
# rendered for this workbench, and (with jq) is JSON. Args: $1=manifest $2=its
# copy from before this run $3=the user's file, as named to them $4=nojq when
# jq is missing
keep_last_good() {
  local m="$1" prev="$2" what="$3" fix="Fix the file and re-run."
  if [ "${4:-}" = "nojq" ]; then
    err "jq is not installed, so ${what} was not merged."
    fix="Install jq and re-run."
  else
    err "${what} is not valid JSON (or not the shape it documents), so this run did not read it."
  fi
  if [ -s "$prev" ] && ! grep -q "__WORKBENCH__" "$prev" && grep -qF "$TARGET/.agents/hooks/" "$prev" &&
     { ! command -v jq >/dev/null 2>&1 || jq -e . "$prev" >/dev/null 2>&1; }; then
    cp "$prev" "$m"
    err "  Kept the manifest from the last run, with your entries in it. $fix"
  else
    err "  The guards are installed without your entries. $fix"
  fi
}

# Fill in __WORKBENCH__ in an installed manifest. Args: $1=file
fill_workbench() {
  local f="$1" wb_esc
  wb_esc="$(printf '%s' "$TARGET" | sed -e 's/[\\&|]/\\&/g')"
  sed "s|__WORKBENCH__|${wb_esc}|g" "$f" >"$f.tmp" && mv "$f.tmp" "$f"
}

# Merge a Claude-shape manifest into a harness settings file: every entry an
# earlier run made (its command starts `: contextium;`) goes, the new ones are
# added, and every other key and hook stays as it was. A first write keeps the
# original beside it. Args: $1=settings file $2=manifest file
merge_hooks_into() {
  local f="$1" m="$2" tmp existed=0
  mkdir -p "$(dirname "$f")"
  # The backup is of a file the user had: one this run creates holds nothing
  # of theirs to keep.
  [ -f "$f" ] && existed=1
  [ -f "$f" ] || printf '{}\n' >"$f"
  if ! jq -e . "$f" >/dev/null 2>&1; then
    err "Left $f alone: it is not readable JSON. Add the hooks from $m to it by hand."
    return 1
  fi
  [ "$existed" = "0" ] || [ -e "$f.pre-contextium" ] || cp -p "$f" "$f.pre-contextium"
  tmp="$(mktemp)"
  # Every event: each loses the entries an earlier run made and gains the
  # manifest's, after the user's own. An event left empty by that is dropped.
  jq --slurpfile m "$m" '
    .hooks = (.hooks // {})
    | .hooks = (reduce (.hooks | keys_unsorted[]) as $ev (.hooks;
          .[$ev] = [ (.[$ev] // [])[]
            | .hooks = [ .hooks[]? | select(((.command // "") | startswith(": contextium;")) | not) ]
            | select((.hooks | length) > 0) ])
        | reduce ($m[0].hooks | keys_unsorted[]) as $ev (.; .[$ev] = ((.[$ev] // []) + $m[0].hooks[$ev]))
        | with_entries(select(.value != [])))
  ' "$f" >"$tmp" && cat "$tmp" >"$f"
  rm -f "$tmp"
}

# A home link: $1 -> $2. A link we made is replaced; a real folder or file, or
# a link pointing elsewhere, is moved aside to <path>.pre-link (never deleted)
# and said. Args: $1=link path $2=target
home_link() {
  local link="$1" target="$2" keep n
  mkdir -p "$(dirname "$link")"
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] && return 0
  fi
  if [ -e "$link" ] || [ -L "$link" ]; then
    keep="$link.pre-link"; n=2
    while [ -e "$keep" ] || [ -L "$keep" ]; do keep="$link.pre-link.$n"; n=$((n + 1)); done
    mv "$link" "$keep"
    err "moved your ${link} aside to ${keep} to link it into the workbench"
  fi
  ln -s "$target" "$link"
  ok "linked ${link} -> ${target}"
}

# The harness homes reach the workbench through links, as
# .agents/checks/check-harness-config-links.ts asserts: ~/.agents/skills always
# (Codex, Gemini CLI and VS Code read it), Claude Code's three (skills, agents,
# output styles) while tools= names Claude Code, and Antigravity's while it
# names Antigravity. unwire_dropped_tools takes them out again.
wire_home_links() {
  home_link "$HOME/.agents/skills" "$TARGET/.agents/skills"
  if [ "$WIRE_CLAUDE" = "1" ]; then
    home_link "$HOME/.claude/skills" "$HOME/.agents/skills"
    home_link "$HOME/.claude/agents" "$TARGET/.agents/agents"
    home_link "$HOME/.claude/output-styles" "$TARGET/.agents/output-styles"
  fi
  if [ "$WIRE_ANTIGRAVITY" = "1" ]; then
    home_link "$HOME/.gemini/config/skills" "$HOME/.agents/skills"
  fi
}

# The pre-tool guards, in each harness's own file. ONE manifest per format,
# in .agents/: .agents/hooks/claude-hooks.json (Claude Code, Codex, Grok
# Build), .agents/gemini-settings.json (Gemini CLI) and .agents/hooks.json
# (Antigravity, read in place) — the last two shipped only while their harness
# is among the workbench's tools (harness_file). A picked harness's hook location is a link to its
# manifest; Claude Code's is a settings file with your own keys in it, so
# the entries are merged into ~/.claude/settings.json instead, and so into a
# ~/.codex/hooks.json of your own. Grok Build reads ~/.grok/hooks/*.json and
# also ~/.claude/settings.json; the same handler twice runs once.
wire_hooks() {
  local manifest="$TARGET/.agents/hooks/claude-hooks.json" codex="$HOME/.codex/hooks.json"
  render_hook_manifest || return 0
  # A Codex link an earlier layout made to .agents/codex-hooks.json follows the
  # manifest whether or not Codex was picked this time: migrate_v7_layout
  # removes that file, and a dangling link runs no guard at all.
  if [ -L "$codex" ] && [ "$(readlink "$codex")" = "$TARGET/.agents/codex-hooks.json" ]; then
    if [ "$WIRE_CODEX" = "1" ]; then
      home_link "$codex" "$manifest"
    else
      rm -f "$codex"
      ok "removed $codex (Codex is not among this workbench's tools)"
    fi
  fi
  if [ "$WIRE_GROK" = "1" ]; then
    home_link "$HOME/.grok/hooks/contextium.json" "$manifest"
  fi
  # Linking needs no jq, so Codex's link is made before the merges that do.
  if [ "$WIRE_CODEX" = "1" ] && { [ ! -e "$codex" ] || [ -L "$codex" ]; }; then
    home_link "$codex" "$manifest"
  fi
  if ! command -v jq >/dev/null 2>&1; then
    err "jq is not installed, so the guards were not merged into any harness's settings."
    err "  Install jq and re-run, or add the hooks in $manifest by hand."
  else
    # Claude Code while tools= names it, as its links are (wire_home_links):
    # an installed Claude Code not among the tools is left alone, so that a
    # --drop-tool claude stays dropped on the next run.
    if [ "$WIRE_CLAUDE" = "1" ]; then
      merge_hooks_into "$HOME/.claude/settings.json" "$manifest" &&
        ok "merged the guards into ~/.claude/settings.json (your own settings and hooks kept)"
    fi
    if [ "$WIRE_CODEX" = "1" ] && [ -e "$codex" ] && [ ! -L "$codex" ]; then
      merge_hooks_into "$codex" "$manifest" &&
        ok "merged the guards into your ~/.codex/hooks.json"
    fi
  fi
  if [ "$WIRE_CODEX" = "1" ]; then
    info "Codex runs these guards only after you trust them once: start codex and accept the hook-trust prompt."
  fi
}

# Gemini CLI: .gemini/settings.json is a link to .agents/gemini-settings.json,
# which points it at AGENTS.md (it reads GEMINI.md by default) and carries the
# guards under hooks.BeforeTool. Gemini CLI's tool names and payload were read
# from its package, not run. Settings of your own live in
# .agents/user-gemini-settings.json (never written by the installer once it
# exists) and are merged into the linked file on every run, so they stay in
# force: a .gemini/settings.json of yours becomes that file on the first run.
# The one-line file an earlier v8 build wrote is ours and simply replaced.
wire_gemini() {
  local f="$TARGET/.gemini/settings.json" m="$TARGET/.agents/gemini-settings.json"
  local user="$TARGET/.agents/user-gemini-settings.json"
  [ -f "$m" ] || return 0
  fill_workbench "$m" || return 0
  if [ -f "$f" ] && [ ! -L "$f" ] &&
     [ "$(tr -d ' \n' <"$f")" = '{"context":{"fileName":["AGENTS.md"]}}' ]; then
    rm -f "$f"
  fi
  if [ -f "$f" ] && [ ! -L "$f" ] && [ ! -e "$user" ]; then
    mv "$f" "$user"
    ok "moved your .gemini/settings.json to .agents/user-gemini-settings.json; every run merges it"
    ok "  into .agents/gemini-settings.json, which .gemini/settings.json links to, so it stays in force"
  elif [ -e "$f" ] && [ ! -L "$f" ]; then
    err "Your .gemini/settings.json is moved aside (next line): .agents/user-gemini-settings.json"
    err "  already holds your Gemini settings. Merge what you need from it into that file and re-run."
  fi
  if [ -f "$user" ]; then
    if ! command -v jq >/dev/null 2>&1; then
      keep_last_good "$m" "$PREV_GEMINI_SETTINGS" ".agents/user-gemini-settings.json" nojq
    elif jq --slurpfile u "$user" '
        . as $t | $u[0] as $u
        | ($u * $t)
        | .context.fileName = (($t.context.fileName + ([$u.context.fileName // empty] | flatten))
            | reduce .[] as $x ([]; if any(.[]; . == $x) then . else . + [$x] end))
        | .hooks.BeforeTool = ($t.hooks.BeforeTool + ($u.hooks.BeforeTool // []))
      ' "$m" >"$m.tmp" 2>/dev/null; then
      mv "$m.tmp" "$m"
    else
      rm -f "$m.tmp"
      keep_last_good "$m" "$PREV_GEMINI_SETTINGS" ".agents/user-gemini-settings.json"
    fi
  fi
  home_link "$f" "../.agents/gemini-settings.json"
  trust_gemini_folder
}

# Gemini CLI loads a folder's .gemini/settings.json — AGENTS.md as context, the
# guards — only when the folder is trusted, and `--skip-trust` does not help: it
# takes effect after the settings have been read. So wiring Gemini CLI trusts
# the workbench in ~/.gemini/trustedFolders.json, keeping every other entry.
# An entry the installer added is recorded (GEMINI_TRUST_OURS), so --drop-tool
# gemini takes back that one and never a folder the user had trusted.
GEMINI_TRUST_OURS=0
trust_gemini_folder() {
  local f="$HOME/.gemini/trustedFolders.json" tmp
  if grep -qxF "gemini-trust	$TARGET" "$TARGET/$HARNESS_FILES_MANIFEST" 2>/dev/null; then
    GEMINI_TRUST_OURS=1
  fi
  if ! command -v jq >/dev/null 2>&1; then
    err "jq is not installed, so Gemini CLI was not told to trust this workbench. Add this entry to ~/.gemini/trustedFolders.json:"
    err "  \"$TARGET\": \"TRUST_FOLDER\""
    return 0
  fi
  mkdir -p "$HOME/.gemini"
  [ -f "$f" ] || printf '{}\n' >"$f"
  if ! jq -e 'type == "object"' "$f" >/dev/null 2>&1; then
    err "Left $f alone: it is not a JSON object. Add \"$TARGET\": \"TRUST_FOLDER\" to it by hand."
    return 0
  fi
  if jq -e --arg k "$TARGET" 'has($k)' "$f" >/dev/null 2>&1; then
    if ! jq -e --arg k "$TARGET" '.[$k] == "TRUST_FOLDER"' "$f" >/dev/null 2>&1; then
      err "Left your entry for this workbench in $f as it is: it says $(jq -c --arg k "$TARGET" '.[$k]' "$f"), not \"TRUST_FOLDER\"."
      err "  Gemini CLI loads none of AGENTS.md, the skills or the guards until it does."
    fi
    return 0
  fi
  tmp="$(mktemp)"
  jq --arg k "$TARGET" '. + {($k): "TRUST_FOLDER"}' "$f" >"$tmp" && cat "$tmp" >"$f"
  rm -f "$tmp"
  GEMINI_TRUST_OURS=1
  ok "trusted this workbench for Gemini CLI in ~/.gemini/trustedFolders.json"
}

# Take back the trust entry the installer added (recorded in the manifest), and
# only while it still says TRUST_FOLDER.
untrust_gemini_folder() {
  local f="$HOME/.gemini/trustedFolders.json" tmp
  grep -qxF "gemini-trust	$TARGET" "$TARGET/$HARNESS_FILES_MANIFEST" 2>/dev/null || return 0
  [ -f "$f" ] && command -v jq >/dev/null 2>&1 || return 0
  jq -e --arg k "$TARGET" '.[$k] == "TRUST_FOLDER"' "$f" >/dev/null 2>&1 || return 0
  tmp="$(mktemp)"
  jq --arg k "$TARGET" 'del(.[$k])' "$f" >"$tmp" && cat "$tmp" >"$f"
  rm -f "$tmp"
  ok "removed this workbench from ~/.gemini/trustedFolders.json"
}

# land.ts commits and pushes, so the workbench is a git repo with an origin.
# A target that is not its own repo is made one, on main, before anything is
# installed; ensure_first_commit commits the installed tree once it is all
# there. Sets NEW_REPO.
NEW_REPO=0
ensure_git_repo() {
  local top
  top="$(git -C "$TARGET" rev-parse --show-toplevel 2>/dev/null || true)"
  [ -n "$top" ] && [ "$(cd "$top" && pwd -P)" = "$(cd "$TARGET" && pwd -P)" ] && return 0
  git -C "$TARGET" init -q
  git -C "$TARGET" symbolic-ref HEAD refs/heads/main
  NEW_REPO=1
  ok "made ${TARGET} a git repo (branch main)"
}

# The first commit of a repo this run made: the installed tree, whole. A git
# with no identity is said, with the commands, and the install goes on.
ensure_first_commit() {
  local out
  [ "$NEW_REPO" = "1" ] || return 0
  git -C "$TARGET" add -A
  if out="$(git -C "$TARGET" commit -q -m "Install Contextium ${VERSION}" 2>&1)"; then
    ok "committed the installed tree as the first commit on main"
  else
    err "Could not make the first commit: git has no identity for you yet."
    err "  git config --global user.name \"Your Name\""
    err "  git config --global user.email you@example.com"
    err "  then: cd ${TARGET} && git commit -m \"Install Contextium\""
    printf '%s\n' "$out" | sed 's/^/  /' >&2
  fi
}

# An origin for land.ts to push to. Asked for on a terminal (blank skips); with
# gh installed and logged in, a private GitHub repo is offered, default no.
# Creating a remote is outward-facing, so --yes never does either.
ensure_origin() {
  local url name
  git -C "$TARGET" remote get-url origin >/dev/null 2>&1 && return 0
  url="$(ask "Remote URL for this workbench's origin (Enter to skip)?" "")"
  if [ -n "$url" ]; then
    git -C "$TARGET" remote add origin "$url"
    ok "added origin ${url}"
    info "Push main to it once: cd ${TARGET} && git push -u origin main"
    return 0
  fi
  name="$(basename "$TARGET")"
  if [ "$NONINTERACTIVE" != "1" ] && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1 &&
     [ "$(ask_yesno "Create a private GitHub repo ${name} with gh and push to it?" n)" = "y" ]; then
    if (cd "$TARGET" && gh repo create "$name" --private --source . --push); then
      ok "created the private GitHub repo ${name} as origin"
      return 0
    fi
    err "gh could not create ${name}."
  fi
  err "This workbench has no origin, so land.ts will refuse to land until it has one:"
  err "  cd ${TARGET} && git remote add origin <url> && git push -u origin main"
}

# A per-harness manifest: .agents/<name> ships only while its harness is among
# the workbench's tools (TOOLS: recorded, named now, less --drop-tool). Wired:
# laid down from the template (wire_gemini then renders it). Dropped: one an
# earlier run installed is removed while it is still exactly
# what that run left — its checksum is in .agents/.contextium-manifest, or for
# hooks.json it is the template itself — and kept and named once changed.
# Gemini CLI's .gemini/settings.json link to it goes with it.
# Args: $1=file name under .agents/ $2=1 when picked $3=the harness, as named
HARNESS_FILES_MANIFEST=".agents/.contextium-manifest"
INSTALLER_WROTE=""
harness_file() {
  local name="$1" picked="$2" label="$3" f="$TARGET/.agents/$1" rel=".agents/$1" sum rendered
  if [ "$picked" = "1" ]; then
    cp "$SCRIPT_DIR/templates/agents/$name" "$f"
    INSTALLER_WROTE="$INSTALLER_WROTE $name"
    return 0
  fi
  # Gemini CLI's link goes whatever happens to the file: a kept, customized
  # file must not stay the settings a dropped tool loads.
  if [ "$name" = "gemini-settings.json" ] && [ -L "$TARGET/.gemini/settings.json" ] &&
     [ "$(readlink "$TARGET/.gemini/settings.json")" = "../.agents/gemini-settings.json" ]; then
    rm -f "$TARGET/.gemini/settings.json"
    rmdir "$TARGET/.gemini" 2>/dev/null || true
  fi
  [ -f "$f" ] || return 0
  if [ -L "$f" ]; then
    err "kept ${rel} — it is a link of yours. ${label} is not among this workbench's tools, so nothing reads it; remove it when you no longer need it."
    return 0
  fi
  sum="$(cksum <"$f" | awk '{print $1, $2}')"
  # Ours: the checksum an earlier run recorded, or the template as shipped, or
  # (for a file an earlier release rendered) the template rendered for here.
  rendered="$(mktemp)"
  sed "s|__WORKBENCH__|$(printf '%s' "$TARGET" | sed -e 's/[\\&|]/\\&/g')|g" "$SCRIPT_DIR/templates/agents/$name" >"$rendered"
  if grep -qxF "${rel}	${sum}" "$TARGET/$HARNESS_FILES_MANIFEST" 2>/dev/null ||
     cmp -s "$f" "$SCRIPT_DIR/templates/agents/$name" || cmp -s "$f" "$rendered"; then
    rm -f "$f"
    ok "removed ${rel}: ${label} is not among this workbench's tools"
  else
    err "kept ${rel} — you changed it. ${label} is not among this workbench's tools, so nothing reads it; delete it when you no longer need it."
  fi
  rm -f "$rendered"
}

# Strip every entry an earlier run merged (its command starts `: contextium;`)
# from a harness settings file, keeping everything else; an event left empty
# is dropped. Args: $1=settings file
strip_hooks_from() {
  local f="$1" tmp
  [ -f "$f" ] && [ ! -L "$f" ] || return 0
  grep -qF ': contextium;' "$f" 2>/dev/null || return 0
  if ! command -v jq >/dev/null 2>&1; then
    err "jq is not installed, so the guards in $f were left in place; remove the entries starting ': contextium;' by hand."
    return 0
  fi
  tmp="$(mktemp)"
  if jq '
      if (.hooks | type) == "object" then
        .hooks = (reduce (.hooks | keys_unsorted[]) as $ev (.hooks;
            .[$ev] = [ (.[$ev] // [])[]
              | .hooks = [ .hooks[]? | select(((.command // "") | startswith(": contextium;")) | not) ]
              | select((.hooks | length) > 0) ])
          | with_entries(select(.value != [])))
      else . end' "$f" >"$tmp" 2>/dev/null; then
    cat "$tmp" >"$f"
    ok "removed the guards from $f (the rest of it kept)"
  else
    err "Left $f alone: it is not readable JSON."
  fi
  rm -f "$tmp"
}

# Remove a link only when it points where this workbench put it.
# Args: $1=link $2=the target it must name
unlink_if_ours() {
  [ -L "$1" ] && [ "$(readlink "$1")" = "$2" ] || return 0
  rm -f "$1"
  ok "removed $1"
}

# Undo the home wiring of each tool --drop-tool named (and this run did not
# name again), touching only what is ours: links that point into this
# workbench, and the `: contextium;` entries merged into a settings file. The
# per-harness files in .agents/ are harness_file's.
unwire_dropped_tools() {
  local t manifest="$TARGET/.agents/hooks/claude-hooks.json"
  for t in $DROP_TOOLS; do
    t="$(harness_key "$t")"
    case " $TOOLS " in *" $t "*) continue ;; esac
    case "$t" in
      grok) unlink_if_ours "$HOME/.grok/hooks/contextium.json" "$manifest" ;;
      codex)
        if [ -L "$HOME/.codex/hooks.json" ]; then
          unlink_if_ours "$HOME/.codex/hooks.json" "$manifest"
          unlink_if_ours "$HOME/.codex/hooks.json" "$TARGET/.agents/codex-hooks.json"
        else
          strip_hooks_from "$HOME/.codex/hooks.json"
        fi
        ;;
      claude)
        strip_hooks_from "$HOME/.claude/settings.json"
        if [ "$(readlink "$HOME/.agents/skills" 2>/dev/null)" = "$TARGET/.agents/skills" ]; then
          unlink_if_ours "$HOME/.claude/skills" "$HOME/.agents/skills"
        fi
        unlink_if_ours "$HOME/.claude/agents" "$TARGET/.agents/agents"
        unlink_if_ours "$HOME/.claude/output-styles" "$TARGET/.agents/output-styles"
        ;;
      gemini) untrust_gemini_folder ;;
      antigravity)
        # Only Antigravity reads ~/.gemini/config/skills.
        if [ "$(readlink "$HOME/.agents/skills" 2>/dev/null)" = "$TARGET/.agents/skills" ]; then
          unlink_if_ours "$HOME/.gemini/config/skills" "$HOME/.agents/skills"
        fi
        ;;
    esac
  done
}

# Record the per-harness manifests this run left, as harness_file reads them.
record_harness_files() {
  local name f
  {
    printf '# Written by the Contextium installer: the per-harness files it left in .agents/.\n'
    # Only what this run wrote: a file kept because the user changed it is
    # theirs, and recording it would make the next run delete their edits.
    for name in $INSTALLER_WROTE; do
      f="$TARGET/.agents/$name"
      [ -f "$f" ] || continue
      printf '%s\t%s\n' ".agents/$name" "$(cksum <"$f" | awk '{print $1, $2}')"
    done
    # The Gemini CLI trust entry, when the installer added it.
    if [ "$WIRE_GEMINI" = "1" ] && [ "$GEMINI_TRUST_OURS" = "1" ]; then
      printf 'gemini-trust\t%s\n' "$TARGET"
    fi
  } >"$TARGET/$HARNESS_FILES_MANIFEST"
}

# Session worktrees live inside the repo for Claude Code and Gemini CLI; keep
# them out of git. Appends only the lines that are missing.
ensure_gitignore() {
  local f="$TARGET/.gitignore" line added=""
  for line in $GITIGNORE_LINES; do
    if [ ! -f "$f" ] || ! grep -qxF "$line" "$f"; then
      if [ -z "$added" ] && [ -s "$f" ]; then
        [ -z "$(tail -c 1 "$f")" ] || printf '\n' >>"$f"
        printf '\n# Session worktrees (Contextium)\n' >>"$f"
      elif [ -z "$added" ]; then
        printf '# Session worktrees (Contextium)\n' >>"$f"
      fi
      printf '%s\n' "$line" >>"$f"
      added="$added $line"
    fi
  done
  [ -z "$added" ] || ok "added to .gitignore:${added}"
}

# --- AGENTS.md: your text kept, Contextium's blocks replaced ---

AUTONOMY_ASK_LINE="Ask before host or infrastructure changes; diagnose and propose freely, but get a yes before mutating shared infra."
AUTONOMY_AUTO_LINE="Act and report on routine work; only stop to ask when genuinely stuck."

# `cksum` of the v6.0.0 and v7.0.0 AGENTS.md templates with their placeholders
# in place. An installed one that normalizes to either was never edited.
PRE_V8_AGENTS_MD_CKSUMS="2363100528 6310|3343248693 7742"

# Render the template for a name and an autonomy. Args: $1=name $2=ask|autonomous
render_agents_md() {
  local line name_esc line_esc
  if [ "$2" = "autonomous" ]; then line="$AUTONOMY_AUTO_LINE"; else line="$AUTONOMY_ASK_LINE"; fi
  # The name is whatever the user typed, and it lands in a sed REPLACEMENT,
  # where \ & and the / delimiter all mean something.
  name_esc="$(printf '%s' "$1" | sed -e 's/[\\&/]/\\&/g')"
  line_esc="$(printf '%s' "$line" | sed -e 's/[\\&/]/\\&/g')"
  sed -e "s/{{NAME}}/$name_esc/g" -e "s/{{AUTONOMY}}/$line_esc/g" "$SCRIPT_DIR/templates/agents/AGENTS.md"
}

# The name and autonomy a v6/v7 AGENTS.md was written with, so replacing an
# unchanged one keeps them. Args: $1=file
pre_v8_name() {
  sed -n "3s/^The working surface for \\(.*\\)'s repo, and the canonical one:.*/\\1/p" "$1"
}
pre_v8_autonomy() {
  if grep -qxF -- "- $AUTONOMY_AUTO_LINE" "$1"; then echo autonomous; else echo ask; fi
}

# True when a pre-v8 AGENTS.md is still exactly the template it was rendered
# from. Args: $1=file
is_pristine_pre_v8() {
  local sum
  sum="$(awk -v sq="'" -v ask="- $AUTONOMY_ASK_LINE" -v auto="- $AUTONOMY_AUTO_LINE" '
    NR == 3 && index($0, "The working surface for ") == 1 {
      p = index($0, sq "s repo, and the canonical one:")
      if (p) $0 = "The working surface for {{NAME}}" substr($0, p)
    }
    $0 == ask || $0 == auto { $0 = "- {{AUTONOMY}}" }
    { print }
  ' "$1" | cksum | awk '{print $1, $2}')"
  case "|$PRE_V8_AGENTS_MD_CKSUMS|" in *"|$sum|"*) return 0 ;; esac
  return 1
}

# Merge template blocks into a user file: each `<!-- contextium:<name> -->` …
# `<!-- /contextium -->` block in the user file is replaced by the template's
# block of that name, a block the template no longer has is dropped, and a
# template block the file lacks is appended at the end. Every other line is
# copied through untouched. Exit 3 when the user file leaves a block unclosed.
# Args: $1=template $2=user file; the result on stdout.
merge_contextium_blocks() {
  awk '
    function block_name(s) { return substr(s, 17, length(s) - 20) }
    FNR == NR {
      if ($0 ~ /^<!-- contextium:[a-z0-9-]+ -->$/) {
        cur = block_name($0); order[++k] = cur; blk[cur] = $0; next
      }
      if (cur != "") {
        blk[cur] = blk[cur] "\n" $0
        if ($0 == "<!-- /contextium -->") cur = ""
      }
      next
    }
    skipping { if ($0 == "<!-- /contextium -->") skipping = 0; next }
    /^<!-- contextium:[a-z0-9-]+ -->$/ {
      n = block_name($0); skipping = 1
      if ((n in blk) && !(n in done)) { print blk[n]; done[n] = 1 }
      next
    }
    { print }
    END {
      if (skipping) exit 3
      for (i = 1; i <= k; i++) if (!(order[i] in done)) { print ""; print blk[order[i]] }
    }
  ' "$1" "$2"
}

# Write .agents/AGENTS.md. Absent: the rendered template. --force: the template,
# the old file kept beside it. A v8 file: only its Contextium blocks are
# replaced. An unchanged v6/v7 one: replaced whole. An edited v6/v7 one: kept,
# backed up, with the Contextium blocks appended for the user to reconcile.
# Args: $1=name $2=autonomy
install_agents_md() {
  local dst="$TARGET/.agents/AGENTS.md" tmp bak rc=0
  mkdir -p "$TARGET/.agents"
  [ -f "$SCRIPT_DIR/templates/agents/AGENTS.md" ] || { err "template AGENTS.md is missing from this clone."; return 1; }
  tmp="$(mktemp)"
  render_agents_md "$1" "$2" >"$tmp"

  if [ ! -f "$dst" ]; then
    mv "$tmp" "$dst"
    ok "installed .agents/AGENTS.md (personalized for $1)"
  elif [ "$FORCE" = "1" ]; then
    bak="$(move_aside_as "$dst" bak)"
    mv "$tmp" "$dst"
    ok "replaced .agents/AGENTS.md (yours is at ${bak#"$TARGET"/})"
  elif grep -q '^<!-- contextium:[a-z0-9-]* -->$' "$dst"; then
    merge_contextium_blocks "$tmp" "$dst" >"$tmp.merged" || rc=$?
    if [ "$rc" -ne 0 ]; then
      err "Left .agents/AGENTS.md alone: a <!-- contextium:… --> block in it is never closed."
      err "  Close it with <!-- /contextium --> and re-run to refresh the Contextium sections."
    elif cmp -s "$tmp.merged" "$dst"; then
      ok "kept .agents/AGENTS.md (its Contextium sections are current)"
    else
      cat "$tmp.merged" >"$dst"
      ok "refreshed the Contextium sections of .agents/AGENTS.md (your text untouched)"
    fi
    rm -f "$tmp" "$tmp.merged"
  elif is_pristine_pre_v8 "$dst"; then
    mv "$tmp" "$dst"
    ok "replaced .agents/AGENTS.md (it was the unchanged template of an earlier version)"
  else
    merge_contextium_blocks "$tmp" "$dst" >"$tmp.merged"
    bak="$(move_aside_as "$dst" bak)"
    mv "$tmp.merged" "$dst"
    rm -f "$tmp"
    err "Your .agents/AGENTS.md predates v8, so it was kept and the Contextium sections were"
    err "  appended to it (the original is at ${bak#"$TARGET"/}). Delete the old sections they"
    err "  replace — What lives where, The Loop, Memory, Enforcement, Principles — and keep yours."
  fi
}

# Move a path aside under the first free `<path>.<suffix>`, `.2`, …; echo it.
# Args: $1=path $2=suffix
move_aside_as() {
  local dst="$1.$2" n=2
  while [ -e "$dst" ] || [ -L "$dst" ]; do
    dst="$1.$2.$n"
    n=$((n + 1))
  done
  cp -p "$1" "$dst"
  printf '%s' "$dst"
}

# --- v7 -> v8: remove what the layer stopped writing, when it is ours ---

# remove_legacy <dir-or-file> — every file under it listed in install-legacy.tsv
# with its checksum still matching goes; anything else there is the user's and
# is listed in $LEFT. Empty folders it leaves behind go too.
remove_legacy() {
  local rel="$1" f frel sum
  [ -e "$TARGET/$rel" ] || return 0
  while IFS= read -r f; do
    frel="${f#"$TARGET"/}"
    sum="$(cksum <"$f" | awk '{print $1, $2}')"
    if grep -qxF "${frel}	${sum}" "$LEGACY_LIST" 2>/dev/null; then
      rm -f "$f"
      REMOVED="$REMOVED $frel"
    else
      LEFT="$LEFT $frel"
    fi
  done < <(find "$TARGET/$rel" -type f 2>/dev/null | LC_ALL=C sort)
  if [ -d "$TARGET/$rel" ]; then
    find "$TARGET/$rel" -depth -type d -empty -exec rmdir {} \; 2>/dev/null || true
  fi
  return 0
}

# The first line of every file the old projector generated.
GEN_MARK="Generated from .agents/AGENTS.md"

# The layer an earlier release generated its per-tool copies from, as it stood
# before this run replaced it: .agents/AGENTS.md, rules/ and skills/. Taken
# only when such a copy exists. Sets LEGACY_SNAP (empty when not taken).
LEGACY_SNAP=""
snapshot_legacy_layer() {
  local rel found=0
  for rel in GEMINI.md .cursor/rules/contextium.mdc .github/copilot-instructions.md .gemini/commands .github/prompts; do
    [ -e "$TARGET/$rel" ] && found=1
  done
  [ "$found" = "1" ] || return 0
  LEGACY_SNAP="$(mktemp -d)"
  for rel in AGENTS.md rules skills; do
    [ ! -e "$TARGET/.agents/$rel" ] || cp -R "$TARGET/.agents/$rel" "$LEGACY_SNAP/$rel"
  done
}

# Remove a per-tool copy an earlier projector generated, only while it is
# exactly what that projector wrote from the snapshot. The marker it carries
# says who wrote it first, not that nobody edited it since: an edited one is
# kept and named. Args: $1=path from the workbench root $2=marker $3=hint
remove_generated() {
  local rel="$1" mark="$2" hint="$3" expect
  if ! grep -qF -- "$mark" "$TARGET/$rel" 2>/dev/null; then
    err "kept ${rel} — Contextium did not write it. $hint"
    return 0
  fi
  if ! have_node; then
    err "kept ${rel} — Node 22.6 or later is not installed, so it could not be compared with what Contextium generated. $hint Install Node and re-run to have it removed, or delete it yourself if you never edited it."
    return 0
  fi
  expect="$(mktemp)"
  if [ -n "$LEGACY_SNAP" ] &&
     node --experimental-strip-types "$SCRIPT_DIR/install-legacy-projection.ts" "$LEGACY_SNAP" "$rel" >"$expect" 2>/dev/null &&
     cmp -s "$expect" "$TARGET/$rel"; then
    rm -f "$TARGET/$rel"
    REMOVED="$REMOVED $rel"
  else
    err "kept ${rel} — you edited it after Contextium generated it. $hint Delete it when you have what you need."
  fi
  rm -f "$expect"
}

# Remove a directory when it is empty. Args: relpaths, deepest first
rmdir_if_empty() {
  local rel
  for rel in "$@"; do
    [ -d "$TARGET/$rel" ] && [ ! -L "$TARGET/$rel" ] && [ -z "$(ls -A "$TARGET/$rel" 2>/dev/null)" ] &&
      rmdir "$TARGET/$rel"
  done
  return 0
}

migrate_v7_layout() {
  local f rel name hp
  REMOVED=""

  # The Codex manifest an earlier v8 build rendered beside the template; the
  # template is rendered in place now, and wire_hooks has moved any link.
  if [ -f "$TARGET/.agents/codex-hooks.json" ] && [ ! -L "$TARGET/.agents/codex-hooks.json" ]; then
    rm -f "$TARGET/.agents/codex-hooks.json"
    REMOVED="$REMOVED .agents/codex-hooks.json"
  fi

  # Folders v8 no longer writes: rules (now AGENTS.md § Standards), the old
  # reviewer and review-script folders (now .agents/agents and the review
  # skill), and the in-repo git hooks and .claude/ half (the checks run from
  # land.ts; hooks and links live in the harness homes).
  LEFT=""
  remove_legacy .agents/rules
  if [ -n "$LEFT" ]; then
    err "kept your own rule files:${LEFT}"
    err "  No tool loads .agents/rules/ at startup. Move each into AGENTS.md as a standard,"
    err "  in a section outside the Contextium blocks, then delete the folder."
  fi
  for rel in .agents/reviewers .agents/scripts; do
    LEFT=""
    remove_legacy "$rel"
    [ -z "$LEFT" ] || err "kept${LEFT} — Contextium did not write it. Nothing runs from ${rel}/ now."
  done

  LEFT=""
  remove_legacy .githooks
  if [ -n "$LEFT" ]; then
    err "kept${LEFT} — Contextium did not write it. v8 has no git hooks: land.ts runs the"
    err "  checks before each commit. Move what you need into your own hooks and delete .githooks/."
  fi
  if [ ! -e "$TARGET/.githooks" ] && [ -d "$TARGET/.git" ] &&
     [ "$(git -C "$TARGET" config --get core.hooksPath 2>/dev/null || true)" = ".githooks" ]; then
    git -C "$TARGET" config --unset core.hooksPath
    REMOVED="$REMOVED core.hooksPath=.githooks"
  fi

  # The in-repo .claude/: links first, then the files, by checksum.
  for hp in skills:../.agents/skills agents:../.agents/reviewers rules:../.agents/rules templates:../.agents/templates; do
    f="$TARGET/.claude/${hp%%:*}"
    if [ -L "$f" ] && [ "$(readlink "$f")" = "${hp#*:}" ]; then
      rm -f "$f"
      REMOVED="$REMOVED .claude/${hp%%:*}"
    fi
  done
  LEFT=""
  for rel in .claude/hooks .claude/output-styles .claude/settings.json .claude/CLAUDE.md; do
    remove_legacy "$rel"
  done
  if [ -n "$LEFT" ]; then
    err "kept${LEFT} — Contextium did not write it."
    case "$LEFT" in
      *.claude/CLAUDE.md*) err "  While .claude/CLAUDE.md exists, Claude Code reads it instead of AGENTS.md: move what you need into AGENTS.md and delete it." ;;
    esac
    case "$LEFT" in
      *.claude/settings.json*) err "  .claude/settings.json still wires hooks from .claude/hooks/, which v8 does not ship; the guards now live in ~/.claude/settings.json." ;;
    esac
  fi
  rmdir_if_empty .claude

  # Links the projector made.
  for rel in .claude/rules:../.agents/rules .codex/skills:../.agents/skills; do
    f="${rel%%:*}"
    if [ -L "$TARGET/$f" ] && [ "$(readlink "$TARGET/$f")" = "${rel#*:}" ]; then
      rm -f "$TARGET/$f"
      REMOVED="$REMOVED $f"
    fi
  done
  if [ -d "$TARGET/.cursor/commands" ]; then
    for f in "$TARGET"/.cursor/commands/*.md; do
      [ -L "$f" ] || continue
      name="$(basename "$f" .md)"
      [ "$(readlink "$f")" = "../../.agents/skills/$name/SKILL.md" ] || continue
      rm -f "$f"
      REMOVED="$REMOVED .cursor/commands/$name.md"
    done
  fi

  # Generated copies of AGENTS.md and of the skills: removed only while they
  # are byte for byte what the projector wrote (legacy_generated).
  for rel in GEMINI.md .cursor/rules/contextium.mdc .github/copilot-instructions.md; do
    [ -f "$TARGET/$rel" ] || continue
    case "$rel" in
      GEMINI.md) remove_generated "$rel" "$GEN_MARK" "Gemini CLI now reads AGENTS.md; add GEMINI.md to context.fileName in .agents/user-gemini-settings.json to keep it." ;;
      *) remove_generated "$rel" "$GEN_MARK" "The tool reads AGENTS.md now." ;;
    esac
  done
  for f in "$TARGET"/.gemini/commands/*.toml "$TARGET"/.github/prompts/*.prompt.md; do
    [ -f "$f" ] || continue
    remove_generated "${f#"$TARGET"/}" "# skill definition" "The tool reads .agents/skills/ now."
  done

  # Only folders this run emptied; an empty folder of the user's stays.
  for rel in .codex .cursor/commands .cursor/rules .cursor .gemini/commands .gemini .github/prompts .github; do
    case "$REMOVED " in *" $rel/"*) rmdir_if_empty "$rel" ;; esac
  done
  # One line, a folder's files counted rather than listed.
  if [ -n "$REMOVED" ]; then
    # shellcheck disable=SC2086  # split on purpose: one removed path per word
    ok "removed what earlier versions installed: $(printf '%s\n' $REMOVED | awk '
      { p = $0; if (p ~ /^\.(agents\/(rules|reviewers|scripts)|claude\/(hooks|output-styles)|githooks|cursor\/commands|gemini\/commands|github\/prompts)\//) { sub(/\/[^\/]*$/, "/", p); sub(/^\.agents\/rules\/.*/, ".agents/rules/", p); sub(/^\.githooks\/.*/, ".githooks/", p) }
        if (!(p in n)) order[++k] = p; n[p]++ }
      END { for (i = 1; i <= k; i++) printf "%s%s%s", (i > 1 ? ", " : ""), order[i], (n[order[i]] > 1 ? " (" n[order[i]] " files)" : "") }')"
  fi
  return 0
}

usage() {
  cat <<EOF
Usage: bash install.sh [TARGET_DIR] [options]

  TARGET_DIR              your workbench (default: prompted, else ~/code/workbench)

Options:
  --harness NAME          the tool you drive this repo with, without the question:
                          t3 (recommended), claude, codex, cursor, vscode, gemini,
                          antigravity, grok
  --agents "claude codex" with T3 Code: the agent(s) it runs (default claude)
  --install-missing       install the chosen tool if it is missing, without asking
  --tools "a b"           older form: the first is the harness (copilot = vscode),
                          and each named tool is wired
  --all-tools             older form: Claude Code, wiring Codex, Gemini CLI,
                          Grok Build and Antigravity as well
  --drop-tool NAME        stop wiring NAME in this workbench (repeatable). Every
                          tool a run wires is recorded in .agents/harness and
                          stays wired on later runs until dropped; a dropped
                          tool's files go while they are still as installed
  --force                 replace a customized .agents/AGENTS.md (kept as .bak)
  --name "Your Name"      set the name without prompting
  --autonomy ask|autonomous   set autonomy without prompting
  --integrations "a b c"  install these integration starters without prompting
  --no-integrations       start with an empty integrations/ (README stub only)
  --hooks / --no-hooks    accepted and ignored: v8 has no git hooks (land.ts runs
                          the checks before each commit)
  --yes                   non-interactive; accept defaults, never prompt, and never
                          install software unless --install-missing is also given
  -h, --help              show this help

Everything lives once, in .agents/. AGENTS.md at the root links to it and the
skills are .agents/skills/, which most tools read as they are; the harness
homes reach the workbench through links, and each wired harness's hooks link
to (or have merged in) the one manifest for its format. Re-running refreshes
what the layer ships and keeps what you added, replaces only the Contextium
blocks of AGENTS.md, and never touches your data dirs. A new workbench is made
a git repo on main; a remote is created only when you say yes on a terminal.
EOF
}

# --- Arg parsing ---

# Keep the untouched argv. The parse loop below shifts it away, and the bootstrap
# path (script piped in on its own, no repo around it) has to hand the SAME args
# to the fetched copy — otherwise a `curl ... | bash -s -- ~/myproject` silently
# installs into the current directory instead.
ORIG_ARGS=("$@")

TARGET=""
FORCE="0"
NONINTERACTIVE="0"
INSTALL_MISSING="0"
ARG_NAME=""
ARG_AUTONOMY=""
ARG_INTEGRATIONS=""
INTEGRATIONS_GIVEN="0"
ARG_HARNESS=""
ARG_AGENTS=""
EXTRA_WIRE=""
DROP_TOOLS=""

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE="1"; shift ;;
    --yes|-y) NONINTERACTIVE="1"; shift ;;
    --install-missing) INSTALL_MISSING="1"; shift ;;
    --name) ARG_NAME="${2:-}"; shift 2 ;;
    --autonomy) ARG_AUTONOMY="${2:-}"; shift 2 ;;
    --harness) ARG_HARNESS="${2:-}"; shift 2 ;;
    --agents) ARG_AGENTS="${2:-}"; shift 2 ;;
    --tools) EXTRA_WIRE="${2:-}"; shift 2 ;;
    --all-tools) EXTRA_WIRE="claude codex gemini grok antigravity"; shift ;;
    --drop-tool) DROP_TOOLS="$DROP_TOOLS ${2:-}"; shift 2 ;;
    --integrations) ARG_INTEGRATIONS="${2:-}"; INTEGRATIONS_GIVEN="1"; shift 2 ;;
    --no-integrations) ARG_INTEGRATIONS=""; INTEGRATIONS_GIVEN="1"; shift ;;
    --hooks|--no-hooks) shift ;;
    -h|--help) usage; exit 0 ;;
    -*) err "Unknown option: $1"; usage >&2; exit 1 ;;
    *) TARGET="$1"; shift ;;
  esac
done

# The older --tools list: its first valid entry is the harness, unless
# --harness was given too.
if [ -n "$EXTRA_WIRE" ] && [ -z "$ARG_HARNESS" ]; then
  for t in $EXTRA_WIRE; do
    k="$(harness_key "$t")"
    if [ -n "$k" ]; then ARG_HARNESS="$k"; break; fi
  done
fi
if [ -n "$ARG_HARNESS" ]; then
  k="$(harness_key "$ARG_HARNESS")"
  if [ -z "$k" ]; then
    err "Unknown harness '$ARG_HARNESS' (one of: $HARNESSES)."
    exit 1
  fi
  ARG_HARNESS="$k"
fi

# --- Main ---

banner

# The layer payload has to sit next to this script. It doesn't when the script
# arrives on its own — which is exactly what `curl -sSL contextium.ai/install |
# bash` does, and that is the install command on the front page. Fetch the repo
# and hand off to the real copy rather than telling the user to go clone it.
# CONTEXTIUM_BOOTSTRAPPED guards against a clone that somehow still lacks the
# payload re-entering this branch forever.
if [ ! -f "$SCRIPT_DIR/templates/agents/AGENTS.md" ] ||
   [ ! -d "$SCRIPT_DIR/templates/agents/skills" ] ||
   [ ! -f "$SCRIPT_DIR/install-legacy.tsv" ]; then
  if [ "${CONTEXTIUM_BOOTSTRAPPED:-0}" = "1" ]; then
    err "Fetched the template but its payload is incomplete (templates/agents/)."
    err "Please open an issue: https://github.com/Ashkaan/contextium/issues"
    exit 1
  fi
  command -v git >/dev/null 2>&1 || {
    err "git is required to install Contextium. Install git and re-run."
    exit 1
  }
  info "Fetching the Contextium template..."
  BOOTSTRAP_DIR="$(mktemp -d)"
  if ! git clone --quiet --depth 1 https://github.com/Ashkaan/contextium.git \
       "$BOOTSTRAP_DIR/contextium" 2>/dev/null; then
    rm -rf "$BOOTSTRAP_DIR"
    err "Could not clone https://github.com/Ashkaan/contextium.git"
    exit 1
  fi
  ok "fetched the template"
  # Run rather than exec, so the clone gets cleaned up afterwards. The child's
  # exit code is this script's exit code.
  export CONTEXTIUM_BOOTSTRAPPED=1
  set +e
  bash "$BOOTSTRAP_DIR/contextium/install.sh" ${ORIG_ARGS[@]+"${ORIG_ARGS[@]}"}
  bootstrap_rc=$?
  set -e
  rm -rf "$BOOTSTRAP_DIR"
  exit "$bootstrap_rc"
fi


# The harness question comes first. Its default is the answer an earlier install
# recorded, when the target is already known.
if [ -n "$TARGET" ] && [ -d "$TARGET" ]; then
  TARGET="$(cd "$TARGET" && pwd)"
fi
DEFAULT_HARNESS="t3"
if [ -n "$TARGET" ] && [ -n "$(harness_file_value harness)" ]; then
  DEFAULT_HARNESS="$(harness_key "$(harness_file_value harness)")"
  [ -n "$DEFAULT_HARNESS" ] || DEFAULT_HARNESS="t3"
fi
HARNESS="${ARG_HARNESS:-$(choose_harness "$DEFAULT_HARNESS")}"

T3_AGENTS=""
if [ "$HARNESS" = "t3" ]; then
  DEFAULT_AGENTS="claude"
  if [ -n "$TARGET" ] && [ "$(harness_file_value harness)" = "t3" ]; then
    case "$(harness_file_value agent)" in claude|codex) DEFAULT_AGENTS="$(harness_file_value agent)" ;; esac
  fi
  for a in ${ARG_AGENTS:-$(choose_t3_agents "$DEFAULT_AGENTS")}; do
    case "$a" in
      claude|codex) T3_AGENTS="$T3_AGENTS $a" ;;
      *) err "T3 Code runs claude or codex; ignoring '$a'." ;;
    esac
  done
  T3_AGENTS="${T3_AGENTS# }"
  [ -n "$T3_AGENTS" ] || T3_AGENTS="claude"
  AGENT="${T3_AGENTS%% *}"
else
  AGENT="$(harness_agent "$HARNESS")"
fi
printf '\n'

# A tool named this run cannot be dropped in the same run: the harness would
# stay wired while the record said otherwise.
NAMED_TOOLS="$HARNESS"
[ "$HARNESS" != "t3" ] || NAMED_TOOLS="$NAMED_TOOLS $T3_AGENTS"
for t in $EXTRA_WIRE; do NAMED_TOOLS="$NAMED_TOOLS $(harness_key "$t")"; done
for t in $DROP_TOOLS; do
  if [ -z "$(harness_key "$t")" ]; then
    err "Unknown tool '$t' for --drop-tool (one of: $HARNESSES)."
    exit 1
  fi
  case " $NAMED_TOOLS " in
    *" $(harness_key "$t") "*)
      err "Cannot drop $t: this run wires it (harness=$HARNESS${T3_AGENTS:+, agents: $T3_AGENTS})."
      err "  Pick the tool you drive the workbench with now: --harness <name> (and --agents for T3 Code), then --drop-tool $t."
      exit 1
      ;;
  esac
done

# Anything the choice needs that is not installed: offered, never forced.
offer_install "$HARNESS"
for a in $T3_AGENTS; do offer_install "$a"; done
printf '\n'

# Resolve target directory.
DEFAULT_TARGET="$HOME/code/workbench"
if [ -z "$TARGET" ]; then
  TARGET="$(ask 'Where is your workbench (the repo that holds every project)?' "$DEFAULT_TARGET")"
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
if [ -d "$TARGET/.agents" ] || [ -d "$TARGET/.claude" ] || [ -e "$TARGET/AGENTS.md" ]; then
  MODE="refresh"
  info "Existing Contextium install found in ${TARGET} — refreshing."
else
  MODE="fresh"
  info "Fresh install into ${TARGET}."
fi
printf '\n'

# Gather the minimal profile. An unchanged earlier AGENTS.md about to be
# replaced supplies its own name and autonomy as the defaults.
OLD_AGENTS_MD="$TARGET/.agents/AGENTS.md"
DEFAULT_NAME="${USER:-developer}"
DEFAULT_AUTONOMY="ask"
if [ -f "$OLD_AGENTS_MD" ] && [ -n "$(pre_v8_name "$OLD_AGENTS_MD")" ]; then
  DEFAULT_NAME="$(pre_v8_name "$OLD_AGENTS_MD")"
  DEFAULT_AUTONOMY="$(pre_v8_autonomy "$OLD_AGENTS_MD")"
fi
NAME="$ARG_NAME"
if [ -z "$NAME" ]; then
  NAME="$(ask "What's your name?" "$DEFAULT_NAME")"
fi

AUTONOMY="$ARG_AUTONOMY"
case "$AUTONOMY" in
  ask|autonomous) : ;;
  "") AUTONOMY="$(choose_autonomy "$DEFAULT_AUTONOMY")" ;;
  *) err "Invalid --autonomy '$AUTONOMY' (use ask|autonomous); defaulting to ask."; AUTONOMY="ask" ;;
esac
printf '\n'

ensure_git_repo
# The manifests as the last run left them, for keep_last_good: the layer
# refresh replaces them before the user's files are merged back in.
PREV_HOOK_MANIFEST="$(mktemp)"
PREV_GEMINI_SETTINGS="$(mktemp)"
trap 'rm -f "$PREV_HOOK_MANIFEST" "$PREV_GEMINI_SETTINGS"; [ -z "$LEGACY_SNAP" ] || rm -rf "$LEGACY_SNAP"' EXIT
[ ! -f "$TARGET/.agents/hooks/claude-hooks.json" ] || cp "$TARGET/.agents/hooks/claude-hooks.json" "$PREV_HOOK_MANIFEST"
[ ! -f "$TARGET/.agents/gemini-settings.json" ] || cp "$TARGET/.agents/gemini-settings.json" "$PREV_GEMINI_SETTINGS"
info "Installing the layer (.agents/) for $(harness_label "$HARNESS" | awk '{ sub(/  +.*/, ""); print }')..."
snapshot_legacy_layer
install_agents_layer
install_agents_md "$NAME" "$AUTONOMY"
link_root_agents_md
# The tools this workbench wires: every one an earlier run recorded, less any
# --drop-tool, plus the harness, T3 Code's agents and each --tools entry named
# now. A tool is never unwired because another was picked: using two tools on
# one workbench is normal, and a re-run for one must not strip the other.
TOOLS=""
for t in $(recorded_tools); do
  case " $DROP_TOOLS " in *" $t "*) continue ;; esac
  add_tool "$(harness_key "$t")"
done
add_tool "$HARNESS"
[ "$HARNESS" != "t3" ] || for t in $T3_AGENTS; do add_tool "$t"; done
for t in $EXTRA_WIRE; do add_tool "$(harness_key "$t")"; done
write_harness_file "$HARNESS" "$AGENT" "$TOOLS"

# A tool folder only for what the tool cannot read from AGENTS.md and
# .agents/skills/ itself.
WIRE_CLAUDE=0
WIRE_CODEX=0
WIRE_GEMINI=0
WIRE_GROK=0
WIRE_ANTIGRAVITY=0
for t in $TOOLS; do
  case "$t" in
    claude) WIRE_CLAUDE=1 ;;
    codex) WIRE_CODEX=1 ;;
    gemini) WIRE_GEMINI=1 ;;
    grok) WIRE_GROK=1 ;;
    antigravity) WIRE_ANTIGRAVITY=1 ;;
  esac
done
harness_file hooks.json "$WIRE_ANTIGRAVITY" "Antigravity"
harness_file gemini-settings.json "$WIRE_GEMINI" "Gemini CLI"
unwire_dropped_tools
info "Linking the harness homes to the workbench..."
wire_home_links
wire_hooks
[ "$WIRE_CLAUDE" = "1" ] && check_claude_version
if [ "$WIRE_GEMINI" = "1" ]; then
  wire_gemini
fi
record_harness_files

# Seed protected data dirs (only when absent).
for rel in $PROTECTED_DIRS; do
  seed_dir "$rel"
done

# Upgrades: take out what earlier versions left that this one no longer writes.
migrate_legacy_layout
migrate_v6_layout
migrate_v7_layout
ensure_gitignore

# Integration starters: pick, then copy the selected ones.
SELECTED_INTEGRATIONS="$(choose_integrations)"
install_integrations "$SELECTED_INTEGRATIONS"
ensure_first_commit
ensure_origin
printf '\n'

# The links and manifests, checked the way the check reports them any time. A
# failed check is not a ready install, and the banner says so.
LINKS_OK=1
if [ -f "$TARGET/.agents/checks/check-harness-config-links.ts" ] && [ -d "$TARGET/.git" ]; then
  if ! have_node; then
    # The check is TypeScript; without Node it cannot run, and neither can
    # /close. The install stands, but it is not called ready.
    LINKS_OK=0
    err "The harness links and hook manifests were not checked: Node 22.6 or later is not installed,"
    err "  and the check runs on it, as does every script in .agents/ (/close among them)."
    err "  Install Node, then re-run."
  elif links_out="$(cd "$TARGET" && node --experimental-strip-types .agents/checks/check-harness-config-links.ts 2>&1)"; then
    ok "${links_out##*$'\n'}"
  else
    LINKS_OK=0
    err "The harness links or hook manifests are not right yet:"
    printf '%s\n' "$links_out" | sed 's/^/  /' >&2
  fi
fi
printf '\n'

# --- Next steps ---

if [ "$LINKS_OK" = "1" ]; then
  printf '%s\n' "${GREEN}=========================================${NC}"
  printf '%s\n' "${GREEN}  Contextium ${VERSION} ready in ${TARGET}${NC}"
  printf '%s\n' "${GREEN}=========================================${NC}"
else
  printf '%s\n' "${YELLOW}=========================================${NC}"
  printf '%s\n' "${YELLOW}  Contextium ${VERSION} installed in ${TARGET}${NC}"
  printf '%s\n' "${YELLOW}  but not ready: fix what the check above names, then re-run.${NC}"
  printf '%s\n' "${YELLOW}=========================================${NC}"
fi
printf '\n'
if [ "$MODE" = "refresh" ]; then
  printf '%s\n' "Refreshed the layer. Your data dirs, and your text in AGENTS.md, were left as they were."
  printf '\n'
fi
case "$HARNESS" in
  t3)          printf '%s\n' "Open ${BOLD}${TARGET}${NC} as a project in ${BOLD}T3 Code${NC}, start a thread (${T3_AGENTS}), and type ${BOLD}\$project${NC}." ;;
  claude)      printf '%s\n' "Run ${BOLD}cd ${TARGET} && claude${NC}, then ${BOLD}/project${NC}." ;;
  codex)       printf '%s\n' "Run ${BOLD}cd ${TARGET} && codex${NC}, then ${BOLD}\$project${NC} (Codex names skills with \$)." ;;
  cursor)      printf '%s\n' "Open ${BOLD}${TARGET}${NC} in ${BOLD}Cursor${NC} and run ${BOLD}/project${NC} in the agent." ;;
  vscode)      printf '%s\n' "Open ${BOLD}${TARGET}${NC} in ${BOLD}VS Code${NC} and run ${BOLD}/project${NC} in Copilot chat (agent mode)." ;;
  gemini)      printf '%s\n' "Run ${BOLD}cd ${TARGET} && gemini${NC}, then ${BOLD}/project${NC}. The folder is trusted in ~/.gemini/trustedFolders.json: trust controls whether Gemini CLI loads AGENTS.md and the guards (and the skills). A headless run in another trust setup needs ${BOLD}GEMINI_CLI_TRUST_WORKSPACE=true${NC}; --skip-trust does not load them." ;;
  antigravity) printf '%s\n' "Run ${BOLD}cd ${TARGET} && agy${NC}, then ${BOLD}/project${NC}." ;;
  grok)        printf '%s\n' "Run ${BOLD}cd ${TARGET} && grok --trust${NC}, then ${BOLD}/project${NC}. Grok loads AGENTS.md and project skills only in a trusted folder." ;;
esac
printf '\n'
printf '%s\n' "Everything lives once: ${BOLD}AGENTS.md${NC} (a link to .agents/AGENTS.md) and ${BOLD}.agents/skills/${NC}."
printf '%s\n' "Change your preferences and stack in AGENTS.md outside the Contextium blocks, and"
printf '%s\n' "put hooks of your own in ${BOLD}.agents/user-hooks.json${NC}; a re-run merges them in."
printf '%s\n' "/close runs the checks before every commit it makes, whichever tool made the change."
printf '\n'
