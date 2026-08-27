#!/usr/bin/env bash
# build-agent-prompts.sh — Step 2 of /debate. Assembles the role-specific
# prompt files for the three formats (dialectic | redteam | council), at either
# 2 or 3 agents. Owns the role-template source of truth.
#
# --agents is about how many SEATS the debate has, not who fills them. Which
# models fill them is decided at dispatch time by what you have installed; see
# dispatch-agents.sh and ../../../hooks/checks/voices.sh.
#
# Outputs a single line to stdout: `prompts_dir=<path>`; per-agent .prompt
# files written under the prompts dir.
#
# peers: dispatch-agents.sh, parse-agent-output.sh, .claude/skills/debate/SKILL.md
#
# Usage:
#   build-agent-prompts.sh --question "<q>" --format dialectic|redteam|council
#                          --agents 2|3 [--context-file <path>]

set -euo pipefail

err() { echo "$@" >&2; }

QUESTION=""
FORMAT=""
CONFIG=""
CONTEXT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --question)     QUESTION="${2:-}"; shift 2 ;;
    --format)       FORMAT="${2:-}"; shift 2 ;;
    --agents)       CONFIG="${2:-}"; shift 2 ;;
    # The old vendor-flavoured names, kept working: they only ever decided how
    # many seats there were.
    --config)       case "${2:-}" in duo|claude) CONFIG=2 ;; cross) CONFIG=3 ;; *) CONFIG="${2:-}" ;; esac; shift 2 ;;
    --context-file) CONTEXT_FILE="${2:-}"; shift 2 ;;
    -h|--help)      sed -n '2,15p' "$0" >&2; exit 0 ;;
    *)              err "unknown flag: $1"; exit 2 ;;
  esac
done

[[ -n "$QUESTION" ]] || { err "--question empty or missing"; exit 2; }

case "$FORMAT" in
  dialectic|redteam|council) ;;
  *) err "--format must be one of: dialectic | redteam | council (got: $FORMAT)"; exit 2 ;;
esac

case "$CONFIG" in
  2|3) ;;
  "") CONFIG=2 ;;
  *) err "--agents must be 2 or 3 (got: $CONFIG)"; exit 2 ;;
esac

# A council is three positions by construction; asking for two of them is asking
# for a different format.
if [[ "$FORMAT" == "council" && "$CONFIG" == "2" ]]; then
  err "council is a 3-agent format; use --agents 3, or pick dialectic/redteam for two"
  exit 2
fi

if [[ -n "$CONTEXT_FILE" ]]; then
  [[ -f "$CONTEXT_FILE" ]] || { err "context file not found: $CONTEXT_FILE"; exit 2; }
fi

PROMPTS_DIR=$(mktemp -d -t debate-prompts-XXXXXX)

ctx_block=""
if [[ -n "$CONTEXT_FILE" ]]; then
  ctx_block=$(cat "$CONTEXT_FILE")
fi

# Roles per (format, seat count). redteam is structurally 2-role whatever the
# seat count says — an advocate and a critic.
roles=()
case "$FORMAT" in
  dialectic)
    if [[ "$CONFIG" == "2" ]]; then
      roles=("thesis" "antithesis")
    else
      roles=("thesis" "antithesis" "third-position")
    fi
    ;;
  redteam)
    roles=("advocate" "critic")
    ;;
  council)
    roles=("pragmatist" "visionary" "skeptic")
    ;;
esac

emit_prompt() {
  local role="$1"
  local prompt_file="$PROMPTS_DIR/${role}.prompt"
  local role_block stance steel_man output_schema

  steel_man="Argue this position as if your career depends on it. Do not hedge."

  case "$role" in
    thesis)
      role_block="You are arguing FOR the proposition / first option."
      stance="Thesis (pro)"
      ;;
    antithesis)
      role_block="You are arguing AGAINST the proposition / for the alternative."
      stance="Antithesis (con)"
      ;;
    third-position)
      role_block="You are arguing a third position — status quo, 'do both', 'neither', or 'wrong question — here's what you're both missing.'"
      stance="Third position"
      ;;
    advocate)
      role_block="You are the founder pitching this plan to your board. Strongest case for the plan."
      stance="Advocate (Blue Team)"
      ;;
    critic)
      role_block="Your job is to save them from a bad decision. Find every weakness, hidden assumption, failure mode."
      stance="Critic (Red Team)"
      ;;
    pragmatist)
      role_block="Feasibility, cost, speed, what works today. Argue from implementation reality."
      stance="Pragmatist"
      ;;
    visionary)
      role_block="Long-term impact, ideal outcomes. Work backward from the best possible future."
      stance="Visionary"
      ;;
    skeptic)
      role_block="Hidden costs, perverse incentives, second-order effects. Trust no one's good intentions."
      stance="Skeptic"
      ;;
  esac

  # Output schema differs for critic + skeptic per SKILL.md body.
  case "$role" in
    critic)
      output_schema=$'## Position\nCritical assessment.\n\n## Key Criticisms\n3 most dangerous flaws.\n\n## Fatal Flaw\nSingle biggest failure risk.\n\n## What Would Change My Mind\n1-2 conditions.'
      ;;
    skeptic)
      output_schema=$'## Position\nCritical assessment.\n\n## Key Arguments\n3 most dangerous failure modes.\n\n## Strongest Point\nWhat other council members are ignoring.\n\n## Acknowledged Weaknesses\nWeaknesses in the skeptical stance.'
      ;;
    *)
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

for role in "${roles[@]}"; do
  emit_prompt "$role"
done

echo "prompts_dir=$PROMPTS_DIR"
