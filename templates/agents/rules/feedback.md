---
paths: null
---

# Feedback

Always-loaded rules derived from user corrections. Each body is the imperative + `[date]` + a judgment-core marker, kept minimal. When you add or amend one, the failure story, verbatim quotes and how-to-apply go in that day's journal, not the rule.

## goal-alignment
ONCE, at the START of a task and before work begins, MUST present two plain-English sections — **Goal:** (one sentence to a few bullets, sized to the work) and **Simplest mechanism:** (the lightest-weight way to achieve it) — then MUST wait for explicit approval. Approval = "yes" / "do it" / "go" / equivalent commit; silence is NOT approval. MUST NOT bundle this gate into the same turn as the first design artifact. **ONCE APPROVAL IS GIVEN THE GATE IS SPENT.** For the remainder of that task MUST NOT re-present a goal/mechanism gate, MUST NOT ask for re-approval of work inside the approved scope, and MUST NOT end a turn with "Approve?", "Want me to build it?", or "Say go and I'll…". Work discovered mid-task that serves the approved goal MUST be done and reported, not re-gated. The ONE exception is a discovery that would REVERSE the approved goal or overwrite a decision already made; that MUST be surfaced, naming what was decided and why the evidence now cuts against it. Before claiming done ("shipped", "fixed", "deployed", "live", "all set"), MUST verify the shipped change implements the agreed mechanism. [2026-05-16] [2026-05-26] [2026-08-08]

## no-guessing
Superseded by @rule:read-before-asserting, which holds the full rule; this id stays so older
citations still resolve. [2026-04-18] [2026-09-28]

## lock-in-needs-evidence
When proposing to "lock in" / "select" / "finalize" a runtime, framework, vendor, major library, or major version for repeated use across the repo, MUST first run BOTH (a) a workload-shaped smoke test that exercises the smallest end-to-end production behavior, AND (b) an external-evidence search covering the vendor's public issue tracker, the official compatibility/test matrix, and an authoritative current-LTS/current-stable lookup. MUST NOT mark a decision "locked" until both are done. The same bar binds a DESIGN whose worth rests on a claim about the world: MUST run the cheapest test that could DISPROVE the claim against already-existing data BEFORE building the artifact. [2026-05-04] [2026-08-07]

## no-spurious-skills
Before invoking a skill (`/project`, `/implement-audit`, etc.), MUST verify the skill is either (a) explicitly requested by the user in the CURRENT message, OR (b) invoked as a declared sub-skill by another skill's step graph already active; MUST NOT trigger skills on keyword matches in user answers or incidental conversation flow. [2026-04-14]

## greenfield-decision-reasoning
When asked "which would you pick?", "what's best?", or any question seeking a single recommendation, MUST reason from greenfield: ignore sunk cost, migration cost, and your own work cost — the user does not bear those. MUST commit to a single recommendation, not a comparison matrix. MUST NOT use "pilot first / gather data" as decision-deferral when the greenfield answer is clear. [2026-04-27]

## investigate-before-no-access
Before asserting lack of access to any external service, system, or data source, MUST check three sources in order: (a) `integrations/<service>/README.md` exists — follow its access pattern; (b) credentials are stored — check your credential store; (c) the service is listed in your deployment stack. MUST NOT parrot an agent's "no access" claim without independent verification. Same bar for a claim of no-REMEDY ("only a human can do this", "the credential is dead"): a hypothesis until the cheapest disproving test has actually been RUN. [2026-04-23] [2026-07-24] [2026-07-25]

## never-hand-work-back
When the user has explicitly authorized an action this turn (verbally, via question, or a "do it" / "yes" directive), MUST execute it end-to-end yourself. MUST NOT respond with a command for the user to run, or hand the work back. When a tool or hook blocks the direct invocation, MUST find an execution path that satisfies both the authorization and the guard. [2026-05-25]

## claude-scripts-tested-outside-claude
Each create/edit/write/execute under `.claude/` is a separate user approval prompt. MUST minimize `.claude/` churn: prefer solutions that don't touch `.claude/`, and when edits ARE needed, plan them up front and land them in the fewest, largest edits. Test-execution: when dev-testing a `.claude/` script mid-session, MUST run it from a copy OUTSIDE the repo; MUST NOT execute it in-place. Scratch generally: EVERY temp or scratch artifact — script copies under test, build output, downloads, intermediate data — MUST be written outside the repo working tree; MUST NOT create a scratch/temp directory anywhere inside the repo. [2026-07-06] [2026-07-27]
