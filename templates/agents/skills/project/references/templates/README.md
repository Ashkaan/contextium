---
project: project-name-slug
status: DERIVED from ROADMAP.md, never hand-written — active|blocked|monitor|completed, by the rule below
priority: high|medium|low   # required on active/blocked/monitor
created: YYYY-MM-DD
tags: [category, technology, type]
description: One line, AT MOST 60 characters, naming what the project is — the project index's one-line column. The longer version is the body's ## Goal.
next: DERIVED from ROADMAP.md, never hand-written — the first ready row's ID and Sub-feature, AT MOST 60 characters, by the rule below. Left out when no row is ready. blocked-on (status blocked) and monitoring-until (status monitor) are derived the same way, same 60-character budget; all three are shown verbatim in the project index.
---

# Project: [Descriptive Name]

<!--
  How `status:` and `next:` are derived — the one definition; anything else
  that asks which roadmap rows are ready, or what state a project is in, uses
  this rule. `roadmap.ts --sync-next` writes it on every landing.

  - Status vocabulary: spec-kit's `planned · in-progress · done`, plus three of
    ours: `blocked: <what>`, `absorbed by <ID>` and `closed: <why>`.
  - Open: any row that is not `done`, `absorbed by …` or `closed: …`.
  - Depends on: `—` (none) or IDs separated by commas, whitespace trimmed. A
    dependency is satisfied when its row is not open.
  - Ready: a row whose Status is `planned` or `in-progress` and whose every
    dependency is satisfied. `blocked: …` rows and rows not open are never
    ready.
  - next: `<ID>: <Sub-feature>` of the FIRST ready row — the first ready
    `in-progress` row in table order, or if none, the first ready `planned` one.
    Written as `next: "R3: checkout retries"`, quoted, because the colon would
    otherwise break the YAML. Past 60 characters, the Sub-feature is cut at the
    last whole word that fits and `…` is appended.
  - Several ready rows: next names only the first; the rest are the parallel
    set.
  - None ready: next is left out.
  - status, the first that applies:
    1. a row is ready → `active`;
    2. an open row is `blocked:` on something that does not start with a
       YYYY-MM-DD date (a person, a vendor, a decision) → `blocked`, with
       `blocked-on: "<ID>: <what>"` for the first such row;
    3. open rows are `blocked:` on dates → `monitor`, with
       `monitoring-until: "<date> — <ID>: <Sub-feature>"` for the earliest;
    4. no row is open (no rows at all included) → `completed`.
    Open rows none of which is ready or blocked (an unknown Status, a
    dependency cycle) cannot be derived; the sync refuses and names them.
  - So a project is never complete while a row is open, and changing its state
    means changing a row: close a row that will not be done, add a
    `blocked: <date>` row to watch something, move that date to extend it.
-->

## Goal

[1-3 sentences: what and why, including what is deliberately left out]

## Outcome

[Written at close: what was achieved, key learnings]

<!-- Everything else has its own file: outstanding work → ROADMAP.md, specs → specs/NNN-name/, decisions → decisions/. -->
