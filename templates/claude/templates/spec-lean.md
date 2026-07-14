# SPEC: <title>

A lean SPEC — four sections. Enough for a fresh-context session (or a reviewer) to implement and check
the work without re-deriving intent. Write it before you build; `/implement` reads it back. If a
section doesn't apply, say so in one line rather than deleting the heading.

> The methodology ships with this 4-section template on purpose. Heavier projects grow their own
> sections (input/output contracts, failure modes, test matrices) as the work demands — add them when
> a real gap bites, not preemptively. See @rule:simplest-solution-default.

## 1 — Ask

What the human actually asked for, in their words where possible. Capturing the verbatim ask matters:
it's the thing you check the finished work against, and it's what keeps the implementation from
drifting into a fancier interpretation than was wanted.

## 2 — Behavior

What success looks like, concretely. The behavior contract: given these inputs, the system does this.
Include the boundary cases per @rule:boundary-inputs — what happens at 0, 1, empty, max, and error
inputs. This section is the spec the implementation is measured against.

## 3 — Files

The files to create or change, repo-relative, with a one-line note on each. Name the existing patterns
you're mirroring (path + what to copy from them) so the implementation matches the surrounding code
instead of inventing a new shape. List downstream consumers you'll need to update in the same pass —
nothing deferred, per @rule:no-deferral.

## 4 — Done

How you'll know it works: the exact commands to run and the output that means success. Not "tests
pass" but the actual command and the actual expected result. Static checks and unit tests are the
floor; include at least one end-to-end check that exercises the real behavior, because that's the gate
that catches what unit tests miss.
