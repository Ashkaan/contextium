<!-- source: github/spec-kit docs/concepts/spec-of-specs.md, § The roadmap artifact, the fenced minimal template @ v1.0.10, commit b5d97b41a3ad703800179eab0e711c1d7173422e -->
# Roadmap: <epic name>

<One or two sentences: what the epic is and why it is being decomposed.>

**Status legend**: planned · in-progress · done

| ID | Sub-feature | Intent | Scope boundary | Depends on | Status | Sub-spec |
|----|-------------|--------|----------------|-----------|--------|----------|
| R1 | <name>      | <one line> | <in / deferred> | —      | planned | — |
| R2 | <name>      | <one line> | <in / deferred> | R1     | planned | — |
| R3 | <name>      | <one line> | <in / deferred> | R1     | planned | — |
<!-- contextium: rules -->

**Rules (contextium).**

- Keep the `ID` column immutable once a sub-spec references it — spec-kit's own rule, from the page this template is copied out of.
- `Sub-spec` holds the spec's folder, `specs/NNN-name/`, or `—` before one exists.
- `done` means that folder's `report.md` says `spec-status: complete`.
- Two Status values beyond the legend: `blocked: <what>` and `absorbed by <ID>`. A watch is `blocked: <date>`.
- Outstanding work that is not a spec — a watch, a manual step — is still a row, with `Sub-spec` left `—`. This table is the project's only list of outstanding work.
- Which row is ready, and how the README's `next:` is derived from it, is written once in the README template's derivation rule (`README.md` beside this file).

<!-- /contextium -->
