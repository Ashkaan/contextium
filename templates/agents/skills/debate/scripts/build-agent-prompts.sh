#!/usr/bin/env bash
# build-agent-prompts.sh — Step 2 of /debate. Writes the three role prompts.
# Owns the role-template SSOT.
#
# Always three roles, no format and no config: a choice the user has to make
# before every debate is a choice they can get wrong. The council roles are the
# ones that proved useful across debates. File names sort into seat order, and
# dispatch-agents.sh hands seat N to panel voice N:
#   pragmatist → Claude, skeptic → Codex, visionary → Grok.
#
# Outputs a single line to stdout: `prompts_dir=<path>`.
#
# peers: dispatch-agents.sh, parse-agent-output.sh, .agents/skills/debate/SKILL.md
#
# Usage:
#   build-agent-prompts.sh --question "<q>" [--context-file <path>]

set -euo pipefail

err() { echo "$@" >&2; }

QUESTION=""
CONTEXT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --question)     QUESTION="${2:-}"; shift 2 ;;
    --context-file) CONTEXT_FILE="${2:-}"; shift 2 ;;
    -h|--help)      sed -n '2,17p' "$0" >&2; exit 0 ;;
    *)              err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$QUESTION" ]] || { err "--question empty or missing"; exit 2; }

if [[ -n "$CONTEXT_FILE" ]]; then
  [[ -f "$CONTEXT_FILE" ]] || { err "context file not found: $CONTEXT_FILE"; exit 2; }
fi

PROMPTS_DIR=$(mktemp -d -t debate-prompts-XXXXXX)

ctx_block=""
if [[ -n "$CONTEXT_FILE" ]]; then
  ctx_block=$(cat "$CONTEXT_FILE")
fi

ROLES=("pragmatist" "skeptic" "visionary")

emit_prompt() {
  local role="$1"
  local prompt_file="$PROMPTS_DIR/${role}.prompt"
  local role_block stance steel_man output_schema

  steel_man="Argue this position as if your career depends on it. Do not hedge."

  case "$role" in
    pragmatist)
      role_block="Feasibility, cost, speed, what works today. Argue from implementation reality."
      stance="Pragmatist"
      output_schema=$'## Position\nOne sentence.\n\n## Key Arguments\n1. [Strongest]\n2. [Second strongest]\n3. [Third strongest]\n\n## Strongest Point\nThe single most compelling reason your position is correct.\n\n## Acknowledged Weaknesses\n1-2 weaknesses you concede, with why they don\'t change your conclusion.'
      ;;
    skeptic)
      role_block="Hidden costs, perverse incentives, second-order effects. Trust no one's good intentions."
      stance="Skeptic"
      output_schema=$'## Position\nCritical assessment.\n\n## Key Arguments\n3 most dangerous failure modes.\n\n## Strongest Point\nWhat other council members are ignoring.\n\n## Acknowledged Weaknesses\nWeaknesses in the skeptical stance.'
      ;;
    visionary)
      role_block="Long-term impact, ideal outcomes. Work backward from the best possible future."
      stance="Visionary"
      output_schema=$'## Position\nOne sentence.\n\n## Key Arguments\n1. [Strongest]\n2. [Second strongest]\n3. [Third strongest]\n\n## Strongest Point\nThe single most compelling reason your position is correct.\n\n## Acknowledged Weaknesses\n1-2 weaknesses you concede, with why they don\'t change your conclusion.'
      ;;
  esac

  {
    echo "$role_block"
    echo "$steel_man"
    echo
    echo "Question: $QUESTION"
    echo "Your assigned position: $stance"
    if [[ -n "$ctx_block" ]]; then
      echo
      echo "CONTEXT FOR DEBATE:"
      echo "$ctx_block"
    fi
    echo
    echo "Structure your response as:"
    echo "$output_schema"
    echo
    echo "Stay under 500 words. Specific, not generic."
  } > "$prompt_file"
}

for role in ${ROLES[@]+"${ROLES[@]}"}; do
  emit_prompt "$role"
done

echo "prompts_dir=$PROMPTS_DIR"
