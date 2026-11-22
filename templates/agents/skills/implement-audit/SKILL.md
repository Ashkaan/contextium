---
name: implement-audit
description: Adversarial review of freshly built code — what was missed, what is inconsistent, what breaks. Run by /implement after a build, and on its own after any substantial change.
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

**Reviews each piece of content once.** Every review leaves a receipt (`scripts/audit-dedupe.ts`): the content it read — the changed source plus every entry point, unchanged dependency, instruction and test record the report's coverage block declares — the answering reviewer, its findings and what it checked. A hand-typed `/implement-audit` after `/implement` phase-4.7, or a post-QA review over records alone, reuses a receipt that still matches and makes no review call. Content the receipt does not cover — a fix, a cosmetic edit batched with fixes, /qa's edits, a trunk merge, an unchanged caller or instruction that moved — is reviewed, within the allowance below, before the close lands it.

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

**Inside `/implement`, pass the report.** `--report` names the spec's `report.md`, whose coverage block (`.agents/skills/implement/SKILL.md` § phase-5) lists what the reviewer must check; the driver refuses before any review call when the block is missing, malformed, names a path that does not exist, or omits an `AGENTS.md` at or above a changed path (the root included). A follow-up round is shown the must-fix and should-fix findings still open, each under its id; one closes as **How a blocker closes** in step-4-fix-round says, and a path an earlier receipt left unreviewed stays unreviewed until a round's diff carries it or the change no longer holds it (for another repo's path: the declaration no longer names it and the file is gone). The reviewer then answers in one frame — its findings and a checked/unchecked line, with evidence, for each item in its prompt — and the receipt approves only when no must-fix or should-fix is open and every required item was checked. A follow-up leaves a previously checked recorded run out of the prompt when its declaration and evidence files are unchanged. Entry points, dependencies and claims without recorded evidence are checked against the current fix. The receipt identifies reused evidence by its earlier review date. A standalone audit with no report reviews the diff alone; its receipt covers the changed paths and nothing declared.

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

**Interrupted and merge reviews recover through that same command.** Only a usable completed answer spends a round, including the final pass. A failed or interrupted attempt never approves anything; retry from the last completed review, which the driver selects automatically. Issued snapshots live in durable thread state; completed receipts recover older snapshots after a restart. Do not ask for another approval merely because an attempt was interrupted.

After a clean approval, a real upstream merge into the reviewed source (or a declared companion) starts a separate, bounded integration allowance under the same owner. The driver proves that the merge descends from the approved history and imports new upstream source, then reviews only the delta since the last completed review, including local fixes made before that merge, kept to this branch's own files and the covered files that moved (`mergeReviewPaths` in `scripts/audit-dedupe.ts`, handed to the checks, the layers and the reviewer as `REVIEW_PATHS_FILE`): the rest of what the trunk imported is other sessions' reviewed work. Legacy receipts without an approved HEAD require matching source at the merge's first parent instead. Fixes, retries and further merges keep that integration allowance until it approves; local edits alone, a local branch merge, a new executor, or an unapproved implementation cannot renew it. Use the normal command and follow its selected bucket and delta; never edit counters or choose an integration key. A changed declaration beside another repo is an explicit required check, and changed dependencies are reviewed even when the product diff is empty.

Rounds 2+ are scoped this way: a follow-up round that re-reads the cumulative diff spends a full vendor call re-deciding settled code, and its own earlier fixes become the next round's findings. The snapshot is a git tree object written through a temp index — it does not touch HEAD, the index, the stash, or any file, which matters because this skill runs against uncommitted work by design. Untracked files ARE captured, so a file created by a fix does not read as new surface forever.

**The reviewer sees more than the diff, and none of it is your job to assemble.** `code-review.ts` splices a BLAST-RADIUS PACK into its own prompt, between the file list and the DIFF: who imports each changed file, what that file imports, and who calls each symbol the diff actually changed, with a real parser finding the enclosing symbol (`.agents/skills/review/blast-radius.ts`). That is the whole-repo context a hosted code-review bot sells, computed per review from this worktree rather than read out of an index that goes stale while the session edits — so there is no GitHub app to install and nothing to buy. Do NOT paste a caller list into the prompt yourself and do not pass the packer a file list: the script derives it from the same union of changed and working files the reviewer is about to read, which is what keeps the pack from citing a file the diff never showed. It fails open — a missing or broken packer costs the review its context and nothing else, because an unknown caller is not by itself a defect.

**The post-QA review is the same path on another bucket.** Initial UI QA runs before the first code review (implement phase-4.6). If a later QA pass edits source during phase-4.8, `.agents/skills/implement/scripts/validate.ts --phase qa-revalidate` reviews what it moved through the same receipt: records alone reuse it, anything else is reviewed with `--since`, spending the qa bucket rather than the build one.

The model family that writes the code is not an independent reviewer of it in the sense the assignment asks for, so the caller names every original author (`POLICY_CHAIN_AUTHOR_VENDORS`, above) and the chain leaves them out. WHICH eligible vendor answers is the `adversarial-review` row's business (`.agents/skills/review/policy.json`, walked by `policy-chain.ts`), not this skill's. The script walks eligible slots in that row, with fallback inside the same call. It reads the diff and repo through its sandbox, so it needs no curated file list.

**One invocation, not two.** Do not re-run a failed review through `policy-review.ts` by hand: the chain walk is in-script, so exit 1 means the chain is ALREADY exhausted, and re-running it cannot help.

`BASE_SHA` is the start of this session's commits (typically `HEAD~N` for N commits this session); `HEAD_SHA` is `HEAD`. Uncommitted work is included and flagged to the reviewer, because this skill runs pre-commit by design.

**For another repo**, set REVIEW_REPO to that thread-owned product worktree and BASE_SHA to its merge-base. Use the same validate.ts --repo invocation above for every round; it runs checks, snapshot and review against that repo. When a change spans repos, name each companion worktree through CODEX_REVIEW_COMPANIONS per .agents/skills/review/SKILL.md, and pass as REPORT the declaration written for the repo under review (.agents/skills/implement/SKILL.md § "A row whose code is in another repo"). Do not run a separate checks/reviewer pair.

Interpret the exit code — this is a **gate**, not a best-effort step:

| Driver exit | Meaning | Action |
|---|---|---|
| 0 | Checks passed; no must-fix or should-fix; the receipt approves (or was reused). | Follow the cosmetic-suggestion rule in step 4. |
| 1 | Findings, failed checks, or unavailable review. | Read triage/check output and stderr. Fix ready findings or checks, then re-enter the scoped round. If diagnostics say no reviewer answered, report unavailable without approval; restore the reviewer before retrying. The unanswered attempt spent no round. |
| 2 | Invalid range or review-role inputs. | Correct the named input; no review round was spent. |
| 3 | No independent reviewer: the row's declared fresh-context fallback found no eligible vendor, or the chain reached a `claude` slot. The driver prints `NEED_FALLBACK_REVIEW=1`. | Pending, NOT a failure, and NOT independent (Contextium). Run `.agents/agents/implement-audit-reviewer.md` in a FRESH context on the same diff, with the coverage items file the note names; save its whole reply and run `validate.ts --fallback-review <file>`, which records it against the receipt. Work its findings through steps 3-4 as usual and record `implement-audit: round-<N>; claude-fallback (fresh context, NOT independent); <findings>; <verdict>`. |
| 4 | Converged with checks passing, and the receipt approves. | Stop the loop; no new review is claimed. A converged round whose receipt does not approve (open findings, an unchecked item) is exit 1 with NEED_FIX=1: nothing changed, so nothing was resolved. |
| 5 | This fix loop's final allowance is spent, or its counter is unreadable or missing after registration. | BLOCK; no approval. Never reset the counter or start another owner. A genuine upstream merge after approval is selected automatically as described above; retry the normal driver before asking. Otherwise restore reviewed bytes, or tell the user what still fails and ask the ceiling question below. |

**A reviewer that cannot run is a FAILED review, never a silent substitution.** When diagnostics report an unavailable reviewer, you MUST NOT fall back to an undeclared provider or artifact author — doing so voids the independence this gate exists to create while still carrying the gate's assurance, which is worse than having no gate. Exit 3 is the one sanctioned fallback: the policy row itself declares it, and the fresh-context review it asks for is recorded with `claude-fallback (fresh context, NOT independent)` in the line and in the receipt, so nobody reads it as independent. Only the user can overrule this otherwise, for the change in front of them: their words, with their name and the date, in `CODE_REVIEW_REVIEWER_OVERRIDE_BY` send the review to Claude, recorded as such (`.agents/skills/review/code-review.ts` § THE REVIEWER OVERRIDE).

**Never fall back to an artifact author.** The chain names exclusions and attempted vendors on stderr and ends with `answered: <vendor>/<model>` on success. Eligible backups are already authorized by policy; do not ask again. Record the answering vendor in the trailer. A Claude slot remains unavailable in this script executor, whether or not Claude authored the artifact.

The loop's stopping rule is the review round cap and lives in step-4. Rounds 2+ are self-bounding — they only carry the fixes.

**A change too large for one review call is reviewed in pieces** (the driver refuses a diff over the byte budget, and spends nothing doing so). Group the changed files into at most four pieces — related files together, each piece's diff under the budget — write each piece's paths NUL-separated to a file, and run round 1 once per piece with `--slice <file>` added, every piece over the SAME `--base` and `--head`:

```bash
printf '%s\0' .agents/skills/a/x.ts .agents/skills/a/x.test.ts >"$PIECE1"
CODE_REVIEW_LOOP_ID="<audit-owner thread id>" POLICY_CHAIN_AUTHOR_THREAD_ID="<writing thread id>" POLICY_CHAIN_AUTHOR_VENDORS="<all writer providers>" \
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$REVIEW_REPO" --phase review \
  --base "$BASE_SHA" --head HEAD --slice "$PIECE1" --scope <scope> --report "$REPORT"
```

A piece receives outstanding checks tied to its files and shared checks without a changed file of their own. The last piece also receives any outstanding checks from earlier pieces.

The pieces of the first review count as that one review, up to four (a piece that spent a round of its own left a four-piece set no repairs). A fifth piece is refused with exit 5. A piece whose set still has unread files prints `SLICE_PENDING=<n>` and one `unread: <path>` line each, exits 1 with `NEED_FIX=0`, and is not a fix request: run the next piece over those files. When the pieces together have read every changed file at its current content, the driver combines them into one receipt, which approves (or names its findings) exactly as one full review would. Never cut pieces by commit (`<commit>..<commit>`): a piece that ends before HEAD reads an earlier version of every file a later commit touched again, and is refused. A file you edit between pieces is unread again until a later piece reads it, and a piece that lists a file an earlier piece already read, an unchanged file or a record is refused before any call.

`.agents/agents/implement-audit-reviewer.md` is retained as a **documented manual fallback only** — it is no longer dispatched by this step.

## step-3-merge-present

Combine Step 1's automated-check failures (which are fix-now by default — syntactic violations that block ship) with the agent's adversarial findings. Re-order into a single numbered list, most-to-least severe. Preserve each finding's triage verdict.

Emit the user-facing list using the Output Format below.

The reviewer emits **triage lines only** — `[must-fix]` / `[should-fix]` / `[nit]`, one per line, or empty stdout on a clean review. It does NOT emit a structured YAML telemetry block; the retired Claude-subagent reviewer did, and callers must not wait for or try to parse one. Compose the telemetry block in this step from the triage lines instead, mapping `[must-fix]` → `fix-now`, `[should-fix]` → `deferred-batch-1`, and `[nit]` → `deferred-batch-2`, so the aggregator's input shape is unchanged.

`[nit]` maps to its own batch for the cosmetic suggestions in step 4.

## step-4-fix-round

Fix EVERY finding whose fix is **ready in this session** — `fix-now` AND `deferred-batch-N`. The triage label orders work within the round; it does NOT schedule across rounds. A `deferred-batch-1` finding with a known fix path ships in the same round as `fix-now`, just lower priority. Defer nothing yourself (root `AGENTS.md` § Standards, **No deferral**):

- A technical choice (architecture, vendor, library, location) is yours: make it, name the rule applied, and fix.
- A fix that needs what only the user can answer — their preference, money, an outbound message, infrastructure they have not allowed — is asked now, as a numbered list, per `.agents/skills/close/references/auto-close-gate.md` precondition (iii); the run halts there and never closes around it.
- A fix blocked on someone else (a vendor response, a third-party fix) holds the row being built, never a new row: `.agents/skills/implement/SKILL.md` § findings-stay-in-row says how. Never invent a date.
- An `out-of-scope` verdict is surfaced to the user, not acted on.

`speculative` findings are documented for counter-pressure, not fixed.

**Batch cosmetic suggestions into a review already needed.** Apply a worthwhile `[nit]` with the next batch of must-fix or should-fix edits. If the receipt approves and only cosmetic suggestions remain, stop and leave them as-is. A suggestion that prevents a concrete failure is a defect; treat it as must-fix or should-fix.

**Check every blocker before fixing it.** Reproduce it with a test. When it reproduces, fix it, the test seen failing first. When it does not — the input is outside the spec's supported inputs and gets the spec's fallback, or the code already handles it — write one line of evidence, `<id>: <what you ran or read>`, to a file and pass it with `--rebuttal <file>` on the next round. That round judges your evidence even when no source changed. A passing test alone proves little: name the input you ran and what it returned. Never leave a finding you think is wrong unanswered, and never edit the code just to make a round run.

**How a blocker closes.** A `--since` round is shown every open must-fix and should-fix under its id (`findingId` in `scripts/audit-dedupe.ts`) and must give each exactly one verdict — `fixed`, `disproved` or `open`, with evidence — or its answer is unusable. `fixed` and `disproved` close it, and `open` keeps it. A shown finding with no verdict stays open, and so does one a round was not shown. A full review replaces the open set with its own findings. A round that closed a blocker by leaving it out judged nothing: an omission is not a judgment.

**A blocker judged open after two repairs in a row means change the approach.** The driver prints `STILL OPEN: <id> …`. Stop patching that piece. Change what it starts from, so the whole kind of failure goes, and say why in the report. A parser patched round after round for each new phrasing of an email is fixed by handing the pipeline the plain value it needs, not by a ninth pattern.

Then re-enter step 2 with `--since` for the fixes alone; the driver re-runs the deterministic checks.

**A piece set is read whole before any fix round.** While the last piece printed `SLICE_PENDING` > 0, run the next piece (step-2), even when a piece reported a finding: fixing first moves the files an earlier piece read and costs another piece to re-read them. Once the set is complete, fix what the combined receipt holds open and review the fixes with `--since` the PRE_TREE of the last piece.

### When to stop

**Ordinary review: one initial review and one focused recheck.** Batch the
first review's confirmed defects and review the fixes together. After that,
start a fix round only for identified, confirmed defects. Record the defects
and the failing and passing evidence in the implementation report or, for a
standalone audit, in its findings. Send only the fixes and affected callers.
This is a default of two reviews; confirmed new or remaining defects can
require further focused reviews within the existing spending allowance. Review
new source edits from QA or integration through the same driver.

**What holds the build.** Every must-fix or should-fix is a bug in this build, whatever round finds it. It holds the build until a round judges it fixed or disproved. Each one names the behavior it breaks and a witness: an input and the wrong result. An input outside the spec's supported inputs that gets the spec's fallback is not a bug.

What does not hold the build:
- **Ideas:** an improvement nobody asked for is an `[idea]`. The driver prints each as `IDEA:`. An idea that may touch sending, money or deleting is held as a should-fix instead, so disprove it if it does not.
- **Notes:** a finding in a file outside this build's change counts only when it says `caused by <changed file:line>`. A break this change causes in an untouched caller is this build's bug. Anything else is another session's code, printed as `NOTED:`.
- **Disproved blockers:** printed as `DISPROVED:`.

The build lists every `IDEA:`, `NOTED:` and `DISPROVED:` line in its report's `## Not built`. A reviewer's ideas reach a roadmap row only as the one improvements row that section adds (`.agents/skills/implement/SKILL.md` § Not built, and the improvements row). A `NOTED:` finding is filed or fixed as § findings-stay-in-row says.

A fix round that blocked only on `NOT FIXED:` or a cited `BROKE:` and filed the rest for later stayed open to invented inputs — a round with three NOT FIXED, each a different made-up layout, and four BROKE all citing one broad spec line — while new real bugs were set aside.

After the first review a changed record is left out of a fix round's diff unless an open finding points at it, so a one-off helper saved as evidence is not re-attacked. A test log or other record the coverage block names is bound by its presence, not its bytes (`boundByPresence`).

A landing refusal is fixed in this build's own work, never by editing `.agents/skills/close`, `.agents/skills/review` or this skill. A build that edits the landing tool spends its rounds reviewing those edits instead of its own work. A defect in those tools goes to the user.

Stop on **whichever of these comes first**:

1. **Converged** — `--since` exits 4: nothing changed since the last snapshot, so there is nothing left to review.
2. **Clean** — the receipt approves and only cosmetic suggestions, if any, remain.
3. **Round 3** — the ceiling: one first review and three repairs, each repair reviewed — rounds 2 and 3, then the final review of the third repair: three repairs catch as much as more rounds did, which ran to 17 and 39 rounds when the ceiling was 10. The third repair, including any cosmetic edits batched with it, gets ONE final review, once per loop: run the same `validate.ts --phase review --since <tree>` command as every round, and the driver runs the final review itself when the reviewer reports the ceiling. Never add `--final` to `validate.ts`; it refuses the option (exit 2), and a run that adds it loses a review. What it finds is a bug the receipt will not approve: BLOCK, and tell the user exactly what still fails. Without that final review, the last round's fixes, and the final review's own, would ship unreviewed. A repeated full review is a round, not a new loop: it never renews the allowance.

Test 3 is **also enforced by the script** (`MAX_ROUNDS` in `.agents/skills/review/code-review.ts`), which refuses round 4 with exit 5 — a ceiling stated only in prose is one a long loop runs straight past.

**Do not use the finding COUNT as a stopping signal.** Measured across a few hundred audits, rounds return ~1.2 must-fix findings whether they are round 3 or round 13. "It's still finding things" means the reviewer was asked again, nothing more. What moves is where the findings land: about a fifth re-open earlier ground at round 2, two fifths at round 3, three fifths by round 5, and it never improves after that. A loop run deep into that region ends up flagging its own previous round's fix as the next defect.

**When you stop at the ceiling with bugs still open**, nothing lands with a known bug. Say plainly in the trailer and the summary what still fails, each with its input and wrong result, and why the loop ended. Then ask the user once, as a numbered question:
- **More repairs:** their words, name and date go in `CODE_REVIEW_PAST_CEILING_BY`.
- **Land anyway:** the bugs ship, under the close's review override (`CLOSE_REVIEW_OVERRIDDEN_BY`, `.agents/skills/close/SKILL.md` § 1), and each becomes a `planned` row.
- **Leave it unlanded.**

Recommend by what fails, and never call landing the default. This is the only review question a build asks the user. Do not quietly continue.

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

`/implement` invokes this skill after mechanism-match and any initial UI QA. The validation driver stops on a deterministic check failure before any vendor call. After that is fixed, it prints PRE_TREE and the reviewer’s triage lines. Apply step 4 and use `--since` with that PRE_TREE when a fix round is needed. Once the receipt approves, record the trailer for the report.

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
| `STILL OPEN: <id>` | A blocker survived two repairs in a row | Change the approach for that piece, not the patch (step-4); say why in the report |
| A blocker you believe is not a bug | The reviewer invented an input, or missed the fallback | Pass `<id>: <evidence>` with `--rebuttal <file>` on the next round (step-4, **Check every blocker**) |
| A round returns findings about code the session never touched | Round 2+ was run as a full review instead of `--since` | Re-scope: rounds 2+ take `--since <the snapshot from before the previous round>`. A full re-review hands the reviewer settled code and it will find something in it |
| `--since` exits 4 immediately on round 2 | No source changed since the snapshot, and no `--rebuttal` was passed | Stop only when the receipt approves. An open blocker closes only by a round's verdict: fix it, or pass your evidence with `--rebuttal`. Check that fixes reached the reviewed worktree. |
| `WARN: shellcheck missing` / `WARN: check-secrets.ts missing` / `WARN: lint missing` | Tool not installed on this machine, or a repo that carries no `.agents/checks/` | Continue — env diff, not a finding. Install the tool locally if you want full coverage; the script does not block on it |
| `unparseable session-base: <SHA>` | `BASE_SHA` env var was empty, malformed, or referred to a commit not in this clone | Re-derive `BASE_SHA = HEAD~N` from `git log --oneline -n N` showing this session's commits; pass via `--session-base` |
| Round 1 produces only `speculative` findings | The agent is padding | The linter flags speculative-only as probable padding; re-emit as `Zero findings within reviewed scope` |
| Second invocation re-ran the review | Something the receipt covers changed (stderr of `status` names it), the owner differed (CODE_REVIEW_LOOP_ID not the audit owner's thread id), or the writer set differed | Read `status --repo` stderr; restore the owner or accept that changed content needs its review |
| `RECEIPT: not approved` on a clean review | A declared item was reported `unchecked`, a changed path was outside the reviewed range, or a follow-up round did not cover a path that moved since the last receipt | Read the `implement-audit:` lines above it; check the item, widen the range, or review `--since` the snapshot of the approved content |
| The close says `changed since the review` | Covered source, a dependency or a declaration moved | Use the same driver with `--since` the last completed review's PRE_TREE. Step 2 selects a proven upstream integration and its allowance automatically; do not request a cumulative full review for that merge. Otherwise use the remaining fix allowance or restore reviewed bytes. |
