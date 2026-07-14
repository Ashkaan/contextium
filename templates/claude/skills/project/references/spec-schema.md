# Lean SPEC Schema (4 sections)

Reference for the [`/spec`](../../spec/SKILL.md) skill (dispatched by [`/project`](../SKILL.md)'s
`think-step-4-dispatch-spec`). Loaded by Claude when writing a SPEC, not held in always-loaded context.

The canonical template lives at [`.claude/templates/spec-lean.md`](../../../templates/spec-lean.md) —
copy it, don't reinvent the section set. A SPEC is four sections: **ask / behavior / files / done**.
That's enough for a fresh-context session (or an adversarial reviewer) to implement and check the work
without re-deriving intent. The same shape applies whether the work is a new app, a feature on an
existing app, or non-app work (audits, rule edits, hook changes, reorganization).

## The four sections

| § | Heading | What goes here |
|---|---|---|
| 1 | **Ask** | The human's verbatim ask, in their words where possible. This is the thing the finished work is checked against — it keeps the implementation from drifting into a fancier interpretation than was wanted. |
| 2 | **Behavior** | What success looks like, concretely: given these inputs, the system does this. Include boundary cases per `@rule:boundary-inputs` — what happens at 0, 1, empty, max, and error inputs. This is the contract the implementation is measured against. |
| 3 | **Files** | The files to create or change, repo-relative, one line each. Name the existing patterns you're mirroring (path + what to copy) so the work matches surrounding code instead of inventing a new shape. List downstream consumers updated in the same pass — nothing deferred, per `@rule:no-deferral`. |
| 4 | **Done** | The exact commands to run and the output that means success. Not "tests pass" but the actual command and expected result. Include at least one end-to-end check that exercises real behavior, not just unit tests. |

## Why lean, not heavy

The methodology ships with four sections on purpose. A heavy multi-section schema forces an author to
fill boilerplate (input contract, output contract, failure modes, eval plan, metadata table) on every
SPEC, including the trivial ones — most of it degrades to "N/A" and the noise hides the parts that
matter. Per `@rule:simplest-solution-default`, start lean and let a project grow its own sections when
a real gap bites, not preemptively. A complex SPEC can add an input/output contract or a failure-mode
table inline; the four named sections are the floor every SPEC clears.

## Boundary rows cite their source

When a boundary row in § 2 describes how *existing* code behaves, read the file and cite `file:line`
— don't infer the behavior from memory. The boundary set (0 / 1 / empty / max / error) is also the
test plan: each edge you enumerate becomes a check in § 4.
