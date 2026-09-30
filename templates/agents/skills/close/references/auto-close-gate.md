# Auto-close gate (SSOT)

The single definition of the **auto-close** behavior. Every skill that ends by handing the session to `/close` references this file from its body's auto-close section and names it in `metadata.peers` (the frontmatter carries no step graph). The gate's logic lives here once — the callers point at it rather than restating it.

## The full auto-closing population

This table is the SSOT for WHICH skills auto-close. The criterion is **the skill's terminal step reaches `/close` on clean completion without the user typing anything** — that is the property the contract lines below protect, and it is narrower than "mentions `/close` somewhere". Any skill meeting it MUST appear here; a skill you add that ends by closing the session gets a row.

| Skill | Terminal step | Fires after |
|---|---|---|
| `/spec` | `step-3-auto-close` | SPEC written + `spec-audit` clean |
| `/implement` | `phase-6-auto-close` | code built + `implement-audit` (phase-4.7) clean + mechanism-match PASS |
| `/implement-audit` | `step-6-auto-close` | **STANDALONE runs only** — review complete with an APPROVE or SHIP-with-deferred verdict. Does nothing when `/implement` dispatched it (a report exists: `specs/NNN-name/report.md`, or a legacy sibling `*-report.md`), because phase-6 owns that tail and a second `/close` would double-fire. Without this row every ad-hoc `/implement-audit` would end holding a line for a commit nobody made. HALTS instead of closing when the review FAILED (chain exhausted), since closing there lands an unreviewed diff under a commit claiming a review |

**`/project` is bound by contract line 1 but not line 2.** It does not auto-close on completion — it *routes*: its `ready-to-close` stage invokes `/close` as that stage's action (a user-initiated route, not an automatic tail), and its think flow ends inside `/spec`'s auto-close rather than its own. So it never consults the gate, and it commits nothing mid-flow: its README and spec ride the close that ends the think flow.

**Contract line 1 — run the REAL close skill.** Use a `Skill` tool call naming `close` when the harness exposes one. Otherwise read `.agents/skills/close/SKILL.md` in this worktree and execute its five steps in order as the close skill, including its verification and journal gates. The absence of a dispatch tool is not a reason to stop with unlanded work. A caller MUST NOT improvise a partial close — writing a journal entry, committing, or calling `land.ts` without running the full close skill. A session commits once, through the close. Improvising the wrap lands a commit while silently skipping the verify, the journal gate, the project-README update, and the three checks that earn the safe-to-close line.

**Contract line 2 — ask whether this session is already closed, before dispatching.** Every caller in the table MUST run the gate below and proceed only on `not-fired`. There is nothing to mark: the close records itself.

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # fired | not-fired
```

**Why there is no marker to write, and no caller key.** A latch each caller writes for itself before dispatching records that a close was DISPATCHED, which is not the question — and a session-wide one set by an early caller suppresses every later auto-close in that session, stranding work uncommitted and unjournaled: the exact loss this gate exists to prevent, caused by the gate. `land.ts --gate` answers the question itself: `fired` only when this thread carries a `closed` marker AND no worktree it owns has anything uncommitted or unpushed. New work re-opens the gate on its own — and a close that dispatched but FAILED never wrote the marker, so its retry is not suppressed either.

**This gate never suppresses a close the USER asks for.** A user typing `/close`, or saying "close the session", is an instruction, not a double-dispatch. Only an auto-close gate consults it.

## What it does

"Wrap" stops being a verb the user types. On a producer verb's **clean completion**, the verb auto-invokes `/close` itself (commit + push, or worktree merge) instead of printing "now run /close". The loop HALTS for the user ONLY when something genuinely needs them.

- `/spec` auto-closes after the SPEC is written + `spec-audit` passes clean.
- `/implement` auto-closes (phase-6) after the code is built + `implement-audit` (phase-4.7) passes clean.
- A skill you add that produces a session worth recording — not a loop verb, no SPEC and no code — auto-closes for the same reason, so it is journaled without the user typing a second command. Give it a row in the population table.

The think→do fresh-context boundary is preserved: `/spec`'s auto-close ENDS the session; the next `/implement` runs in a fresh tab. Auto-close does not roll `/spec` into `/implement`.

## Precondition — proceed to `/close` IFF BOTH hold

**(i) No hard stop or deferral question is outstanding for this verb's run.**

By construction, the auto-close gate is the verb's terminal step — control only reaches it on clean completion. If the verb needed a hard stop only the user can clear or wanted to propose a **deferral** (no deferral and a class fix is atomic), it already halted at that `AskUserQuestion` EARLIER and never reached this gate. So an outstanding question means the gate is not evaluated at all — the verb is parked at the question.

When the user answers, the verb RESUMES from where it halted and continues toward this gate. At that point precondition (i) is satisfied (the question is answered) and the gate is evaluated — subject to (ii).

The goal-alignment FRONT gate (intent approved up front) is unchanged and orthogonal — it fires before any work, not here. There is no SPEC user-review **sign-off** halt: a machine-audited SPEC is committed + revisable on main, reviewed by the user in the fresh `/implement` tab.

**(ii) This session is not already closed with nothing written since.**

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate
```

`not-fired` → proceed. `fired` → everything this thread wrote is already on its repo's trunk and nothing has changed since; do NOT re-invoke. This is the double-fire guard for the resume path: if the user answered a held question and the verb resumes after `/close` had already run, this stops a second dispatch. It says nothing about a close the user asks for.

## Action — when both preconditions hold

**This block is the only copy.** Callers point at this section rather than restating the commands — if the gate grows a mode or the ledger moves, exactly one place changes.

1. Check the gate — there is nothing to write first, and no caller name to pass:
   ```bash
   node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # proceed on `not-fired`
   ```
2. Run `/close` by the method in contract line 1. `land.ts` writes the `closed` marker itself, at the end, and only after its three checks pass — so a close that failed at Land leaves the gate open for the retry that lands it.

`/close` runs its OWN internal gates unchanged — auto-close only removes the *user-typed `/close` step* and the *SPEC sign-off halt*, it does NOT skip:

- `/implement`'s phase-4.5 **mechanism-match** ("agreed to X, diff does X", goal alignment SHIP clause) — a FAIL halts BEFORE phase-6 (a divergence the user must see); it does not auto-commit.
- `/close`'s own checks (verify, the journal check, the landing proofs).

## Halt cases (auto-close does NOT fire)

| Situation | Behavior |
|---|---|
| Depth-policy **decision** pending | Verb halted at the `AskUserQuestion`; gate never reached. After the user answers, the verb resumes and then auto-closes (subject to (ii)). |
| **Deferral** proposed (a major plan deviation) | Verb halts with the deferral `AskUserQuestion`; auto-close does not fire until the user approves or the work lands. |
| `implement-audit` / `spec-audit` returned **fix-now** work | Findings are fixed in-flight by the audit's own fix loop; only a clean audit pass reaches this gate. The fix loop never asks the user anything, so it raises no halt of its own. |
| Mechanism-match **FAIL** (`/implement` phase-4.5) | HALT — the user must see the divergence; auto-close does not fire. |

## Peers / scripts

- `scripts/land.ts --gate` — the double-fire guard (`fired` / `not-fired`), with the stale-marker case in `scripts/tests/land-cases.ts` (run by `scripts/land.gates.test.ts`) covering what a per-caller key existed to prevent.
- Referenced by: every skill in the population table above. Each names this file in `metadata.peers` and dispatches `/close` from its body's auto-close section. To re-verify that claim rather than trust it: `grep -L "auto-close-gate.md" $(grep -l "land.ts --gate" .agents/skills/*/SKILL.md)` should print nothing.
