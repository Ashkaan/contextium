#!/usr/bin/env bash
# project-rules.sh — give each AI tool its native config, from the ONE canonical
# copy in the target project's .agents/ directory.
#
# .agents/ is canonical. Every tool that reads the same file format gets a
# SYMLINK into it, so there is exactly one copy of each skill on disk and editing
# any path edits the same file. Only the tools whose format genuinely differs get
# a generated file, and those are regenerated from .agents/ on every run.
#
# Sources (inside TARGET_DIR, laid down by install.sh before this runs):
#   .agents/AGENTS.md            the working agreement, already personalized
#   .agents/rules/*.md           the principle rules
#   .agents/skills/*/SKILL.md    the Loop and its reviewers
#
# Per-tool output (inside TARGET_DIR):
#   claude   .claude/skills -> ../.agents/skills          (symlink)
#            .claude/rules -> ../.agents/rules            (symlink)
#            .claude/agents -> ../.agents/reviewers       (symlink)
#            (.claude/CLAUDE.md is install.sh's, not this script's — it carries
#             the --force and pre-v6-migration logic this script has no part in)
#   codex    .codex/skills -> ../.agents/skills           (symlink)
#   cursor   .cursor/commands/<name>.md -> the SKILL.md   (symlink per skill)
#            .cursor/rules/contextium.mdc                 (generated — .mdc frontmatter)
#   gemini   GEMINI.md                                    (generated)
#            .gemini/commands/<name>.toml                 (generated — TOML)
#   copilot  .github/copilot-instructions.md              (generated)
#            .github/prompts/<name>.prompt.md             (generated — prompt frontmatter)
#
# The root AGENTS.md -> .agents/AGENTS.md symlink is NOT per-tool: install.sh
# creates it with the canonical layer, because the docs, CLAUDE.md and any tool
# looking for a root instructions file expect it whichever tools you selected.
#
# Usage:
#   project-rules.sh <tool> <target_dir>   # write <tool>'s config into target_dir
#   project-rules.sh --list                # list supported tools + their targets
#
# Re-runnable: symlinks are recreated, generated files are rewritten. bash 3.2
# compatible (macOS default).
set -euo pipefail

ALL_TOOLS="claude codex cursor gemini copilot"
GEN_NOTE="<!-- Generated from .agents/AGENTS.md + .agents/rules/*.md. Do not edit by hand; edit the source in .agents/ and re-run the installer. -->"

die() { echo "FATAL: $*" >&2; exit 1; }

if [ "${1:-}" = "--list" ]; then
  echo "Supported tools (key -> instructions file + commands):"
  echo "  claude    .claude/skills|rules|agents -> .agents/ (CLAUDE.md is install.sh's)"
  echo "  codex     AGENTS.md (root, always) + .codex/skills -> .agents/skills"
  echo "  cursor    .cursor/rules/contextium.mdc    + .cursor/commands/*.md -> the skills"
  echo "  gemini    GEMINI.md                       + .gemini/commands/*.toml"
  echo "  copilot   .github/copilot-instructions.md + .github/prompts/*.prompt.md"
  exit 0
fi

TOOL="${1:-}"
TARGET="${2:-}"
[ -n "$TOOL" ] && [ -n "$TARGET" ] || die "usage: project-rules.sh <tool> <target_dir> (try --list)"
case " $ALL_TOOLS " in *" $TOOL "*) : ;; *) die "unknown tool: $TOOL (try --list)";; esac

AGENTS_DIR="$TARGET/.agents"
[ -f "$AGENTS_DIR/AGENTS.md" ] || die "missing $AGENTS_DIR/AGENTS.md — install.sh lays it down first"
[ -d "$AGENTS_DIR/rules" ] || die "missing $AGENTS_DIR/rules"
[ -d "$AGENTS_DIR/skills" ] || die "missing $AGENTS_DIR/skills"

# --- Symlinks ---------------------------------------------------------------

# Point $TARGET/$1 at $2 (a path relative to $1's own directory). Replaces a prior
# link outright. A REAL file or directory in that spot is an upgrade from the
# layout that copied everything into .claude/ — move it aside rather than delete
# it, because it may hold skills the user wrote themselves.
# Args: $1=relpath-under-target $2=relative-link-target $3=what-it-points-at
link_into_agents() {
  local rel="$1" link_target="$2" label="$3" dst="$TARGET/$1" kept n
  mkdir -p "$(dirname "$dst")"
  if [ -L "$dst" ] && [ "$(readlink "$dst")" = "$link_target" ]; then
    # Already ours, pointing where we want it. A symlink pointing ANYWHERE else
    # is the user's own wiring and gets preserved like a real file would be.
    rm -f "$dst"
  elif [ -e "$dst" ] || [ -L "$dst" ]; then
    # Never destroy an earlier rescue. A second conflicting run would otherwise
    # delete the .pre-agents copy this installer promised to keep and put the
    # newer file there, losing the original outright. Find a free suffix.
    kept="$dst.pre-agents"; n=2
    while [ -e "$kept" ]; do
      kept="$dst.pre-agents.$n"
      n=$((n + 1))
    done
    mv "$dst" "$kept"
    echo "[projector] kept your old ${rel} as ${kept#"$TARGET"/}"
  fi
  ln -s "$link_target" "$dst"
  echo "[projector] linked ${rel} -> ${label}"
}

# --- Source assembly --------------------------------------------------------

# The instructions body: AGENTS.md (minus its H1) followed by every principle rule.
build_body() {
  local f
  awk 'NR==1 && /^# / {next} {print}' "$AGENTS_DIR/AGENTS.md"
  echo
  echo "# Principles"
  echo
  echo "These are the always-on rules, identical in every tool."
  echo
  # find, not a glob: rules nest (rules/meta/ai-layer-authoring.md), and a
  # one-level glob silently dropped every nested rule from the generated files
  # while the layer promised they carried the rules verbatim. Sorted so the
  # generated output is stable between runs.
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    awk 'NR==1 && /^# / {next} {print}' "$f"
    echo
  done < <(find "$AGENTS_DIR/rules" -type f -name '*.md' ! -name 'README.md' 2>/dev/null | LC_ALL=C sort)
}

# Read a frontmatter field from a SKILL.md, folding a YAML block scalar into one
# line. Args: $1=file $2=field
#
# `description: >` followed by indented lines is valid and the format check
# accepts it. Read only the key's own line and such a skill projects with an
# empty description — which is the field the tool uses to decide when to offer
# the command, so it becomes undiscoverable rather than visibly broken.
skill_field() {
  awk -v field="$2" '
    /^---$/ { d++; if (d >= 2) exit; next }
    d != 1 { next }
    folding {
      # A new top-level key ends the block; anything indented continues it.
      if ($0 ~ /^[^[:space:]]/) { exit }
      sub(/^[[:space:]]+/, "")
      if ($0 != "") { out = (out == "" ? $0 : out " " $0) }
      next
    }
    # Block-scalar test first: `description: >` also matches the single-line
    # pattern below, and would yield a description of ">".
    $0 == field": >" || $0 == field": |" || $0 == field": >-" || $0 == field": |-" {
      folding = 1; out = ""; next
    }
    index($0, field": ") == 1 { print substr($0, length(field) + 3); exit }
    END { if (folding) print out }
  ' "$1"
}

# Escape a string for a double-quoted YAML scalar: backslash and double quote.
yaml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Escape a string for a TOML basic string. Skill descriptions quote the user's own
# words ("close", "wrap up"), so an unescaped one would end the TOML string early.
toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

# Emit a SKILL.md for a tool that reads plain markdown with its own frontmatter.
# The skill's own frontmatter (name, description, allowed-tools, metadata.peers)
# is kept, but left as a second `---` block it makes the file look like it has
# two frontmatters and renders as stray horizontal rules. Fence it instead, so
# it survives intact and reads as what it is — and so prune_stale_commands can
# recognize a file this script wrote by its `# skill definition` line.
# Args: $1=SKILL.md path
skill_body_fenced() {
  awk '
    NR==1 && /^---$/ { print "```yaml"; print "# skill definition"; infm=1; next }
    infm && /^---$/  { print "```"; infm=0; next }
    { print }
  ' "$1"
}

# --- Per-tool instructions file ---------------------------------------------

write_instructions() {
  local out dir
  case "$TOOL" in
    gemini)  out="$TARGET/GEMINI.md" ;;
    copilot) out="$TARGET/.github/copilot-instructions.md" ;;
    cursor)  out="$TARGET/.cursor/rules/contextium.mdc" ;;
    *) return 0 ;;
  esac
  dir="$(dirname "$out")"; mkdir -p "$dir"
  if [ "$TOOL" = "cursor" ]; then
    { printf -- '---\ndescription: Contextium methodology and principles\nalwaysApply: true\n---\n\n'
      printf '%s\n\n' "$GEN_NOTE"
      build_body; } > "$out"
  else
    { printf '%s\n\n' "$GEN_NOTE"; build_body; } > "$out"
  fi
  echo "[projector] wrote ${out#"$TARGET"/}"
}

# --- Per-tool commands ------------------------------------------------------

# Delete generated command files whose skill no longer exists in .agents/skills/.
# Writing is not enough on its own: rename or delete a skill and the old command
# file survives every re-install, so the tool still offers a command that runs a
# procedure the layer no longer ships. The symlinked tools do not need this — a
# link to a deleted skill is a dangling link, which is at least visible — but the
# per-skill Cursor links are removed here too, for the same reason.
# Only files matching a skill-name shape are considered, so a command the user
# wrote by hand and dropped in the same directory is left alone.
prune_stale_commands() {
  local dir suffix f name
  case "$TOOL" in
    gemini)  dir="$TARGET/.gemini/commands";  suffix=".toml" ;;
    copilot) dir="$TARGET/.github/prompts";   suffix=".prompt.md" ;;
    cursor)  dir="$TARGET/.cursor/commands";  suffix=".md" ;;
    *) return 0 ;;
  esac
  [ -d "$dir" ] || return 0
  for f in "$dir"/*"$suffix"; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    name="$(basename "$f" "$suffix")"
    [ -d "$AGENTS_DIR/skills/$name" ] && continue
    # Never delete a command the user wrote themselves. Cursor's directory holds
    # symlinks we made, so being a symlink is the proof there; the other two hold
    # files we generated, and every one of those carries the fence marker that
    # skill_body_fenced writes.
    if [ "$TOOL" = "cursor" ]; then
      [ -L "$f" ] || continue
    else
      grep -q '^# skill definition$' "$f" 2>/dev/null || continue
    fi
    rm -f "$f"
    echo "[projector] removed ${f#"$TARGET"/} (no such skill any more)"
  done
}

# The skills ARE the commands. Tools that read SKILL.md as-is get a symlink; the
# two that need another format get a file generated from the same source. The
# whole SKILL.md goes through, frontmatter included, so the generated tools run
# the same procedure the symlinked ones do.
write_commands() {
  local d name desc out dir body
  prune_stale_commands
  for d in "$AGENTS_DIR"/skills/*/; do
    [ -f "$d/SKILL.md" ] || continue
    name="$(basename "$d")"
    desc="$(skill_field "$d/SKILL.md" description)"
    case "$TOOL" in
      cursor)
        link_into_agents ".cursor/commands/$name.md" \
          "../../.agents/skills/$name/SKILL.md" ".agents/skills/$name/SKILL.md"
        continue ;;
      gemini)
        dir="$TARGET/.gemini/commands"; mkdir -p "$dir"
        out="$dir/$name.toml"
        # A TOML multi-line LITERAL string ('''), not a basic one ("""). The
        # skills are full of backslashes — regexes, escaped globs — and a basic
        # string would try to read each one as an escape sequence and fail the
        # parse. A literal string takes the body verbatim.
        #
        # Unless the body contains ''' itself, which no literal string can hold.
        # Then fall back to a basic string and escape it, which costs nothing but
        # legibility and is the only shape that parses.
        body="$(skill_body_fenced "$d/SKILL.md")"
        { printf 'description = "%s"\n' "$(toml_escape "$desc")"
          if printf '%s' "$body" | grep -qF "'''"; then
            printf 'prompt = """\n'
            printf '%s\n' "$(toml_escape "$body")"
            printf '"""\n'
          else
            printf "prompt = '''\n"
            printf '%s\n' "$body"
            printf "'''\n"
          fi; } > "$out" ;;
      copilot)
        dir="$TARGET/.github/prompts"; mkdir -p "$dir"
        out="$dir/$name.prompt.md"
        # Quoted: a description carrying ": " or a leading "#" is valid skill
        # text and invalid bare YAML, and would silently break the prompt's
        # metadata rather than fail loudly.
        { printf -- '---\ndescription: "%s"\n---\n\n' "$(yaml_escape "$desc")"
          skill_body_fenced "$d/SKILL.md"; } > "$out" ;;
      *) continue ;;
    esac
    echo "[projector] wrote ${out#"$TARGET"/}"
  done
}

# --- Main -------------------------------------------------------------------

case "$TOOL" in
  claude)
    link_into_agents ".claude/skills"    "../.agents/skills"    ".agents/skills"
    link_into_agents ".claude/rules"     "../.agents/rules"     ".agents/rules"
    link_into_agents ".claude/agents"    "../.agents/reviewers" ".agents/reviewers"
    ;;
  codex)
    link_into_agents ".codex/skills" "../.agents/skills" ".agents/skills"
    ;;
  *)
    write_instructions
    write_commands
    ;;
esac

echo "[projector] done: $TOOL -> $TARGET"
