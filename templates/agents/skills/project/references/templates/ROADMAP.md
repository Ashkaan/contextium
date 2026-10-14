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
- `Sub-spec` holds the spec's folder, `specs/NNN-name/`; `manual` for a step no spec is ever written for — a message, a call, a decision, a console click; or `—` before a spec exists. `/project` plans a ready `—` row and only lists a ready `manual` one.
- `done` means that folder's `report.md` says `spec-status: complete`.
- Three Status values beyond the legend: `blocked: <what>`, `absorbed by <ID>` and `closed: <why>` — a row finished without being done (superseded, dropped, or shipped with no report), the why saying which. A watch is `blocked: <date>`; anything else after `blocked:` is a wait on someone.
- Outstanding work that is not a spec is still a row: a watch has Status `blocked: <date>` and Sub-spec `—`, a manual step has Sub-spec `manual`. This table is the project's only list of outstanding work.
- Which row is ready, and how the README's `status:` and `next:` are derived from the rows, is written once in the README template's derivation rule (`README.md` beside this file). A project is never complete while a row is open.

<!-- /contextium -->
