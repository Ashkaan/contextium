# Auto-close gate (SSOT)

The single definition of the **auto-close** behavior. Every skill that ends by handing the session to `/close` references this file from its body's auto-close section and names it in `metadata.peers` (the frontmatter carries no step graph). The gate's logic lives here once — the callers point at it rather than restating it.

## The full auto-closing population

This table is the SSOT for WHICH skills auto-close. The criterion is **the skill's terminal step reaches `/close` on clean completion without the user typing anything** — that is the property the contract lines below protect, and it is narrower than "mentions `/close` somewhere". Any skill meeting it MUST appear here; a skill you add that ends by closing the session gets a row. Keep it aligned with the current skill bodies.

| Skill | Terminal step | Fires after |
|---|---|---|
| `/spec` | `step-3-auto-close` | SPEC written + `spec-audit` clean |
| `/implement` | `phase-6-auto-close` | code built + `implement-audit` (phase-4.7) clean + mechanism-match PASS |
| `/implement-audit` | `step-6-auto-close` | Standalone APPROVE; see Caller ownership. HALTS instead of closing when the review FAILED (chain exhausted), since closing there lands an unreviewed diff under a commit claiming a review |
| `/qa` | `Standalone finish` | Standalone changes verified; see Caller ownership |

**`/project` is bound by contract line 1 but not line 2.** It does not auto-close on completion — it *routes*: its `ready-to-close` stage invokes `/close` as that stage's action (a user-initiated route, not an automatic tail), and its think flow ends inside `/spec`'s auto-close rather than its own. So it never consults the gate, and it commits nothing mid-flow: its README and SPEC ride the close that ends the think flow.

**Contract line 1 — run the REAL close skill.** Use a `Skill` tool call naming `close` when the harness exposes one. Otherwise read `.agents/skills/close/SKILL.md` in this worktree and execute its five steps in order as the close skill, including its verification and journal gates. The absence of a dispatch tool is not a reason to stop with unlanded work. A caller MUST NOT improvise a partial close — writing a journal entry, committing, or calling `land.ts` without running the full close skill. A session commits only through its close. Improvising the wrap lands a commit while silently skipping the verify, the journal gate, the project-README update, and the three checks that earn the safe-to-close line.

No hook backs this line; it holds only by the caller following it.

**Contract line 2 — ask whether this session is already closed, before dispatching.** Every caller in the table MUST run the gate below and proceed only on `not-fired`. There is nothing to mark: the close records itself.

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # fired | not-fired | held
```

**There is no marker to write and no caller key.** `land.ts --gate` answers `fired` only when this thread carries a `closed` marker and no worktree it owns has anything uncommitted or unpushed, so new work reopens the gate (a caller that keeps working after its close needs no key) and a failed close never suppresses its retry. A latch each caller writes before dispatching records that a close was DISPATCHED, which is not the question — and a session-wide one set by an early caller suppresses every later auto-close in that session, stranding work unjournaled: the exact loss this gate exists to prevent, caused by the gate.

**This gate never suppresses a close the USER asks for.** A user typing `/close`, or saying "close the session", is an instruction, not a double-dispatch. Only an auto-close gate consults it.

## Caller ownership

Any skill in the table that runs as a step of another producer returns its
evidence and verdict to that caller — QA and implement-audit inside /implement. It
does not evaluate or start its own close while that producer still has steps
left; only the enclosing producer owns the landing/publish order. A report
file's presence alone does not identify the caller or make a standalone run
nested.

Standalone QA closes only after its changes are verified; a read-only run
reports directly. A standalone audit closes on APPROVE only. BLOCK or an
unavailable review keeps the workflow open.

## What it does

"Wrap" stops being a verb the user types. On a producer verb's **clean completion**, the verb auto-invokes `/close` itself (commit + push, or worktree merge) instead of printing "now run /close". The loop HALTS for the user ONLY when something genuinely needs them.

- `/spec` auto-closes after the SPEC is written + `spec-audit` passes clean.
- `/implement` auto-closes (phase-6) after the code is built + `implement-audit` (phase-4.7) passes clean.
- `/implement-audit` (standalone) and `/qa` (standalone) close at their listed completion boundary; no second command from the user is needed to record their work.
- A skill you add that produces a session worth recording — not a loop verb, no SPEC and no code — auto-closes for the same reason, so it is journaled without the user typing a second command. Give it a row in the population table.

The think→do fresh-context boundary is preserved: `/spec`'s auto-close ENDS the session, and its close prints the `/implement <slug> <row>` command for the user to run in a fresh session. Auto-close does not roll `/spec` into `/implement`, and nothing starts the build on its own.

## Precondition — proceed to `/close` IFF ALL THREE hold

**(i) No hard stop or deferral question is outstanding for this verb's run.**

By construction, the auto-close gate is the verb's terminal step — control only reaches it on clean completion. If the verb needed a hard stop only the user can clear or wanted to propose a **deferral** (no deferral and a class fix is atomic), it already halted at that question EARLIER and never reached this gate. So an outstanding question means the gate is not evaluated at all — the verb is parked at the question.

When the user answers, the verb RESUMES from where it halted and continues toward this gate. At that point precondition (i) is satisfied (the question is answered) and the gate is evaluated — subject to (ii).

The goal-alignment FRONT gate (intent approved up front) is unchanged and orthogonal — it fires before any work, not here. There is no SPEC user-review **sign-off** halt: a machine-audited SPEC is committed + revisable on main, reviewed by the user in the fresh `/implement` tab.

**(ii) This session is not already closed with nothing written since.**

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate
```

`not-fired` → proceed. `fired` → everything this thread wrote is already on its repo's trunk and nothing has changed since; do NOT re-invoke. This is the double-fire guard for the resume path: if the user answered a held question and the verb resumes after `/close` had already run, this stops a second dispatch. It says nothing about a close the user asks for. `held` → the close landed and is waiting on its live checks (`.agents/skills/close/SKILL.md` § Hold for the live checks, the owed checks listed under it); do NOT dispatch `/close` again — run those checks and `land.ts --release`.

**(iii) Nothing the run surfaced is left open.**

A clean audit is not a clean run. Before the gate, list everything this run surfaced that the diff does not already settle: a question it had, an issue or fault it noticed (in or out of its own scope), a reviewer note it did not act on, and an improvement it saw ("this could also…", "worth tightening…"). Each item leaves the list one of two ways:

- **Done now.** The default, for issues and improvements alike: fix it in this worktree, re-run what the fix touches, and say what changed in the summary. A fix that is scoped and reversible is not a question, and "want me to also…?" is a deferral, not a question (`AGENTS.md` § Standards, No deferral).
- **Asked.** Only when the answer is genuinely the user's: a choice between real alternatives where their preference decides it, or something only they can clear (money, an outbound message, host infrastructure, a vendor). Ask every such item at once as a numbered list, recommendation first, and HALT. On the user's answer the verb resumes, does the work, re-runs this sweep, and then closes.

**What "open" means — the one definition.** A close means the work is done: anything still open keeps the session open, because a close that printed what was open and landed anyway left it where nobody acts on it. What a close may carry:

- a roadmap row that is `done`, `closed: <why>` or `absorbed by <ID>`;
- a `planned` row that is not `manual`, whether its spec is written (a hand-off to a fresh `/implement`) or not yet (a future step the user asked for);
- a `planned` `manual` row that cannot start yet, because a row its `Depends on` names — in this project or another (`checkout-flow R2`) — is still open, and no entry there names nothing: it is not the user's to do until that row finishes, and it holds the next close that touches it once it is ready;
- a check set for a future date, on someone or something else: a row `blocked: YYYY-MM-DD <what>`, or `blocked: until YYYY-MM-DD <why>` (a `manual` row included — once that date passes, `/project triage blocked` lists it to set `planned` again), dated today or later in local time, or a journal `- wait: … YYYY-MM-DD …` line dated on or after the entry — neither naming the user (`open-decision.ts` says which words do).

Everything else holds the close: a step waiting on the user (a draft to send, a console click, a `manual` row unless it is set aside `blocked: until <date>` on something else or waits on an open row, a wait that names the user — whatever its date), a half-built piece (a row set `in-progress`, a spec report written `partial`), a wait with no date or a date already past. An item the user must DO is not a question, so it is not asked: the reply lists it as what they do, and the verb halts without closing; when they say it is done, the verb sets the `manual` row it finished (`roadmap.ts --set <ID> done`) and closes; a row whose spec's report reads `complete` is `land.ts`'s to set, and it sets it before its gates. A row whose `Depends on` names no row (an unknown project or ID) holds the close too. Land enforces this over every row and report the push adds or changes — its Status, Sub-spec or Depends on cell — `check-roadmap-decisions.ts` — and over the journal's **Blocked:** bullets (`check-journal-entry.ts` F12, beside F9's refusal of a decision); on its `NOT CLOSED` the reply lists every line it printed, and the close re-runs once they are done. Rows and journal lines the push did not touch are never judged. What also never happens is an item parked as prose: a "noticed", "could improve" or "open question" line in the completion summary, the report or the journal, with the close already fired.

The journal entry records the sweep as `open_items: none` in its front matter, and Land refuses an entry without it (`journal-entry.md` § Field reference, F10), or with a line worded as waiting on the user (F11); `check-roadmap-decisions.ts` reads the lines a close adds to a spec report for the same wording. There is no other value: an entry cannot be written for a run that still has a question, so the question is asked BEFORE the close, never in the reply that prints the close's last line — and never parked in a report as "waiting on the user".

This is not the retired sign-off halt. A run whose list empties by doing the work closes unattended; the halt fires only when a question is real, and it asks that question rather than asking for approval.

## Action — when all three preconditions hold

**This block is the only copy.** Callers point at this section rather than restating the commands — if the gate grows a mode or the ledger moves, exactly one place changes.

1. Check the gate — there is nothing to write first, and no caller name to pass:
   ```bash
   node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # proceed on `not-fired`
   ```
2. Run `/close` by the method in contract line 1. `land.ts` writes the `closed` marker itself, at the end, and only after its three checks pass — so a close that failed at Land leaves the gate open for the retry that lands it.

Whatever the run reports — what changed, a path, counts — is said before step 2. The close's printed block ends the reply: nothing follows its last line (`.agents/skills/close/SKILL.md` § 5).

`/close` runs its OWN internal gates unchanged — auto-close only removes the *user-typed `/close` step* and the *SPEC sign-off halt*, it does NOT skip:

- `/implement`'s phase-4.5 **mechanism-match** ("agreed to X, diff does X", against the spec's `**Input**` and `## Clarifications`) — a FAIL halts BEFORE phase-6 (a divergence the user must see); it does not auto-commit.
- `/close`'s verification, journal and landing gates, including root-cause status and evidence for shipping claims.

## Halt cases (auto-close does NOT fire)

| Situation | Behavior |
|---|---|
| Depth-policy **decision** pending | Verb halted at the question; gate never reached. After the user answers, the verb resumes and then auto-closes (subject to (ii)). |
| **Deferral** proposed (a major plan deviation) | Verb halts with the deferral question; auto-close does not fire until the user approves or the work lands. |
| `implement-audit` / `spec-audit` returned **fix-now** work | Findings are fixed in-flight by the audit's own fix loop; only a clean audit pass reaches this gate. The fix loop no longer asks the user anything, so it raises no halt of its own. |
| Mechanism-match **FAIL** (`/implement` phase-4.5) | HALT — the user must see the divergence; auto-close does not fire. |
| Open-items sweep left a **question** (precondition (iii)) | HALT with the numbered list. Everything else the sweep found was done before asking. After the answers, the verb does the work, re-sweeps, and auto-closes. |
| Something **waiting on the user or half-built** (precondition (iii)) | HALT listing what they do, or what is left to build; Land refuses the same state as `NOT CLOSED`. When it is done, the verb sets the `manual` rows it finished (`land.ts` sets a row whose spec's report reads `complete`) and auto-closes. |

## Peers / scripts

- `scripts/land.ts --gate` — the double-fire guard (`fired` / `not-fired`), with the stale-marker case in `scripts/tests/land-cases.ts` (run by `scripts/land.gates.test.ts`) covering what a per-caller key existed to prevent.
- Referenced by: every skill in the population table above. Each names this file in `metadata.peers` and dispatches `/close` from its body's auto-close section. To re-verify that claim rather than trust it: `grep -L "auto-close-gate.md" $(grep -l "land.ts --gate" .agents/skills/*/SKILL.md)` should print nothing.
