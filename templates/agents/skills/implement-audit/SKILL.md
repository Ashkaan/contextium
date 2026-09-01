---
name: implement-audit
description: Adversarial review of freshly-built code — find what was missed, what's inconsistent, what breaks. The single code reviewer for the loop, and it runs exactly once per session. Auto-fired by /implement; standalone-callable after any substantial ad-hoc change. Emits the `implement-audit:` commit trailer the git hook requires.
disable-model-invocation: false
allowed-tools: "Bash(.agents/skills/implement-audit/scripts/*:*) Bash(.agents/scripts/code-review.sh:*) Bash(git *:*) Bash(npm *:*) Read Grep Glob Task"
peers:
  - .agents/scripts/code-review.sh
  - .agents/scripts/reviewer-chain.sh
  - .agents/reviewers/implement-audit-reviewer.md
  - .agents/skills/implement/SKILL.md
  - .agents/skills/close/SKILL.md
  - .githooks/checks/check-audit-trailers.sh
enforces:
  - "@rule:no-deferral"
  - "@rule:simplest-solution-default"
  - "@rule:mechanisms-not-prose"
handoffs_from:
  - .agents/skills/implement/SKILL.md
  - .agents/skills/close/SKILL.md
steps:
  - id: step-0-session-dedupe
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Run scripts/audit-dedupe.sh status. Line 1 `done` means this session already audited — re-emit the stored trailer (line 2+) and EXIT the skill without a second review. Line 1 `fresh` proceeds to step 1."
  - id: step-1-automated-checks
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Run scripts/run-automated-checks.sh --session-base <BASE_SHA>. Pass its output verbatim into the reviewer brief. Any FAIL line is a must-fix in step 3's merged list."
  - id: step-2-review
    kind: gate
    gate:
      tool: shell
      on_fail: halt
      condition: "Snapshot first (SNAP=$(.agents/scripts/code-review.sh --snapshot)), then review. ROUND 1 reviews everything: code-review.sh <BASE_SHA> <HEAD_SHA>. ROUNDS 2+ review ONLY the fixes: code-review.sh --since <the snapshot taken before the previous round>. Exit 0 = reviewed (findings on stdout; empty = clean). Exit 4 = converged, stop and approve — not a failure. Exit 5 = the round-4 ceiling, stop and report what's open — not a failure. Exit 3 = no external reviewer: fall back to a fresh-context agent and label the reduced independence. Exit 1 or 124 = the review did NOT happen; halt and report it unavailable. Exit 2 = bad args; fix the range."
  - id: step-3-merge
    kind: action
    action: "Merge step 1's FAIL lines (must-fix by default) with step 2's findings into one numbered list, most-severe first, preserving each triage verdict."
  - id: step-4-fix-round
    kind: action
    action: "Fix every must-fix AND should-fix finding with a ready fix THIS round; hold nits in a running list. Re-review with --since. Stop on convergence (exit 4), on the round-4 ceiling (exit 5), or when a round mostly re-opens ground an earlier round already touched. Then fix the held nits in one pass. Never ask the user whether to run another round."
  - id: step-5-emit-trailer
    kind: action
    action: "Compose the one-line `implement-audit:` trailer (rounds + findings + verdict), run scripts/audit-dedupe.sh mark \"<trailer>\" to record it for the session, and print it. /implement writes it into its report; /close reads it onto the commit; a standalone run hands it to the user for the commit message."
---

# /implement-audit — the loop's code reviewer

Review code just built in this conversation. Be adversarial — assume things were
missed and find them. Do not confirm the work is good; find what is wrong.

This is the **single code reviewer** for the loop. `/implement` fires it after
building; `/close` fires it as a backstop for work that never went through
`/implement`. Both callers hit step 0 first, so it runs **once per session** no
matter how many verbs ask for it.

## Critical

- **Once per session, enforced by a file, not by judgment.** Step 0 reads a
  marker keyed on the session id. Without it, `/close` would re-review a diff
  `/implement` already cleared — a full reviewer call and a fix loop spent
  re-deciding settled code. The marker also stores the first run's trailer, so
  the second caller re-emits it rather than re-earning it.
- **The reviewer should not be the author.** `code-review.sh` runs the review on
  a different model when one is installed. When none is (`exit 3`), fall back to
  a fresh-context agent and **say so** — reduced independence reported as full
  independence is worse than no review, because it is trusted more.
- **A reviewer that could not run is a FAILED review.** Exit 1 and 124 mean the
  review did not happen. Halt and report it; do not emit a passing trailer.
- **Only review work from this conversation.** Do not flag unrelated uncommitted
  changes, review the whole `git status`, or pad findings to avoid an empty
  result.

## Scope

Establish `BASE_SHA` — the start of this session's commits, typically `HEAD~N`
for the N commits you made. Everything after it, committed or not, is in scope.
Everything before it belongs to another session.

## step-0-session-dedupe — have we already audited this session?

```bash
bash .agents/skills/implement-audit/scripts/audit-dedupe.sh status
```

`done` → print the stored trailer, say the audit already ran this session, and
exit. `fresh` → continue.

## step-1-automated-checks — the deterministic half

```bash
bash .agents/skills/implement-audit/scripts/run-automated-checks.sh --session-base "$BASE_SHA"
```

Tests, linter, shellcheck on changed shell files, and the repo's own secret scan.
Missing tooling produces `SKIP`, not failure. Every `FAIL` line is a must-fix, and
the whole output goes into the reviewer brief verbatim so the review does not
spend its output cap re-deriving what a linter already proved.

## step-2-review — the judgment half

```bash
SNAP=$(bash .agents/scripts/code-review.sh --snapshot)   # BEFORE the round
bash .agents/scripts/code-review.sh "$BASE_SHA" HEAD      # round 1
```

Later rounds review **only the fixes**:

```bash
NEXT=$(bash .agents/scripts/code-review.sh --snapshot)    # before round N+1
bash .agents/scripts/code-review.sh --since "$SNAP"
```

Take the snapshot *before* each round, and pass the *previous* round's snapshot
to `--since`. Re-reading the whole diff every round is what produces fix loops of
fifteen and twenty rounds: the reviewer re-decides settled code, and each round's
own fixes become the next round's findings.

Exit codes that are **not** failures: `4` (nothing changed — converged, approve)
and `5` (round-4 ceiling — stop and report what is still open). Exit `3` means no
external reviewer is installed; dispatch a fresh-context agent with the same
brief and label the result. In Claude Code that is
`Task(subagent_type="implement-audit-reviewer")`, falling back to a
general-purpose agent with that agent file's body prepended; in a tool without
subagents, run the same brief in a clean context. Exit `1` and `124` mean no review happened at all.

## step-3-merge — one list

One numbered list, most severe first, holding both halves:

```markdown
## implement-audit findings

N. **<title>**: `<file>:<line>` — <what is wrong> — **<must-fix | should-fix | nit>** — <suggested fix>

## Summary
- Findings: N (M must-fix, P should-fix, Q nit)
- Assessment: **BLOCK** | **APPROVE**
```

Found nothing? Say "Zero findings within reviewed scope." Do not pad.

## step-4-fix-round — fix, then re-review the fixes

Fix every must-fix and should-fix finding whose fix is ready **this round**. Hold
nits in a list and clear them in one pass at the end. The triage label orders
work inside the round; it does not schedule work to a later session per
`@rule:no-deferral`.

Defer only when the fix needs a design decision nobody has made, or is blocked on
something outside the repo. Both cases get surfaced to the user, not filed
quietly in a README.

Stop the loop on convergence, at the ceiling, or when a round is mostly
re-opening ground an earlier round already touched. Never ask the user whether to
run another round — the cap decides that.

## step-5-emit-trailer — the trailer

```bash
TRAILER="implement-audit: codex, 2 rounds, 5 findings (5 fixed, 0 open) — APPROVE"
bash .agents/skills/implement-audit/scripts/audit-dedupe.sh mark "$TRAILER"
echo "$TRAILER"
```

Name the reviewer that actually answered (`code-review.sh` prints
`answered: <slot>` on stderr), or `claude-fallback`. The git hook requires this
line on any commit carrying substantial code; it never parses the fields, so they
are for the human reading `git log` later.

## Examples

**Fired by /implement.** Step 0 says `fresh`. Checks pass except shellcheck on a
new script. Round 1 returns 3 must-fix + 1 should-fix; all four are fixed plus the
shellcheck failure. Round 2 (`--since`) returns nothing changed → exit 4,
converged, APPROVE. Trailer marked and printed; `/implement` writes it into the
report.

**/close after /implement.** Step 0 says `done` and prints the stored trailer.
The skill exits immediately — no second reviewer call. This is the case the
marker exists for.

**Ad-hoc fix that grew.** The user hand-edited ~120 lines and typed
`/implement-audit`. Step 0 `fresh`, full flow, findings fixed, trailer handed back
for the commit message.

**Fix that broke something.** Round 2 reviews only the fixes and finds one
inverted a condition at the opposite boundary. Fixed; round 3 converges.

**Single-model machine.** Round 1 exits 3. A fresh-context agent reviews instead
and the report says: same model as the author, so independence is reduced.
Trailer reviewer: `claude-fallback`.

## Troubleshooting

| Failure | Cause | Fix |
|---|---|---|
| Review did not happen | exit 1 or 124 | The reviewer chain was exhausted or timed out. Halt and report unavailable — do NOT emit a passing trailer. |
| No reviewer configured | exit 3 | Expected on a single-model machine. Fall back to a fresh-context agent and label reduced independence. |
| Empty diff | exit 2 with "the diff is empty" | The sha range is wrong, or the work is in a different checkout. Re-derive `BASE_SHA` from `git log --oneline`. |
| `--since` rejected | "a ref this session's --snapshot never issued" | You passed a commit sha. Every commit resolves to a tree, so it would silently pull in other sessions' work. Pass the tree printed by `--snapshot`. |
| Round-4 ceiling | exit 5 | Not a failure. Stop, clear held nits, and report what is still open in the trailer and the summary. |
| Agent type not found | the harness cached agent names at session start, or the tool has no subagents | Run the brief in a clean context with the body of `.agents/reviewers/implement-audit-reviewer.md` prepended. |
