#!/usr/bin/env bash
# scaffold.sh — write the conforming skeleton for a new .claude/ artifact.
#
# The shape of a skill, hook or agent file is mechanical: the same frontmatter
# fields, the same section order, every time. /author used to describe that shape
# in prose and ask the model to reproduce it, which is how two skills end up with
# different frontmatter for no reason. This writes it instead.
#
# The rule branch deliberately writes NO file: a rule is an inline `## <slug>`
# section appended to an existing .claude/rules/*.md, so this validates the slug,
# checks it against every rule id already in the repo, and prints where to put it.
#
# USAGE
#   scaffold.sh skill <name>
#   scaffold.sh agent <name>
#   scaffold.sh hook  <name>
#   scaffold.sh rule  <slug>
#
# EXIT: 0 written (or, for rule, validated); 1 bad name, collision, or existing
# target. It never overwrites — an existing artifact is a stop, not a merge.

set -euo pipefail

err() { echo "author-scaffold: $*" >&2; }

TYPE="${1:-}"
NAME="${2:-}"

case "$TYPE" in
  skill|agent|hook|rule) : ;;
  *) err "usage: scaffold.sh skill|agent|hook|rule <name>"; exit 1 ;;
esac

[[ -n "$NAME" ]] || { err "a name is required"; exit 1; }

# Reject rather than normalize. Silently rewriting someone's name is how an
# artifact ends up somewhere they don't look for it.
if [[ ! "$NAME" =~ ^[a-z][a-z0-9-]*$ ]]; then
  err "'$NAME' is not kebab-case (^[a-z][a-z0-9-]*\$). Rename it — this will not normalize it for you."
  exit 1
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || true)}"
[[ -n "$ROOT" ]] || { err "not inside a git repo, and CLAUDE_PROJECT_DIR is unset"; exit 1; }
cd "$ROOT"

refuse_existing() {
  if [[ -e "$1" ]]; then
    err "$1 already exists. Pick another name — scaffolding never overwrites."
    exit 1
  fi
}

case "$TYPE" in
  skill)
    target=".claude/skills/${NAME}/SKILL.md"
    refuse_existing ".claude/skills/${NAME}"
    mkdir -p ".claude/skills/${NAME}"
    cat > "$target" <<EOF
---
name: ${NAME}
description: <WHAT it does + WHEN to use it. This is what the model routes on — a description that never says when it applies never fires.>
disable-model-invocation: false
allowed-tools: "Read Edit Write Bash"
enforces: []
---

# /${NAME} — <one-line purpose>

<Two or three sentences: what this skill is for, and what it is not for.>

## Critical

- <The thing that goes wrong when someone skips a step here.>
- <The failure this skill exists to prevent.>

## <step-name>

<What to do. If a step is a lookup, a computation, a format check, or a grep, it
belongs in scripts/ as a script this body calls — not in prose here.>

## Examples

**<Ordinary case>.** <What happens, step by step.>

**<Edge case>.** <What happens when the usual assumption doesn't hold.>

## Troubleshooting

| Failure | Cause | Fix |
|---|---|---|
| <symptom> | <why> | <what to do> |
EOF
    echo "$target"
    ;;

  agent)
    target=".claude/agents/${NAME}.md"
    refuse_existing "$target"
    mkdir -p .claude/agents
    cat > "$target" <<EOF
---
name: ${NAME}
description: <When the orchestrator should dispatch this agent. Agents are for work that benefits from FRESH context — review, investigation, a cold read.>
model: inherit
tools: Read, Grep, Glob
---

You are the ${NAME} agent. You have NO session history — you see only the brief
you are given. Do not assume context that is not in it.

## Input contract

<What the brief always contains: paths, a diff, a question, prior findings.>

## What you do

<The single job. One job per agent.>

## MUST NOT

- <The thing this agent must never do — write, commit, contact a third party.>

## Output contract

<The exact shape you return. The caller parses this, so it is a contract, not a
suggestion.>

# ${NAME}: <one-line summary>
EOF
    echo "$target"
    ;;

  hook)
    target=".claude/hooks/${NAME}.sh"
    refuse_existing "$target"
    mkdir -p .claude/hooks
    cat > "$target" <<'EOF'
#!/usr/bin/env bash
# HOOK_NAME.sh — <what this refuses, and why>.
#
# Fires on: <event> (wire it into .claude/settings.json — an unwired hook never
# runs, and nothing will tell you).
#
# A blocking PreToolUse hook exits 2. Exit 1 is NOT blocking; it prints and lets
# the call through, which is the single most common way a hook silently does
# nothing.
set -uo pipefail

INPUT="$(cat 2>/dev/null || true)"
# Read what you need out of $INPUT (tool name, file path, command) with jq.

block() { echo "BLOCKED: $*" >&2; exit 2; }

# Every refusal names the file and the fix. A hook that says "not allowed" and
# nothing else gets worked around instead of obeyed.

exit 0
EOF
    sed -i.bak "s/HOOK_NAME/${NAME}/" "$target" && rm -f "${target}.bak"
    chmod +x "$target"
    echo "$target"
    echo "NOT WIRED YET: add it to .claude/settings.json under the right event." >&2
    ;;

  rule)
    # No file is written. Check the id against every rule already in the repo:
    # ids are cited as @rule:<id> across skills, hooks and docs, so a duplicate
    # makes every citation ambiguous and a rename breaks all of them.
    if [[ -d .claude/rules ]] && grep -rq "^## ${NAME}\$" .claude/rules/ 2>/dev/null; then
      err "a rule with id '${NAME}' already exists:"
      grep -rn "^## ${NAME}\$" .claude/rules/ >&2
      err "Rule ids are effectively immutable — pick a more specific slug, or amend that rule instead."
      exit 1
    fi
    cat <<EOF
Rule '${NAME}' is available. A rule is an inline section, not a new file —
append this to the .claude/rules/*.md file whose topic it belongs to:

## ${NAME}
[When X,] MUST <action>[; MUST NOT <anti-pattern>]. [$(date +%Y-%m-%d)]
<One line: the failure this closes, or the principle behind it.>

Before you append, read the sibling headings in that file:
  grep -n '^## ' .claude/rules/<file>.md
If this overlaps an existing rule, amend that rule instead of adding a near-twin.
EOF
    ;;
esac
