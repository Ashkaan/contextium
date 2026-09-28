# Auto-close gate

The one definition of **auto-close**: a skill that produces work hands the
session to `/close` itself on clean completion, instead of printing "now run
/close". The loop halts for the user only when something needs them. Each
caller points here rather than restating the rule.

## Who auto-closes

| Skill | Fires after |
|---|---|
| `/spec` | the spec folder is written and `/spec-audit` passed clean |
| `/implement` | the code is built and validated, mechanism-match passed, `/implement-audit` passed clean, `report.md` written |
| `/implement-audit` | **standalone runs only**, with an APPROVE or SHIP-with-deferred verdict. When `/implement` dispatched it (`/implement-audit --from-implement <spec-folder>`), `/implement` owns the close and the audit does nothing here |

`/spec`'s close ENDS the session. The next `/implement` runs in a fresh one,
because a session that wrote the plan defends it; auto-close never rolls
`/spec` into `/implement`.

## Preconditions — proceed only when both hold

**(i) Nothing is waiting on the user.** The gate is the caller's last step, so
control reaches it only on clean completion. A caller that needed a decision,
or wanted to propose a deferral, halted at that question earlier and never got
here. When the user answers, the caller resumes and reaches the gate then.

**(ii) This caller has not already fired in this session.**

```bash
bash .agents/skills/close/scripts/close-fired.sh status <caller>   # spec | implement | implement-audit
```

`not-fired` → proceed. `fired` → `/close` already ran for this caller; do not
dispatch it again. This guards the resume path, where a caller continues after
an answered question and would otherwise close twice.

## Action

1. Mark, so a later resume cannot double-fire:
   ```bash
   bash .agents/skills/close/scripts/close-fired.sh mark <caller>
   ```
2. Dispatch the real `/close` (in Claude Code, the Skill tool). Never perform
   its steps yourself — a hand-rolled close commits while skipping the verify,
   the roadmap flip, or the journal check.

`/close` runs all of its own steps. Auto-close removes only the user-typed
`/close`; it does not skip `/implement`'s mechanism-match or any check inside
`/close`.

## Halt cases — auto-close does not fire

| Situation | Behavior |
|---|---|
| A decision or deferral question is open | The caller is parked at the question; after the answer it resumes and then auto-closes, subject to (ii). |
| The audit returned findings | They are fixed in the audit's own loop; only a clean pass reaches the gate. The loop ends itself (converged, or four rounds) and never asks whether to continue. |
| The reviewer could not run | A failed audit, not a clean one. Halt and report it; never close an unreviewed diff. |
| Mechanism-match FAIL (`/implement`) | Halt: the user must see the divergence. |

## Not suppressed

A close the user asks for — typing `/close`, or saying "close the session" — is
an instruction, not a double-dispatch. Only an auto-close gate reads the marker.
