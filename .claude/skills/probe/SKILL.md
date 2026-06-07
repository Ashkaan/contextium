---
name: probe
description: Adversarial review of current work — find what was missed, what's inconsistent, what breaks. Standalone-callable, and also triggered by /close for substantial changes (the wrap verb folds probe into the close flow). Use after completing work to catch blind spots before closing out.
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Task
peers:
  - .claude/agents/probe-reviewer.md
  - .claude/skills/close/SKILL.md
enforces:
  - "@rule:mechanisms-not-prose"
handoffs_from:
  - .claude/skills/close/SKILL.md
steps:
  - id: step-0-run-checks
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: Run the project's own checks (tests, the commit gate) against the session diff and review the diff yourself. Capture results; failures become fix-now items in Step 2's merged list.
  - id: step-1-dispatch-reviewer
    kind: action
    action: Dispatch the probe-reviewer agent (or code-reviewer for code-heavy diffs) with scope + changed files + brief + Step 0 results. The agent returns triaged findings (fix-now / nice-to-have / out-of-scope).
  - id: step-2-merge-present
    kind: action
    action: Merge Step 0 failures (fix-now by default) with Step 1's adversarial findings into one numbered list, severity-ordered, preserving triage verdicts.
  - id: step-3-fix-round
    kind: gate
    gate:
      tool: AskUserQuestion
      on_fail: halt
      condition: Fix every fix-now AND nice-to-have finding with a ready fix THIS round. Round 2 caps the loop without override; round 3 fires AskUserQuestion (ship | redesign | defer).
---

# Probe — Deep Second Look

Review work just completed in this conversation. Be adversarial — assume things were missed and find them. Do not confirm the work is good; find what's wrong.

## Critical — Scope

**Only review work from this conversation.** Do NOT flag unrelated uncommitted changes, review the full `git status`, comment on other sessions' work, or pad findings with non-issues.

`/close` triggers this skill automatically for substantial changes (a new app, or a large diff across code files). Standalone invocation works the same way — same step-0-run-checks / step-1-dispatch-reviewer / step-2-merge-present / step-3-fix-round flow, same triaged output, same 2-round recursion cap.

The skill has two halves. Step 0 runs the project's own checks in the main conversation (they need Bash + the session's tool access). Step 1 dispatches a fresh-context review agent for the adversarial-reasoning half — an agent that has no prior commitment to "this is fine because I wrote it." The two halves merge into a single numbered list of findings with triage verdicts.

## Expected State

The quality gate (peer-consistency, edge cases, downstream consumers, doc surface) should have already run during implementation. If probe consistently finds 3+ issues, flag this as a process failure — the upstream gate isn't working, and the root cause should be addressed rather than just fixing symptoms.

## step-0-run-checks

Establish the session diff first: `BASE_SHA` is the start of this session's commits (typically `HEAD~N` for N commits this session). Then run the project's own checks against `BASE_SHA..HEAD` and review the diff yourself. There is no separate check-runner script — run the checks inline with the Bash tool:

- Run the test suite if one exists.
- Run the commit gate (`.claude/hooks/commit-gate.sh`) or whatever linter/formatter the project wires into it, scoped to the changed files.
- Read the diff (`git diff BASE_SHA..HEAD`) and look for the obvious: dangling `@rule:` references, leftover debug code, secrets, half-applied edits, missing peer files.

Capture the results. Any failure here is a fix-now item by default — these are deterministic violations that block ship. Pass the captured results into Step 1's agent brief as ground truth so the agent doesn't duplicate the work.

## step-1-dispatch-reviewer

Dispatch a fresh-context review agent with the Agent tool. Try `Task(subagent_type="probe-reviewer", ...)` first; for a code-heavy diff `Task(subagent_type="code-reviewer", ...)` is the better fit. **If the agent type returns "not found"**, the harness has not auto-loaded the agent file for this session (it caches agent names at session start; fixed on next restart). Fall back to `Task(subagent_type="general-purpose", ...)` with the full body of `.claude/agents/probe-reviewer.md` (minus frontmatter) prepended to the prompt. Either dispatch path produces the same triaged-findings output.

Brief the agent with:

- **Scope**: `BASE_SHA..HEAD` where `BASE_SHA` is the start of this session's commits.
- **Changed files**: the list of files touched.
- **Brief**: one paragraph summarizing what the main orchestrator intended to accomplish.
- **Project context**: if applicable, the path to the project README.
- **Check results**: the captured output from Step 0 — the agent treats these as ground truth and doesn't re-run them.

The agent returns triaged findings (fix-now / nice-to-have / out-of-scope). Recursion is capped at 2 rounds; on round 3 this skill fires `AskUserQuestion` asking `ship | redesign | defer`.

## step-2-merge-present

Combine Step 0's check failures (fix-now by default — deterministic violations that block ship) with the agent's adversarial findings. Re-order into a single numbered list, most-to-least severe. Preserve each finding's triage verdict. Emit the user-facing list using the Output Format below.

## step-3-fix-round

Fix EVERY finding whose fix is **ready in this session** — both `fix-now` AND `nice-to-have`. The triage label orders work within the round; it does NOT schedule across rounds. A `nice-to-have` finding with a known fix path ships in the same round as `fix-now`, just lower priority. Defer to a future session ONLY when:

- The fix needs an unmade design decision (architecture, vendor, scope) — track via a `projects/<domain>/<date>_<slug>/` README.
- The fix is blocked on an external dependency (vendor response, third-party fix) — `status: blocked` project with `blocked-on:`.
- The verdict is `out-of-scope` (wrong reviewer, different domain) — surface to the user, do not act.

Then re-run Step 0 + Step 1 for round 2 against the new HEAD. Round 2 is the absolute cap without user override — on round 3, halt and `AskUserQuestion` (ship | redesign | defer).

This "fix everything ready in the same round" discipline is @rule:no-deferral applied to probe findings: ready fixes ship now, not in a later session.

**Anti-pattern this step closes:** an orchestrator receives 1 fix-now + 4 nice-to-have findings, all with concrete suggested fixes ready to land, fixes only the fix-now item, and asks the user permission to address the rest. The triage label is for ordering within the round, not for scheduling work to a later session.

## Output Format

```markdown
## Probe Findings

<numbered list, most-to-least severe. Each line:>

N. **<title>**: `<file>:<line>` — <nature> — verdict: **<fix-now | nice-to-have | out-of-scope>** — rule: `@rule:<id>` (or "none") — <suggested fix>

## Summary

- Total findings: N
- Breakdown: M fix-now, P nice-to-have, Q out-of-scope
- Ship assessment: **BLOCK** | **APPROVE**
```

If nothing found: say so explicitly ("Zero findings within reviewed scope"). Do not pad with marginal items just to avoid the empty case.

## Examples

### Example 1 — close-folded probe (substantial change)

`/close` detects a substantial change and dispatches `/probe` automatically. Step 0 runs the test suite (pass) and the commit gate, and the diff read surfaces a dangling `@rule:` reference in a changed file (fix-now). Step 1 dispatches probe-reviewer with the Step 0 summary; the agent returns 3 fix-now + 1 nice-to-have. Step 2 merges the dangling-ref finding + the agent's 4 findings = 5 numbered findings. Step 3 fixes all of them (5 of 5 ready) in one pass, re-runs Step 0 + Step 1 for round 2; round 2 returns zero findings → APPROVE; close resumes.

### Example 2 — standalone probe (manual invocation)

The user types `/probe` after a small change to ask for a second look. Same flow. Round 1 returns 1 fix-now + 2 out-of-scope; the orchestrator fixes the fix-now, surfaces the out-of-scope items to the user (does not act on them), and exits without round 2.

### Example 3 — zero findings

Round 1 Step 0 returns all green; Step 1's agent returns no findings. Step 2 emits the explicit `Zero findings within reviewed scope` message — NOT padded with marginal items to avoid the empty result. Ship assessment: APPROVE. No round 2.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `Agent type 'probe-reviewer' not found` | Session pre-dates the `.claude/agents/probe-reviewer.md` file or the harness hasn't auto-loaded it | Fall back to `Task(subagent_type="general-purpose", ...)` with the full agent body prepended to the prompt; both paths produce identical triaged output |
| Round 3 cap hit | Two fix rounds did not converge; new probe surface kept the finding count flat | Fire `AskUserQuestion` with options `ship | redesign | defer`; do NOT proceed to round 3 fix-round without the user decision |
| A check tool isn't installed on this box | Tooling diff, not a probe finding | Continue — install the tool locally if you want full coverage; do not block on it |
| Can't resolve `BASE_SHA` | The env var was empty or referred to a commit not in this clone | Re-derive `BASE_SHA = HEAD~N` from `git log --oneline -n N` showing this session's commits |
| Round 1 produces only marginal findings | The agent is padding | Re-emit as `Zero findings within reviewed scope` rather than passing padding off as real findings |
