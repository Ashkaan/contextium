---
name: project
description: Single entry point for project work. No args renders the live priority-sorted project index. Existing slug loads the README, detects stage via scripts/detect-stage.sh, and routes to the right action (think flow, /implement, /close, or report-state). New freeform creates a project and runs the think flow. complete/update modes do status changes only. Composes /spec, /implement, and /close as primitives. Use when the user says "/project", "/project [slug]", "let's work on [project]", "create a project for [X]", "complete [slug]", or "update [slug]".
disable-model-invocation: false
argument-hint: "[create|complete|update] [description or domain/slug]"
allowed-tools: "Bash(.claude/skills/project/scripts/*:*) Bash(node .claude/hooks/generators/project-index.generate.ts:*) Read Edit Write Task AskUserQuestion Skill"
peers:
  - .claude/skills/spec/SKILL.md
  - .claude/skills/implement/SKILL.md
  - .claude/skills/close/SKILL.md
  - .claude/hooks/generators/project-index.generate.ts
enforces:
  - "@rule:boundary-inputs"
  - "@rule:depth-policy"
  - "@rule:simplest-solution-default"
  - "@rule:no-deferral"
handoffs_to:
  - .claude/skills/spec/SKILL.md
  - .claude/skills/implement/SKILL.md
  - .claude/skills/close/SKILL.md
writes:
  - projects/{domain}/{date}_{slug}/{name}.spec.md
steps:
  - id: step-0-resolve-mode
    kind: action
    action: "Run scripts/parse-arg-mode.sh on $ARGUMENTS. Output 'mode:' line determines flow: blank → step-0.5-render-index; create → new project + think flow; existing-slug → step-1-stage-detect-and-route; complete → status change only; update → frontmatter edit only."
  - id: step-0.5-render-index
    kind: action
    action: "For blank-mode only. Run `node .claude/hooks/generators/project-index.generate.ts --out -` via Bash. CRITICAL: COPY THE ENTIRE CAPTURED STDOUT into your assistant response as user-visible text — do NOT stop at the Bash tool card. After pasting, prompt 'Which one to start? Type /project [slug].'"
  - id: step-1-stage-detect-and-route
    kind: action
    action: "For existing-slug paths: resolve slug via scripts/find-project.sh, then run scripts/detect-stage.sh on the project folder. Route per Stage Detection table: needs-planning → think flow; ready-to-implement → invoke /implement (with turn-count judgment per step-2-turn-count-gate); ready-to-close → invoke /close; monitor/blocked/completed → report state (read-only — MUST NOT execute the next step, just describe what it is)."
  - id: step-2-turn-count-gate
    kind: gate
    gate:
      tool: halt
      on_fail: halt
      condition: "Before invoking /implement from within /project: judge session length. Short session (clear sense of fewer than 50 prior user turns): invoke /implement [slug] inline. Long session: emit ONE line 'Long session — open a fresh tab and paste: /implement [slug].' That's the only acceptable copy-paste-command output."
  - id: think-step-0-goal-alignment
    kind: gate
    gate:
      tool: AskUserQuestion
      on_fail: halt
      condition: "BEFORE any context-load: produce goal in plain language + simplest mechanism + explicit ask 'does this match?'. MUST wait for explicit yes/approval. Silence is NOT approval."
  - id: think-step-1-context-load
    kind: action
    action: "Load focused context. Always load base (CLAUDE.md, git log, last 3 journals). Scope slice per path prefix table in body. Don't over-load — use an Explore agent for cross-file pattern questions."
  - id: think-step-2-explore
    kind: action
    action: Use an Explore agent to find similar implementations, naming conventions, error handling, types, tests, and any existing primitive the SPEC would otherwise reinvent. Document patterns with file:line references.
  - id: think-step-3-design
    kind: action
    action: Map files to CREATE / UPDATE. Identify risks with mitigations. Enumerate boundary cases per @rule:boundary-inputs (0/1/empty/max/error).
  - id: think-step-4-dispatch-spec
    kind: gate
    gate:
      tool: skill
      on_fail: halt
      condition: "Hand the agreed design to /spec. Dispatch the /spec skill, which writes the lean 4-section SPEC at projects/{domain}/{date}_{slug}/{name}.spec.md, spirit-checks it, and auto-closes (commits the SPEC) on a clean pass — no sign-off halt. /project does NOT write the SPEC inline and does NOT roll into /implement — that runs in a fresh context, where the user reviews the committed SPEC."
---

# /project — the project entry point

`/project` is the **single entry point for project work**. It composes the loop's three verbs (think → do → wrap) into one skill that picks the right action based on what you asked and what stage the project is in.

## Critical

- **Goal-alignment ALWAYS comes first** when the think flow runs (per `@rule:depth-policy`). The think flow's `think-step-0-goal-alignment` produces (goal in plain language + simplest mechanism + explicit ask "does this match?") and MUST wait for explicit user approval before context-load, design, or SPEC writing. Silence is NOT approval. Skipping this is the most expensive mistake the loop can make — a goal/shape mismatch caught up front costs one turn; caught after the work is built it costs the rebuild.
- **No copy-paste-command outputs as the default.** When the router lands on `ready-to-implement` in a short session, INVOKE `/implement [slug]` inline — do not tell the user to paste a command. The only acceptable copy-paste output is the long-session fresh-tab handoff (see `step-2-turn-count-gate`), and only because `/implement`'s fresh-context boundary is load-bearing.
- **Stage detection is a script result, not a judgment.** Run `scripts/detect-stage.sh` to get the stage; don't infer from prose.
- **Blank-mode: paste the generator output INTO your response.** After `step-0.5-render-index` runs Bash, the captured stdout is in your context but NOT yet visible to the user (the Bash tool card is truncated). You MUST copy the entire stdout into your assistant message body. "Ran the generator" is not the deliverable; the user reading the index in your reply IS.
- **The SPEC stays lean, and `/project` doesn't write it — `/spec` does.** The think flow ends by dispatching `/spec` (`think-step-4-dispatch-spec`), which writes the four-section SPEC (Ask / Behavior / Files / Done per `.claude/templates/spec-lean.md`), spirit-checks it, and auto-closes (commits it) — the user reviews the committed SPEC in the fresh `/implement` tab, not at a sign-off gate. Don't pad it with boilerplate that degrades to "N/A"; a heavy project grows its own sections when a real gap bites, per `@rule:simplest-solution-default`.

## Modes (`step-0-resolve-mode`, `step-0.5-render-index`)

| Argument | What /project does | Mechanism |
|---|---|---|
| blank | Run the project-index generator, **paste output into your response**, then prompt "Which one to start? Type /project [slug]." | `step-0.5-render-index` |
| `create <description>` or bare freeform new | New project + think flow | inline think flow |
| `<domain>/<slug>` or `<slug>` (existing) | Load README → detect stage → route | `step-1-stage-detect-and-route` + table below |
| `complete <slug>` | Status change only | inline (no delegation) |
| `update <slug>` | Frontmatter edit only | inline (no delegation) |

## Stage Detection & Routing (`step-1-stage-detect-and-route`)

For existing-project-slug paths only. Load `projects/<domain>/<date>_<slug>/README.md` first, then route per the table below. Detection is observable from filesystem + frontmatter — no AI judgment needed for the detection itself.

| Detected stage | Detection signal | What /project does |
|---|---|---|
| **needs-planning** | `status: active` + no `*.spec.md` file in project folder | Run the think flow (steps 0–4 below); `think-step-4-dispatch-spec` hands off to `/spec`, which writes, spirit-checks, and auto-closes (commits) the SPEC. |
| **ready-to-implement** | `status: active` + `*.spec.md` exists + no corresponding `*-report.md` | Check session turn count (see § Turn-count gate below). Fresh session → invoke `/implement <slug>` inline. Long session → emit a single-line message: "Long session — open a fresh tab and paste: `/implement <slug>`." |
| **ready-to-close** | `status: active` + `*-report.md` exists + no `journal/<today>.md` session block referencing this slug | Invoke `/close` inline. |
| **monitor** | `status: monitor` | Read `monitoring-until:` + watch criteria. Report state. No further action. |
| **blocked** | `status: blocked` | Read `blocked-on:`. Report what's blocking. No further action. |
| **completed** | `status: completed` | Read `## Outcome` section. Report. No further action. |

### Turn-count gate (step-2-turn-count-gate) — for ready-to-implement only

`/implement` enforces a fresh-context boundary (it refuses to run with a long prior context). That boundary fires on direct user invocation, not on skill-to-skill dispatch. So `/project` must apply its own turn-count judgment BEFORE invoking `/implement` — otherwise the protection is bypassed.

Use your own awareness of session length:
- Short session (you have a clear sense of <50 prior user turns): invoke `/implement <slug>` inline. Work starts immediately.
- Long session (the conversation has been going for a while; >50 turns or feels long): do NOT invoke. Emit ONE line: `Long session — open a fresh tab and paste: \`/implement <slug>\`.` That's the only acceptable "copy-paste command" — and only because the fresh-context boundary is load-bearing.

If unsure whether the session is long, lean toward invoking — `/implement`'s own fresh-context check is the backstop.

## Canonical project README scaffold

See [references/readme-template.md](references/readme-template.md) for the canonical project README scaffold, optional sections, folder structure, domain convention, naming convention, and priority classifier.

## Create (+ think flow)

When invoked with a free-form description (not an explicit `complete` / `update` verb), treat it as a new project.

1. Determine the domain (ask if unclear). Domain is any short kebab folder under `projects/` (e.g. `ai`, `finance`, `home`, `business`). New domain → ask the user first.
2. Create folder: `/projects/{domain}/YYYY-MM-DD_brief-description/`
3. Create `README.md` with frontmatter (`project`, `status`, `priority`, `created`, `tags`, `description`, `next`) and body sections (Goal, Status, Current Progress, Next Steps). Priority classifier: `high` = serves an explicit current goal; `medium` = meta-infrastructure (rules/hooks/skills/support-apps); `low` = neither.
4. Run the **think flow** below to produce the project's first SPEC file.
5. Commit the README + SPEC together.

## Work an existing project (router behavior)

Invoked with `<domain>/<slug>` or a bare `<slug>` matching an existing project. Don't recreate the README — read it, run stage detection, route per the Stage Detection table above.

The think flow only fires when the detected stage is **needs-planning** (no SPEC file yet). When a project already has a SPEC + no report, route to /implement instead. When a project has a report but isn't closed, route to /close. A project folder holds more than one SPEC over its life (`foundation.spec.md`, then per-phase SPECs) — name each for what it covers. Multiple SPEC files: pick the most-recent that has no sibling `*-report.md` as the active SPEC; if all SPECs are reported, the next stage is needs-planning again (for the next chunk of work).

## The think flow

The think flow is **SPEC-write only — no code written.** It produces a context-rich SPEC file (lean 4-section template) that `/implement` executes one-pass in a fresh context.

**Order: goal-alignment first, then codebase, then design.** Per `@rule:depth-policy`, every think flow starts with a one-turn goal+shape gate BEFORE any context-load, design, or SPEC writing.

### `think-step-0-goal-alignment` — agree on the goal + simplest shape

Before any context-load, codebase reading, or SPEC writing, produce a one-turn statement with:

1. **The goal in plain language**, sized to the work (a sentence for simple work, a paragraph or bullet list for complex projects, a numbered list of outcomes when scope is wide).
2. **The simplest mechanism** you think achieves it (also plain language; cite an existing pattern if one fits, to avoid authoring new infrastructure, per `@rule:simplest-solution-default`).
3. An explicit ask: "Does this match what you want?"

MUST wait for explicit approval or revision before proceeding to `think-step-1-context-load`. Approval = "yes" / "do it" / "ship it"; revision = any change to the goal or mechanism. Silence is NOT approval. MUST NOT bundle goal-alignment into the same turn as the first design artifact — present goal+mechanism first, get acknowledgment, THEN move to step-1.

See [references/think-flow-deep.md § think-step-0-goal-alignment](references/think-flow-deep.md#think-step-0-goal-alignment--why-this-gate-exists) for why this gate exists.

### `think-step-1-context-load` — load focused context

Load only what the work needs. Always load base: CLAUDE.md (auto-loaded on a fresh session), `git log --oneline -20`, last 3 `journal/*.md` files. Then load the scope slice based on the path prefix:

| Scope shape | What loads |
|---|---|
| `apps/<name>` | `apps/<name>/README.md` + `SPEC.md` (if exists) + the main source files + tests + `git log --oneline -10 -- apps/<name>/` |
| `integrations/<name>` | `integrations/<name>/README.md` + the typed client + frontmatter + `git log --oneline -10 -- integrations/<name>/` |
| `projects/<domain>/<slug>` | the project `README.md` + recent journal entries touching it + linked rules (`@rule:<id>` mentioned in the README) |
| `.claude/rules/<file>` | the rule file + peers (frontmatter `peers:`) + skills citing it |

For an existing project, the load is driven by the project README's inputs list. Don't read more than the scope needs — over-loading defeats the purpose. Use an Explore agent for cross-file pattern questions rather than Read across many files.

### `think-step-2-explore` — find the patterns AND the primitives

Use an **Explore agent** (lighter on context than direct reads) to find:

1. **Similar implementations** — analogous features with file:line references
2. **Naming conventions** — actual examples from the codebase
3. **Error handling patterns** — how errors are created and handled
4. **Type definitions** — relevant interfaces and types
5. **Test patterns** — test file structure and assertion styles
6. **Existing primitives the SPEC would otherwise reinvent** — for every helper, utility function, or wrapper the SPEC is about to introduce by name, MUST grep the repo for the name + 2–3 plausible synonyms BEFORE adding it to the Files-to-Change list. Per `@rule:simplest-solution-default`, if the function already exists it MUST be reused; a parallel implementation is a hard violation. See [references/think-flow-deep.md § think-step-2-explore](references/think-flow-deep.md#think-step-2-explore--primitives).

Document patterns in a table: `Category | File:Lines | Pattern` (NAMING / ERRORS / TYPES / TESTS / PRIMITIVES).

### `think-step-3-design` — map the changes

- Files to CREATE / UPDATE, in dependency order
- Per `@rule:boundary-inputs`, enumerate behavior at: 0 inputs (empty), 1 input, empty (blank/null), max (large), error (invalid)
- **Boundary cases that describe existing code behavior MUST cite `file:line`.** Read the file, confirm the actual behavior, cite the line. Inference from memory is forbidden. See [references/think-flow-deep.md § think-step-3](references/think-flow-deep.md#think-step-3-design--boundary-cites-and-rules-made-incorrect).
- **Enumerate rules made incorrect by this work.** Grep `.claude/rules/*.md` for any statement that will no longer be true after the work ships (a new path-of-use for a primitive, a retired file path). Each such rule MUST be amended in the same commit per `@rule:no-deferral`. Document the amendments in the Files-to-Change list.
- Identify risks in a `Risk | Mitigation` table
- Land the full scope in this session — list every downstream consumer that needs updating, nothing deferred, per `@rule:no-deferral`.

### `think-step-4-dispatch-spec` — hand off to /spec

`/project` does not write the SPEC inline. Once the design is agreed (goal-aligned, explored, mapped), dispatch the [`/spec`](../spec/SKILL.md) skill with the design context. `/spec` writes the lean 4-section SPEC (**Ask / Behavior / Files / Done** per [`.claude/templates/spec-lean.md`](../../templates/spec-lean.md); see [references/spec-schema.md](references/spec-schema.md) for the explainer) to `projects/{domain}/{date}_{slug}/{name}.spec.md`, runs the `spirit-check` agent to catch interpretation drift, and auto-closes (commits the SPEC) on a clean pass per [`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md).

A multi-session project produces multiple SPECs over its life (`foundation.spec.md`, then per-phase SPECs) — name each for what it covers. Genuinely one-off work too small for the think flow skips it entirely: do the work directly and journal it.

**Do not start implementing.** `/implement` runs in a fresh context — open a new tab (or `/clear`), then `/implement <project-slug>`. That fresh-context boundary is why the think flow ends at `/spec`'s auto-close (which commits the SPEC and ENDS the session) rather than rolling into the build. The user reviews the committed SPEC in the fresh `/implement` tab.

## Complete

Only the user can mark a project complete. Present summary + loose ends, ask for confirmation. Then:

1. Set `status: completed` in frontmatter
2. Remove `next`/`blocked-on`, write `## Outcome` section

## Frontmatter Change

1. Update the relevant field(s) in project frontmatter (`status`, `priority`, `next`, `blocked-on`, `monitoring-until`, `description`, `tags`)
2. For `blocked` status: use `blocked-on` instead of `next`. For `monitor` status: use `monitoring-until: YYYY-MM-DD`.

## Why a fresh context between think and do

The failure mode is the same Claude session holding the plan plus the investment in prior choices, then defending them mid-stream when implementation runs in-context. The fresh-context boundary between think (`/project`) and do (`/implement`) is the methodological fix. `/implement` enforces it by refusing a long prior context. A new tab has zero prior turns and passes naturally; `/clear` works too.

## Scripts

| Script | Purpose | Inputs → Output |
|---|---|---|
| [`scripts/parse-arg-mode.sh`](scripts/parse-arg-mode.sh) | Parse `$ARGUMENTS` into a mode tag | `[input]` → `mode: blank\|create\|existing-slug\|complete\|update` + `payload: [remainder]` |
| [`scripts/find-project.sh`](scripts/find-project.sh) | Resolve a slug to a project folder path; suggest nearest matches if not found | `[slug or domain/slug]` → `PATH:...`, `NOT_FOUND`, or `NOT_FOUND:nearest: ...` |
| [`scripts/detect-stage.sh`](scripts/detect-stage.sh) | Detect project stage from filesystem + frontmatter | `[project-path]` → `stage: needs-planning\|ready-to-implement\|ready-to-close\|monitor\|blocked\|completed` + active spec path + spec/report counts |
| [`scripts/check-staleness.sh`](scripts/check-staleness.sh) | Scan active/blocked/monitor projects for stale (no recent journal mention) ones — optional, fire only when user asks "anything I'm forgetting?" | `[days]` (default 14) → zero+ lines `STALE:[domain]/[slug]:days-since-last-mention=[N]` |

Note: `node .claude/hooks/generators/project-index.generate.ts --out -` is invoked by `step-0.5-render-index` and produces the priority-sorted Active/Blocked/Monitoring table.

## Examples

### Example 1: blank invocation

User: `/project`

Actions:
1. `step-0-resolve-mode` → `parse-arg-mode.sh` returns `mode: blank`.
2. `step-0.5-render-index` → run `node .claude/hooks/generators/project-index.generate.ts --out -` via Bash.
3. Paste the entire captured stdout into the assistant response as user-visible text.
4. After the table, prompt: "Which one to start? Type `/project [slug]`."

Output: the full priority-sorted Active/Blocked/Monitoring table inline in the reply, then the prompt.

### Example 2: existing slug, needs-planning stage

User: `/project lead-intake-automation`

Actions:
1. `step-0-resolve-mode` → `mode: existing-slug`, payload `lead-intake-automation`.
2. `step-1-stage-detect-and-route` → `find-project.sh lead-intake-automation` → `PATH:projects/business/2026-05-05_lead-intake-automation`.
3. `detect-stage.sh projects/business/2026-05-05_lead-intake-automation` → `stage: needs-planning`.
4. Run the think flow (step-0-goal-alignment first per Critical, then step-1-context-load → step-3-design → step-4-dispatch-spec, which invokes `/spec`).

Output: `/spec` writes a SPEC file at `projects/business/2026-05-05_lead-intake-automation/{name}.spec.md`, spirit-checks it, and auto-closes (commits it). The session ends; the user opens a fresh tab for `/implement` and reviews the committed SPEC there.

### Example 3: existing slug, ready-to-implement, short session

User (in a fresh tab): `/project index-generator`

Actions:
1. `parse-arg-mode.sh` → `mode: existing-slug`.
2. `detect-stage.sh` → `stage: ready-to-implement`, active-spec `foundation.spec.md`.
3. `step-2-turn-count-gate` → short session (< 50 turns). Invoke `/implement index-generator` inline.

Output: /implement runs end-to-end.

### Example 4: existing slug, ready-to-implement, long session

User (in a long-running session): `/project index-generator`

Actions:
1-2. Same as Example 3.
3. `step-2-turn-count-gate` → long session detected. Emit ONE line.

Output: `Long session — open a fresh tab and paste: /implement index-generator`.

### Example 5: blocked project

User: `/project vendor-migration`

Actions:
1-2. `mode: existing-slug`, resolve to `projects/business/2026-05-11_vendor-migration`.
3. `detect-stage.sh` → `stage: blocked`.
4. Read `blocked-on:` from frontmatter. Report what's blocking. No further action.

Output: "Blocked on: the vendor's reply to the migration quote. No action available until the response lands."

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `parse-arg-mode.sh` returns `mode: create` for what looks like a slug | Slug has no hyphen (e.g., `test`) so the kebab heuristic doesn't fire | Use the full `domain/slug` form, or rename the project folder to a multi-word kebab slug |
| `detect-stage.sh` returns `stage: unknown` | README missing or status: frontmatter unrecognized | Open the project's README.md and verify the `status:` line uses one of: active, blocked, monitor, completed |
| Router invoked /implement but it refused | Long session (>50 turns) skipped the turn-count gate | Re-invoke from a fresh tab with the same slug; the `step-2-turn-count-gate` should have caught this |
| Multi-SPEC project: wrong SPEC picked as active | `detect-stage.sh` picks the most-recent `.spec.md` without a sibling `-report.md` | Verify SPEC/report naming matches: `foo.spec.md` pairs with `foo-report.md` (NOT `foo.report.md`). Rename if mismatched |
| Goal-alignment skipped, went straight to context-load | Critical violation of `@rule:depth-policy` | Stop, restate goal+mechanism, ask "does this match?", wait for explicit yes before continuing |
