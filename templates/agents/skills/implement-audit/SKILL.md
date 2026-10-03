---
name: implement-audit
description: Adversarial review of freshly-built code — find what was missed, what's inconsistent, what breaks. The single code reviewer for the loop. Auto-fired by /implement (phase-4.7); standalone-callable after any substantial change. Writes an `implement-audit:` line into the report.
allowed-tools: Bash Read Grep Glob
metadata:
  peers: ".agents/agents/implement-audit-reviewer.md .agents/skills/implement/SKILL.md"
---

# implement-audit — the loop's code reviewer

Review code just built in this conversation. Be adversarial — assume things were missed and find them. Do not confirm the work is good; find what's wrong.

`implement-audit` is the **single code reviewer** everywhere: `/implement` fires it at phase-4.7, and it is standalone-callable as `/implement-audit` after any ad-hoc substantial change. The retired bespoke code-review agent and the old per-surface dispatches all consolidated here.

## Critical — Scope

**Only review work from this conversation.** Do NOT flag unrelated uncommitted changes, review full `git status`, comment on other sessions' work, or pad findings with non-issues. One exception, per that rule: a security or data-loss defect read in passing (exposed credential, injection, destructive-by-default path) is still reported — with the `out-of-scope` verdict, so it never holds the patch.

The skill has two reasoning halves. Step 1 runs automated checks in the main conversation (they need Bash + the session's tool access). Step 2 runs the adversarial-reasoning half on **a different vendor from the author — whichever one the `adversarial-review` policy row selects** — a reviewer from the model family that wrote the code has a prior commitment to "this is fine because I wrote it" that fresh context alone does not remove. The two halves merge into a single numbered list of findings with triage verdicts.

**Runs at most once per session.** Step 0's dedupe guard (`scripts/audit-dedupe.ts`) makes a hand-typed `/implement-audit` after `/implement` phase-4.7 a no-op that re-emits the first run's trailer, not a second full review.

## Expected State

/implement's Phase 4 layers (`validate.ts --phase checks`) should have already run. If implement-audit consistently finds 3+ issues, flag this as a process failure — the layers aren't catching what they should, and the fix for that must reach the cause.

## step-0-session-dedupe

```bash
node --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.ts status
```

- Line 1 `fresh` → no audit ran this session; proceed to `step-1-automated-checks`.
- Line 1 `done` → an audit already ran (the trailer is on line 2+). Re-emit that stored trailer for the caller and **exit the skill** — do not dispatch a second review. This is how `/implement` audits exactly once (phase-4.7) and a later hand-typed `/implement-audit` no-ops instead of double-reviewing.

## step-1-automated-checks

Run the 5 deterministic checks against the diff between `$BASE_SHA` (start of this session's commits) and HEAD via the extracted script:

```bash
node --experimental-strip-types .agents/skills/implement-audit/scripts/run-automated-checks.ts --session-base "$BASE_SHA"
```

The script emits TAP-ish `PASS: <check>` / `FAIL: <check> <detail>` / `WARN: <check> missing` lines plus a final `SUMMARY:` line. The 5 checks: each touched package's own lint and typecheck (`implement/scripts/layer-1.ts`), shellcheck on changed `.sh`, `.agents/checks/check-standards-refs.ts` on changed files, `.agents/skills/review/find-peers.ts --base $BASE_SHA`, and `.agents/checks/check-secrets.ts --since $BASE_SHA` — the same citation and secrets scans `land.ts` runs before it commits. A check whose program is absent (a product repo carries no `.agents/checks/`) is a `WARN`, never a `FAIL`. Capture stdout verbatim — Step 2 passes it to the agent as ground truth so the agent doesn't duplicate the work.

## step-2-dispatch-reviewer

The review runs on **the vendor the policy assigns, never the session model**.

**Snapshot before every review, and review only the fixes after round 1.** Take the snapshot FIRST — it has to capture the tree the reviewer is about to read, not the tree after you fix what it says.

```bash
# Every round, before dispatching:
SNAP=$(node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot)

# Round 1 — the whole change:
node --experimental-strip-types .agents/skills/review/code-review.ts "$BASE_SHA" "$HEAD_SHA"

# Rounds 2+ — only what changed since the round before:
node --experimental-strip-types .agents/skills/review/code-review.ts --since "$PREV_SNAP"
```

`PREV_SNAP` is the `SNAP` captured before the PREVIOUS round. Keep the current one for the next round.

Rounds 2+ are scoped this way: a follow-up round that re-reads the cumulative diff spends a full vendor call re-deciding settled code, and its own earlier fixes become the next round's findings. The snapshot is a git tree object written through a temp index — it does not touch HEAD, the index, the stash, or any file, which matters because this skill runs against uncommitted work by design. Untracked files ARE captured, so a file created by a fix does not read as new surface forever.

**The reviewer sees more than the diff, and none of it is your job to assemble.** `code-review.ts` splices a BLAST-RADIUS PACK into its own prompt, between the file list and the DIFF: who imports each changed file, what that file imports, and who calls each symbol the diff actually changed, with a real parser finding the enclosing symbol (`.agents/skills/review/blast-radius.ts`). That is the whole-repo context a hosted code-review bot sells, computed per review from this worktree rather than read out of an index that goes stale while the session edits — so there is no GitHub app to install and nothing to buy. Do NOT paste a caller list into the prompt yourself and do not pass the packer a file list: the script derives it from the same union of changed and working files the reviewer is about to read, which is what keeps the pack from citing a file the diff never showed. It fails open — a missing or broken packer costs the review its context and nothing else, because an unknown caller is not by itself a defect.

**The post-QA re-review is NOT a second `/implement-audit`.** When `/qa` edits source during `/implement` phase-4.8, those edits are code nobody has reviewed, and `audit-dedupe.ts` would turn a second dispatch of this skill into a no-op that re-emits the stored trailer — a clean-looking audit over unreviewed bytes. So `/implement` routes that round through `.agents/skills/implement/scripts/validate.ts --phase qa-revalidate`, which calls `code-review.ts --since` directly. The dedupe stays exactly as it is: this skill reviews once per session, and that is still right.

The model family that writes the code (the `agent=` line of `.agents/harness`) is not an independent reviewer of it in the sense the assignment asks for. Putting the review on a different vendor by construction is the point — and WHICH vendor is the `adversarial-review` row's business (`.agents/skills/review/policy.json`, walked by `policy-chain.ts`, which skips the author's vendor), not this skill's. The script walks that row's chain itself, so a primary that is absent, non-zero, or hung falls through to the declared backup INSIDE the one call. The script reads the diff and the repo itself through its sandbox, so it needs no curated file list.

**One invocation, not two.** Do not re-run a failed review through `policy-review.ts` by hand: the chain walk is in-script, so exit 1 means the chain is ALREADY exhausted, and re-running it cannot help.

`BASE_SHA` is the start of this session's commits (typically `HEAD~N` for N commits this session); `HEAD_SHA` is `HEAD`. Uncommitted work is included and flagged to the reviewer, because this skill runs pre-commit by design.

**When the code is in another repo** (a product worktree `$PRODUCT_WT` from `write-root.sh`, as `/implement` § "A row whose code is in another repo" sets up), both steps read that worktree, never this one: step 1 runs `run-automated-checks.ts --session-base "$BASE_SHA" --repo-dir "$PRODUCT_WT"`, and every `code-review.ts` call here — snapshot, round 1, `--since` — runs with `CODEX_REVIEW_REPO="$PRODUCT_WT"` in its environment. `BASE_SHA` is `git -C "$PRODUCT_WT" merge-base HEAD origin/<its trunk>`. Left to default, both read this repo's worktree, which holds only the spec, and pass.

Interpret the exit code — this is a **gate**, not a best-effort step:

| Exit | Meaning | Action |
|---|---|---|
| 0 | Reviewed. stdout carries zero or more `[must-fix]` / `[should-fix]` / `[nit]` lines. | Proceed to step-3. Empty stdout here means reviewed-clean. |
| 4 | `--since` only: nothing changed between the snapshot and now, so the fix loop has CONVERGED. | Not a failure. Stop the loop, fix any held nits, emit an APPROVE trailer. Never re-run a full review to "confirm" it. |
| 5 | `--since` only: the loop hit the round-4 ceiling. | Not a failure either. Stop, fix held nits, and name what is still open in the trailer and summary. Do NOT switch to the two-arg form to get another round — that is the same call the ceiling just refused. |
| 1 | CHAIN EXHAUSTED — every declared slot answered unusably (non-zero, or empty output with no `NO_FINDINGS` sentinel). On the `adversarial-review` row, slots that were merely absent, failing or timed out end in exit 3 instead (below). | The audit FAILED. Report the reviewer unavailable and do NOT emit an approving trailer. Do not re-run: the fall-through already happened. |
| 124 | Chain exhausted, last slot timed out. | Treat exactly like exit 1. |
| 3 | No independent reviewer answered (every vendor in the row unavailable, or the chain reached a CLAUDE slot). | NOT a failure, and NOT independent (Contextium). Run `.agents/agents/implement-audit-reviewer.md` in a FRESH context on the same diff, work its findings through steps 3-4 as usual, and record `implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); <findings>; <verdict>`. Inside `/implement`, `validate.ts` exits 3 (pending) until `validate.ts --fallback-review <file>` has read those findings. |
| 2 | Caller error (bad arity, unresolvable SHA, base not an ancestor of head). | Fix the SHA range and re-run; not a review outcome. |

**A reviewer that cannot run is a FAILED review, never a silent substitution.** On exit 1 or 124 you MUST NOT fall back to a subagent of the authoring model — that voids the independence this gate exists to create while still carrying the gate's assurance, which is worse than having no gate. Exit 3 is the one sanctioned fallback (Contextium): the policy row itself says no independent vendor could answer, and the fresh-context review it asks for is recorded with `claude-fallback (fresh context, NOT independent)` in the line, so nobody reads it as independent.

**The prohibition is on CLAUDE specifically, not on any one non-Claude vendor.** Every non-Claude slot the row declares is walked automatically; the script names each one it tried on stderr and ends with `answered: <vendor>/<model>`. Do NOT stop to ask whether the backup is permitted — the policy table already answered that, and asking only pauses a finished diff for a permission that was already granted. Record which vendor answered in the `implement-audit:` trailer so the commit says who reviewed it.

The loop's stopping rule is the review round cap and lives in step-4. Bound the ROUND 1 pass to ~400 changed lines; split a larger diff into separate passes. Rounds 2+ are self-bounding — they only carry the fixes.

`.agents/agents/implement-audit-reviewer.md` is retained as a **documented manual fallback only** — it is no longer dispatched by this step.

## step-3-merge-present

Combine Step 1's automated-check failures (which are fix-now by default — syntactic violations that block ship) with the agent's adversarial findings. Re-order into a single numbered list, most-to-least severe. Preserve each finding's triage verdict.

Emit the user-facing list using the Output Format below.

The reviewer emits **triage lines only** — `[must-fix]` / `[should-fix]` / `[nit]`, one per line, or empty stdout on a clean review. It does NOT emit a structured YAML telemetry block; the retired Claude-subagent reviewer did, and callers must not wait for or try to parse one. Compose the telemetry block in this step from the triage lines instead, mapping `[must-fix]` → `fix-now`, `[should-fix]` → `deferred-batch-1`, and `[nit]` → `deferred-batch-2`, so the aggregator's input shape is unchanged.

`[nit]` maps to its own batch because nits are handled differently from everything else: they are held, not fixed in-round, and they never justify another round. See step-4.

## step-4-fix-round

Fix EVERY finding whose fix is **ready in this session** — `fix-now` AND `deferred-batch-N`. The triage label orders work within the round; it does NOT schedule across rounds. A `deferred-batch-1` finding with a known fix path ships in the same round as `fix-now`, just lower priority. Defer to a future session ONLY when:

- The fix needs an unmade design decision (architecture, vendor, scope) — track via `projects/<domain>/<date>_<slug>/` README
- The fix is blocked on an external dependency (vendor response, third-party fix) — a `blocked: <what>` row in the project's `ROADMAP.md`, from which its `status: blocked` and `blocked-on:` are derived
- The verdict is `out-of-scope` (wrong reviewer, different domain) — surface to user, do not act

`speculative` findings are documented for counter-pressure, not fixed.

**Nits are held, not fixed in-round.** Keep a running list of every `[nit]` across all rounds. Do not fix them mid-loop and do not let one justify another round — a nit is an unbounded supply, and re-reviewing after fixing one is how the loop finds the next one forever. When the loop stops, fix the whole held list in a single pass. They still land this session, so "no deferral" is satisfied.

Then re-invoke Step 1 + Step 2, Step 2 now scoped with `--since` to the fixes alone.

### When to stop

Stop on **whichever of these comes first**:

1. **Converged** — `--since` exits 4: nothing changed since the last snapshot, so there is nothing left to review.
2. **Clean** — the round returns zero findings.
3. **Self-inflicted** — most of the round's must-fix findings re-open ground an earlier round already touched (same file, within ~25 lines of an earlier finding). The loop is now reviewing its own fixes.
4. **Round 4** — a hard ceiling. Stop, fix the held nits, and report what is still open.

Test 3 is the real signal and usually fires first; test 4 is the backstop for when it does not. Test 4 is **also enforced by the script**, which refuses a 5th round with exit 5 — a ceiling stated only in prose is one a long loop runs straight past.

**Do not use the finding COUNT as a stopping signal.** Measured across a few hundred audits, rounds return ~1.2 must-fix findings whether they are round 3 or round 13. "It's still finding things" means the reviewer was asked again, nothing more. What moves is where the findings land: about a fifth re-open earlier ground at round 2, two fifths at round 3, three fifths by round 5, and it never improves after that. A loop run deep into that region ends up flagging its own previous round's fix as the next defect.

**When you stop at the ceiling with findings still open**, say so plainly in the trailer and the summary: what is unfixed, and why the loop ended. Do not fire a question, and do not quietly continue.

**Still emit the round number** in the `implement-audit:` trailer at step-5-emit-trailer — it is the record of how long the loop ran. No `recursion-cap-override:` line is needed; the ceiling is enforced here, not at commit time.

Class-fix discipline: ready fixes ship atomically. The "fix everything ready in the same round" rule above generalizes class-fix-is-atomic to non-class findings — same intent, broader scope.

**Anti-pattern this step closes:** an orchestrator receives 1 fix-now + 4 deferred-batch-1 findings, all with concrete suggested fixes ready to land, fixes only the fix-now item, and asks the user's permission to address the rest. The triage label was over-interpreted as "schedule for later" when its actual semantic is "lower priority within this round."

## step-5-emit-trailer

When the fix loop stops — for any of step-4's four reasons — compose the one-line trailer and record it:

```bash
node --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.ts mark \
  "implement-audit: round-<N>; <M findings: K fix-now + L deferred fixed, R remaining>; <APPROVE|SHIP-with-deferred>"
```

Then print the trailer line. Examples:

- `implement-audit: round-1; zero findings; APPROVE`
- `implement-audit: round-2; 5 findings (4 fix-now + 1 deferred fixed), 0 remaining; APPROVE`
- `implement-audit: round-1; claude-fallback (fresh context, NOT independent); 2 findings (2 fix-now fixed), 0 remaining; APPROVE` — the exit-3 path: completed, weaker, never independent

The leading `round-<N>` is a machine field, not prose. Keep it first and keep the hyphen form.

**When the loop stopped at the round-4 ceiling with work still open**, say which findings are unfixed in the same line and use the `SHIP-with-deferred` verdict:

```
implement-audit: round-4 (ceiling); 12 findings, 2 remaining (contract drift in sync.ts, unverified KV shape); SHIP-with-deferred
```

One line, written into `report.md` § Validation Results, or printed for a standalone run. The round number is a record of how long the loop ran, not a gated field. The ceiling is enforced in step-4, where the loop actually runs; a commit-time round gate can only ask for an override after the calls have already been spent.

**Where the line goes** — a record in the artifact folder, never a gate on a commit (a trailer is a record, not a gate):

- Inside `/implement`: phase-5 writes this line into the report's validation section — `specs/NNN-name/report.md`, or a legacy `{name}-report.md`. `/close` does not read it out of the report, and nothing checks a commit for it.
- Standalone `/implement-audit` (no report): print the line; `/close` § 3 quotes it under the journal entry's `**Changes:**`, which is where it survives the session.

## step-6-auto-close

**Standalone runs only.** The producer skills hand off to `/close` on clean completion,
and a session that ends at this skill's trailer is a session that stops one step short of
landing. Inside `/implement` the audit is phase-4.7 and
phase-6 closes, so nothing is missing. Run standalone — which is what happens after any
ad-hoc change — and the skill's last act was to print a trailer whose only purpose is to
ride a commit that then never got made. The session ends holding it.

So: **if a report exists for this work — `specs/NNN-name/report.md` in the spec's folder, or a legacy sibling `*-report.md` — do nothing** — `/implement` owns
the tail and a second `/close` would double-fire against the gate. Otherwise,
when the verdict is `APPROVE` or `SHIP-with-deferred`:

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # proceed on `not-fired`
```

then run `/close` per the gate; the journal entry carries the step-5 line.

**HALT rather than close when the review FAILED** — step-2 exits 1, 3 or 124, the chain
exhausted. Closing there would land an unreviewed diff under a commit that claims a
review, which is worse than not closing at all.

**If the line does go on a commit, put it in the SAME paragraph as any other trailer.**
Git reads trailers only from the final paragraph of a message, so an `implement-audit:`
line separated from another trailer by a blank line is invisible to
`git log --format='%(trailers:key=implement-audit,valueonly)'`.

## Output Format

```markdown
## implement-audit Findings

<numbered list, most-to-least severe. Each line:>

N. **<title>**: `<file>:<line>` — <nature> — verdict: **<fix-now | deferred-batch-1 | speculative | out-of-scope>** — failure: <the failure it causes> (or "none") — <suggested fix>

## Structured Telemetry

```yaml
findings:
  - id: 1
    verdict: ...
    rule: ...
    message: ...
```

## Summary

- Total findings: N
- Breakdown: M fix-now, P deferred, Q speculative, R out-of-scope
- Ship assessment: **BLOCK** | **APPROVE**
```

If nothing found: say so explicitly ("Zero findings within reviewed scope"). Do not pad —.

## Examples

### Example 1 — /implement phase-4.7 (substantial change)

`/implement` reaches phase-4.7 after mechanism-match and dispatches `/implement-audit`. Step 0 dedupe is `fresh`. Step 1 runs `run-automated-checks.ts --session-base $BASE_SHA`; output: `PASS: lint (6 files)`, `FAIL: standards-refs — see stderr` naming `apps/foo/handler.ts:42` citing a standard that does not exist, rest PASS. Step 2 snapshots the tree (`SNAP1`), then runs `code-review.ts $BASE_SHA HEAD`; it exits 0 with 3 `[must-fix]` + 1 `[should-fix]` + 1 `[nit]` on stdout. Step 3 merges the standards-refs FAIL (fix-now) + the reviewer's 5 = 6 findings. Step 4 fixes the 5 must-fix/should-fix items in one pass and holds the nit. Round 2 snapshots again (`SNAP2`) and runs `code-review.ts --since $SNAP1` — the reviewer sees only the fixes, not the original 6 files — and returns zero findings → stop on test 2. Step 4 fixes the held nit. Step 5 marks + prints `implement-audit: round-2; 6 findings (5 fixed + 1 nit), 0 remaining; APPROVE`. /implement phase-5 writes the line into the report.

### Example 2 — a hand-typed /implement-audit after /implement (the dedupe no-op)

`/implement` phase-4.7 dispatched `/implement-audit`; later in the same session the user types `/implement-audit` again. The first run did the full review and `audit-dedupe.ts mark`ed the trailer; the second one's Step 0 sees `done` and re-emits the stored trailer without a second review. Net: exactly one audit per session.

### Example 3 — zero findings (the explicit empty case)

Round 1 Step 1 returns all PASS; Step 2's agent returns no findings. Step 3 emits the explicit `Zero findings within reviewed scope` message — NOT padded with speculative items. Step 5 marks `implement-audit: round-1; zero findings; APPROVE`. Ship assessment: APPROVE. No round 2.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `code-review.ts` exits 1 — "the chain is exhausted" | EVERY declared slot failed: container down, auth expired, CLI not installed, or usage quota exhausted. The stderr above names each one and why. | The audit FAILED. Do NOT re-run through `policy-review.ts` — that walks the same chain, which has already been walked. Falling back to a CLAUDE reviewer stays forbidden. Restore a vendor (install or re-authenticate its CLI) and re-run. |
| `code-review.ts` exits 1 — "no parseable findings and no NO_FINDINGS sentinel" | A vendor answered but said nothing usable; indistinguishable from a crash, so it is NOT chain fallthrough | Treat as NOT reviewed. Re-run; if it repeats, inspect the stderr tail the script prints. Never read empty stdout as a clean pass. |
| `code-review.ts` exits 124 | Review exceeded the timeout (default 900s) | Same handling as exit 1. Raise `CODEX_REVIEW_TIMEOUT_S` only if the diff is genuinely large; a hang usually means a stdin-wait regression (the script redirects stdin from `/dev/null` to prevent it). |
| `code-review.ts` exits 2 | Bad arity, unresolvable SHA, or base is not an ancestor of head | Caller error, not a review outcome. Re-derive `BASE_SHA` from `git log --oneline` and re-run. |
| Diff exceeds the byte budget (exit 1) | The change is larger than the prompt budget | Split the range and review in parts. The script refuses rather than reviewing a truncated slice, because a partial review reported as clean is the failure mode this gate exists to prevent. |
| Rounds keep returning findings near ones already fixed | The loop is reviewing its own fixes, not the change | Stop — this is step-4's test 3. Do not fire a question, and do not read the finding COUNT as a reason to continue; it stays flat at ~1.2/round however deep the loop goes |
| A round returns findings about code the session never touched | Round 2+ was run as a full review instead of `--since` | Re-scope: rounds 2+ take `--since <the snapshot from before the previous round>`. A full re-review hands the reviewer settled code and it will find something in it |
| `--since` exits 4 immediately on round 2 | The fix round changed nothing on disk — findings were dismissed rather than fixed, or the fixes went to a different tree | If the findings were genuinely all rejected, the loop is done; say so. Otherwise check you are in the session worktree the fixes landed in |
| `WARN: shellcheck missing` / `WARN: check-secrets.ts missing` / `WARN: lint missing` | Tool not installed on this machine, or a repo that carries no `.agents/checks/` | Continue — env diff, not a finding. Install the tool locally if you want full coverage; the script does not block on it |
| `unparseable session-base: <SHA>` | `BASE_SHA` env var was empty, malformed, or referred to a commit not in this clone | Re-derive `BASE_SHA = HEAD~N` from `git log --oneline -n N` showing this session's commits; pass via `--session-base` |
| Round 1 produces only `speculative` findings | The agent is padding | The linter flags speculative-only as probable padding; re-emit as `Zero findings within reviewed scope` |
| Second invocation re-ran the full review | `audit-dedupe.ts` marker absent (no session id — `CONTEXTIUM_SESSION`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_SESSION_ID` — set → dedupe fails safe, or `mark` not called at step-5) | Confirm step-5 ran `audit-dedupe.ts mark`; check `/tmp/implement-audit-done/<session-id>` exists |
