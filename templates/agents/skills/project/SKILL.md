---
name: project
description: Single entry point for project work. No argument renders the project index; an existing slug loads the project, detects its stage with scripts/detect-stage.sh and routes it to the think flow, /implement or a state report; a freeform description creates a project and runs the think flow (goal alignment, context, explore, grill, design, roadmap rows) before handing the design to /spec; complete and update change status only. Use when the user says "/project", "/project <slug>", "let's work on <project>", "create a project for <X>", "complete <slug>" or "update <slug>".
allowed-tools: "Bash(bash .agents/skills/project/scripts/*:*) Bash(bash .agents/skills/close/scripts/*:*) Bash(node .agents/generators/project-index.generate.ts:*) Read Edit Write Task Skill AskUserQuestion"
metadata:
  peers: ".agents/skills/spec/SKILL.md .agents/skills/implement/SKILL.md .agents/skills/close/SKILL.md .agents/skills/project/references/templates/README.md .agents/skills/project/references/templates/ROADMAP.md .agents/skills/close/scripts/roadmap.sh .agents/generators/project-index.generate.ts"
---

# /project — the project entry point

`/project` picks the right action from what you asked and what stage the
project is in. It does the thinking; `/spec` writes the specs, `/implement`
builds them, `/close` records and commits.

## Critical

- **Goal alignment comes first** in every think flow (`@rule:goal-alignment`).
  State the goal and the simplest mechanism, ask "does this match?", and wait
  for an explicit yes before loading context or designing. Silence is not
  approval. A mismatch caught here costs one turn; caught after the build it
  costs the rebuild.
- **Stage detection is a script result**, not a judgment: run
  `scripts/detect-stage.sh` and route on its `stage:` line.
- **`/project` never writes a spec.** The think flow ends by handing the design
  to `/spec`, which writes one spec folder per roadmap row, audits each and
  auto-closes. The user is never the first reviewer of a spec.
- **The roadmap is the only list of outstanding work.** A project README has no
  Status, Current Progress or Next Steps section, and its `next:` is derived from
  `ROADMAP.md`, never hand-written.
- **Blank mode: the index goes in your reply.** The generator's stdout reaches
  your context, not the user; paste it verbatim.

## Modes

Run `bash .agents/skills/project/scripts/parse-arg-mode.sh "$ARGUMENTS"`:

| `mode:` | What /project does |
|---|---|
| `blank` | Render the index (below) |
| `create` | New project + think flow (§ Create) |
| `existing-slug` | Resolve, detect stage, route (§ Stage routing) |
| `complete` / `update` | § Complete and frontmatter changes — no think flow |

**Blank mode.** Run `node .agents/generators/project-index.generate.ts --out -`
and paste its stdout into the reply unchanged. Then run
`bash .agents/skills/project/scripts/check-staleness.sh --expired-only` — monitor
windows that have lapsed, a decision nobody made. For its lines, add a block:

```
**Lapsed — 2**
- web/checkout-retries — ended 2026-01-20 (12 days ago)
- data/sync-engine — monitor with no monitoring-until date

`/project <slug>` to close or extend.
```

`EXPIRED:<domain>/<slug>:monitoring-until=<date>:days-overdue=<N>` is the first
bullet shape, `NOWINDOW:<domain>/<slug>` the second. No lines means no block —
not an all-clear line. End with: "Which one to start? Type `/project <slug>`."

## Stage routing

Resolve with `bash .agents/skills/project/scripts/find-project.sh <slug>`
(`PATH:` or `NOT_FOUND[:nearest: …]` — offer the nearest, never guess), read
the README, then run
`bash .agents/skills/project/scripts/detect-stage.sh <project-folder>`:

| `stage:` | What /project does |
|---|---|
| `needs-planning` | No spec or no roadmap row yet, or `next-row:` names a ready row whose spec folder is `—`, missing, or holds an open `[NEEDS CLARIFICATION]` marker. Run the think flow for that row. |
| `ready-to-implement` | `active-spec:` is owed work. Apply § Fresh-context check, then `/implement <slug>` — the project slug, never a spec path; `/implement` finds the row itself. |
| `ready-to-close` | `next-row:` names a row whose spec is reported complete but whose Status is not `done` — a close that did not finish. Invoke `/close`; it flips the row and syncs `next:`. |
| `all-specs-reported` | Nothing ready is owed a spec or a build. Do NOT start a think flow — § Every spec reported. |
| `monitor` / `blocked` / `completed` | Report `monitoring-until:` / `blocked-on:` / `## Outcome`. No further action. |
| `unknown` | Report why: `status: missing-readme`, an unrecognised status, or the `roadmap-error:` line (fix the table; `roadmap.sh` names the problem). |

### Every spec reported

Reaching "no spec owed work" does not mean a next chunk is owed — the remaining
item is often a watch, and a think flow started here invents scope. Run
`bash .agents/skills/close/scripts/project-remaining-work.sh <project-folder>`
and show the user its `verdict:`, every `roadmap:` row and `todo:` item, and any
`roadmap-error:`. Then ask the user (a numbered list, recommendation first; in
Claude Code, `AskUserQuestion`) which it is, and edit nothing before the answer:

| Answer | What /project does |
|---|---|
| Start the next chunk | Run the think flow |
| Shipped, just needs watching | `status: monitor`, `monitoring-until: YYYY-MM-DD` (ask for the date if nothing names one) |
| It is done | `complete` (below) |
| Leave it active | Report and stop |

### Fresh-context check

A session that wrote the plan defends it, so `/implement` runs in a fresh
context. Before invoking it from here, judge session length: short (clearly
under ~50 user turns) → invoke `/implement <slug>` inline; long → print one line,
`Long session — open a fresh tab and paste: /implement <slug>`, and stop. That
is the only copy-paste command this skill emits.

## Project files

`projects/<domain>/YYYY-MM-DD_<slug>/`, with `<domain>` one of the folders
already under `projects/` (a new domain is asked about first):

| File | Template | Holds |
|---|---|---|
| `README.md` | [references/templates/README.md](references/templates/README.md) | frontmatter, `## Goal`, `## Outcome`, and the one definition of how `next:` is derived |
| `ROADMAP.md` | [references/templates/ROADMAP.md](references/templates/ROADMAP.md) | rows R1.. with `Depends on`, `Status`, `Sub-spec` — the only list of outstanding work |
| `specs/NNN-name/` | `.agents/skills/spec/references/templates/` | one spec per row: `spec.md`, `plan.md`, `tasks.md`, `research.md`, then `/implement`'s `report.md` |
| `decisions/` | MADR, per `decisions/README.md` | decisions expensive to reverse |

`roadmap.sh` in `.agents/skills/close/scripts/` is the one reader and writer of
the table: `roadmap.sh <folder>` lists rows, `--set <ID> <status> [--sub-spec specs/NNN-name/]`
changes one, `--sync-next` rewrites the README's `next:`. Templates are
spec-kit's, pinned in [references/templates/SOURCE.md](references/templates/SOURCE.md).

A project made before this layout (loose `*.spec.md` files, no `ROADMAP.md`) is
still read by every script; its next spec is written in the new layout, with a
`ROADMAP.md` created from the template.

## Create

1. Pick the domain (ask if unclear) and create
   `projects/<domain>/YYYY-MM-DD_<slug>/`.
2. Scaffold `README.md` from the template: `project`, `status: active`,
   `priority`, `created`, `tags`, and `description:` — one line, at most 60
   characters, naming what the project is. Priority: `high` serves a current
   goal the user has named, `medium` is infrastructure that makes the rest
   work, `low` is neither. Keep the template's derivation comment. Do not
   write `next:`.
3. Scaffold `ROADMAP.md` from the template with the epic name and intro. The
   think flow's row split REPLACES its three placeholder rows; `roadmap.sh`
   refuses a table that still holds a `<name>` row.
4. Run the think flow. Commit nothing here: `/spec`'s auto-close commits the
   README, roadmap and specs together.

## The think flow

Writes no code. Order: goal → context → explore → grill → design → rows →
`/spec`.

### think-step-0-goal-alignment

One turn, before anything is read: (1) the goal in plain language, sized to
the work; (2) the simplest mechanism that achieves it, naming an existing
pattern if one fits (`@rule:simplest-solution-default`); (3) "Does this match
what you want?" Wait for an explicit yes or a revision. Never bundle this with
the first design artifact.

### think-step-1-context-load

Load only what the work needs: `.agents/AGENTS.md`, `git log --oneline -20`,
the last three `journal/<date>/` folders, then the slice the scope names — an
app's README, SPEC.md, main source and tests; a project's README, ROADMAP.md
and recent journal mentions; a rule and the skills citing it. Use an Explore
agent for cross-file questions rather than reading many files yourself.

### think-step-2-explore

With an Explore agent, find and cite `file:line` for: similar
implementations, naming, error handling, types, test patterns, and every
existing primitive the design would otherwise reinvent — grep each helper name
the design introduces plus two or three synonyms; an existing one is reused,
never duplicated. Every credential or config value the design needs is
resolved to where it actually lives, read rather than assumed
(`@rule:no-guessing`).

### think-step-2.5-grill

Settle the open decisions before designing around them. An open decision is an
unsettled choice that would change a file in the design, an edge-case row, a
data-sourcing choice, or the scope line; a choice that changes none of these is
not a question — adopt the recommendation silently and record it.

- Ask the user (a numbered list, recommendation first; in Claude Code,
  `AskUserQuestion`), at most four independent questions per round; a decision
  that depends on another waits for the next round. Each recommendation says in
  one line what picking it means for the build.
- This is not a second goal-alignment gate: never end a round with "approve?".
- Stop when the list is empty. "Enough" / "your call" adopts every remaining
  recommendation as `adopted (user waved off)`; after four rounds, as
  `adopted (ceiling)` — name those in the reply. An empty list skips the step.
- Record every decision, asked or adopted, as a ledger row — Decision, Chosen,
  Source (`user` | `adopted (recommendation)` | `adopted (user waved off)` |
  `adopted (ceiling)`), Rejected + why. `/spec` writes it into spec.md's
  `## Clarifications`; a grill whose answers live only in the conversation has
  produced nothing. Anything still unsettled becomes a
  `[NEEDS CLARIFICATION: …]` marker, and `/implement` will not start past it.

### think-step-3-design

- Files to CREATE / UPDATE, in dependency order.
- Data sourcing, per input, before choosing a transport: where it canonically
  lives, the candidate transports, the one chosen and why
  (`@rule:deterministic-over-ai` — fetch data that exists; prompt only for
  judgment).
- Behavior at 0 / 1 / empty / max / error (`@rule:boundary-inputs`); a row that
  describes existing code cites the `file:line` you read.
- Rules this work makes untrue: grep `.agents/rules/` and amend each in the same
  change (`@rule:no-deferral`).
- Risks, each with its mitigation.

### think-step-3.6-row-split

Decide the rows this design becomes in `ROADMAP.md`:

- One row is the common case. Several when the tasks fall into groups that each
  ship on their own; a group that needs another's output names that row in
  `Depends on` (`R4`, or `R4, R6`), and rows with `—` can run in parallel.
- Every row designed this session gets a spec folder now. A row only named, not
  designed, keeps Sub-spec `—` and sends the next session back here.
- IDs are `R` + (highest existing + 1), never reused or renumbered.
- Work that is not a spec is still a row: a watch is `blocked: <date>`, a manual
  step has Sub-spec `—`.

Which rows are ready and what `next:` says are the README template's rule,
applied by `roadmap.sh` — not decided here.

### think-step-4-dispatch-spec

Invoke `/spec` (Skill tool) with every designed row and the grill ledger. It
writes one `specs/NNN-name/` per row, sets each row with `roadmap.sh --set`,
syncs `next:`, runs `/spec-audit` on each folder and auto-closes. HALT only if
`/spec` surfaces a held reviewer escalation, a spirit-check DRIFT, or a
deferral; otherwise the session ends there, and `/implement` runs in a fresh
context.

## Complete and frontmatter changes

- **`complete <slug>`** — show the summary and loose ends
  (`project-remaining-work.sh`), then set `status: completed`, drop `next:` /
  `blocked-on:`, write `## Outcome`. `/close` also completes a project on its
  own when the last piece lands; that rule lives in
  `.agents/skills/close/SKILL.md`.
- **`update <slug>`** — edit the fields asked for. `blocked` carries
  `blocked-on:`, `monitor` carries `monitoring-until: YYYY-MM-DD`; each is one
  sentence of at most 60 characters. `next:` is never edited by hand: change
  the roadmap and run `roadmap.sh <folder> --sync-next`.

Either way, leave the edit uncommitted and invoke `/close`, which commits it
with the session's record.

## Scripts

| Script | In → out |
|---|---|
| [`scripts/parse-arg-mode.sh`](scripts/parse-arg-mode.sh) | `"$ARGUMENTS"` → `mode: blank\|create\|existing-slug\|complete\|update` + `payload:` |
| [`scripts/find-project.sh`](scripts/find-project.sh) | `<slug>` or `<domain>/<slug>` → `PATH:…`, `NOT_FOUND` or `NOT_FOUND:nearest: …` |
| [`scripts/detect-stage.sh`](scripts/detect-stage.sh) | `<project-folder>` → `stage:`, `status:`, `specs:`, `reports:`, `active-spec:`, and with a roadmap `next-row:` and any `roadmap-error:` |
| [`scripts/check-staleness.sh`](scripts/check-staleness.sh) | `--expired-only` → `EXPIRED:` / `NOWINDOW:` lines; `[days]` (default 14) adds `STALE:` for projects with no journal mention in that window — run it when the user asks what they are forgetting |

Each has a `*.test.sh` beside it.

## Examples

**New project.** `/project create a retry for failed checkout payments` →
`projects/web/2026-01-10_checkout-retries/` scaffolded → goal and mechanism
stated, user says yes → context, explore, a two-question grill → the design
splits into R1 (retry queue) and R2 (alert on exhaustion, depends on R1) →
`/spec` writes `specs/001-retry-queue/` and `specs/002-exhaustion-alert/`,
audits both, closes. Only R1 is ready.

**Everything reported.** `/project sync-engine` → `stage: all-specs-reported`
→ remaining work shows `verdict: work-remains` and `roadmap: R3 blocked:
2026-02-01` → asked, the user picks "just needs watching" → `status: monitor`,
`monitoring-until: 2026-02-01`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `mode: create` for what is a slug | a one-word slug has no hyphen | use `<domain>/<slug>` |
| `stage: unknown`, `roadmap-error: placeholder row R1` | rows were added under the template's placeholders | delete the `<name>` rows |
| `stage: unknown`, `status: missing-readme` | wrong folder, or no README | re-run `find-project.sh` |
| `needs-planning` on a row that has a spec | the spec holds a `[NEEDS CLARIFICATION]` marker | settle it with the user, edit the marker out |
| Went straight to context-load | step 0 skipped | stop, state goal and mechanism, wait for a yes |
