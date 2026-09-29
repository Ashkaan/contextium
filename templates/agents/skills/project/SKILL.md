---
name: project
description: Single entry point for project work — renders the live project index, or loads a slug and routes it to the think flow, /implement, /close or a state report, composing /spec, /implement and /close as primitives. Use when the user says "/project", "/project [slug]", "let's work on [project]", "create a project for [X]", "complete [slug]", or "update [slug]". No args renders the live priority-sorted project index; an existing slug loads the README and detects stage via scripts/detect-stage.sh; new freeform creates a project and runs the think flow; complete/update modes do status changes only.
allowed-tools: "Bash(.agents/skills/project/scripts/*:*) Bash(bash .agents/skills/project/scripts/*:*) Bash(bash .agents/skills/close/scripts/project-remaining-work.sh:*) Bash(node .agents/generators/project-index.generate.ts:*) Read Edit Write Task Skill"
metadata:
  peers: "AGENTS.md .agents/skills/implement/SKILL.md .agents/skills/close/SKILL.md .agents/skills/spec/SKILL.md .agents/generators/project-index.generate.ts"
---

# /project — the project entry point

`/project` is the **single entry point for project work**. It composes the loop's three verbs (think → do → wrap) into one skill that picks the right action based on what you asked and what stage the project is in.

The index render lives here rather than in a skill of its own because a cross-skill dispatch boundary is where the agent loses the thread: orchestration overhead causes the second skill's instructions to be skipped. Folding eliminates the boundary; the index-render is `step-0.5-render-index` here.

## Critical

- **Goal-alignment ALWAYS comes first** when the think flow runs. The think flow's `think-step-0-goal-alignment` produces (goal in plain language + simplest mechanism + explicit ask "does this match?") and MUST wait for explicit user approval before context-load, design, or SPEC writing. Silence is NOT approval. Skipping this is the single most expensive mistake the loop makes: a goal or shape mismatch caught here costs one turn, and caught after the build it costs the rebuild. **This step is not the whole enforcement:** it only reaches sessions that enter `/project`, `/spec` or `/implement`, and most task-shaped work does not. Every other session is held to the same gate by the think flow's goal-alignment step.
- **SPEC writing + machine review live in `/spec`, not here.** Per `think-step-4-dispatch-spec`, `/project` does the thinking (goal-alignment → context-load → explore → design → row split → categorize) then hands the design to `/spec`, which writes one spec folder per designed roadmap row, dispatches `/spec-audit` (reviewer consensus + spirit-check), folds findings, and auto-closes. `/project` never writes the SPEC itself and never runs the machine review. The user is NEVER the first reviewer — the SPEC is machine-audited before it lands, because a plan presented raw ships the findings a reviewer would have caught in one pass. Each artifact has exactly ONE machine reviewer: SPECs get `/spec-audit` (inside `/spec`); shipped diffs get `/implement-audit` (inside `/implement`). One artifact type means one machine reviewer per artifact-write.
- **No copy-paste-command outputs as the default.** When the router lands on `ready-to-implement` in a short session, INVOKE `/implement [slug]` inline — do not tell the user to paste a command. The only acceptable copy-paste output is the long-session fresh-tab handoff (see `step-2-turn-count-gate`), and only because `/implement`'s fresh-context boundary is load-bearing: a session that wrote the plan defends it mid-build instead of judging it.
- **Stage detection is a script result, not a judgment.** Run `scripts/detect-stage.sh` to get the stage; don't infer from prose.
- **Credentials in plans must resolve to a named secret-store item + field BEFORE plan-review.** "From the key or whatever app Y uses" is a `AGENTS.md § Standards → Read before asserting` violation. Resolve the item's name + field (and its id, where the store has one) during `think-step-2-explore` by reading the store or the repo's credential helper, and cite it explicitly in the plan. A plan naming a credential nobody looked up names one that may not exist.
- **Standards made incorrect by the SPEC's work are in-scope for the same commit.** If shipping the SPEC's work makes any statement in `AGENTS.md` § Standards (or any other standing rule the repo keeps) wrong, it MUST be amended in the same commit. Enumerate "standards made incorrect" as part of `think-step-3-design`. Deferring the amendment to a follow-up iteration is the deferral pattern `AGENTS.md § Standards → No deferral` forbids.
- **Blank-mode: paste the generator output INTO your response.** After `step-0.5-render-index` runs Bash, the captured stdout is in your context but NOT yet visible to the user. Many harnesses render the Bash tool card **collapsed** — a one-line chip with a disclosure arrow, no output body. So stdout left in the tool card has reached nobody; "ran the generator" is not the deliverable, the user reading the index in your reply IS. Paste it verbatim: `buildCompact` emits finished markdown, so there is no formatting judgment left to make — reformatting it is how the paste turns into a summary. Self-check before sending: does the reply text literally contain the project rows? The failure this prevents is the agent running the generator and then asking "which one to start?" of a user who cannot see the list.

## Modes (`step-0-resolve-mode`, `step-0.5-render-index`)

| Argument | What /project does | Mechanism |
|---|---|---|
| blank | Run `scripts/render-index.sh` — one call, whole render — and **paste its stdout verbatim into your response** (the tool card may be collapsed — the user sees only what your reply text contains). The index, the lapsed-window block and the closing prompt are all in that stdout; add nothing. | `step-0.5-render-index` |
| `create <description>` or bare freeform new | New project + think flow | inline think flow |
| `<domain>/<slug>` or `<slug>` (existing) | Load README → detect stage → route | `step-1-stage-detect-and-route` + table below |
| `complete <slug>` | Status change only | inline (no delegation) |
| `update <slug>` | Frontmatter edit only | inline (no delegation) |

### Lapsed monitor windows (part 3 of `step-0.5-render-index`)

A `monitor` project is "shipped, watching, not actionable" — which is correct
until its `monitoring-until:` date passes, at which point nothing distinguishes
it from a project nobody decided about. A window that lapses silently lets the
post-ship defects it existed to catch go unnoticed, and lapsed windows pile up
unless something prints them — the silence becomes the norm.

`scripts/render-index.sh` already emits this block beneath the index (it calls
`check-staleness.sh --expired-only` and formats the rows), newest-lapse last —
this section is the specification of that shape, not a step to perform:

```
**Lapsed — 2**
- web/checkout-retries — ended 2026-01-17 (32 days ago)
- data/sync-engine — ended 2026-02-01 (17 days ago)

`/project <slug>` to close or extend.
```

The heading carries the count in the same shape as Active / Blocked /
Monitoring / Completed, so the line beneath it names only the action.

`NOWINDOW:` lines render as `<domain>/<slug> — monitor with no monitoring-until
date` in the same block; that is the same decision, missing its deadline.

Three constraints, each of which is why this is a printed list:

- **It is NOT a question put to the user.** A modal gate on the mode the user
  types most often would fire on nearly every invocation until the backlog
  cleared, and a question box holds a handful of options against a backlog
  that can be longer. The user reads the list and ignores it or acts on it; the
  render never blocks.
- **Zero lapsed prints NOTHING.** No "all clear" line — the block's absence is
  the all-clear, and a clean run should cost no lines.
- **It does not change any project's status.** Closing or extending a window is
  `/project <slug>` (report-state for `monitor`) or `/project update <slug>`,
  both of which the user drives. This step surfaces; it does not decide.

## Stage Detection & Routing (`step-1-stage-detect-and-route`)

For existing-project-slug paths only. Load `projects/<domain>/<date>_<slug>/README.md` first, then route per the table below. Detection is observable from filesystem + frontmatter — no AI judgment needed for the detection itself.

| Detected stage | Detection signal | What /project does |
|---|---|---|
| **needs-planning** | `status: active` + no spec at all — or, with `ROADMAP.md`, no rows yet, or a ready row whose Sub-spec is `—`, whose spec folder is missing on disk, or whose spec still carries a `NEEDS CLARIFICATION` marker (`next-row:` names it) | Run the think flow (steps 0 through 3.5 below) for that row, then `think-step-4-dispatch-spec` hands off to `/spec` (writes + audits the spec folders, then auto-closes). No user sign-off halt here (option A). |
| **all-specs-reported** | `status: active` + every spec reported — or, with `ROADMAP.md`, no ready row owed a spec or implementation | **Do NOT start a think flow.** Run `step-1.5-remaining-work-gate`: `bash .agents/skills/close/scripts/project-remaining-work.sh <project-folder>`, report what is actually left, and ask whether the project wants a next chunk, a watch window, closing out, or nothing. See § Every SPEC reported below. |
| **ready-to-implement** | `status: active` + a spec still owed work — with `ROADMAP.md`, the first ready row (in-progress before planned) whose spec folder has no `complete` report and no open marker; a legacy loose `*.spec.md` owed work wins over every row | Check session turn count (see § Turn-count gate below). Fresh session → invoke `/implement <project-slug>` inline. Long session → emit a single-line message: "Long session — open a fresh tab and paste: `/implement <project-slug>`." Always the PROJECT slug (not a sub-SPEC name, not a path — `/implement`'s worktree setup rejects both; see note in `think-step-4-dispatch-spec`). `/implement` resolves the row from `detect-stage.sh`'s `next-row:` itself. |
| **ready-to-close** | `status: active` + `ROADMAP.md`, and a ready row whose spec is reported `complete` while the row is not yet `done` (`next-row:` names it) — a close that did not finish. It outranks new work, because the row the close flips may be what unblocks the next one | Invoke `/close` inline; it flips the row to `done` and re-derives `next:`. |
| **monitor** | `status: monitor` | Read `monitoring-until:` + watch criteria. Report state. No further action. |
| **blocked** | `status: blocked` | Read `blocked-on:`. Report what's blocking. No further action. |
| **completed** | `status: completed` | Read `## Outcome` section. Report. No further action. |

### Every SPEC reported (`step-1.5-remaining-work-gate`) — for all-specs-reported only

Reaching "no SPEC is waiting for a report" does NOT mean a next chunk is owed.
A finished project often has only an observation window left, and a router
that answered needs-planning here would have to be overridden by hand and the
project marked `monitor`. A think flow started from this stage invents scope.

So this stage asks instead of routing. The counting is already written — reuse
`/close`'s script rather than re-deriving it:

```bash
bash .agents/skills/close/scripts/project-remaining-work.sh projects/<domain>/<date>_<slug>
```

Read its output and put it in front of the user before the question — the
`verdict:` line, every `roadmap:` row it names (on a `ROADMAP.md` project the
table is the only list of outstanding work), any `roadmap-error:`, every
`todo:` / `unparsed:` / `shard:` item, and the README's `next:` value. The verdict is not the answer, it narrows it:

- `verdict: work-remains` — something is written down as outstanding, but the
  script cannot tell a build from a watch. Quote the items; the whole question is
  which kind they are. (A project whose one open box reads "Watch the first
  scheduled run land on its own" sits here.)
- `verdict: no-hard-signal` — nothing countable is left, so the project is either
  finished or waiting on a next chunk nobody has written down yet.

Then ask the user (a numbered list, recommendation first; in Claude Code,
`AskUserQuestion`) with four options: start the next chunk, watch it, close
it out, or leave it alone. MUST NOT run the think flow and MUST NOT edit the
README before the answer arrives.

| Answer | What /project does |
|---|---|
| Start the next chunk | Proceed to `think-step-0-goal-alignment` and run the think flow normally. |
| Shipped, just needs watching | `status: monitor` + `monitoring-until: YYYY-MM-DD` naming what is being observed, 60 characters at most; drop `next:`. Ask for the date if the remaining item does not carry one. |
| It is done | The § Complete path: summary + loose ends, `status: completed`, drop `next:` / `blocked-on:`, write `## Outcome`. |
| Leave it active | Report and stop. Nothing is edited. |

The middle two are status changes the USER asked for, which is the
`/project complete|update` path. They are NOT the autonomous flip
"Project completion" reserves for `/close` § 2 — that one happens
without asking, this one only happens because the user answered.

### Turn-count gate (step-2-turn-count-gate) — for ready-to-implement only

**Nothing refuses a long context.** No hook or check blocks `/implement` in a session that has been running for hours. This step is therefore the only thing standing between a long session and an in-context `/implement`, and it is judgment — so make it deliberately rather than by default. A session cannot read its own token count mid-turn, so what follows stays turn-shaped.

Use your own awareness of session length:
- Short session (you have a clear sense of <50 prior user turns): invoke `/implement <slug>` inline. Work starts immediately.
- Long session (the conversation has been going for a while; >50 turns or feels long): do NOT invoke. Emit ONE line: `Long session — open a fresh tab and paste: \`/implement <slug>\`.` That's the only acceptable "copy-paste command" — and only because the fresh-context boundary matters (§ Why a fresh context between think and do), and nothing downstream will catch it if this step doesn't.

If unsure whether the session is long, lean toward invoking.

## Project files

A project folder is `projects/{domain}/YYYY-MM-DD_brief-description/`, in one of
the domains `knowledge/README.md` § Domains lists (where it lists none, the
folders already under `projects/`); a new domain is an edit there first, and is
asked about before it is made. It holds:

| File | Template | Holds |
|---|---|---|
| `README.md` | [references/templates/README.md](references/templates/README.md) | frontmatter, `## Goal`, `## Outcome` — and the one definition of how `next:` is derived from the roadmap |
| `ROADMAP.md` | [references/templates/ROADMAP.md](references/templates/ROADMAP.md) | the rows — the project's ONLY list of outstanding work, with `Depends on` between them |
| `specs/NNN-name/` | `.agents/skills/spec/references/templates/` | one spec per row: `spec.md`, `plan.md`, `tasks.md`, `research.md`, then `/implement`'s `report.md` |
| `decisions/` | MADR, per `decisions/README.md` | decisions expensive to reverse |

No `## Status`, `## Current Progress` or `## Next Steps` section is written: the
roadmap replaced all three. Loose `*.spec.md` / `*-report.md` files are the
legacy layout (an older project may also carry a `## Shard Status` table): the
scripts read them, and nothing writes them.

## Create (+ think flow)

When invoked with a free-form description (not an explicit `complete` / `update` verb), treat it as a new project.

1. Determine the domain (ask if unclear) from the list above.
2. Create the folder `projects/{domain}/YYYY-MM-DD_brief-description/` in the session's worktree.
3. Scaffold `README.md` from [references/templates/README.md](references/templates/README.md). Frontmatter: `project`, `status: active`, `priority`, `created`, `tags`, `description`. The `description:` field is ONE line of AT MOST 60 characters naming what the project IS — it becomes the index's `One-line` column, which is read in a chat column too narrow to wrap dozens of them, and the index never clips, so the budget is yours to hit when you WRITE it. The fuller version is the body's `## Goal`. Priority classifier: `high` = serves a goal the user has written down (a goals file under `knowledge/`, where one exists); `medium` = meta-infrastructure (standards/hooks/skills/telemetry/frameworks/support-apps); `low` = neither. **Do not write `next:` by hand** — it is derived from the roadmap by `roadmap.sh --sync-next` once rows exist, per the template's derivation rule. Keep the template's derivation comment; it is the rule's one home.
4. Scaffold `ROADMAP.md` from [references/templates/ROADMAP.md](references/templates/ROADMAP.md) — epic name and intro filled — and run the **think flow** below. Its row split REPLACES the template's three placeholder rows with the real ones (never appended beneath them: `roadmap.sh` refuses a table that still holds a `<name>` row), and `/spec` writes each designed row's spec folder.
5. Do NOT commit the README, ROADMAP or specs here. The think flow's tail is `/spec`, whose
   own `step-3-auto-close` dispatches `/close`, and `/close` § 4 is the one place
   a session commits — it stages everything the session touched. Leave the files in the
   working tree and let that close file them. Committing here would split one
   session's work across two commits for no gain.

## Work an existing project (router behavior)

Invoked with `<domain>/<slug>` or a bare `<slug>` matching an existing project. Don't recreate the README — read it, run stage detection, route per the Stage Detection table above.

The think flow only fires when the detected stage is **needs-planning** — a ready roadmap row with no spec yet, one whose spec folder is missing, or one whose spec carries an open `NEEDS CLARIFICATION` marker (`detect-stage.sh`'s `next-row:` names the row to plan), or a project with no spec at all. When a ready row's spec is still owed work, route to /implement instead. When a ready row's spec is reported complete but its row is not `done`, route to /close. A project holds one spec folder per row over its life. If nothing ready is owed work the stage is **all-specs-reported**, which is a question and not a think flow (§ Every SPEC reported). A legacy project — loose `*.spec.md` / `*.plan.md`, no `ROADMAP.md` — is still read by `detect-stage.sh`, and its next spec is written in the new layout, with a `ROADMAP.md` created from the template.

## The think flow

The think flow is **SPEC-write only — no code written.** It produces a context-rich spec folder that `/implement` executes one-pass in a fresh context.

**Order: goal-alignment first, then codebase, then the grill, then design.** Every think flow starts with a one-turn goal+shape gate BEFORE any context-load, design, or SPEC writing. The grill (`think-step-2.5-grill`) sits between reading the codebase and designing against it: decisions get settled while changing them is free, rather than surfacing as rework once `/implement` is running.

### `think-step-0-goal-alignment` — agree on the goal + simplest shape

Before any context-load, codebase reading, or SPEC writing, produce a one-turn statement with:

1. **The goal in plain language**, sized to the work (a sentence for simple work, a paragraph or bullet list for complex projects, a numbered list of outcomes when scope is wide).
2. **The simplest mechanism** you think achieves it (also plain language; cite an existing pattern if one fits — e.g. "reuse the existing retry helper" — to avoid authoring new infrastructure).
3. An explicit ask: "Does this match what you want?"

MUST wait for explicit approval or revision before proceeding to `think-step-1-context-load`. Approval = "yes" / "do it" / "ship it"; revision = any change to the goal or mechanism. Silence is NOT approval. MUST NOT bundle goal-alignment into the same turn as the first design artifact — present goal+mechanism first, get acknowledgment, THEN move to step-1.

The point of this gate: catch goal/shape mismatch before hours of design + machine review + implementation amplify it. See [references/think-flow-deep.md § think-step-0-goal-alignment](references/think-flow-deep.md#think-step-0-goal-alignment--why-this-gate-exists) for the failure shapes it catches.

### `think-step-1-context-load` — load focused context

Load only what the work needs. Always load base: AGENTS.md (auto-loaded on a fresh session), `git log --oneline -20`, last 3 `journal/<date>/` folders. Then load the scope slice based on the path prefix:

| Scope shape | What loads |
|---|---|
| `apps/<name>` | `apps/<name>/README.md` + `SPEC.md` (if exists) + the main entry points + shared helpers + its tests + `git log --oneline -10 -- apps/<name>/` |
| `integrations/<name>` | `integrations/<name>/README.md` + the typed client + its frontmatter (hosts, aliases) + `git log --oneline -10 -- integrations/<name>/` |
| `projects/<domain>/<slug>` | the project `README.md` + `ROADMAP.md` + recent journal entries touching it |
| a standard in `AGENTS.md` § Standards | the bullet + the skills citing it |

For an existing project, the load is driven by the project README's Critical-Files / inputs list. Don't read more than the scope needs — over-loading defeats the purpose. Use the Explore agent for cross-file pattern questions rather than Read across many files. For one-off deep dives outside a project, read the relevant slice directly — there is no standalone load command.

### `think-step-2-explore` — find the patterns AND the primitives

Use the **Explore agent** (lighter on context than direct reads) to find:

1. **Similar implementations** — analogous features with file:line references
2. **Naming conventions** — actual examples from the codebase
3. **Error handling patterns** — how errors are created and handled
4. **Type definitions** — relevant interfaces and types
5. **Test patterns** — test file structure and assertion styles
6. **Existing primitives the plan would otherwise reinvent** — for every helper, utility function, or wrapper the plan is about to introduce by name (e.g. `ensureSshKey`, `parseToList`, `commitFiles`), MUST grep the repo for the name + 2–3 plausible synonyms BEFORE adding it to the Files-to-Change list. If the function already exists it MUST be reused; a parallel implementation is a hard violation. See [references/think-flow-deep.md § think-step-2-explore](references/think-flow-deep.md#think-step-2-explore--primitives--credentials) for why.
7. **Credentials cited by name** — for every credential or named secret the SPEC references, MUST confirm the entry exists where the repo keeps them — read the credential helper's map or list the secret store's items — and resolve the actual item name + field. "From the key app X uses" is unverifiable until the entry is shown to exist.

Document patterns in a table: `Category | File:Lines | Pattern` (NAMING / ERRORS / TYPES / TESTS / PRIMITIVES / CREDS).

### `think-step-2.5-grill` — settle the decisions before designing around them

Origin: the "grill me" skill from Matt Pocock's *Workflow for AI Coding* walkthrough. Its claim is that misalignment, not bad code, is the main failure of AI-assisted work, and that the cure is an interview that walks the decision tree branch by branch before anything is written down. The part that makes it cheap rather than exhausting is that **every question ships with its recommended answer**, so the common reply is "yes".

Runs AFTER `think-step-2-explore` so the questions are repo-informed (a question the codebase already answers is not a question), and BEFORE `think-step-3-design` so the design is built on settled decisions instead of being revised by them.

**This is not a second goal-alignment gate.** "goal alignment"'s approval was spent at `think-step-0` and MUST NOT be re-requested. These are decisions *inside* the approved scope. Never end a grill turn with "approve?" or "shall I proceed?".

#### 1. Build the open-decisions list

An open decision is an unsettled choice that would change at least one of:

- a row in the Files-to-Change table (which file gets written, or whether it exists)
- an Edge Cases row in spec.md (what happens at 0 / 1 / empty / max / error)
- a transport choice in plan.md's Data sourcing table (API vs SSH vs bundled vs file)
- the scope line (what this chunk of work deliberately does not do)

**A choice that fails all four is NOT a question.** If both candidate answers produce an identical design, adopt the recommendation silently and record it as adopted — asking it spends a turn to buy nothing. This filter is the whole defense against the 40-to-100-question session Pocock describes; without it the step becomes the back-and-forth it exists to prevent.

#### 2. Ask

Ask the user — a numbered list, recommendation first; in Claude Code, `AskUserQuestion`:

- **The recommendation goes first**, labelled `(Recommended)`, with a one-line description saying what picking it means for the build. A free-text answer is always available and is recorded verbatim.
- **At most 4 questions per round**, and only genuinely independent ones batched together. A decision whose sensible answer depends on another MUST wait for the next round — that is the "one branch at a time" discipline, preserved without paying a turn per question.
- **Name the thing in plain English** per `AGENTS.md` § Working preferences — the question is read by someone who does not have the repo open.
- **Make the options tell apart.** Each option says what the user would see differently afterwards, and the question gives one concrete case where the options produce different results. If no such case can be named, the choice fails § 1's filter and is adopted, not asked. Plain words alone do not do this: "they seem the same to me" is the answer a grill question gets when its options differ only in wording.

#### 3. Stop

The grill ends when the open-decisions list is empty and the last round surfaced nothing new. Three early exits:

| Trigger | What happens |
|---|---|
| User says "enough" / "just go" / "your call" | Every remaining open decision adopts its recommendation, recorded as `adopted (user waved off)`. Stop immediately. |
| 4 rounds reached | Same adoption, recorded as `adopted (ceiling)`. Name the adopted decisions in the reply so they are visible, not silent. |
| List was empty after the filter | Skip the step. No questions, no ceremony, no "nothing to ask" line. |

The 4-round ceiling exists because work chunks here are small and every round costs the user a turn; Pocock runs uncapped hour-long sessions because his chunk is a whole feature. If a project genuinely needs more, the user says "keep going" and the ceiling lifts for that session.

#### 4. Record

Every decision — asked or adopted — lands in a ledger carried to `think-step-4-dispatch-spec` and written into **spec.md's `## Clarifications`**, under `### Session YYYY-MM-DD`, in the table the spec template defines (`.agents/skills/spec/references/templates/spec.md` § Clarifications). Its `User's words` column takes the user's reply exactly as typed, dated and quoted — a numbered answer like "1) a" is quoted as "1) a", and the option it picked goes in `Chosen`, which is the AI's wording and never presented as the user's.

The Rejected column is what a later session reads to avoid re-litigating a settled choice, and it is where the work's out-of-scope boundary comes from. The ledger MUST reach the SPEC — a grill whose answers live only in the conversation has produced nothing.

**Boundary cases for this step**: 0 open decisions → step skipped, no output. 1 → a single one-question round. Free-text answer → recorded verbatim as the decision, and it MAY open new open decisions (that is a new round, not a violation). Max → 4 rounds × 4 questions = 16 asked decisions, remainder adopted. A question tool unavailable or declined → print the questions and their recommendations as plain text in the reply and wait for a reply; MUST NOT proceed to design with the list unresolved.

### `think-step-3-design` — map the changes

- Files to CREATE / UPDATE, in dependency order
- **Data-sourcing table — fill BEFORE choosing transports.** For EVERY external/data input the work reads, write one row: `What | Where it canonically lives | Candidate transports | Chosen + why`. The point is to force the API-vs-SSH-vs-bundle-vs-file question explicitly per input, instead of inheriting a transport from a prior session's design or a sibling app. Prefer the API to SSH per row — including for repo files, which are read over the code host's API rather than over SSH to a machine that happens to hold a checkout. A row whose chosen transport is SSH MUST state why no API/bundle form works (verified absent, not assumed). This step exists because a transport inherited from a neighbour costs rounds of rework to unwind once the design has been built on it, and nothing else forces the per-input sourcing question up front.
- Enumerate behavior at: 0 inputs (empty), 1 input, empty (blank/null), max (large), error (invalid)
- **Boundary cases that describe existing code behavior MUST cite `file:line`.** Read the file, confirm the actual behavior, cite the line. Inference from memory is forbidden. See [references/think-flow-deep.md § think-step-3](references/think-flow-deep.md#think-step-3-design--boundary-cite--standards-incorrect) for why.
- **Enumerate standards made incorrect by this work.** Read `AGENTS.md` § Standards (and any other standing rule the repo keeps) for any statement that will no longer be true after the plan ships (new runtime in an enum, new path-of-use for a primitive, new integration name, retired file path). Each such statement MUST be amended in the same commit as the plan's work. Document the amendments in the Files-to-Change table.
- Identify risks in a `Risk | Mitigation` table
- **If the SPEC creates a new top-level folder under `apps/` or `integrations/`**, MUST ask the user (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`) the categorization choice and quote the rule statement inline:
  - **(a) integration** — wraps an external product (third-party SaaS, OSS on another host, vendor API, or host-bound product we connect to). Goes in `integrations/<product-name>/` with `hosts:` declaring the external address(es). Rule: Integrations are external connectors (`integrations/README.md`).
  - **(b) app** — repo-authored code we wrote (worker, scheduled task, library, CLI, deploy tooling). Goes in `apps/<name>/` named for what the code IS or DOES. Use `deploys-to:` (NOT `hosts:`) if host-bound. Rule: Apps are repo-authored code (`apps/README.md`).
  - Then scaffold the correct shape (frontmatter `hosts:` for integrations, `deploys-to:` for host-bound apps).

### `think-step-3.6-row-split` — split the design into roadmap rows

Rows track whether a spec depends on another, so independent specs can run as
parallel sessions and the close of an implement run can print every
parallel-able spec command together.

After the Files-to-Change table is drafted, and before `/spec` is dispatched,
decide the rows this design becomes in `ROADMAP.md`:

- **One row** is the common case — a design that ships as one piece.
- **Several rows** when the tasks fall into groups that each ship on their own.
  A group that needs another group's output names that row in `Depends on`
  (`R4`, or `R4, R6`); groups with no such need have `—` and can run in
  parallel.
- **Every row designed this session gets a spec folder now.** `/spec` writes one
  `specs/NNN-name/` per row handed to it, so a close can print every ready row
  as its own `/implement <slug> <id>` block at once. A row only named, not
  designed, keeps Sub-spec `—` and sends the next session back here.
- **IDs**: `R` + (the highest existing numeric ID + 1), from `R1`. An ID is
  never reused or renumbered — specs, reports and commits cite it.
- **Work that is not a spec is still a row.** A watch is a row whose Status is
  `blocked: <date>`; a manual step is a row with Sub-spec `—`. The table is the
  project's only list of outstanding work.

Which rows are ready, and what `next:` says, is not decided here: it is the
README template's derivation rule, applied by `close/scripts/roadmap.sh`.

### `think-step-3.5-categorize` — classify every proposed artifact

For each file in the Files-to-CREATE list, place it by the table in `AGENTS.md` § What lives where (and, for `apps/` against `integrations/`, the two folders' READMEs). Multiple rows may match; apply the most specific. Document each artifact's category as a "Category" column in the Files-to-Change table.

- No match → artifact is mis-conceived. Ask the user before continuing.
- Two places at the same level → a gap in the layout. Ask the user.

SPECs with any uncategorized new artifact fail machine-review.

### `think-step-4-dispatch-spec` — hand the design to /spec

The design is complete (decisions settled in the grill, files mapped, boundary cases enumerated, artifacts categorized, rows split). Hand `/spec` every row designed, and the `think-step-2.5-grill` decision ledger with the design — it writes the ledger into spec.md's `## Clarifications`, which is also what `/spec-audit`'s spirit-check reads. `/project` does NOT write the SPEC itself — it dispatches `/spec`, which owns SPEC-writing, the machine review, and the auto-close. This is the terminal step of the think flow.

Dispatch `/spec` via the Skill tool. `/spec`:

1. Writes one `specs/NNN-name/` folder per row from `.agents/skills/spec/references/templates/`, writes the rows into `ROADMAP.md` (creating it from the template when absent), and re-derives the README's `next:`.
2. Dispatches `/spec-audit` on each folder (reviewer consensus + spirit-check on spec.md's Input, Clarifications and behavior contract plus plan.md's Simplest shape), folds findings, writes the `spec-audit:` line.
3. Auto-invokes `/close` on clean completion (commit + push the specs), surfacing the `## SPEC Created` summary in the close output, with each ready row's `/implement <slug> <id>` in its own block. There is NO separate user sign-off halt here — option A: the machine-audited SPEC is committed + revisable on the trunk, reviewed by the user in the fresh `/implement` tab.

**HALT only** if `/spec` surfaces a hard stop (a held reviewer escalation or a spirit-check DRIFT the user must adjudicate) or proposes a deferral. Otherwise the think flow ENDS when `/spec` auto-closes; the next `/implement` runs in a fresh tab.

The think→do fresh-context boundary is preserved: `/spec`'s auto-close ends the session. `/implement <project-slug>` runs fresh — the argument is the PROJECT slug, never a sub-SPEC name or file path (`/implement`'s worktree setup validates the first token against `^[a-z][a-z0-9-]{0,63}$` and rejects paths/non-slugs). A specific row is `/implement <slug> <id>`, the ID lowercased (`r4`) so it passes that same regex; it is matched to the row case-insensitively.

`/spec-audit` writes its `spec-audit:` line into each folder's plan.md Constitution Check; it is a record, never a gate on a commit.

## Complete

Two paths reach `status: completed`, and they differ in who decides:

1. **`/project complete <slug>` — the user asked for it.** Present summary +
   loose ends, then set `status: completed`, remove `next` / `blocked-on`, and
   write the `## Outcome` section.
2. **`/close` § 2 — the last piece of work just landed.** The flip is automatic
   there and is NOT asked about: when nothing countable is
   outstanding and the goal is met, `/close` sets `completed` (or `monitor` +
   `monitoring-until:` when the shipped thing still has to prove itself on a
   future run) in the same README write as the session update. See
   `.agents/skills/close/SKILL.md` § 2 — that section is the SSOT for the
   automatic flip; do not restate its rules here.

A project reaching this skill already `completed` is a report-state, not a
re-close.

## Frontmatter Change

1. Update the relevant field(s) in project frontmatter (`status`, `priority`, `next`, `blocked-on`, `monitoring-until`, `description`, `tags`)
2. For `blocked` status: use `blocked-on` instead of `next`. For `monitor` status: use `monitoring-until: YYYY-MM-DD`. A rewritten `description:` keeps its 60-character budget, and so do `next:`, `blocked-on:` and `monitoring-until:` (the date counts). All three are ONE short human-facing sentence (the single immediate next action / what it's blocked on / the observation window) — never a multi-action backlog or status dump.
3. Leave the edit uncommitted and dispatch `/close` — it commits the frontmatter
   change along with anything else the session touched, in the session's ONE
   commit. A status flip is not worth its own commit, and committing here would
   mean a second one lands minutes later carrying the journal.

## Why a fresh context between think and do

The failure mode is the same session holding the plan + the investment in prior choices, then defending them mid-stream — hours of drift before anyone notices. The fresh-context boundary between think (`/project`) and do (`/implement`) is the methodological fix. Nothing enforces it mechanically, so the boundary rests on `step-2-turn-count-gate` above and on opening a new tab, which costs nothing; `/clear` works too.

## Scripts

| Script | Purpose | Inputs → Output |
|---|---|---|
| [`scripts/render-index.sh`](scripts/render-index.sh) | **The whole blank-mode render in one call** — runs the index generator, appends the lapsed-window block (formatting `check-staleness.sh --expired-only`'s rows per § Lapsed monitor windows), appends the closing prompt. ~0.5s. Composition only, no judgment; nothing is left for the model to assemble | none → finished markdown on stdout, pasted verbatim |
| [`scripts/parse-arg-mode.sh`](scripts/parse-arg-mode.sh) | Parse `$ARGUMENTS` into a mode tag | `[input]` → `mode: blank\|create\|existing-slug\|complete\|update` + `payload: [remainder]` |
| [`scripts/find-project.sh`](scripts/find-project.sh) | Resolve a slug to a project folder path; suggest nearest matches if not found | `[slug or domain/slug]` → `PATH:...`, `NOT_FOUND`, or `NOT_FOUND:nearest: ...` |
| [`scripts/detect-stage.sh`](scripts/detect-stage.sh) | Detect project stage from filesystem + frontmatter + ROADMAP rows | `[project-path]` → `stage: needs-planning\|all-specs-reported\|ready-to-implement\|ready-to-close\|monitor\|blocked\|completed\|unknown` + active spec path (`specs/NNN-name/spec.md`, or a legacy `*.spec.md` / `*.plan.md`) + spec/report counts + `next-row:` on a ROADMAP project + `roadmap-error:` when its table is malformed + `spec-state-error:` (and `stage: unknown`) when `spec-state.sh` crashed |
| [`scripts/check-staleness.sh`](scripts/check-staleness.sh) | Two scans. `--expired-only`: monitor projects whose `monitoring-until:` has passed — fires on EVERY blank-mode render (`step-0.5-render-index`), ~0.2s. No flag: also scans active/blocked/monitor for no recent journal mention — optional, fire when the user asks "anything I'm forgetting?", ~1.2s | `--expired-only` \| `[days]` (default 14) → zero+ lines `EXPIRED:[domain]/[slug]:monitoring-until=[date]:days-overdue=[N]`, `NOWINDOW:[domain]/[slug]`, `STALE:[domain]/[slug]:days-since-last-mention=[N\|never]` |

Each has a `*.test.sh` beside it.

Note: `node .agents/generators/project-index.generate.ts --compact` is invoked by `render-index.sh` (not by the model directly) and produces the slim priority-sorted view as finished markdown: **Active — N**, **Blocked — N** and **Monitoring — N** tables (`glyph | slug | one-line`), then **Completed — N**. The BLANK LINE between each heading and its table header is load-bearing and MUST NOT be tidied away: glued together they are one paragraph, and in common chat markdown renderers a table cannot interrupt a paragraph, so the index collapses into a blob of literal pipes. Every heading carries its own count in the same shape, so bucket sizes read without counting rows. `render-index.sh` holds the Completed line back and re-prints it beneath the lapsed block, which is why that line is emitted last here. Shape is fixed in `buildCompact` precisely so the skill's paste is a copy, not a composition. The skill reads the working tree live (uncommitted freshness).

## Examples

### Example 1: blank invocation

User: `/project`

Actions:
1. `step-0-resolve-mode` → `parse-arg-mode.sh` returns `mode: blank`.
2. `step-0.5-render-index` → run `bash .agents/skills/project/scripts/render-index.sh` via Bash.
3. Paste the entire captured stdout into the assistant response as user-visible text, verbatim — index, lapsed-window block and closing prompt are all already in it. Add nothing.

Output: the reply body itself contains the `**Active — N**`, `**Blocked — N**` and `**Monitoring — N**` markdown tables, then any `**Lapsed — N**` block, then `**Completed — N**`, then the prompt. If the reply is shorter than the script's stdout, step 3 didn't happen.

### Example 2: existing slug, needs-planning stage

User: `/project checkout-retries`

Actions:
1. `step-0-resolve-mode` → `mode: existing-slug`, payload `checkout-retries`.
2. `step-1-stage-detect-and-route` → `find-project.sh checkout-retries` → `PATH:projects/web/2026-01-10_checkout-retries`.
3. `detect-stage.sh projects/web/2026-01-10_checkout-retries` → `stage: needs-planning`.
4. Run the think flow (step-0-goal-alignment first per Critical, then step-1-context-load → step-3.5-categorize → step-4-dispatch-spec, which hands off to `/spec`).

Output: `/spec` writes `projects/web/2026-01-10_checkout-retries/specs/001-{name}/` and its ROADMAP.md row, runs `/spec-audit` on the folder, and auto-closes (commit + push) with the `## SPEC Created` summary — unless a reviewer escalation or spirit DRIFT halts for the user. The session ends; `/implement` runs in a fresh tab.

### Example 3: existing slug, ready-to-implement, short session

User (in a fresh tab): `/project sync-engine`

Actions:
1. `parse-arg-mode.sh` → `mode: existing-slug`.
2. `detect-stage.sh` → `stage: ready-to-implement`, active-spec `specs/001-foundation/spec.md`, next-row `R1` (a legacy project shows `foundation.spec.md` and no next-row).
3. `step-2-turn-count-gate` → short session (< 50 turns). Invoke `/implement sync-engine` inline.

Output: /implement runs end-to-end.

### Example 4: existing slug, ready-to-implement, long session

User (in a long-running session): `/project sync-engine`

Actions:
1-2. Same as Example 3.
3. `step-2-turn-count-gate` → long session detected. Emit ONE line.

Output: `Long session — open a fresh tab and paste: /implement sync-engine`.

### Example 5: blocked project

User: `/project payments-migration`

Actions:
1-2. `mode: existing-slug`, resolve to `projects/web/2026-01-11_payments-migration`.
3. `detect-stage.sh` → `stage: blocked`.
4. Read `blocked-on:` from frontmatter. Report what's blocking. No further action.

Output: "Blocked on: the payment provider approving production API access. No action available until it lands."

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `parse-arg-mode.sh` returns `mode: create` for what looks like a slug | Slug has no hyphen (e.g., `test`) so the kebab heuristic doesn't fire | Use the full `domain/slug` form, or rename the project folder to a multi-word kebab slug |
| `detect-stage.sh` returns `stage: unknown` | README missing, status: frontmatter unrecognized, or a `roadmap-error:` line | Open the project's README.md and verify the frontmatter `status:` line uses one of: active, blocked, monitor, completed; for a `roadmap-error:`, fix the table it names |
| Router invoked /implement from a long session and it ran anyway | Nothing refuses one | `step-2-turn-count-gate` is the only guard; if it was skipped, stop and re-invoke `/implement <slug>` from a fresh tab |
| Multi-SPEC project: wrong SPEC picked as active | `detect-stage.sh` asks `close/scripts/spec-state.sh` which SPECs are still owed work — a declared `spec-status:`/`**Status**:` beats the filename, and a report named for a slice (`phase-2-sync-freshness-report.md`) counts as `partial`, not done | Read the report's own Status line. If it says the SPEC is finished, say so there rather than renaming the file — the declaration is the SSOT and renaming loses which slice the report covered |
| `stage: ready-to-close` on a project nobody is closing | A spec was reported complete but the close that should have flipped its row to `done` did not finish | Invoke `/close`; it flips the row and re-derives `next:` |
| Goal-alignment skipped, went straight to context-load | Critical violation of goal alignment | Stop, restate goal+mechanism, ask "does this match?", wait for explicit yes before continuing |
