# Think-Flow Deep Reference

Reference for [`/project`](../SKILL.md) think-flow gates. Progressive-disclosure tier 3 — extended justifications and "Why this gate exists" paragraphs that don't need to live in the always-loaded skill body.

The MUST statements and gate definitions stay in [`SKILL.md`](../SKILL.md); this file holds the failure shapes and reasoning that justify each gate.

## `think-step-0-goal-alignment` — why this gate exists

The point of the gate: catch goal/shape mismatch BEFORE hours of design + machine review + implementation amplify it.

Three goal mismatches recur, and each costs hours to unwind once built:

1. **A service where a function would do.** "Shared workflow" read as "build a daemon" produces thousands of lines — an HTTP service with auth, per-caller allowlists, retry loops, cleanup jobs — where the actually-simple solution is one function call of a few dozen lines, with no daemon, no port and no service unit.
2. **The wrong existing pattern.** Two patterns in the repo do similar jobs; without pinning "which existing pattern matches?" up front, the design is built on the one that does not fit.
3. **A lock-in not tested end to end.** A runtime or vendor chosen without running the real input shape through it (a webhook's actual payload, say) drifts from what production sends.

A one-turn "is this what you want?" gate catches all three. The rule in the user's terms: agree on the goal together up front before starting work, then find the simplest way forward.

**What the gate does not reach.** It runs only in sessions that enter `/project`, `/spec` or `/implement`; much task-shaped work never does, and in those sessions the gate is presented no more often than anywhere else. So this step is real enforcement but only for sessions that reach it. Every other session is held to the same gate by the think flow's goal-alignment step.

## `think-step-2-explore` — Primitives & Credentials

### Why item 6 (existing primitives grep) exists

A plan that invents `ensureSshKeyOnce` while `ensureSshKey` already exists in the repo, and is the proven pattern, ships a parallel implementation that drifts from the original. If the function already exists it MUST be reused (or moved if its current location is wrong); a parallel implementation is a hard violation.

The remediation: for every helper, utility function, or wrapper the plan is about to introduce by name (e.g. `ensureSshKey`, `parseToList`, `wrapInTemplate`, `validateOutcome`, `commitFiles`), grep the repo for the name + 2–3 plausible synonyms BEFORE adding it to the Files-to-Change list.

### Why item 7 (credentials resolution) exists

A plan that cites a credential as "from the SSH key entry, or whatever the sync app uses" may name an entry that does not exist. "From entry X" is unverifiable until the entry is shown to exist; "from the item the X app uses" is unverifiable until X's actual mapping from variable to stored item is read.

The remediation: for every credential or named secret the SPEC references, read the repo's credential helper (its map of names to stored items) to confirm the entry exists, OR list the secret store's items and resolve the actual item name + field.

## `think-step-3-design` — Boundary-cite + Standards-incorrect

### Why boundary cases must cite file:line

A boundary row written from memory — "the store is unreachable → the router throws → no fallback" — can contradict the code, which in fact catches the error and falls through with a status. The row was inferred; the actual code path was different. Inference from memory is forbidden — if a boundary row describes existing behavior, Read the file and cite the line.

### Why "standards made incorrect" must be enumerated

A plan that defers amending a standard its own work makes untrue — even when the standard is one paragraph and the amendment is two lines — commits the deferral `AGENTS.md § Standards → No deferral` forbids, and leaves the next session reading a rule that is no longer so. Any statement in `AGENTS.md` § Standards (or any other standing rule the repo keeps) that will no longer be true after the plan ships MUST be amended in the same commit as the plan's work.

The remediation: read `AGENTS.md` § Standards for any statement that will no longer be true after the plan ships (new runtime in an enum, new path-of-use for a primitive, new integration name, retired file path). Document the amendments in the Files-to-Change table.

## `think-step-4-dispatch-spec` — why the SPEC review is mandatory

A plan trusted to the user for first review ships what a reviewer would have caught in one pass: a boundary case that contradicts the source code, a reinvention of an existing helper, a dozen findings of which half must be fixed. The user is NOT the first reviewer.

Every think flow produces a SPEC — one `specs/NNN-name/` folder per roadmap row it designed — and each is machine-audited before it lands; there is no "is this a plan or a SPEC?" distinction. `/project` hands SPEC-writing to `/spec`, which runs `/spec-audit` (reviewer consensus + spirit-check) itself. Each artifact has exactly ONE machine reviewer: SPECs get `/spec-audit` (inside `/spec`); shipped diffs get `/implement-audit` (inside `/implement`).

`/spec-audit` writes its `spec-audit:` line into the folder's plan.md Constitution Check; it is a record, never a gate on a commit.

## Blank-mode failure (Critical bullet)

The failure: the user invokes /project in a fresh tab, the generator runs, and the agent moves straight to asking "which one to start?" without pasting the captured stdout — the user cannot see what to pick. "Ran the generator" is not the deliverable; the user reading the index in the reply IS.

## Long-session fresh-tab handoff

The failure: the same session holds the plan + the investment in prior choices, then defends them mid-stream when /implement runs in-context, and hours of drift go by before anyone notices. The fresh-context boundary between think (`/project`) and do (`/implement`) is the methodological fix. Nothing enforces it mechanically — no hook refuses an in-context `/implement` — so the boundary is guidance in this skill and in `/implement`, and it holds by judgment.
