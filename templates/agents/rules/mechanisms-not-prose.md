---
paths: null
---

# Mechanisms, Not Prose

A rule that only lives in a document doesn't fire. Always loaded.

## mechanisms-not-prose
Every behavioral rule you actually want enforced MUST be backed by a mechanism: a hook that runs at
commit or edit time, a check script, a scheduled audit, or a concrete step inside a skill that fires a
named tool call at a known decision point. A rule that exists only as advisory prose will fail under
pressure — it gets forgotten in exactly the moment it was written to cover.

This does not mean every preference needs a hook. It means: if a rule is load-bearing, wire it. If you
can't wire it, treat it as a guideline and be honest that it's advisory, not enforced. The repo's own
hooks (commit gate, destructive-git guard, memory-write guard) are the model — the rule's reasoning
lives in the rule file, the enforcement lives in the hook, and the two reference each other.

Corollaries:
- **One behavior, one surface.** When a hook already enforces something, don't also write a rule that
  merely restates it. The hook's header comment is the declaration; a duplicate rule just drifts.
- **Single source of truth.** Each fact — a rule's text, a wire format, an allow-list — lives in
  exactly one file. References point at it by a stable id; nothing is mirrored as prose in two places.
- **Don't build enforcement for failures that haven't happened.** Speculative hooks are theater. Add
  the mechanism when the failure mode is real, and extend an existing surface before inventing a new
  one.

See @rule:write-your-own-rules for how to add a rule that follows this discipline. [2026-04-13]

## deterministic-over-ai
When a task has an authoritative deterministic source — an API, a stable page to parse, a
computation, a lookup table, a file in the repo — MUST use that source. MUST NOT ask a model to infer
data that can be fetched, computed, or parsed.

Models are for judgment: classification, summarization, synthesis, generation. They are not for data
that already exists at a known address. When designing any pipeline step, the first question is "is
this data, or is this judgment?" — data gets fetched, judgment gets prompted.

The same split governs a skill's own steps. A step that is a lookup, a format check, a grep, or a
fixed transform belongs in `scripts/` as something that runs the same way every time; describing it
in prose and hoping the model reproduces it is how two runs of one skill diverge. [2026-04-24]

## no-speculative-enforcement
MUST NOT build a hook, check, or rule for a failure that has not happened yet. When a new pattern
does need enforcing, MUST extend an existing mechanism rather than standing up a parallel one.

A rule with no failure behind it costs the same attention as one that earned its place, and it
crowds out the ones that did. [2026-04-17]
