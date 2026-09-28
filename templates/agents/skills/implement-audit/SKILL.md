---
name: implement-audit
description: Adversarial review of freshly built code — find what was missed, what is inconsistent, what breaks — with automated checks first and an independent reviewer for the judgment half, fixing every ready finding in a bounded loop. The loop's single code reviewer, once per session. Fired by /implement; run it standalone after any substantial ad-hoc change. Writes an `implement-audit:` line into the spec's report.md.
allowed-tools: "Bash Read Grep Glob Edit Write Task Skill"
metadata:
  peers: ".agents/skills/implement-audit/scripts/audit-dedupe.sh .agents/skills/implement-audit/scripts/run-automated-checks.sh .agents/scripts/code-review.sh .agents/scripts/reviewer-chain.sh .agents/reviewers/implement-audit-reviewer.md .agents/skills/implement/SKILL.md .agents/skills/close/SKILL.md .agents/skills/close/references/auto-close-gate.md"
---

# /implement-audit — the loop's code reviewer

Review code built in this session. Be adversarial: assume things were missed
and find them. Do not confirm the work is good; find what is wrong.

This is the **single code reviewer** for the loop. `/implement` fires it after
building; `/close` fires it as a backstop for work that skipped `/implement`;
the user can run it by hand. Step 0 makes it run **once per session** whoever
asks. `/implement` invokes it as `/implement-audit --from-implement <spec-folder>`
and `/close` as `/implement-audit --from-close`; without either the run is
standalone.

## Rules

- **Once per session, by a file, not by judgment.** Step 0 reads a marker keyed
  on the session id, which also stores the first run's line so a second caller
  re-emits it instead of re-reviewing settled code.
- **The reviewer is not the author.** `code-review.sh` runs the review on a
  different model when one is installed. When none is (exit 3), a fresh-context
  agent reviews instead, and the line **says so** — reduced independence
  reported as full independence is trusted more than it deserves.
- **A reviewer that could not run is a FAILED review** (exit 1 or 124). Halt and
  report it; never emit an approving line.
- **Only this session's work.** Do not review unrelated uncommitted changes or
  pad the list. One exception: a security or data-loss defect read in passing
  is still reported, marked out of scope, so it never holds the patch.

## Scope

`BASE_SHA` is the last commit before this session's work (`git log --oneline`
shows where it starts). Everything after it, committed or not, is in scope.

## step-0 — already audited?

```bash
bash .agents/skills/implement-audit/scripts/audit-dedupe.sh status
```

`done` → print the stored line (line 2 onward), say the audit already ran this
session, and stop. `fresh` → continue.

## step-1 — automated checks

```bash
bash .agents/skills/implement-audit/scripts/run-automated-checks.sh --session-base "$BASE_SHA"
```

Tests, linter, shellcheck on changed shell files, the repo's secret scan.
Missing tooling is `SKIP`, not failure. Every `FAIL` is a must-fix, and the
whole output goes into the reviewer brief verbatim so the review does not spend
itself re-deriving what a linter proved.

## step-2 — the review

Snapshot BEFORE each round; round 1 reviews everything, later rounds only the
fixes since the previous round's snapshot:

```bash
SNAP=$(bash .agents/scripts/code-review.sh --snapshot)     # before round 1
bash .agents/scripts/code-review.sh "$BASE_SHA" HEAD        # round 1

NEXT=$(bash .agents/scripts/code-review.sh --snapshot)     # before round N+1
bash .agents/scripts/code-review.sh --since "$SNAP"         # rounds 2+
SNAP="$NEXT"
```

Re-reading the whole diff every round makes the reviewer re-decide settled code
and turns each round's fixes into the next round's findings.

| Exit | Meaning | Action |
|---|---|---|
| 0 | reviewed; findings on stdout, empty = clean | step 3 |
| 4 | `--since`: nothing changed — converged | stop; approve |
| 5 | `--since`: the round-4 ceiling | stop; report what is still open |
| 3 | no external reviewer installed | review with a fresh-context agent (in Claude Code, `Task` with `subagent_type: implement-audit-reviewer`; elsewhere, the same brief in a clean context with `.agents/reviewers/implement-audit-reviewer.md` prepended), and label the line `fresh-context` |
| 1, 124 | the review did not happen (chain exhausted, or timed out) | FAILED audit — halt and report |
| 2 | bad arguments or an empty range | re-derive `BASE_SHA` and re-run |

`code-review.sh` prints `answered: <reviewer>` on stderr; that name goes in the
line.

## step-3 — one list

Merge step 1's `FAIL` lines with the review's findings, most severe first,
keeping each triage label:

```markdown
## implement-audit findings

N. **<title>**: `<file>:<line>` — <what is wrong> — **<must-fix | should-fix | nit>** — <suggested fix>

## Summary
- Findings: N (M must-fix, P should-fix, Q nit)
- Assessment: **BLOCK** | **APPROVE**
```

Nothing found → "Zero findings within reviewed scope." Do not pad.

## step-4 — fix, then re-review the fixes

Fix every must-fix and should-fix whose fix is ready, this round. The label
orders work inside the round; it does not schedule work for later
(`@rule:no-deferral`). Defer only a fix that needs a decision nobody has made or
is blocked outside the repo, and surface it to the user.

Hold nits in a running list; do not fix them mid-loop, and never let one justify
another round. Clear the whole list in one pass when the loop stops.

Stop on whichever comes first: converged (exit 4); a clean round; a round whose
findings mostly re-open ground an earlier round touched (the loop is reviewing
its own fixes); or round 4 (exit 5). The finding count is not a signal — later
rounds find about as much as early ones, just in their own fixes. Never ask the
user whether to run another round.

## step-5 — the line

```bash
LINE="implement-audit: <reviewer>, round-<N>, <M> findings (<K> fixed, <R> open) — <APPROVE | SHIP-with-deferred>"
bash .agents/skills/implement-audit/scripts/audit-dedupe.sh mark "$LINE"
echo "$LINE"
```

`SHIP-with-deferred` only when the ceiling stopped the loop with findings open;
name them in the summary. The line is a record, not a gate
(`@rule:audit-lines-are-records`):

- with `--from-implement`, `/implement` writes it verbatim into the named
  spec folder's `report.md` under Validation Results;
- standalone, `/close` quotes it in the journal entry's `**Changes:**`.

## step-6 — auto-close (standalone runs only)

Invoked with `--from-implement` or `--from-close`, do nothing: the caller owns
the close, and a second `/close` from here would fire inside the first. The caller is named, never inferred — `/implement` runs this
audit before its `report.md` exists. Otherwise, on `APPROVE` or
`SHIP-with-deferred`, hand the session to
`/close` per
[../close/references/auto-close-gate.md](../close/references/auto-close-gate.md)
with caller `implement-audit`. A FAILED review halts instead: closing would land
an unreviewed diff.

## Examples

**Fired by /implement.** Step 0 `fresh`. Checks pass except shellcheck on a new
script. Round 1 returns 2 must-fix, 1 should-fix, 1 nit; all fixed plus the
shellcheck finding, the nit held. Round 2 (`--since`) exits 4. The nit is fixed.
`implement-audit: codex, round-2, 5 findings (5 fixed, 0 open) — APPROVE` goes
into the report.

**/close after /implement.** Step 0 `done`; the stored line is printed and the
skill stops.

**Single-model machine.** Round 1 exits 3. A fresh-context agent reviews, and
the line reads `implement-audit: fresh-context, round-1, …` so no one mistakes
it for an independent review.

## Troubleshooting

| Failure | Fix |
|---|---|
| Exit 1 or 124 | The reviewer chain is down or timed out. Halt; no approving line. Restore a reviewer and re-run. |
| Exit 2, "the diff is empty" | Wrong range, or the work is in another checkout. Re-derive `BASE_SHA`. |
| `--since` rejected | You passed a commit SHA; pass the tree `--snapshot` printed. |
| Findings about code the session never touched | Round 2+ ran as a full review; use `--since`. |
| The audit ran twice in one session | No session id was exported, so the marker could not be written. Carry the first line forward by hand. |
