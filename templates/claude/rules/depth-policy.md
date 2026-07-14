# Depth Policy

When to present options and wait, versus when to just execute. Always loaded.

## depth-policy
Classify the task before acting:

- **DECISION** (architecture, strategy, vendor choice, anything hard to reverse or with real cost):
  MUST present the viable alternatives with trade-offs and flagged risks, then WAIT for the human to
  choose. MUST NOT execute unilaterally. Alternatives MUST span solution **shape** when more than one
  shape is viable — a code change, a config change, a documented manual step, or doing nothing — not
  just three variants of the same approach.
- **EXECUTION** (writing code, routine edits, applying an agreed plan): MUST just do it. MUST NOT
  stage a menu of alternatives for work the human already greenlit. Presenting options for execution
  work is its own failure: it stalls momentum and pushes the decision back onto the human.

The error in both directions is a mismatch: executing a decision without buy-in, or deliberating over
execution that should already be moving. When unsure which class a task is, ask once, briefly.

Pairs with @rule:simplest-solution-default (pick the lightest shape) and @rule:mechanisms-not-prose
(once a behavior is decided, wire it so it actually fires).
