# Auto-close gate (SSOT)

The single definition of the **auto-close** behavior shared by `/spec` and `/implement`. Both skills reference this file from their step graphs (a terminal `kind: gate` step, `tool: skill`) and list it in `peers:`. Per the single-source principle, the gate's logic lives here once — the two skills point at it rather than restating it.

## What it does

"Wrap" stops being a verb the user types. On a producer verb's **clean completion**, the verb auto-invokes `/close` itself (journal + commit + push) instead of printing "now run /close". The loop HALTS for the user ONLY when something genuinely needs them.

- `/spec` auto-closes after the SPEC is written + `spirit-check` passes clean.
- `/implement` auto-closes (the terminal `close` step) after the code is built + `implement-audit` passes clean.

The think→do fresh-context boundary is preserved: `/spec`'s auto-close ENDS the session; the next `/implement` runs in a fresh tab. Auto-close does not roll `/spec` into `/implement`.

## Precondition — proceed to `/close` IFF BOTH hold

**(i) No depth-policy decision or deferral question is outstanding for this verb's run.**

By construction, the auto-close gate is the verb's terminal step — control only reaches it on clean completion. If the verb needed a `@rule:depth-policy` **decision** or wanted to propose a **deferral** (`@rule:no-deferral`), it already halted at that `AskUserQuestion` EARLIER and never reached this gate. So an outstanding question means the gate is not evaluated at all — the verb is parked at the question.

When the user answers, the verb RESUMES from where it halted and continues toward this gate. At that point precondition (i) is satisfied (the question is answered) and the gate is evaluated — subject to (ii).

The goal-alignment FRONT gate (intent approved up front, in `/project`'s think flow) is unchanged and orthogonal — it fires before any work, not here. The old SPEC user-review **sign-off** halt is REMOVED: a spirit-checked SPEC is committed + revisable on the main branch, reviewed by the user in the fresh `/implement` tab.

**(ii) No `close-fired` marker exists for this session.**

```bash
bash .claude/skills/close/scripts/close-fired.sh status
```

`not-fired` → proceed. `fired` → `/close` already ran this session; do NOT re-invoke it. This is the double-fire guard for the resume path: if the user answered a held question and the verb resumes after `/close` had already partially run, the marker stops a second dispatch.

## Action — when both preconditions hold

1. Mark the session so a later resume can't double-fire:
   ```bash
   bash .claude/skills/close/scripts/close-fired.sh mark
   ```
2. Dispatch `/close` via the Skill tool.

`/close` runs its OWN internal steps unchanged — auto-close only removes the *user-typed `/close` step* and the *SPEC sign-off halt*, it does NOT skip:

- `/implement`'s **mechanism-match** gate ("Agreed to X. Diff does X.") — a FAIL halts BEFORE the close step (a divergence the user must see); it does not auto-commit.
- `/close`'s own journal + project-update steps.

## Halt cases (auto-close does NOT fire)

| Situation | Behavior |
|---|---|
| Depth-policy **decision** pending | Verb halted at the `AskUserQuestion`; gate never reached. After the user answers, the verb resumes and then auto-closes (subject to (ii)). |
| **Deferral** proposed (a major plan deviation) | Verb halts with the deferral `AskUserQuestion` per `@rule:no-deferral`; auto-close does not fire until the user approves or the work lands. |
| `implement-audit` returned **fix-now** work | Findings are fixed in-flight by the audit's own fix loop; only a clean audit pass reaches this gate. A round-3 cap `AskUserQuestion` (`ship\|redesign\|defer`) is a decision → HALT, not close. |
| Mechanism-match **FAIL** (`/implement`) | HALT — the user must see the divergence; auto-close does not fire. |

## Peers / scripts

- `scripts/close-fired.sh` — the session-scoped double-fire guard (status/mark).
- Referenced by: `.claude/skills/spec/SKILL.md`, `.claude/skills/implement/SKILL.md` (both list this file in `peers:` and dispatch `/close` from their terminal auto-close gate).
