#!/usr/bin/env bash
# install-legacy-projection.sh — what the v6/v7 projector would have written at
# one path, regenerated from the layer it was generated from. install.sh uses it
# to tell a generated file nobody touched (removed on upgrade) from one the user
# edited (kept): the "Generated from .agents/AGENTS.md" marker and the
# "# skill definition" fence survive an edit, so they prove only who wrote the
# file first, not that it is still as written.
#
# The functions below are v6.0.0's and v7.0.0's scripts/projector/project-rules.sh
# output code, byte for byte in what they print (the two tags agree on it).
#
# Usage:
#   install-legacy-projection.sh <snapshot of .agents/> <path from the workbench root>
#     <path> is one of GEMINI.md, .cursor/rules/contextium.mdc,
#     .github/copilot-instructions.md, .gemini/commands/<skill>.toml,
#     .github/prompts/<skill>.prompt.md
# Prints the file's expected content. Exit: 0 printed · 1 nothing to compare
# against (no such skill, or a path the projector never wrote)
#
# bash 3.2 compatible.
set -uo pipefail

AGENTS_DIR="${1:?usage: install-legacy-projection.sh <snapshot> <path>}"
REL="${2:?usage: install-legacy-projection.sh <snapshot> <path>}"

GEN_NOTE="<!-- Generated from .agents/AGENTS.md + .agents/rules/*.md. Do not edit by hand; edit the source in .agents/ and re-run the installer. -->"

build_body() {
  local f
  awk 'NR==1 && /^# / {next} {print}' "$AGENTS_DIR/AGENTS.md"
  echo
  echo "# Principles"
  echo
  echo "These are the always-on rules, identical in every tool."
  echo
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    awk 'NR==1 && /^# / {next} {print}' "$f"
    echo
  done < <(find "$AGENTS_DIR/rules" -type f -name '*.md' ! -name 'README.md' 2>/dev/null | LC_ALL=C sort)
}

skill_field() {
  awk -v field="$2" '
    /^---$/ { d++; if (d >= 2) exit; next }
    d != 1 { next }
    folding {
      if ($0 ~ /^[^[:space:]]/) { exit }
      sub(/^[[:space:]]+/, "")
      if ($0 != "") { out = (out == "" ? $0 : out " " $0) }
      next
    }
    $0 == field": >" || $0 == field": |" || $0 == field": >-" || $0 == field": |-" {
      folding = 1; out = ""; next
    }
    index($0, field": ") == 1 { print substr($0, length(field) + 3); exit }
    END { if (folding) print out }
  ' "$1"
}

yaml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

toml_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

skill_body_fenced() {
  awk '
    NR==1 && /^---$/ { print "```yaml"; print "# skill definition"; infm=1; next }
    infm && /^---$/  { print "```"; infm=0; next }
    { print }
  ' "$1"
}

skill_md() { # <name> — the snapshot's SKILL.md for a command file, or fail
  local f="$AGENTS_DIR/skills/$1/SKILL.md"
  [ -f "$f" ] || return 1
  printf '%s' "$f"
}

case "$REL" in
  GEMINI.md | .github/copilot-instructions.md)
    [ -f "$AGENTS_DIR/AGENTS.md" ] || exit 1
    printf '%s\n\n' "$GEN_NOTE"
    build_body
    ;;
  .cursor/rules/contextium.mdc)
    [ -f "$AGENTS_DIR/AGENTS.md" ] || exit 1
    printf -- '---\ndescription: Contextium methodology and principles\nalwaysApply: true\n---\n\n'
    printf '%s\n\n' "$GEN_NOTE"
    build_body
    ;;
  .gemini/commands/*.toml)
    name="${REL#.gemini/commands/}"
    md="$(skill_md "${name%.toml}")" || exit 1
    desc="$(skill_field "$md" description)"
    body="$(skill_body_fenced "$md")"
    printf 'description = "%s"\n' "$(toml_escape "$desc")"
    if printf '%s' "$body" | grep -qF "'''"; then
      printf 'prompt = """\n'
      printf '%s\n' "$(toml_escape "$body")"
      printf '"""\n'
    else
      printf "prompt = '''\n"
      printf '%s\n' "$body"
      printf "'''\n"
    fi
    ;;
  .github/prompts/*.prompt.md)
    name="${REL#.github/prompts/}"
    md="$(skill_md "${name%.prompt.md}")" || exit 1
    desc="$(skill_field "$md" description)"
    printf -- '---\ndescription: "%s"\n---\n\n' "$(yaml_escape "$desc")"
    skill_body_fenced "$md"
    ;;
  *) exit 1 ;;
esac
