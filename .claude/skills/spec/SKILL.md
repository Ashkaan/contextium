---
name: spec
description: Write the SPEC. Given a design (handed over by /project, or gathered ad-hoc mid-session), write the lean 4-section SPEC file, optionally sanity-check it against the user's ask with the spirit-check agent, then present it for sign-off. The SPEC-writing half of the loop's Think verb — broken out so a SPEC can be produced anytime one is needed, not only inside a full /project think flow.
disable-model-invocation: false
argument-hint: "[spec-name or scope hint]"
allowed-tools: "Read Edit Write Task Skill AskUserQuestion"
peers:
  - .claude/skills/project/SKILL.md
  - .claude/agents/spirit-check.md
  - .claude/skills/project/references/spec-schema.md
  - .claude/templates/spec-lean.md
enforces:
  - "@rule:boundary-inputs"
  - "@rule:simplest-solution-default"
  - "@rule:depth-policy"
  - "@rule:no-deferral"
handoffs_from:
  - .claude/skills/project/SKILL.md
writes:
  - projects/{domain}/{date}_{slug}/{name}.spec.md
  - apps/{name}/SPEC.md
steps:
  - id: step-1-write-spec
    kind: action
    action: "Write the SPEC file using the lean 4-section template at .claude/templates/spec-lean.md (Ask / Behavior / Files / Done). Location depends on work shape per the table in the body — new app: apps/{name}/SPEC.md; non-app work: projects/{domain}/{date}_{slug}/{name}.spec.md."
  - id: step-2-spirit-check
    kind: gate
    gate:
      tool: agent
      on_fail: warn
      condition: "Optional but recommended. Dispatch the spirit-check agent with the user's verbatim ask plus the SPEC's Ask + Behavior sections, to catch interpretation drift (you asked for X, the SPEC describes Y). On DRIFT, fix the SPEC before presenting; a drift the user must adjudicate is a depth-policy decision."
  - id: step-3-user-review
    kind: gate
    gate:
      tool: halt
      on_fail: halt
      condition: "SPEC written (and spirit-checked). HALT — present the SPEC for user sign-off. Do not proceed to /implement; that runs in a fresh context (a new tab, or /clear)."
---

# /spec — write the SPEC

`/spec` is the **SPEC-writing half of the Think verb**. `/project` does the thinking — goal-alignment, context-load, explore, design — then hands the design to `/spec`, which writes the actual SPEC file, sanity-checks it, and presents it for sign-off. Breaking it out means a SPEC can be produced ANY time one is needed: inside a full `/project` think flow, OR ad-hoc when work-in-progress turns out to need one in the moment.

## Critical

- **The SPEC stays lean.** Four sections — Ask / Behavior / Files / Done — per [`.claude/templates/spec-lean.md`](../../templates/spec-lean.md). Don't pad it with boilerplate that degrades to "N/A"; a heavy project grows its own sections when a real gap bites, per `@rule:simplest-solution-default`.
- **The Ask section is the user's verbatim ask.** Capture it in their words. It's the thing the finished work is checked against — it keeps the implementation from drifting into a fancier interpretation than was wanted.
- **Fresh-context boundary preserved.** `/spec` ends at user review. The next `/implement` runs in a fresh tab — `/spec` does NOT roll into `/implement`.
- **Don't paper over a gap.** If the design left a credential, a file path, or an API unresolved, resolve it now (read the file, find the item) — a SPEC that says "from whatever config X uses" is a guess, not a spec.

## step-1-write-spec — write the SPEC file

The SPEC is a committed artifact capturing WHAT this work delivers + HOW + done criteria, using the lean 4-section template. See [project/references/spec-schema.md](../project/references/spec-schema.md) for the section-by-section explainer.

**Location depends on the work shape:**

| Work shape | Destination |
|---|---|
| New app (first SPEC) | `apps/{name}/SPEC.md` (canonical, permanent — evolves in-place) |
| Non-app work (audits, rule/hook edits, refactors) | `projects/{domain}/{date}_{slug}/{name}.spec.md` (project-scoped) |
| Genuinely one-off, too small for a SPEC | Skip — do the work directly and journal it |

A multi-session project produces multiple SPECs over its life (`foundation.spec.md`, then per-phase SPECs) — name each for what it covers.

## step-2-spirit-check — sanity-check against the ask

Optional but recommended, and the lightest review the methodology ships with. Dispatch the `spirit-check` agent with the user's verbatim ask plus the SPEC's Ask and Behavior sections. The agent reads ONLY those — its single job is to catch interpretation drift (you asked for a function, the SPEC describes a deployed service). On a MATCH, proceed. On DRIFT, fix the SPEC; if the drift is a genuine choice the user must make, that's a `@rule:depth-policy` decision — surface it.

Heavier multi-model SPEC review (an external reviewer pass, a consensus loop) is an advanced pattern to grow into, not wired into the starter template. See `docs/architecture.md`.

## step-3-user-review — HALT for user review

Hard stop. The SPEC file is written. Present it for user sign-off. **Do not start implementing.** `/implement` runs in a fresh context — open a new tab (or `/clear`), then `/implement <project-slug>`.

Emit:

```markdown
## SPEC Created

**File**: `<spec-path>`
**Summary**: {2-3 sentence overview}
**Scope**: {N} files to CREATE, {M} to UPDATE, {K} total tasks
**Key Patterns**: {pattern with file:line}, {pattern with file:line}
**Spirit-check**: {MATCH | DRIFT — <what was fixed> | skipped}

**Next Step**: review the SPEC, then in a fresh context (a new tab, or `/clear`): `/implement <project-slug>`
```

## Examples

### Example 1 — dispatched by /project (the golden path)

`/project <slug>` runs the think flow through design, then its `think-step-4-dispatch-spec` invokes `/spec`. `step-1` writes `projects/<domain>/<date>_<slug>/main.spec.md`. `step-2` dispatches `spirit-check` → MATCH. `step-3` presents `## SPEC Created` with the fresh-tab `/implement` next-step and HALTS. The user reviews, then opens a fresh tab for `/implement`.

### Example 2 — ad-hoc mid-session SPEC

Working together, it turns out a small change needs a SPEC. `/spec "<scope hint>"` reads the design context already in session (lighter than a full think flow), writes the SPEC at the schema-correct location, spirit-checks it, presents for review. No `/project` think flow required.

### Example 3 — spirit DRIFT

`step-2` returns spirit-check DRIFT (the SPEC's Behavior diverged from the user's Ask). `/spec` fixes the SPEC to match the ask; if the divergence is a real choice, it surfaces the decision to the user before presenting. Then `step-3` presents the corrected SPEC.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| SPEC written but not at the schema location | Wrong work-shape branch in `step-1` | Re-check the location table; new apps → `apps/{name}/SPEC.md`, non-app → `projects/.../{name}.spec.md` |
| spirit-check agent "not found" | Harness hasn't auto-loaded `.claude/agents/spirit-check.md` this session | Fall back to a `general-purpose` agent with the spirit-check body prepended, or skip the check (it's optional) and note "skipped" in the summary |
| `/spec` rolled straight into implementing | `step-3` halt was skipped | The fresh-context boundary is load-bearing — present the SPEC and stop; `/implement` runs in a new tab |
