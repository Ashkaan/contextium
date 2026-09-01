---
name: spec
description: Write the SPEC. Given a design (handed over by /project, or gathered ad-hoc mid-session), write the lean 4-section SPEC file, audit it via /spec-audit (independent design review + spirit-check), then auto-invoke /close on a clean pass. The SPEC-writing half of the loop's Think verb — broken out so a SPEC can be produced anytime one is needed, not only inside a full /project think flow.
disable-model-invocation: false
argument-hint: "[spec-name or scope hint]"
allowed-tools: "Bash(.agents/skills/close/scripts/*:*) Read Edit Write Task Skill AskUserQuestion"
peers:
  - .agents/skills/project/SKILL.md
  - .agents/skills/spec-audit/SKILL.md
  - .agents/reviewers/spirit-check.md
  - .agents/skills/project/references/spec-schema.md
  - .agents/skills/close/references/auto-close-gate.md
  - .agents/templates/spec-lean.md
enforces:
  - "@rule:boundary-inputs"
  - "@rule:simplest-solution-default"
  - "@rule:depth-policy"
  - "@rule:no-deferral"
handoffs_from:
  - .agents/skills/project/SKILL.md
handoffs_to:
  - .agents/skills/spec-audit/SKILL.md
  - .agents/skills/close/SKILL.md
writes:
  - projects/{domain}/{date}_{slug}/{name}.spec.md
  - apps/{name}/SPEC.md
steps:
  - id: step-1-write-spec
    kind: action
    action: "Write the SPEC file using the lean 4-section template at .agents/templates/spec-lean.md (Ask / Behavior / Files / Done). Location depends on work shape per the table in the body — new app: apps/{name}/SPEC.md; non-app work: projects/{domain}/{date}_{slug}/{name}.spec.md."
  - id: step-2-spec-audit
    kind: gate
    gate:
      tool: skill
      on_fail: halt
      condition: "UNCONDITIONAL. Dispatch /spec-audit on the SPEC path. It decides materiality itself, runs the independent design reviewer and the spirit-check agent, folds accepted findings into the SPEC in place, and returns the `spec-audit:` trailer. A DRIFT the user must adjudicate is a depth-policy decision → HALT. A reviewer that could not run is a FAILED audit → report it, do not auto-close."
  - id: step-3-auto-close
    kind: gate
    gate:
      tool: skill
      on_fail: halt
      condition: "Terminal auto-close gate. SPEC written + /spec-audit clean and no depth-policy decision / deferral outstanding → auto-invoke /close per .agents/skills/close/references/auto-close-gate.md (check close-fired.sh status, mark, dispatch /close to commit the SPEC with the spec-audit: trailer). The SPEC commits and is revised on the main branch — no sign-off halt. The next /implement runs in a fresh context (a new tab, or /clear)."
---

# /spec — write the SPEC

`/spec` is the **SPEC-writing half of the Think verb**. `/project` does the thinking — goal-alignment, context-load, explore, design — then hands the design to `/spec`, which writes the actual SPEC file, audits it, and auto-closes (commits) on a clean pass. Breaking it out means a SPEC can be produced ANY time one is needed: inside a full `/project` think flow, OR ad-hoc when work-in-progress turns out to need one in the moment.

## Critical

- **The SPEC stays lean.** Four sections — Ask / Behavior / Files / Done — per [`.agents/templates/spec-lean.md`](../../templates/spec-lean.md). Don't pad it with boilerplate that degrades to "N/A"; a heavy project grows its own sections when a real gap bites, per `@rule:simplest-solution-default`.
- **The Ask section is the user's verbatim ask.** Capture it in their words. It's the thing the finished work is checked against — it keeps the implementation from drifting into a fancier interpretation than was wanted.
- **`/spec` auto-closes; there is no sign-off halt.** On a clean audit, `/spec` auto-invokes `/close` to commit the SPEC (per [`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md)). The SPEC lands on the main branch and is revised there — the user reviews it in the fresh `/implement` tab, not at a pre-commit gate. `/spec` only HALTS if the audit surfaces a choice the user must make (a `@rule:depth-policy` decision), or if the reviewer could not run.
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

## step-2-spec-audit — review the design before it becomes code

Dispatch [`/spec-audit`](../spec-audit/SKILL.md) on the SPEC path. Unconditionally — it decides for
itself whether the change is material enough to spend a reviewer call on, so this step never asks you
to judge that.

It runs two reviewers with different jobs:

- an **independent design reviewer** (a different model from the one that wrote the SPEC, when one is
  installed) attacks the design — missing boundary cases, peers left inconsistent, a shape bigger than
  the ask, a "done" section that cannot actually be run;
- the **spirit-check agent** reads only the user's verbatim ask and the behavior contract, and answers
  whether the SPEC describes the thing that was asked for. This catches what the design reviewer
  structurally cannot: a SPEC that is internally excellent and solves the wrong problem.

Accepted findings are folded into the SPEC in place. On a clean pass it returns the `spec-audit:`
trailer for the close commit. On a DRIFT the user must adjudicate, that is a `@rule:depth-policy`
decision — surface it and HALT; auto-close does not fire until it is resolved. If the reviewer could
not run at all, that is a FAILED audit, not a clean one: report it and do not auto-close.

This is the cheapest review in the loop. A missing boundary case costs one line here and a rewrite
after the code exists.

## step-3-auto-close — auto-invoke /close

Terminal gate. The SPEC is written and audited clean, and no depth-policy decision or deferral is outstanding. Per the auto-close gate ([`../close/references/auto-close-gate.md`](../close/references/auto-close-gate.md)): check `close-fired.sh status`, `mark`, and dispatch `/close`. The SPEC is committed to the main branch — **no sign-off halt** — and the user reviews it in the fresh `/implement` tab, revising on main if needed.

Auto-close ENDS this session. **Do not start implementing.** `/implement` runs in a fresh context — open a new tab (or `/clear`), then `/implement <project-slug>`.

Before dispatching `/close`, print a short summary so the closing commit is legible:

```markdown
## SPEC Created

**File**: `<spec-path>`
**Summary**: {2-3 sentence overview}
**Scope**: {N} files to CREATE, {M} to UPDATE, {K} total tasks
**Key Patterns**: {pattern with file:line}, {pattern with file:line}
**Audit**: {reviewer} — {N findings folded}; spirit {MATCH | DRIFT — <what was fixed>}

**Next Step**: `/close` is committing the SPEC now. Review it on the branch, then in a fresh context (a new tab, or `/clear`): `/implement <project-slug>`
```

## Examples

### Example 1 — dispatched by /project (the golden path)

`/project <slug>` runs the think flow through design, then its `think-step-4-dispatch-spec` invokes `/spec`. `step-1` writes `projects/<domain>/<date>_<slug>/main.spec.md`. `step-2` dispatches `/spec-audit` → two findings folded, spirit MATCH. `step-3` prints `## SPEC Created` and auto-invokes `/close`, which commits the SPEC to main. The session ends; the user opens a fresh tab for `/implement` and reviews the committed SPEC there.

### Example 2 — ad-hoc mid-session SPEC

Working together, it turns out a small change needs a SPEC. `/spec "<scope hint>"` reads the design context already in session (lighter than a full think flow), writes the SPEC at the schema-correct location, audits it, and auto-closes (commits). No `/project` think flow required.

### Example 3 — the SPEC drifted from the ask

`step-2` returns spirit DRIFT: the Behavior section describes a scheduled service, and the user asked for a script. `/spec` rewrites it down to a script. If the divergence is a real choice, it surfaces the decision and HALTS — auto-close does not fire until the user resolves it; then `/spec` resumes and auto-closes.

### Example 4 — no independent reviewer installed

`step-2`'s design reviewer exits 3 (only the authoring model on this machine). `/spec-audit` falls back to a fresh-context agent, folds its findings, and labels the trailer `claude-fallback`. The summary says plainly that the reviewer shared the author's model, so independence was reduced.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| SPEC written but not at the schema location | Wrong work-shape branch in `step-1` | Re-check the location table; new apps → `apps/{name}/SPEC.md`, non-app → `projects/.../{name}.spec.md` |
| spirit-check agent "not found" | The harness has not auto-loaded `.agents/reviewers/spirit-check.md` this session, or the tool has no subagents | Run the check in a clean context with the spirit-check body prepended, and note the fallback in the summary |
| Commit rejected: missing `spec-audit:` trailer | The git hook saw a SPEC change with no audit on the record | Run `/spec-audit` on the SPEC and put its trailer in the commit message. A non-material edit still emits one. |
| `/spec` rolled straight into implementing | `step-3` auto-close dispatched `/implement` instead of `/close` | Auto-close commits the SPEC and ENDS the session; the fresh-context boundary is load-bearing — `/implement` runs in a new tab, never inline |
| `/close` fired twice | `close-fired` marker missing (no session id) | Expected fail-safe; `close-fired.sh` skips dedup when `CLAUDE_CODE_SESSION_ID` is unset. A rare same-session double-close is harmless |
