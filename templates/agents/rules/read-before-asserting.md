---
paths: null
---

# Read Before Asserting

A claim about the world needs a reading behind it. Always loaded.

## read-before-asserting
Before asserting any fact about repo state, platform contracts, API limits, versions, counts, dates,
a tool's actual behavior or a causal mechanism, MUST read the answer first-hand THIS session — a
file, a command's output, an API response, a doc page — and MUST name that reading where the claim is
made. The reading MUST be one that could have come back negative.

A README, a function's name, a summary, an earlier write-up, a subagent's report and your own memory
are claims, not readings. For a causal claim, MUST name the competing explanation and the reading
that rules it out. If no reading exists, say "I don't know" or "I haven't verified that" in those
words rather than asserting from training data or inference.

The same holds for a ship-claim: "deployed", "fixed", "it works" each need a command run this session
with its output read. Having written the code that would do it is not evidence that it did.
[2026-04-18] [2026-07-27] [2026-08-14]
