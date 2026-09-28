---
paths: null
---

# Adversarial Review

How a review ends, and what it is allowed to say. Always loaded.

## adversarial-recursion-cap
A fix loop MUST end on the WORK, not on a finding count. A round that opens NEW ground MAY continue;
a round whose findings mostly re-open ground an earlier round already touched is the last one.

**Finding count is not the signal and MUST NOT be read as one.** Late rounds return roughly as many
findings as early ones — they are just increasingly about code an earlier round already decided. A
loop that stops "when the findings dry up" does not stop.

**A code or SPEC review fix loop MUST NOT run past round 4.** Stop there, fix what is ready, and
report what is still open. MUST NOT ask the user whether to run another round, and MUST NOT silently
continue. The mechanism is in `code-review.sh`, which refuses a fifth round rather than leaving this
to good intentions. [2026-08-10]

## adversarial-nothing-found-valid
A reviewer MUST be allowed to find nothing, and MUST say so explicitly when it does. MUST NOT pad the
output with trivia or speculation to avoid an empty result.

The pressure runs the other way too: a review that returns only marginal observations is reporting
nothing found in a way that looks like work. Say "zero findings within the reviewed scope" and stop.
[2026-04-18]

## adversarial-triaged-output
Every finding MUST carry a verdict — `must-fix`, `should-fix`, or `nit` — and every `must-fix` MUST
name either the rule it violates or the concrete failure it causes. A finding that is neither
rule-backed nor failure-backed cannot be a must-fix.

The verdict orders work WITHIN the round. It does not schedule work to a later session: a should-fix
whose fix is ready ships now, in the same round, per `@rule:no-deferral`. [2026-04-18]

## adversarial-silence-is-not-approval
A reviewer that returns nothing, crashes, times out, or answers with something the caller cannot
parse MUST be treated as a FAILED review, never as a clean one. An empty response is what a crashed
CLI produces, and reading it as "nothing wrong" hands you a passing gate over work nobody read.

That is why the reviewers require an explicit `NO_FINDINGS` line for a clean pass, and why a round
that produces neither a finding nor that sentinel exits non-zero. [2026-08-27]

## audit-lines-are-records
A review's verdict MUST be written as one line into the folder of the artifact it reviewed, where the
next reader of that artifact finds it: `/spec-audit` writes its `spec-audit:` line into the spec's
`plan.md`, and `/implement` writes `implement-audit:`, `class-sweep:` and `test-failure-observed:`
into the spec's `report.md`. The close's journal entry quotes them.

No hook refuses a commit for a missing line. A line in a commit message is read by nobody at review
time, and a gate that only checks a line exists teaches its escape hatch rather than the review. What
makes the review happen is the producing skill dispatching it every time. [2026-09-24]
