---
paths: null
---

# Single Source of Truth

Every fact lives in exactly one file. Always loaded.

## single-source-of-truth
Every fact — a rule's content, a step definition, a wire format, a schema, a peer declaration — MUST
live in exactly one file. MUST NOT be mirrored as prose across several. Other files reference it by
its stable id or its path.

Two copies of a fact are one edit away from disagreeing, and nothing tells you which one is now
wrong. [2026-04-18]

## user-is-final-arbiter
When rules conflict, or a reading is genuinely ambiguous, MUST defer to the user and MUST flag the
conflict rather than resolving it silently. MUST NOT rewrite a rule unilaterally to remove the
tension. [2026-04-18]
