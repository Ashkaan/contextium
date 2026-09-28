<!-- source: github/spec-kit templates/commands/plan.md:114-135 (Phase 0: Outline & Research) @ v1.0.10, commit b5d97b41a3ad703800179eab0e711c1d7173422e — spec-kit publishes no research template file; this is its Phase 0 format -->
# Research: [FEATURE NAME]

**Spec**: [spec.md](spec.md) | **Plan**: [plan.md](plan.md) | **Date**: [DATE]

<!--
  Phase 0, as spec-kit's plan step runs it:

  1. Extract unknowns from Technical Context:
     - For each NEEDS CLARIFICATION → research task
     - For each dependency → best practices task
     - For each integration → patterns task

  2. Generate and dispatch research agents:
     For each unknown in Technical Context:
       Task: "Research {unknown} for {feature context}"
     For each technology choice:
       Task: "Find best practices for {tech} in {domain}"

  3. Consolidate findings in research.md, one entry per unknown.

  Output: research.md with all NEEDS CLARIFICATION resolved.
-->

## [Unknown: the question, e.g. "the best way to do X"]

- Decision: [what was chosen]
- Rationale: [why chosen]
- Alternatives considered: [what else evaluated]
<!-- contextium: sources -->
- Sources: [what the conclusion was read from — a path with its line, a URL, a command and its output, or a named research pass — each with the date it was read]

<!-- /contextium -->

<!-- contextium: decision-records -->
**Where a decision is recorded (contextium).** research.md and MADR overlap
only at `Decision:`, and they split by scope. A decision that stays inside this
spec is written here in full. A decision that outlives the spec, or would be
expensive to reverse, is written as a MADR file in the narrowest `decisions/`
folder containing everyone who could act contrary to it (the format and the
placement rule are the repo root's `decisions/README.md`), and this entry's
`Decision:` line becomes a link to that file instead of restating it:

- Decision: [NNNN-title](<relative path to the record>)

The research — Rationale, Alternatives considered, Sources — stays here, since
that is what this spec needed to find out.

<!-- /contextium -->
