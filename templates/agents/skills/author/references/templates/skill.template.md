---
name: {{name}}
description: TODO WHAT this skill does + WHEN to use it. Third person ("Scaffolds…", not first-person); under 1536 chars — the model's invocation trigger, not a label.
argument-hint: "[TODO args or remove if none]"
disable-model-invocation: false
enforces: []
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

If this skill has gates (user questions, halt, shell checks, agent/skill dispatch),
declare a `steps:` graph in frontmatter and give each step id a matching body
section (per @rule:skill-step-graph + @rule:skill-step-graph). Simple
single-body skills without gates may omit `steps:`.

## Examples

### Example 1 — TODO

TODO a concrete walk-through of the common path.
