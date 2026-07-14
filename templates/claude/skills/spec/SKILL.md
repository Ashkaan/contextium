---
name: spec
description: Write the SPEC. Given a design (handed over by /project, or gathered ad-hoc mid-session), write the lean 4-section SPEC file, sanity-check it against the user's ask with the spirit-check agent, then auto-invoke /close on a clean pass. The SPEC-writing half of the loop's Think verb — broken out so a SPEC can be produced anytime one is needed, not only inside a full /project think flow.
disable-model-invocation: false
argument-hint: "[spec-name or scope hint]"
allowed-tools: "Bash(.claude/skills/close/scripts/*:*) Read Edit Write Task Skill AskUserQuestion"
peers:
  - .claude/skills/project/SKILL.md
  - .claude/agents/spirit-check.md
  - .claude/skills/project/references/spec-schema.md
  - .claude/skills/close/references/auto-close-gate.md
  - .claude/templates/spec-lean.md
enforces:
  - "@rule:boundary-inputs"
  - "@rule:simplest-solution-default"
  - "@rule:depth-policy"
  - "@rule:no-deferral"
handoffs_from:
  - .claude/skills/project/SKILL.md
handoffs_to:
  - .claude/skills/close/SKILL.md
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
      condition: "Dispatch the spirit-check agent with the user's verbatim ask plus the SPEC's Ask + Behavior sections, to catch interpretation drift (you asked for X, the SPEC describes Y). On DRIFT, fix the SPEC before continuing; a drift the user must adjudicate is a depth-policy decision → HALT."
  - id: step-3-auto-close
    kind: gate
    gate:
      tool: skill
      on_fail: halt
      condition: "Terminal auto-close gate. SPEC written + spirit-check clean and no depth-policy decision / deferral outstanding → auto-invoke /close per .claude/skills/close/references/auto-close-gate.md (check close-fired.sh status, mark, dispatch /close to commit the SPEC). The SPEC commits and is revised on the main branch — no sign-off halt. The next /implement runs in a fresh context (a new tab, or /clear)."
---

# /spec — write the SPEC

`/spec` is the **SPEC-writing half of the Think verb**. `/project` does the thinking — goal-alignment, context-load, explore, design — then hands the design to `/spec`, which writes the actual SPEC file, spirit-checks it, and auto-closes (commits) on a clean pass. Breaking it out means a SPEC can be produced ANY time one is needed: inside a full `/project` think flow, OR ad-hoc when work-in-progress turns out to need one in the moment.

## Critical

- **The SPEC stays lean.** Four sections — Ask / Behavior / Files / Done — per [`.claude/templates/spec-lean.md`](../../templates/spec-lean.md). Don't pad it with boilerplate that degrades to "N/A"; a heavy project grows its own sections when a real gap bites, per `@rule:simplest-solution-default`.
- **The Ask section is the user's verbatim ask.** Capture it in their words. It's the thing the finished work is checked against — it keeps the implementation from drifting into a fancier interpretation than was wanted.
- **`/spec` auto-closes; there is no sign-off halt.** On a clean spirit-check, `/spec` auto-invokes `/close` to commit the SPEC (per [`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md)). The SPEC lands on the main branch and is revised there — the user reviews it in the fresh `/implement` tab, not at a pre-commit gate. `/spec` only HALTS if a spirit-check DRIFT is a genuine choice the user must make (a `@rule:depth-policy` decision).
- **Fresh-context boundary preserved.** `/spec`'s auto-close ENDS the session. The next `/implement` runs in a fresh tab — `/spec` does NOT roll into `/implement`.
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

The lightest review the methodology ships with, and the gate that decides whether auto-close fires. Dispatch the `spirit-check` agent with the user's verbatim ask plus the SPEC's Ask and Behavior sections. The agent reads ONLY those — its single job is to catch interpretation drift (you asked for a function, the SPEC describes a deployed service). On a MATCH, proceed to auto-close. On DRIFT, fix the SPEC; if the drift is a genuine choice the user must make, that's a `@rule:depth-policy` decision — surface it and HALT (auto-close doesn't fire until it's resolved).

Heavier multi-model SPEC review (an external reviewer pass, a consensus loop) is an advanced pattern to grow into, not wired into the starter template.

## step-3-auto-close — auto-invoke /close

Terminal gate. The SPEC is written and spirit-checked clean, and no depth-policy decision or deferral is outstanding. Per the auto-close gate ([`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md)): check `close-fired.sh status`, `mark`, and dispatch `/close`. The SPEC is committed to the main branch — **no sign-off halt** — and the user reviews it in the fresh `/implement` tab, revising on main if needed.

Auto-close ENDS this session. **Do not start implementing.** `/implement` runs in a fresh context — open a new tab (or `/clear`), then `/implement <project-slug>`.

Before dispatching `/close`, print a short summary so the closing commit is legible:

```markdown
## SPEC Created

**File**: `<spec-path>`
**Summary**: {2-3 sentence overview}
**Scope**: {N} files to CREATE, {M} to UPDATE, {K} total tasks
**Key Patterns**: {pattern with file:line}, {pattern with file:line}
**Spirit-check**: {MATCH | DRIFT — <what was fixed>}

**Next Step**: `/close` is committing the SPEC now. Review it on the branch, then in a fresh context (a new tab, or `/clear`): `/implement <project-slug>`
```

## Examples

### Example 1 — dispatched by /project (the golden path)

`/project <slug>` runs the think flow through design, then its `think-step-4-dispatch-spec` invokes `/spec`. `step-1` writes `projects/<domain>/<date>_<slug>/main.spec.md`. `step-2` dispatches `spirit-check` → MATCH. `step-3` prints `## SPEC Created` and auto-invokes `/close`, which commits the SPEC to main. The session ends; the user opens a fresh tab for `/implement` and reviews the committed SPEC there.

### Example 2 — ad-hoc mid-session SPEC

Working together, it turns out a small change needs a SPEC. `/spec "<scope hint>"` reads the design context already in session (lighter than a full think flow), writes the SPEC at the schema-correct location, spirit-checks it, and auto-closes (commits). No `/project` think flow required.

### Example 3 — spirit DRIFT

`step-2` returns spirit-check DRIFT (the SPEC's Behavior diverged from the user's Ask). `/spec` fixes the SPEC to match the ask. If the divergence is a real choice, it surfaces the decision and HALTS — auto-close does not fire until the user resolves it; then `/spec` resumes and auto-closes.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| SPEC written but not at the schema location | Wrong work-shape branch in `step-1` | Re-check the location table; new apps → `apps/{name}/SPEC.md`, non-app → `projects/.../{name}.spec.md` |
| spirit-check agent "not found" | Harness hasn't auto-loaded `.claude/agents/spirit-check.md` this session | Fall back to a `general-purpose` agent with the spirit-check body prepended, and note the fallback in the summary |
| `/spec` rolled straight into implementing | `step-3` auto-close dispatched `/implement` instead of `/close` | Auto-close commits the SPEC and ENDS the session; the fresh-context boundary is load-bearing — `/implement` runs in a new tab, never inline |
| `/close` fired twice | `close-fired` marker missing (no session id) | Expected fail-safe; `close-fired.sh` skips dedup when `CLAUDE_CODE_SESSION_ID` is unset. A rare same-session double-close is harmless |
