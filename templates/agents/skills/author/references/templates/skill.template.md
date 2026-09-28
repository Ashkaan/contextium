---
name: {{name}}
description: TODO WHAT this skill does + WHEN to use it, and the arguments it takes if any ("Takes [x]"). Third person ("Scaffolds…", not first-person); at most 1024 characters — the model's invocation trigger, not a label.
allowed-tools: TODO space-separated tools, e.g. Bash Read Edit — or delete this line
metadata:
  peers: "TODO space-separated paths this skill loads or dispatches — or delete metadata"
---

# {{name}}

TODO one-paragraph statement of what `/{{name}}` does and when to reach for it.
Keep this SKILL.md body ≤500 lines; push any longer detail into `references/`
(one level deep) so it loads on demand at zero context cost until read.

## Critical

- TODO the load-bearing invariants — the things that MUST hold for this skill to be correct. Delete if none.

## Flow

1. TODO first step.
2. TODO second step.

If this skill has gates (user questions, halts, shell checks, agent/skill
dispatch), give each step its own `## <step-id>` section saying what it does and,
for a gate, what happens when it fails (per @rule:skill-step-graph). A skill
without gates is one body.

## Examples

### Example 1 — TODO

TODO a concrete walk-through of the common path.
