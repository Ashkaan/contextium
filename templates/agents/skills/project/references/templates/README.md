---
project: project-name-slug
status: active|blocked|monitor|completed
priority: high|medium|low   # required on active/blocked/monitor
created: YYYY-MM-DD
tags: [category, technology, type]
description: One line, AT MOST 60 characters, naming what the project is — the project index's one-line column. The longer version is the body's ## Goal.
next: DERIVED from ROADMAP.md, never hand-written — the first ready row's ID and Sub-feature, AT MOST 60 characters, by the rule below. Left out when no row is ready. blocked-on (status blocked) and monitoring-until (status monitor) stay hand-written, same 60-character budget; all three are shown verbatim in the project index.
---

# Project: [Descriptive Name]

<!--
  How `next:` is derived — the one definition; anything else that asks which
  roadmap rows are ready uses this Ready test.

  - Status vocabulary: spec-kit's `planned · in-progress · done`, plus two of
    ours: `blocked: <what>` and `absorbed by <ID>`.
  - Depends on: `—` (none) or IDs separated by commas, whitespace trimmed. A
    dependency is satisfied when its row is `done` or `absorbed by …`.
  - Ready: a row whose Status is `planned` or `in-progress` and whose every
    dependency is satisfied. `blocked: …`, `done` and `absorbed by …` rows are
    never ready.
  - next: `<ID>: <Sub-feature>` of the FIRST ready row — the first ready
    `in-progress` row in table order, or if none, the first ready `planned` one.
    Written as `next: "R3: checkout retries"`, quoted, because the colon would
    otherwise break the YAML. Past 60 characters, the Sub-feature is cut at the
    last whole word that fits and `…` is appended.
  - Several ready rows: next names only the first; the rest are the parallel
    set.
  - None ready: next is left out, and status is then `blocked` with
    `blocked-on:`, `monitor` with `monitoring-until:`, or `completed`.
-->

## Goal

[1-3 sentences: what and why, including what is deliberately left out]

## Outcome

[Written at close: what was achieved, key learnings]

<!-- Everything else has its own file: outstanding work → ROADMAP.md, specs → specs/NNN-name/, decisions → decisions/. -->
