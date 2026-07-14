# Think-Flow Deep Reference

Reference for [`/project`](../SKILL.md) think-flow gates. Extended reasoning and "why this gate exists"
notes that don't need to live in the always-loaded skill body.

The MUST statements and gate definitions stay in [`SKILL.md`](../SKILL.md); this file holds the
reasoning that justifies each gate.

## `think-step-0-goal-alignment` — why this gate exists

The point of the gate: catch a goal/shape mismatch BEFORE hours of design and implementation amplify
it. Agreeing on the goal and the simplest shape up front is the cheapest correction available — it
costs one turn. Discovering the mismatch after the work is built costs the rebuild.

Two failure shapes this gate prevents:

1. **Over-building.** Reading "shared workflow" as "build a service" and shipping a long-running daemon
   with bearer auth, allowlists, and retry loops, when the actual ask was a thirty-line function call.
   Per `@rule:simplest-solution-default`, the lightest shape that satisfies the need is the right one,
   and that decision belongs in the goal statement, before any code.
2. **Wrong-pattern lock-in.** Building against the wrong existing pattern because the iteration never
   explicitly pinned "which pattern matches this?" up front.

A one-turn "is this what you want?" gate catches both. State the goal in plain language, state the
simplest mechanism, ask, and wait for explicit approval before loading context or writing a SPEC.

## `think-step-2-explore` — primitives

### Why the existing-primitives grep matters

Before adding any helper, utility, or wrapper to the Files-to-Change list by name, grep the repo for
that name plus two or three plausible synonyms. The common failure is inventing a near-duplicate of a
function that already exists under a slightly different name — a parallel implementation of something
the codebase already has. Per `@rule:simplest-solution-default`, if the function already exists it MUST
be reused (or moved if its location is wrong); a second copy is a hard violation and a future drift
source.

## `think-step-3-design` — boundary cites and rules made incorrect

### Why boundary cases must cite file:line

When a boundary row describes how existing code behaves, read the file and cite the line. The failure
this prevents is a boundary row written from memory that contradicts the actual code path — e.g. a row
claiming a function throws when the real code falls through to an error-typed result. Inference from
memory is the trap; reading the file and citing the line is the fix. The boundary set (0 / 1 / empty /
max / error) per `@rule:boundary-inputs` is also the test plan: each edge becomes a check in the SPEC's
Done section.

### Why "rules made incorrect" must be enumerated in the same pass

If shipping this work makes any statement in `.claude/rules/*.md` no longer true — a new path of use
for a primitive, a retired file path — that rule MUST be amended in the same commit as the work, per
`@rule:no-deferral`. Deferring a rule amendment to "a follow-up" is the exact deferral pattern the
rules forbid; the rule and the code drift apart the moment they ship separately.

The remediation: grep `.claude/rules/*.md` for any statement that the work will falsify, and document
the amendment in the Files-to-Change list.

## Why the SPEC stays lean, and how it's reviewed

The think flow ends by handing the agreed design to `/spec` (`think-step-4-dispatch-spec`), which
writes the four-section SPEC (Ask / Behavior / Files / Done), runs the `spirit-check` agent to catch
interpretation drift, and auto-closes (commits the SPEC) on a clean pass. There is no heavyweight
machine-review gate and no pre-commit sign-off halt — the SPEC is short enough to read, it lands on the
main branch, and the user reviews it in the fresh `/implement` tab, revising on main if intent drifted.
The discipline that keeps the SPEC trustworthy lives in the steps before it: goal-alignment up front,
the primitives grep, boundary cites against real code, plus the spirit-check. A SPEC that clears those
is ready to commit and read directly. Splitting `/spec` out of `/project` also means a SPEC can be
written ad-hoc, without the full think flow, whenever work turns out to need one.

Keep the SPEC lean per `@rule:simplest-solution-default`. A heavy multi-section schema forces an author
to fill boilerplate on every SPEC, most of which degrades to "N/A" and hides the parts that matter. Let
a project grow its own sections when a real gap bites, not preemptively.

## Blank-mode: paste the index into the reply

When `/project` runs with no args, the index generator's output lands in your context but is NOT yet
visible to the human — the tool-call card is truncated. You MUST copy the full generated index into
your assistant message. "Ran the generator" is not the deliverable; the human reading the index in
your reply is.

## Why a fresh context between think and do

The drift this prevents: the same session holding both the plan and the sunk investment in prior
choices, then defending those choices mid-stream when implementation runs in-context. The
fresh-context boundary between think (`/project`) and do (`/implement`) is the fix — a new tab (or
`/clear`) carries zero prior turns and no attachment to earlier decisions, so it can read the SPEC as
written rather than as remembered.
