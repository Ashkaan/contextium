---
name: spec
description: Think — write the lean SPEC that the build will be measured against.
---
Write the SPEC. Four sections, no more:

1. **Ask** — what was asked for, in the asker's own words. This is what the finished work gets checked against, and it is what keeps the build from drifting into something fancier than was wanted.
2. **Behavior** — what success looks like, concretely: given these inputs, the system does this. Include the edges: 0, 1, empty, max, and error.
3. **Files** — what to create or change, one line each, naming the existing pattern each one mirrors. List the downstream callers you'll update in the same pass; nothing deferred.
4. **Done** — the exact commands to run and the output that means success. Not "tests pass" — the command and the expected result, including at least one end-to-end check.

Then review it before building — `/spec-audit`. Resolve anything the design left vague now: a SPEC that says "whatever config that other thing uses" is a guess wearing a spec's clothes.

Stop after the SPEC. The build happens in a fresh chat, so the context that grew attached to the plan is not the one that judges the result.
