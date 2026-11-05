---
name: implement-audit
description: Adversarial review of freshly-built code — find what was missed, what's inconsistent, what breaks. The single code reviewer for the loop. Auto-fired by /implement (phase-4.7); standalone-callable after any substantial change. Writes an `implement-audit:` line into the report.
allowed-tools: Bash Read Grep Glob
metadata:
  peers: ".agents/agents/implement-audit-reviewer.md .agents/skills/implement/SKILL.md .agents/skills/implement/scripts/validate.ts .agents/skills/review/SKILL.md"
---

# implement-audit — the loop's code reviewer

Review code just built in this conversation. Be adversarial — assume things were missed and find them. Do not confirm the work is good; find what's wrong.

`implement-audit` is the **single code reviewer** everywhere: `/implement` fires it at phase-4.7, and it is standalone-callable as `/implement-audit` after any ad-hoc substantial change. The retired bespoke code-review agent and the old per-surface dispatches all consolidated here.

## Critical — Scope

**Only review work from this conversation.** Do NOT flag unrelated uncommitted changes, review full `git status`, comment on other sessions' work, or pad findings with non-issues. One exception, per that rule: a security or data-loss defect read in passing (exposed credential, injection, destructive-by-default path) is still reported — with the `out-of-scope` verdict, so it never holds the patch.

The skill has two halves. Step 1 runs automated checks in the main conversation. Step 2 runs adversarial reasoning on a policy-assigned vendor after excluding the original authors — a reviewer from the model family that wrote the code has a prior commitment to "this is fine because I wrote it" that fresh context alone does not remove — after reading `.agents/skills/review/SKILL.md` § Where things are found (including T3 execution lineage). The two halves merge into a numbered list of findings.

**Reviews each piece of content once.** Every review leaves a receipt (`scripts/audit-dedupe.ts`): the content it read — the changed source plus every entry point, unchanged dependency, instruction and test record the report's coverage block declares — the answering reviewer, its findings and what it checked. A hand-typed `/implement-audit` after `/implement` phase-4.7, or a post-QA review over records alone, reuses a receipt that still matches and makes no review call. Content the receipt does not cover — a fix, a held nit fixed at the end, /qa's edits, a trunk merge, an unchanged caller or instruction that moved — is reviewed, within the allowance below, before the close lands it.

## Expected State

The producer’s quality checks (/implement's Phase 4 layers, `validate.ts --phase checks`) should have already run. If implement-audit consistently finds 3+ issues, flag this as a process failure — the layers aren't catching what they should, and its fix is bound by root `AGENTS.md` § Standards, **Fix the cause**.

## step-0-receipt

In T3, resolve the audit owner from the `parentThreadId` in this thread’s required `orchestrator_capabilities` result (reuse it if already called). Read `.agents/skills/review/SKILL.md` before dispatch. Fill the command placeholders from actual T3 context; substitute literal values in a child’s task, never leave shell variables for it to inherit. Outside T3, omit T3-only prefixes and leave `CODE_REVIEW_LOOP_ID` unset: the owner is then the close's own thread id (`.agents/skills/close/scripts/thread.ts`), the id the close checks the receipt under.

```bash
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" node --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.ts status --repo "$REVIEW_REPO"
```

- Line 1 `done` → a receipt of this owner still covers this repo's content as it is now (its trailer or summary is line 2). Re-emit it for the caller and **exit the skill** — no review is owed.
- Line 1 `fresh` → no receipt covers the content as it is now; stderr says why (none yet, the last attempt did not complete, unresolved findings, or the paths that changed since). Proceed to `step-1-automated-checks`. A trailer written earlier is never a reason to skip: it is a record, not proof.

## step-1-automated-checks

The existing validation driver in step 2 runs the deterministic checks before each review. Capture its PASS/FAIL/WARN output as ground truth; do not run a separate duplicate review or duplicate check pass. A failed check stops before any vendor call.

The checks are `run-automated-checks.ts --session-base "$BASE_SHA"`, which the driver runs: each touched package's own lint and typecheck (`implement/scripts/layer-1.ts`), shellcheck on changed `.sh`, `.agents/checks/check-standards-refs.ts` on changed files, `.agents/skills/review/find-peers.ts --base $BASE_SHA`, and `.agents/checks/check-secrets.ts --since $BASE_SHA` — the same citation and secrets scans `land.ts` runs before it commits. Each prints a TAP-ish `PASS:` / `FAIL:` / `WARN:` line, then a final `SUMMARY:` line. A check whose program is absent (a product repo carries no `.agents/checks/`) is a `WARN`, never a `FAIL`.

## step-2-dispatch-reviewer

Before any review, supply verified original authors per `.agents/skills/review/SKILL.md` § Where things are found. Preserve the input through every round and the post-QA review, adding any provider that writes fixes. A child executor must use the original authors, not its own provider.

**Inside `/implement`, pass the report.** `--report` names the spec's `report.md`, whose coverage block (`.agents/skills/implement/SKILL.md` § phase-5) lists what the reviewer must check; the driver refuses before any review call when the block is missing, malformed, names a path that does not exist, or omits an `AGENTS.md` at or above a changed path (the root included). A follow-up round is shown the must-fix and should-fix findings still open; one stays open until a round reviews a change to the file it names and does not re-report it, and a path an earlier receipt left unreviewed stays unreviewed until a round's diff carries it. The reviewer then answers in one frame — its findings and a checked/unchecked line, with evidence, for every declared item — and the receipt approves only when no must-fix or should-fix is open and every required item was checked. A standalone audit with no report reviews the diff alone; its receipt covers the changed paths and nothing declared.

**Snapshot before every review, and review only the fixes after round 1.** Take the snapshot FIRST — it has to capture the tree the reviewer is about to read, not the tree after you fix what it says.

```bash
# Round 1. REVIEW_REPO is this worktree or the product worktree under review.
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" POLICY_CHAIN_AUTHOR_THREAD_ID="<writing thread id>" POLICY_CHAIN_AUTHOR_VENDORS="<all writer providers>" \
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$REVIEW_REPO" --phase review \
  --base "$BASE_SHA" --head HEAD --scope <scope> --report "$REPORT"
# Rounds 2+: use PRE_TREE printed by the previous invocation.
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" POLICY_CHAIN_AUTHOR_THREAD_ID="<writing thread id>" POLICY_CHAIN_AUTHOR_VENDORS="<all writer providers>" \
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$REVIEW_REPO" --phase review \
  --base "$BASE_SHA" --since "$PREV_SNAP" --scope <scope> --report "$REPORT"
```

The driver snapshots before each review and prints PRE_TREE; keep it for the next round. A `NOTE: … still covers this content — no review call` line means the receipt was reused and nothing was spent; `RECEIPT: approved` or `RECEIPT: not approved` follows every completed review. Parse triage lines separately from its check output and NEED_FIX/NEED_E2E fields. NEED_FIX=1 means fix before continuing; NEED_E2E=1 requires the producer’s E2E walk again. This is the only review invocation per round. The exit table below describes the review result. The driver preserves convergence and spent-limit exits 4 and 5; neither is a fresh clean review.

Rounds 2+ are scoped this way: a follow-up round that re-reads the cumulative diff spends a full vendor call re-deciding settled code, and its own earlier fixes become the next round's findings. The snapshot is a git tree object written through a temp index — it does not touch HEAD, the index, the stash, or any file, which matters because this skill runs against uncommitted work by design. Untracked files ARE captured, so a file created by a fix does not read as new surface forever.

**The reviewer sees more than the diff, and none of it is your job to assemble.** `code-review.ts` splices a BLAST-RADIUS PACK into its own prompt, between the file list and the DIFF: who imports each changed file, what that file imports, and who calls each symbol the diff actually changed, with a real parser finding the enclosing symbol (`.agents/skills/review/blast-radius.ts`). That is the whole-repo context a hosted code-review bot sells, computed per review from this worktree rather than read out of an index that goes stale while the session edits — so there is no GitHub app to install and nothing to buy. Do NOT paste a caller list into the prompt yourself and do not pass the packer a file list: the script derives it from the same union of changed and working files the reviewer is about to read, which is what keeps the pack from citing a file the diff never showed. It fails open — a missing or broken packer costs the review its context and nothing else, because an unknown caller is not by itself a defect.

**The post-QA review is the same path on another bucket.** When `/qa` edits source during `/implement` phase-4.8, `.agents/skills/implement/scripts/validate.ts --phase qa-revalidate` reviews what it moved through the same receipt: records alone reuse it, anything else is reviewed with `--since`, spending the qa bucket rather than the build one.

The model family that writes the code is not an independent reviewer of it in the sense the assignment asks for, so the caller names every original author (`POLICY_CHAIN_AUTHOR_VENDORS`, above) and the chain leaves them out. WHICH eligible vendor answers is the `adversarial-review` row's business (`.agents/skills/review/policy.json`, walked by `policy-chain.ts`), not this skill's. The script walks eligible slots in that row, with fallback inside the same call. It reads the diff and repo through its sandbox, so it needs no curated file list.

**One invocation, not two.** Do not re-run a failed review through `policy-review.ts` by hand: the chain walk is in-script, so exit 1 means the chain is ALREADY exhausted, and re-running it cannot help.

`BASE_SHA` is the start of this session's commits (typically `HEAD~N` for N commits this session); `HEAD_SHA` is `HEAD`. Uncommitted work is included and flagged to the reviewer, because this skill runs pre-commit by design.

**For another repo**, set REVIEW_REPO to that thread-owned product worktree and BASE_SHA to its merge-base. Use the same validate.ts --repo invocation above for every round; it runs checks, snapshot and review against that repo. When a change spans repos, name each companion worktree through CODEX_REVIEW_COMPANIONS per .agents/skills/review/SKILL.md. Do not run a separate checks/reviewer pair.

Interpret the exit code — this is a **gate**, not a best-effort step:

| Driver exit | Meaning | Action |
|---|---|---|
| 0 | Checks passed; no must-fix or should-fix; the receipt approves (or was reused). | Merge any nits in step 3. |
| 1 | Findings, failed checks, or unavailable review. | Read triage/check output and stderr. Fix ready findings or checks, then re-enter the scoped round. If diagnostics say no reviewer answered, report unavailable without approval; restore the reviewer before retrying. |
| 2 | Invalid range or review-role inputs. | Correct the named input; no review round was spent. |
| 3 | No independent reviewer: the row's declared fresh-context fallback found no eligible vendor, or the chain reached a `claude` slot. The driver prints `NEED_FALLBACK_REVIEW=1`. | Pending, NOT a failure, and NOT independent (Contextium). Run `.agents/agents/implement-audit-reviewer.md` in a FRESH context on the same diff, with the coverage items file the note names; save its whole reply and run `validate.ts --fallback-review <file>`, which records it against the receipt. Work its findings through steps 3-4 as usual and record `implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); <findings>; <verdict>`. |
| 4 | Converged with checks passing, and the receipt approves. | Stop the loop; no new review is claimed. A converged round whose receipt does not approve (open findings, an unchecked item) is exit 1 with NEED_FIX=1: nothing changed, so nothing was resolved. |
| 5 | Final review allowance already spent, or the counter is unreadable or missing after this audit registered one. | BLOCK; no approval. Never reset the counter, never start another owner for the same change. Recover by restoring the reviewed bytes, or ask the user, once, to authorize spending past the allowance; below the ceiling a build never asks them for another review. |

**A reviewer that cannot run is a FAILED review, never a silent substitution.** When diagnostics report an unavailable reviewer, you MUST NOT fall back to an undeclared provider or artifact author — doing so voids the independence this gate exists to create while still carrying the gate's assurance, which is worse than having no gate. Exit 3 is the one sanctioned fallback (Contextium): the policy row itself declares it, and the fresh-context review it asks for is recorded with `claude-fallback (fresh context, NOT independent)` in the line and in the receipt, so nobody reads it as independent.

**Never fall back to an artifact author.** The chain names exclusions and attempted vendors on stderr and ends with `answered: <vendor>/<model>` on success. Eligible backups are already authorized by policy; do not ask again. Record the answering vendor in the trailer. A Claude slot remains unavailable in this script executor, whether or not Claude authored the artifact.

The loop's stopping rule is the review round cap and lives in step-4. Rounds 2+ are self-bounding — they only carry the fixes.

**A change too large for one review call is reviewed in pieces** (the driver refuses a diff over the byte budget, and spends nothing doing so). Group the changed files into at most four pieces — related files together, each piece's diff under the budget — write each piece's paths NUL-separated to a file, and run round 1 once per piece with `--slice <file>` added, every piece over the SAME `--base` and `--head`:

```bash
printf '%s\0' .agents/skills/a/x.ts .agents/skills/a/x.test.ts >"$PIECE1"
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" POLICY_CHAIN_AUTHOR_THREAD_ID="<writing thread id>" POLICY_CHAIN_AUTHOR_VENDORS="<all writer providers>" \
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$REVIEW_REPO" --phase review \
  --base "$BASE_SHA" --head HEAD --slice "$PIECE1" --scope <scope> --report "$REPORT"
```

Each piece spends a round from the same allowance (piece 1 is round 1, piece 4 is round 4), so a set of four leaves six rounds and the one final review for fixes. A piece whose set still has unread files prints `SLICE_PENDING=<n>` and one `unread: <path>` line each, exits 1 with `NEED_FIX=0`, and is not a fix request: run the next piece over those files. When the pieces together have read every changed file at its current content, the driver combines them into one receipt, which approves (or names its findings) exactly as one full review would. Never cut pieces by commit (`<commit>..<commit>`): a piece that ends before HEAD reads an earlier version of every file a later commit touched again, and is refused. A file you edit between pieces is unread again until a later piece reads it, and a piece that lists a file an earlier piece already read, an unchanged file or a record is refused before any call.

`.agents/agents/implement-audit-reviewer.md` is retained as a **documented manual fallback only** — it is no longer dispatched by this step.

## step-3-merge-present

Combine Step 1's automated-check failures (which are fix-now by default — syntactic violations that block ship) with the agent's adversarial findings. Re-order into a single numbered list, most-to-least severe. Preserve each finding's triage verdict.

Emit the user-facing list using the Output Format below.

The reviewer emits **triage lines only** — `[must-fix]` / `[should-fix]` / `[nit]`, one per line, or empty stdout on a clean review. It does NOT emit a structured YAML telemetry block; the retired Claude-subagent reviewer did, and callers must not wait for or try to parse one. Compose the telemetry block in this step from the triage lines instead, mapping `[must-fix]` → `fix-now`, `[should-fix]` → `deferred-batch-1`, and `[nit]` → `deferred-batch-2`, so the aggregator's input shape is unchanged.

`[nit]` maps to its own batch because nits are handled differently from everything else: they are held, not fixed in-round, and they never justify another round of their own. See step-4.

## step-4-fix-round

Fix EVERY finding whose fix is **ready in this session** — `fix-now` AND `deferred-batch-N`. The triage label orders work within the round; it does NOT schedule across rounds. A `deferred-batch-1` finding with a known fix path ships in the same round as `fix-now`, just lower priority. Defer nothing yourself (root `AGENTS.md` § Standards, **No deferral**):

- A technical choice (architecture, vendor, library, location) is yours: make it, name the rule applied, and fix.
- A fix that needs what only the user can answer — their preference, money, an outbound message, infrastructure they have not allowed — is asked now, as a numbered list, per `.agents/skills/close/references/auto-close-gate.md` precondition (iii); the run halts there and never closes around it.
- A fix blocked on someone else (a vendor response, a third-party fix) becomes a `blocked: YYYY-MM-DD <what>` row in the project's `ROADMAP.md` only when that date is real; never invent one. A wait with no known date holds the close (the gate's § What "open" means), so say it in the reply as what is open.
- An `out-of-scope` verdict is surfaced to the user, not acted on.

`speculative` findings are documented for counter-pressure, not fixed.

**Nits are held, and land inside a reviewed round.** Keep a running list of every `[nit]` across all rounds; do not let one justify a round of its own — a nit is an unbounded supply. Fix the held nits you will fix together with the last round's must-fix and should-fix edits, so the review that round already spends reads them; a nit you leave unfixed is written down with why (its disposition) in the report. Never edit source after the last review you have allowance for: that content has no receipt, and the close refuses it.

**A finding you believe is wrong is not dismissed by converging.** An open must-fix or should-fix keeps the receipt from approving, and a round with nothing changed resolves nothing. Change the code so the next round can review your answer, or ask the user, as a numbered question, to accept it.

Then re-enter step 2 with `--since` for the fixes alone; the driver re-runs the deterministic checks.

**A piece set is read whole before any fix round.** While the last piece printed `SLICE_PENDING` > 0, run the next piece (step-2), even when a piece reported a finding: fixing first moves the files an earlier piece read and costs another piece to re-read them. Once the set is complete, fix what the combined receipt holds open and review the fixes with `--since` the PRE_TREE of the last piece.

### When to stop

Keep going on your own: below the ceiling, never ask the user whether to run another review. Stop on **whichever of these comes first**:

1. **Converged** — `--since` exits 4: nothing changed since the last snapshot, so there is nothing left to review.
2. **Clean** — the round returns zero findings, and the receipt approves.
3. **Round 10** — the ceiling, a guard against a loop that never ends. The last round's own fixes, with the held nits you fix, still get ONE final review, once per loop: run the same `validate.ts --phase review --since <tree>` command as every round, and the driver runs the final review itself when the reviewer reports the ceiling. Never add `--final` to `validate.ts`; it refuses the option (exit 2), and a run that adds it loses a review. What it finds is open work the receipt will not approve: fix it only within allowance you still have, else report it open and BLOCK. Without that final review, the last round's fixes, and the final review's own, would ship unreviewed. A repeated full review is a round, not a new loop: it never renews the allowance.

**A repeat spot means redesign, not another patch.** When the driver prints `[code-review] REPEAT SPOT: <file:line>`, the reviewer flagged the same place (same file, within 25 lines) that the last review left open: the patch did not close the defect, or opened the next hole beside it. Stop patching that piece. Rewrite it as a whole around the case the findings keep circling, with a test for each finding it has drawn, and send the rewrite through the next round. A handler that draws a new gap in every review is closed by replacing its patches with one design that covers every case, not by an eighth patch. Stopping the loop on a repeat instead left the finding open, and the build asking the user for one more review.

Test 3 is **also enforced by the script** (`MAX_ROUNDS` in `.agents/skills/review/code-review.ts`), which refuses round 11 with exit 5 — a ceiling stated only in prose is one a long loop runs straight past.

**Do not use the finding COUNT as a stopping signal.** Measured across a few hundred audits, rounds return ~1.2 must-fix findings whether they are round 3 or round 13. "It's still finding things" means the reviewer was asked again, nothing more. What moves is where the findings land: about a fifth re-open earlier ground at round 2, two fifths at round 3, three fifths by round 5, and it never improves after that. A loop run deep into that region ends up flagging its own previous round's fix as the next defect.

**When you stop at the ceiling with findings still open**, say so plainly in the trailer and the summary: what is unfixed, and why the loop ended. Then ask the user once, as a numbered question, whether to spend past the allowance on what is open; this is the only review question a build asks them. Do not quietly continue.

**Still emit the round number** in the `implement-audit:` trailer at step-5-emit-trailer — it is the record of how long the loop ran. No `recursion-cap-override:` line is needed; the ceiling is enforced here, not at commit time.

Class-fix discipline: ready fixes ship atomically. The "fix everything ready in the same round" rule above generalizes class-fix-is-atomic to non-class findings — same intent, broader scope.

**Anti-pattern this step closes:** an orchestrator receives 1 fix-now + 4 deferred-batch-1 findings, all with concrete suggested fixes ready to land, fixes only the fix-now item, and asks the user's permission to address the rest. The triage label was over-interpreted as "schedule for later" when its actual semantic is "lower priority within this round."

## step-5-emit-trailer

When the loop stops, compose the trailer. APPROVE requires a receipt that covers the content as it is now — the last driver run printed `RECEIPT: approved` or reused the receipt, and nothing has been edited since. An unfixed blocker, an unchecked declared item, a source edit after the last review, or a driver exit 5 is BLOCK: print that verdict, write nothing, and keep auto-close blocked. Do not turn a review-limit note into approval. On APPROVE, attach the trailer to the receipt; `mark` refuses (exit 1, the reasons on stderr) when no receipt covers this content, because a trailer is a record and never the proof:

```bash
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" node --experimental-strip-types .agents/skills/implement-audit/scripts/audit-dedupe.ts mark \
  "implement-audit: round-<N>; <M findings: K fix-now + L deferred fixed, R remaining>; APPROVE" --repo "$REVIEW_REPO"
```

Then print the trailer line. Examples:

- `implement-audit: round-1; zero findings; APPROVE`
- `implement-audit: round-2; 5 findings (4 fix-now + 1 deferred fixed), 0 remaining; APPROVE`
- `implement-audit: round-1; claude-fallback (fresh context, NOT independent); 2 findings (2 fix-now fixed), 0 remaining; APPROVE` — the exit-3 path: completed, weaker, never independent

The leading `round-<N>` is a machine field, not prose. Keep it first and keep the hyphen form.

**At the ceiling with work still open**, identify each unresolved finding or verification gap and print a BLOCK trailer. Do not reset the counter or ask another reviewer in the same loop.

One line, written into `report.md` § Validation Results, or printed for a standalone run. The round number is a record of how long the loop ran, not a gated field. The ceiling is enforced in step-4, where the loop actually runs; a commit-time round gate can only ask for an override after the calls have already been spent.

**Where the line goes** — a record in the artifact folder, never a gate on a commit (a trailer is a record, not a gate):

- Inside `/implement`: phase-5 writes this line into the report's validation section — `specs/NNN-name/report.md`. `/close` does not read it out of the report, and nothing checks a commit for it.
- Standalone `/implement-audit` (no report): print the line; `/close` § 3 quotes it under the journal entry's `**Changes:**`, which is where it survives the session.

## step-6-auto-close

Follow close/references/auto-close-gate.md § Caller ownership. When this audit
is a step in another producer, return the verdict and evidence to that caller;
it owns the close. A report file alone does not establish that relationship.
For a standalone run with verdict `APPROVE`:

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate    # proceed on `not-fired`
```

then run `/close` per the gate; the journal entry carries the step-5 line.

**HALT rather than close on BLOCK or an unavailable review.** A driver exit 1
with fixable findings/check failures goes through the fix loop first; exit 5 is
a spent review limit and remains blocked. Closing there would land an unreviewed diff under a commit that claims a
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

If nothing found: say so explicitly ("Zero findings within reviewed scope"). Do not pad.

## Examples

### Example 1 — /implement phase-4.7 (substantial change)

`/implement` invokes this skill after mechanism-match. The validation driver stops on a deterministic check failure before any vendor call. After that is fixed, it prints PRE_TREE and the reviewer’s triage lines. Fix the must-fix/should-fix findings, hold nits, then run the driver with `--since` using that PRE_TREE. On convergence, fix held nits and record the trailer; `/implement` puts it in the report.

### Example 2 — a hand-typed /implement-audit after /implement (the receipt is reused)

`/implement` phase-4.7 dispatched `/implement-audit`; later in the same thread the user types `/implement-audit` again. If nothing the receipt covers has changed, Step 0 sees `done` and re-emits the trailer without a review call. If a file moved since — say the journal entry and one more source fix — Step 0 says `fresh`, names the source fix, and the driver reviews that content within the allowance left; the journal entry alone would not have counted.

### Example 3 — zero findings (the explicit empty case)

Round 1 Step 1 returns all PASS; Step 2's agent returns no findings. Step 3 emits the explicit `Zero findings within reviewed scope` message — NOT padded with speculative items. Step 5 marks `implement-audit: round-1; zero findings; APPROVE`. Ship assessment: APPROVE. No round 2.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `code-review.ts` exits 1 — "the chain is exhausted" | EVERY declared slot failed: container down, auth expired, CLI not installed, or usage quota exhausted. The stderr above names each one and why. | The audit FAILED. Do NOT re-run through `policy-review.ts` — that walks the same chain, which has already been walked. Falling back to a CLAUDE reviewer stays forbidden. Restore a vendor (install or re-authenticate its CLI) and re-run. |
| `code-review.ts` exits 1 — "no parseable findings and no NO_FINDINGS sentinel" | A vendor answered but said nothing usable; indistinguishable from a crash, so it is NOT chain fallthrough | Treat as NOT reviewed. Re-run; if it repeats, inspect the stderr tail the script prints. Never read empty stdout as a clean pass. |
| `code-review.ts` exits 124 | Review exceeded the timeout (default 900s) | Same handling as exit 1. Raise `CODEX_REVIEW_TIMEOUT_S` only if the diff is genuinely large; a hang usually means a stdin-wait regression (the script redirects stdin from `/dev/null` to prevent it). |
| `code-review.ts` exits 2 | Invalid range or original-author provenance | Correct the specific input named on stderr. |
| Diff exceeds the byte budget (exit 1) | The change is larger than the prompt budget | Review it as up to four pieces by file over one base and head (`--slice <file>`, step-2). The script refuses rather than reviewing a truncated slice, because a partial review reported as clean is the failure mode this gate exists to prevent; the refusal spends no round. |
| `SLICE_PENDING=<n>` with `NEED_FIX=0` | A piece finished and other changed files are still unread by any piece | Run the next piece over the `unread:` files, same `--base` and `--head`. Not a finding, and no fix round yet. |
| `REPEAT SPOT` lines, or rounds keep returning findings near ones already fixed | Each patch leaves the next hole beside it | Redesign that piece as a whole (step-4, § A repeat spot) and review the rewrite. Do not fire a question, and do not read the finding COUNT as a reason to continue; it stays flat at ~1.2/round however deep the loop goes |
| A round returns findings about code the session never touched | Round 2+ was run as a full review instead of `--since` | Re-scope: rounds 2+ take `--since <the snapshot from before the previous round>`. A full re-review hands the reviewer settled code and it will find something in it |
| `--since` exits 4 immediately on round 2 | The fix round changed nothing on disk — findings were dismissed rather than fixed, or the fixes went to a different tree | If the findings were genuinely all rejected, the loop is done; say so. Otherwise check you are in the session worktree the fixes landed in |
| `WARN: shellcheck missing` / `WARN: check-secrets.ts missing` / `WARN: lint missing` | Tool not installed on this machine, or a repo that carries no `.agents/checks/` | Continue — env diff, not a finding. Install the tool locally if you want full coverage; the script does not block on it |
| `unparseable session-base: <SHA>` | `BASE_SHA` env var was empty, malformed, or referred to a commit not in this clone | Re-derive `BASE_SHA = HEAD~N` from `git log --oneline -n N` showing this session's commits; pass via `--session-base` |
| Round 1 produces only `speculative` findings | The agent is padding | The linter flags speculative-only as probable padding; re-emit as `Zero findings within reviewed scope` |
| Second invocation re-ran the review | Something the receipt covers changed (stderr of `status` names it), the owner differed (CODE_REVIEW_LOOP_ID not the audit owner's thread id), or the writer set differed | Read `status --repo` stderr; restore the owner or accept that changed content needs its review |
| `RECEIPT: not approved` on a clean review | A declared item was reported `unchecked`, a changed path was outside the reviewed range, or a follow-up round did not cover a path that moved since the last receipt | Read the `implement-audit:` lines above it; check the item, widen the range, or review `--since` the snapshot of the approved content |
| The close says `changed since the review` | A fix, a held nit, /qa or a trunk merge moved covered content after the last review | Review that change within the remaining allowance — `--since` the last PRE_TREE for your own edits; after a trunk merge, a full review from the new merge base (`--base "$(git merge-base HEAD origin/main)" --head HEAD`), which spends a round, because a `--since` diff would carry every merged commit — or restore the reviewed bytes |
