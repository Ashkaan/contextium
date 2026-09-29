---
name: {{name}}
description: TODO third person, what this skill does AND when to fire it (trigger phrases included) — the model's invocation trigger, at most 1,024 characters; caveats and history go in the body
# allowed-tools: TODO one space-separated string, only if the skill's own commands would otherwise prompt every run
# metadata:
#   peers: "TODO the references, scripts and dispatched skills/agents the body loads, space-separated"
---

# {{name}}

TODO one-paragraph statement of what `/{{name}}` does and when to reach for it.
The shape this file must keep — the six frontmatter keys, `metadata.peers`,
the learned-state folder convention, the body standard — is
`AGENTS.md` § Skill shape; `check-skills.sh` holds it to that. Whether only the user may
fire it is `skillOverrides` in `~/.claude/settings.json`, not a field here.

## Critical

- TODO the load-bearing invariants — the things that MUST hold for this skill to be correct. Delete if none.

## Flow

1. TODO first step.
2. TODO second step.

Every gate (a question, a halt, a shell check, an agent/skill dispatch) is a
named section here stating its check and what happens on failure; every
deterministic step is a script in `scripts/` that the section invokes.

## Examples

### Example 1 — TODO

TODO a concrete walk-through of the common path.
