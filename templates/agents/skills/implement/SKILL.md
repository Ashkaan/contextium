---
name: implement
description: The "do" verb of the loop — execute a SPEC with rigorous self-validation. Use ONLY in a fresh context after running /project in a prior session.
allowed-tools: "Bash(.agents/skills/implement/scripts/*:*) Bash(.agents/skills/close/scripts/*:*) Bash(git *:*) Bash(npm *:*) Bash(node *:*) Bash(npx *:*) Read Edit Write Task Skill"
metadata:
  peers: ".agents/skills/project/SKILL.md .agents/skills/implement-audit/SKILL.md .agents/skills/close/references/auto-close-gate.md .agents/skills/implement/scripts/setup-worktree.sh .agents/skills/close/scripts/write-root.sh .agents/skills/close/scripts/harness.sh .agents/hooks/check-shared-checkout-write.sh"
---

# /implement — Plan-Driven Executor

## Critical

- **Fresh-context boundary matters, and nothing enforces it.** A session that wrote the SPEC and invested in its choices defends them mid-stream instead of checking them, so open a new session (or `/clear`) before invoking — that is a judgment you make, not one the harness makes for you.
- **The worktree is mandatory.** Phase 0.5 sets `${WORKTREE_DIR}`; every edit MUST target absolute paths under it. The shared-checkout guard (`.agents/hooks/check-shared-checkout-write.sh`) refuses writes into the checkout other sessions share. Do NOT edit in the main repo. A row whose code is in ANOTHER repo (a product) adds a second worktree, of that repo, and every edit to its code and every check and review of it target that one — § "A row whose code is in another repo" below.
- **The check ORDER is a script, not a table.** Phase 4 calls `scripts/validate.ts`, which runs lint → tests → quality → review → re-lint-if-dirty in one fixed sequence. You do not choose the order and there is no argument that spells "review before lint". The table that used to live here put the code review at layer 4, ahead of E2E — so a clean review landed on a session that had run none, and `audit-dedupe.ts` then no-op'd the real review when it finally came.
- **E2E (Phase 4) is a hard gate, and it always runs.** Static checks + unit tests are never sufficient. Re-read the spec's E2E walk (tasks.md's test tasks) and execute every step against a running app before claiming complete — once after `--phase checks`, and again every time a later phase prints `NEED_E2E=1`. An unchanged review does not buy a skipped E2E.
- **If it is a UI, `/qa` runs fully (Phase 4.8).** `validate.ts --phase qa-list` says whether a web app changed; that is a lookup, not a judgment. Any target it prints gets a complete `/qa` — the installed impeccable, screenshots, sight-check, visual review — and `--require-qa` refuses the close until every target has a marker for the tree that is about to ship.
- **Mechanism-match (Phase 4.5) is a hard gate.** Before reporting done, write the one-line verification — agreed mechanism vs. what the diff did. If they don't match, fix the diff or surface the divergence; never paper over per "goal alignment"'s SHIP clause.
- **implement-audit (Phase 4.7) is a hard gate.** The built diff gets its ONE machine review via `/implement-audit` — the single code reviewer for the repo, the diff-side mirror of `/spec-audit`. Fix every ready finding in-session; proceed only on a clean pass. This writes the `implement-audit:` line the report carries.
- **Auto-close (Phase 6) is the loop tail.** On clean completion `/implement` invokes `/close` itself per `close/references/auto-close-gate.md` — the user does not type `/close`. It HALTS instead only on a deferral or a mechanism-match FAIL.
- **Golden Rule:** if validation fails, fix it before moving on. Never accumulate broken state.

Cole Medin's framework calls implementation the second leg of the PIV loop. **Validation loops catch mistakes early. Run checks after every change. Fix issues immediately.**

## Phase 0 — FRESH-SESSION GATE (hard requirement) (phase-0-fresh-session-gate)

The failure this guards against is the same session holding the SPEC, investing in its prior choices, then defending them mid-stream. Check the context this session already carries before starting: well past 200,000 tokens, or any session that wrote the SPEC itself, is the case to stop and start fresh.

It is advice, not a refusal. A turn count is a poor stand-in for context size (the same number of turns spans a 2x range of tokens), and a hard token ceiling blocks sessions that are fine; so the boundary stays a judgment, and turning it into a refusal is the user's decision rather than a maintenance one.

## Phase 0.5 — WORKTREE SETUP (phase-0.5-worktree-setup)

> **`/implement` is not the only thing that makes a worktree.** ANY session that
> writes to this repo gets its own worktree from `close/scripts/write-root.sh`,
> and the shared-checkout guard sends it there. What is specific to `/implement`
> is the NAME: this phase claims a readable `<slug>` worktree up front, before
> any edit, so the session's tree is named after the work.

Deterministic — owned by [`scripts/setup-worktree.sh`](scripts/setup-worktree.sh) (logic + slug-regex SSOT via `--validate-slug` / `--print-regex`). Run it first, from the repo:

```bash
bash .agents/skills/implement/scripts/setup-worktree.sh <slug>                        # plain
bash .agents/skills/implement/scripts/setup-worktree.sh --slug <slug> --shard <row>   # a named row
```

It prints `WORKTREE_DIR=<path>` (and `SLUG=` + `SHARD=` for the two-arg form); Phase 1+ uses absolute paths under `WORKTREE_DIR`. The script is idempotent: a resumed session re-runs it and gets the same tree. It records the worktree in this thread's ledger (`write-root.sh --adopt`), so `/close` lands it like any other; a worktree made any other way is one no close commits.

**Worktree naming**:
- A session that already has a worktree of this repo — the one its harness started it in (a T3 Code thread, `claude -w`, a Codex app thread), or one an earlier call made — builds there, and no second one is made.
- Otherwise single-arg `/implement <slug>` → a worktree named `<slug>` where the recorded harness keeps its own (`close/scripts/harness.sh`; `CLAUDE_WORKTREE_HOME` overrides the folder), on branch `worktree-<slug>` under Claude Code and `session/<slug>` elsewhere.
- Two-arg `/implement <slug> <row>` → the same, named `<slug>-<row>`. The script prints `SLUG=<slug>` + `SHARD=<row>` so Phase 1 resolves the spec without re-splitting the composite (composite is ambiguous when either part has hyphens). `<row>` is the ROADMAP.md row ID lowercased (`r4`); the flag keeps its old name, `--shard`.
- **Before any worktree exists**, `setup-worktree.sh` resolves the roadmap row in both forms and REFUSES — creating nothing — when the row does not exist (listing the IDs), when a bare `/implement <slug>` finds the project at any stage but `ready-to-implement`, or when the row's spec still carries a `NEEDS CLARIFICATION` marker (printing each one). Once the worktree exists it sets the row `in-progress` through `roadmap.ts --set`; a failed write only warns.

### A row whose code is in another repo

The spec, report and roadmap stay in this repo's worktree. When the spec says
the code lives in another repo — a product, named by its absolute path — that
repo gets a worktree of its own, and the build and its audit read IT:

- `PRODUCT_WT=$(bash .agents/skills/close/scripts/write-root.sh <its absolute path>)` —
  the worktree, recorded in this thread's ledger so `/close` lands it. Read its
  nearest `AGENTS.md` first. Every edit to the product's code targets an
  absolute path under `$PRODUCT_WT`; never its shared checkout, never a copy
  under this repo.
- `BASE_SHA=$(git -C "$PRODUCT_WT" merge-base HEAD origin/<its trunk>)`.
- Every `validate.ts` phase takes `--repo "$PRODUCT_WT"`, and its `--scope` is a
  pathspec relative to `$PRODUCT_WT` (a glob such as `src/**`);
  a project slug or `apps/<app>` names nothing there.
- Every `code-review.ts --snapshot` runs as
  `CODEX_REVIEW_REPO="$PRODUCT_WT" node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot`.
- `/implement-audit` takes the same `$PRODUCT_WT` (its own steps say where).

Without these, every command defaults to this repo's worktree, which holds only
the spec: the checks pass over nothing and the review reads the wrong diff,
and neither says so.

## Phase 1 — LOAD (phase-1-load)

The argument is a project slug, optionally followed by a roadmap row ID
(`/implement <slug> r4`), or a spec path.

**Which spec is a script result.** Ask the stage detector; do not glob the
folder yourself:

```bash
node --experimental-strip-types .agents/skills/project/scripts/detect-stage.ts projects/<domain>/<date>_<slug>
```

| Invocation | Spec to run |
|---|---|
| `/implement <slug>` | `active-spec:` from `detect-stage.ts`, whose `next-row:` names the row — the first ready row (in-progress before planned) whose spec is still owed work and carries no open `NEEDS CLARIFICATION`. A legacy loose `*.spec.md` still owed work wins over every row, as work already in flight. |
| `/implement <slug> r4` | Row `R4`, matched case-insensitively; its Sub-spec is column 4 of `node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder>`. No such row → HALT listing the IDs. `setup-worktree.sh` printed `SLUG=<slug>` + `SHARD=r4` — read those, never re-split the composite `<slug>-<shard>`. |
| A spec path | Use it directly. |
| Stage is not `ready-to-implement` | HALT: "`<slug>` is at stage `<stage>` — run `/project <slug>`" (`setup-worktree.sh` refuses the same case before creating anything). |
| No project matches the slug | HALT: "no project matches `<name>`" + list nearest slugs. |

**The clarification gate runs here, whoever made the worktree.** `setup-worktree.sh` refuses the same cases before creating anything, but nothing guarantees it ran — a harness may have made this session's worktree, and the spec may have changed since:

```bash
node --experimental-strip-types .agents/skills/close/scripts/open-clarifications.ts <project-folder>/specs/NNN-name   # exit 1 → HALT
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --set <ID> in-progress      # once it passes
```

Exit 1 prints each open `NEEDS CLARIFICATION` marker as `file:line: text`. HALT with those lines and `run /project <slug>` — a marker is a decision nobody made, and building past it is the misalignment the grill exists to prevent. The `in-progress` flip is informational: `/close` writes `done`, from the report. **`<project-folder>` for the flip is under `projects/` of this thread's worktree (`write-root.sh .`), never the shared workbench checkout:** a flip written there is a dirty file no close commits, and `land.ts` then refuses to fast-forward that checkout on every later close, so `detect-stage.ts` keeps reading a row as `in-progress` after its landing set it `done` — and routes the next `/implement` to work that already shipped.

`apps/{name}/SPEC.md` is read as context when the work targets an existing app, and is never the build spec.

**What to read.** A spec is a folder, `specs/NNN-name/`, written from spec-kit's
templates (`.agents/skills/spec/references/templates/`). Read it by SECTION
NAME; the rest of this skill uses these names:

| Name used below | In the spec folder | In a legacy `*.spec.md` |
|---|---|---|
| the verbatim ask | spec.md `**Input**` | § 0 |
| the interpretation + settled decisions | spec.md `## Clarifications` | § 0a |
| the simplest shape | plan.md `### Simplest shape` | § 0b |
| the behavior contract | spec.md `## User Scenarios & Testing`, `## Requirements` | § 1 |
| the boundary cases | spec.md `### Edge Cases` | § 4 |
| the acceptance commands | spec.md `### Acceptance` | § 5 |
| the E2E walk (hard gate) | tasks.md's test tasks | § 6 |
| the tasks | tasks.md's task lines | § 7 |
| the patterns to mirror | plan.md `### Patterns to follow` | § 8 |
| the inputs and data sourcing | plan.md `## Technical Context` → Inputs / Outputs, `### Data sourcing` | § 2 / § 2a / § 3 |
| the validation commands | plan.md `## Validation Commands` | § 11 |

The legacy column is the fallback for loose `*.spec.md` / `*.plan.md` files
from projects that predate the spec-folder layout, and nowhere else. A `.plan.md` older than the
13-section schema holds the same content under Summary, Patterns to Follow,
Files to Change, Boundary Cases, Tasks, Validation Commands, E2E Verification
and Acceptance Criteria.

If no spec resolves:
```
Error: no spec found for <argument>
Write one first: /project <slug>
```

## Phase 1.5 — DEPENDENCIES (phase-1.5-dependencies)

A fresh worktree has the repo's files and none of its installed dependencies:
`node_modules` and other install output are git-ignored, so they stay in the
checkout they were installed in. For each package the SPEC touches, install the
way that package says to — its README, or its lockfile (`npm ci` beside a
`package-lock.json`, and so on) — inside `${WORKTREE_DIR}`, before Phase 3.
Without it the first lint or typecheck fails on a missing module, which reads as
a defect in the change.

## Phase 2 — PREPARE (phase-2-prepare)

Phase 0.5 already created (or reused) the per-session worktree at `${WORKTREE_DIR}`. Verify:

```bash
git -C "${WORKTREE_DIR}" rev-parse --abbrev-ref HEAD
# Expected: the session's branch (worktree-${slug} / session/${slug} for a new one)

git -C "${WORKTREE_DIR}" status
# Expected: clean for a new worktree (fresh from origin/HEAD)
```

If the worktree is missing or on the wrong branch, abort with a pointer back to Phase 0.5 — do NOT create alternative branches in the main repo. Every session works in its own worktree on its own branch; a feature branch in the shared checkout is what the worktree exists to replace.

## Phase 3 — EXECUTE (phase-3-execute)

For each task in tasks.md (§ 7 in a legacy SPEC):

### 3.1 Verify Assumptions (this is the failure-class fix)

Before writing any code:
- **Read the target file** you're about to create or modify
- **Read adjacent files** — what it imports from, what imports it
- **Verify SPEC references** — do the functions, interfaces, KV keys, hosts, integrations the SPEC mentions actually exist? Match the SPEC's expectations?
- **If assumptions are wrong**, adapt before implementing. Document what differs from the SPEC in the §Deviations section of the report.

This step alone addresses today's "no guessing" failures.

### 3.1.5 Peer sweep — is this change a class?

Before implementing, ask whether the thing you are about to change exists
anywhere else. If it plausibly does, sweep for it FIRST and fix every match in
this session:

```bash
node --experimental-strip-types .agents/skills/implement/scripts/peer-sweep.ts \
  --pattern '<the pattern, not the file>' \
  --scope '<pathspec, widest you can justify>'
```

"A class fix is atomic" owns what counts as a peer and why an under-covering
sweep fails it. Operationally here: sweep the MECHANISM, not the file — siblings
live in directories you did not touch — and account for every one of the
`MATCHES: N` the script reports. A 48-match sweep read to match 12 is an unswept
sweep. `MATCHES: 0` is valid evidence; print it and proceed. If you suspect
siblings exist anyway, the pattern is too narrow — broaden and re-run.

When the sweep defines a population you fixed, declare it in `report.md` as
`class-sweep: <regex> -- <pathspec>` with the output of
`node --experimental-strip-types .agents/skills/review/find-peers.ts --verify-sweep '<regex>' -- <pathspec>`
exiting 0 (it prints each survivor and exits 1 otherwise); a survivor is your
fix, not a reviewer's. A peer first found by
`/implement-audit` in Phase 4.7 means this step under-covered — fix it here,
not there.

### 3.2 Implement

- Read the **MIRROR** file reference from the patterns to mirror (plan.md `### Patterns to follow`) and understand the pattern
- Make the change as specified in the SPEC
- **Check integration**: does your change connect correctly to adjacent code? Imports resolve? Callers/callees still work? Data flows correctly across boundaries?

### 3.3 Validate Immediately

After EVERY task:

```bash
# Layer 1 of Phase 4's ladder (don't skip): the package's own lint, then its
# typecheck — its `lint` / `typecheck` / `check` npm script or make target
printf '%s\n' <file> | node --experimental-strip-types .agents/skills/implement/scripts/layer-1.ts
```

If it fails: read error, fix, re-run, only proceed when passing.

### 3.4 Track Progress

```
Task 1: CREATE apps/<slug>/foo.ts ✅
Task 2: UPDATE apps/<slug>/worker.ts ✅
```

Document deviations as you go.

## Phase 4 — VALIDATE ALL (hard gate) (phase-4-validate-all)

**The order is `scripts/validate.ts`, and this file does not restate it.** Run:

```bash
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --phase checks --scope <arg>
```

That runs layer 1 (each touched package's lint, then its typecheck — halt on
fail, because type errors mask runtime errors), then layer 2 (each package's own
tests: its `test` script or make target, else its `*.test.ts` under
`node --test`), then layer 3 (the `.agents/checks/` land.ts runs, as a dry run
of the close's gates, advisory). A package that declares no lint or typecheck is
a WARN line, not a FAIL, and so is a code file that no package owns: nothing
lints it, and the line names it. `scripts/resolve-scope.ts` turns the
scope argument into the file list (blank → staged files; `apps/<name>` or a bare
name matching `apps/*` → that app; `integrations/<name>` → that integration;
`projects/<path>` → that project; anything else → glob expansion, a directory
listed as the files in it). For a row whose code is in another repo, add
`--repo "$PRODUCT_WT"` and give `--scope` relative to it (§ "A row whose code is
in another repo"), here and in every later phase.

A **table** of layers used to live here, and it was a suggestion. It listed the
code review as "layer 4", BEFORE the E2E row — so a review that came back clean
landed on a session that had walked no E2E at all, and `audit-dedupe.ts` then
no-op'd the real review when it finally came. A model reading a table decides
when to read it. A model calling a script does not decide anything: `validate.ts`
exposes phases, and no argument spells "review before lint". If this file ever
disagrees with the script about the order, the script is right and this file is
the bug.

`validate.ts` ends every phase with two machine fields:

| Field | Meaning |
|---|---|
| `NEED_FIX=1` | the reviewer left `[must-fix]` / `[should-fix]` open, or a layer failed. Fix, then re-enter the phase. |
| `NEED_E2E=1` | the tree moved, so the E2E walk has to be done again. `--phase checks` always prints this — the first E2E is unconditional. |
| `NEED_FALLBACK_REVIEW=1` | no independent reviewer answered (`code-review.ts` exit 3), and the phase exits 3: the review is **pending**, not passed. Run `.agents/agents/implement-audit-reviewer.md` in a fresh context on the same diff, save its output to a file as it is (its verdicts and its "Zero findings." line are read; so are triage lines with `NO_FINDINGS` — an empty file is a review that did not happen), and run `validate.ts --fallback-review <file>` — its exit 0 is the pass, its exit 1 the findings to fix. Record the line with `claude-fallback (fresh context, NOT independent)`. Weaker, not failed. |

The remaining phases, in the order the script enforces them: **E2E** (below) →
**phase-4.5** mechanism-match → **phase-4.7** `--phase review` → **phase-4.8**
`/qa` if the diff touched a UI → phase-5.

### Write tests

You MUST write tests for new code:
- Every new function gets at least one test
- Error cases and boundary cases get tests
- Update existing tests if behavior changed
- **Test across boundaries** — endpoint shape + service integration, not just isolated unit
- Observe RED first; the excerpt goes into `report.md` as its `test-failure-observed:` line

### REQUIRED: End-to-End Verification

> **⚠️ Do NOT proceed to Phase 4.5 until all E2E steps below pass.**

**This runs once here, unconditionally, and again on every later `NEED_E2E=1`.**
It does not wait for the review and it is not skipped when the review comes back
clean — a clean review says the code reads right, which is a different claim from
the thing working. `--phase checks` prints `NEED_E2E=1` on every run for exactly
this reason.

Re-read the E2E walk — tasks.md's test tasks (§ 6 in a legacy SPEC). Execute every one as a checklist:

- [ ] Start the application (worker, dev server, etc.)
- [ ] For EACH test task:
  - [ ] Execute the test exactly as described
  - [ ] Verify expected outcome matches the SPEC
  - [ ] If it fails: fix, re-run, confirm
- [ ] Confirm all E2E tests pass before proceeding

If the spec has no test tasks, perform a basic smoke test of the new behavior.

**This is a hard gate.** Static checks + unit tests alone are never sufficient.

## Phase 4.5 — MECHANISM-MATCH GATE (hard gate) (phase-4.5-mechanism-match)

> **⚠️ Do NOT proceed to Phase 5 until the mechanism-match line is written and passes.**

Phase 4 verifies the diff WORKS (tests pass, E2E succeeds, code review clean). Phase 4.5 verifies the diff is the **right mechanism** — the one the user agreed to in conversation, not a shortcut that solves the surface symptom another way. Enforces "goal alignment"'s SHIP clause.

Procedure:

1. Re-read the verbatim ask (spec.md `**Input**`) and the interpretation (`## Clarifications`) — § 0 and § 0a in a legacy SPEC.
2. Name the agreed mechanism in plain English in ONE sentence — use the user's own words where possible (e.g., "read the token from the secrets manager", "use a shared SSH function", "make it persistent across token rotation").
3. Run `git diff --stat HEAD` (or `git log --oneline ${BASE_SHA}..HEAD` for multi-commit work) to inspect what was actually shipped.
4. Write ONE verification line:
   - PASS: `Agreed to X. Diff does X.` → proceed to Phase 5.
   - FAIL: `Agreed to X. Diff does Y.` → halt. Surface the divergence. Either fix the diff to actually implement X, OR ask the user whether the divergence is acceptable. MUST NOT proceed to Phase 5 with a known mismatch.

Common drift patterns to watch for:

- User said "use the library" → I called the REST API directly because it was faster.
- User said "make it persistent" → I added a one-shot fix instead of a daemon / cron / scheduled task.
- User said "read it from the secrets manager" → I replaced the static token with another static token instead.
- User said "shared function" → I built a deployed service.

If the Input is paraphrased rather than verbatim, the front-gate already locked the mechanism in Clarifications — use that as the source of truth. If neither captures the mechanism cleanly, that itself is spec drift to surface before claiming done.

## Phase 4.7 — IMPLEMENT-AUDIT (hard gate) (phase-4.7-implement-audit)

> **⚠️ Do NOT proceed to Phase 5 until `/implement-audit` returns a clean pass.**

The code is built, validated, and mechanism-matched. Now it gets its ONE machine review — `/implement-audit`, the single code reviewer for the whole repo. This is the diff-side mirror of the SPEC-side `/spec-audit`: each artifact the loop produces gets exactly one machine reviewer, fired automatically by the producer.

Run it through the driver, so the snapshot, the mandatory automated checks and
the reviewer happen in that order and nothing is optional:

```bash
PRE=$(node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot)
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --phase review \
  --base "$BASE_SHA" --head HEAD --scope <arg>
# rounds 2+, after fixing:
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --phase review \
  --since "$PRE" --scope <arg>
```

For a row whose code is in another repo, the snapshot is
`CODEX_REVIEW_REPO="$PRODUCT_WT" … --snapshot`, both `validate.ts` calls add
`--repo "$PRODUCT_WT"`, and `BASE_SHA` is that repo's merge-base (§ "A row whose
code is in another repo").

`--phase review` snapshots, runs `run-automated-checks.ts` (**mandatory** — a
FAIL there stops the phase before a vendor call is spent), runs `code-review.ts`,
and parses its stdout. A `[must-fix]` or `[should-fix]` sets `NEED_FIX=1` and
exits 1; a `[nit]` does not — nits are held for one pass at the end of the loop,
never a reason to re-enter it. Exit 4 (converged) and exit 5 (the round-4
ceiling) are `NEED_FIX=0` with a note; exit 1 or 124 means the review did NOT
happen, which is not a clean pass and not a nit to hold. Exit 3 prints
`NEED_FALLBACK_REVIEW=1` and the phase exits 3, pending: no independent
reviewer answered, so run the implement-audit-reviewer agent in a fresh
context, save its output, and hand it to
`validate.ts --fallback-review <file>`, which passes or fails the phase on them
exactly as on a vendor's. Record it as
`claude-fallback (fresh context, NOT independent)` — a weaker review, never an
independent one. `--phase qa-revalidate` does the same. If the tree moved during
the round, layers 1+2 re-run and `NEED_E2E=1` sends you back to the E2E walk.

The reviewer now reads a **blast-radius pack** alongside the diff — who imports
each changed file, what it imports, and who calls each symbol the diff changed
(`.agents/skills/review/blast-radius.ts`). That is the whole-repo context
a hosted review bot sells, computed per review from this worktree. It fails open:
a missing packer costs the review its context and nothing else.

Dispatch `/implement-audit` via the Skill tool, scoped to this worktree's diff (`BASE_SHA..HEAD` plus any uncommitted changes). The skill:

1. Writes a once-per-session dedupe marker (`audit-dedupe.ts`) so a later standalone `/implement-audit` in the same session/worktree no-ops instead of re-reviewing. `/implement` audits exactly here, and a hand-typed `/implement-audit` afterwards re-emits that trailer rather than running a second review.
2. Runs its automated checks + reviews the diff via `.agents/skills/review/code-review.ts`, on **the vendor the `adversarial-review` policy row selects** (a different vendor from the author). The script walks that row's chain itself, so one vendor being down is not an outage; if the WHOLE chain is exhausted it exits 3 and the audit runs a fresh-context review instead, recorded as `claude-fallback (fresh context, NOT independent)` — completed, weaker, and never reported as independent.
3. Merges triaged findings and fixes every ready finding **in this session**, re-reviewing only the fixes each round and stopping when a round mostly re-opens ground an earlier round already touched — and in no case past round 4 —. It never asks the user whether to continue.
4. Emits the `implement-audit:` line, carrying the round number as a record rather than as a gated field.

Proceed to Phase 5 only on a clean audit pass. The `implement-audit:` line goes into `report.md` § Validation Results at Phase 5; nothing reads it off a commit — a trailer is a record, not a gate.

## Phase 4.8 — QA IF IT IS A UI (hard gate) (phase-4.8-qa-if-ui)

> **⚠️ `/close` does NOT run while `--require-qa` exits 1.**

Whether a UI changed is a **lookup**, not a judgment you make from the file
paths:

```bash
PRE_QA=$(node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot)
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --phase qa-list --base "$BASE_SHA"
```

For a row whose code is in another repo, every snapshot here and below takes
`CODEX_REVIEW_REPO="$PRODUCT_WT"` and every `validate.ts` call `--repo
"$PRODUCT_WT"` (§ "A row whose code is in another repo") — the UI that changed
is in that repo, and `qa-list` run against this one finds none.

**Pass `--base`.** Without it the enumerator reads `git diff HEAD` plus
untracked, which is blind to everything the session already COMMITTED — and
phase-4.7 reviews `BASE_SHA..HEAD` plus uncommitted. A session that committed its
UI change would get `skipped-not-web` for a diff that was all pixels.

`qa-targets.ts` walks up from each changed file to the nearest directory owning a
`package.json`, asks `detect-app.ts` what it is, and keeps the ones it calls web
(`astro-cf`, `astro`, `next`, `vite`, `static`, `node-server`). A change in a
shared package that is not itself web fans out to the web apps that import it, so
one edit to a shared component still sends both consumers through `/qa`. A
detector that CRASHES is a HALT, never "not web" — reading a failure as "no UI
here" is how a UI ships with no QA and a green run.

**Zero `QA_TARGETS` lines** → skip `/qa`, record `qa: skipped-not-web` in the
report, go to phase-5.

**One or more** → run `/qa --before <target>` on each, to COMPLETION. "Fully"
means all of it: `/qa`'s own `impeccable-detect.ts` against the live page and
its fixes, then screenshots, then the sight-check, then the fresh-context visual
review. That script runs the `impeccable` npm shim, which the script installs
if it is missing from PATH; there is no skill folder. Do not pin impeccable, do not
skip the detect step, and do not let the visual reviewer stand in for it. Then:

```bash
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --phase qa-revalidate --since "$PRE_QA"
POST_QA=$(node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot)
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --require-qa \
  --targets-file <the QA_TARGETS list> --tree "$POST_QA"
```

`/qa` fixes things, and those fixes are code nobody reviewed — `qa-revalidate`
re-runs layers 1+2 **over what `/qa` moved** (not over `--scope`: its edits are
routinely unstaged or untracked) and `code-review.ts --since` over them directly (not a second
`/implement-audit`, which `audit-dedupe.ts` would no-op into a clean-looking
audit over unreviewed bytes) and prints `NEED_E2E=1`. **One** qa-revalidate
round: still dirty, or still `NEED_FIX=1`, is a HALT. That round gets its own
round-4 budget — the implementation fix loop can have spent all four, and a
post-QA review that returns "ceiling reached" without calling a vendor would ship
`/qa`'s own source edits unreviewed behind a note.

`--require-qa` then checks that every target has a `/qa` marker keyed on the tree
that is about to ship. A marker is written only by `/qa` itself, only on full
completion — never by hand. Because the key is the tree, a later `/qa` that
edited source invalidates an earlier target's marker, and that target runs again.

## Phase 5 — REPORT (phase-5-report)

Write `report.md` INSIDE the spec folder, `specs/NNN-name/report.md`, with
`spec: NNN-name`. (For a legacy loose spec, `{spec-name}-report.md` beside it,
with `spec: {spec-name}`.)

**The frontmatter is not decoration — it is how every later reader knows whether this spec is finished.** `spec-status:` is `complete` only when nothing in the spec is still owed; anything else (a slice done, code done but not shipped, a task list half-run, a rejected approach) is `partial`. `close/scripts/spec-state.ts` reads it — for a folder, ONLY that folder's `report.md` frontmatter counts — and `/close`, `/project` and this skill's own spec resolution all read spec-state. Asking the filesystem "does `<name>-report.md` exist?" instead calls a SPEC finished the moment any report is filed under its exact name, and unstarted forever when the report is named for the slice it covered.

The report's format is [`references/templates/report.md`](references/templates/report.md). Fill it in, setting `spec-status:` and `**Status**` by the rule above — the template shows `complete`, which is right only when nothing in the spec is still owed.

**The roadmap row is not yours to finish.** Phase 0.5 set it `in-progress`;
`/close` sets it `done` once `spec-state.ts` reads your report as `complete`,
and re-derives the README's `next:`. Do not edit ROADMAP.md's Status here.

### The spec stays in place

The spec folder is a committed artifact — it does not move on completion. Git history records that `/implement` ran against it; the report sits inside it. `/close` commits both.

## Phase 6 — AUTO-CLOSE (phase-6-auto-close)

"Wrap" is no longer a verb the user types. On clean completion `/implement` auto-invokes `/close` itself per the shared SSOT [close/references/auto-close-gate.md](../close/references/auto-close-gate.md).

Print the completion summary first:

```markdown
## Implementation Complete

**Spec**: `{project-folder}/specs/NNN-name/` — row {ID} (stays in place)
**Branch**: `{branch-name}`
**Status**: ✅ Complete

### Validation
| Check | Result |
|---|---|
| Type check | ✅ |
| Lint | ✅ |
| Tests | ✅ ({N} new) |
| Quality | ✅ |
| implement-audit | ✅ ({rounds} round(s), all findings addressed) |
| E2E | ✅ ({N} steps) |
| Mechanism-match | ✅ |
| QA | ✅ ({N} targets) / skipped-not-web |

### Files Changed
- {N} files created
- {M} files updated
- {K} tests written

### Deviations
{Summary or "Implementation matched the SPEC."}

### Artifacts
- Report: `{project-folder}/specs/NNN-name/report.md` (legacy: `{name}-report.md` beside the spec)
- Spec: `{project-folder}/specs/NNN-name/` (in place)
```

Then the auto-close gate:

- **Precondition (all three must hold):** (i) no deferral question to the user is outstanding (a mechanism-match FAIL at phase-4.5 halts here and auto-close does NOT fire — the user must see it); (ii) phase-4.8 either found no web target or `validate.ts --require-qa` exited 0 — an incomplete `/qa` on a changed UI is a halt, not a note on the report; (iii) `node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate` returns `not-fired`.
- **Action when all three hold:** run `/close` per the gate. `/close` verifies, updates the project, journals, and lands every worktree this thread owns. The `implement-audit:` line is already in the report — see phase-5. The user does NOT type `/close`.
- `/close` runs its own internal gates unchanged. See the SSOT for the full halt-case table.

For PR-flow work (rare — most repo work goes direct-to-main), the user can run `gh pr create` after the close instead of the worktree merge.

## Examples

### Example 1: Fresh-context invocation (the golden path)

User opens a new session in the main checkout and types `/implement <slug>`. The context is fresh. Phase 0.5 runs `setup-worktree.sh <slug>`, which validates the slug, creates a worktree named `<slug>` where the harness keeps its worktrees, records it in the thread's ledger, and prints `WORKTREE_DIR=...`. Phase 1 asks `detect-stage.ts`, which names row R2 and `specs/002-sync/spec.md`; it reads spec.md, plan.md and tasks.md by section name. Phase 3 executes each task with Verify-Assumptions → Implement → Validate-Immediately. Phase 4 runs `validate.ts --phase checks`; E2E is exercised against the running surface because `NEED_E2E=1` always comes back from that phase. Phase 4.5 writes "Agreed to X. Diff does X." Phase 4.7 runs `--phase review` — the reviewer reads the diff plus a blast-radius pack — and comes back `NEED_FIX=0`. Phase 4.8 runs `--phase qa-list`; a toolchain-only change prints `QA_TARGETS=` with nothing after it, so `/qa` is skipped and the report records `skipped-not-web`. Phase 5 writes `specs/002-sync/report.md` with `spec-status: complete`; the close flips R2 to `done`. Done.

### Example 2: Long context

User types `/implement <slug>` in a session already carrying 260,000 tokens, most of it the conversation that wrote the SPEC. **Nothing blocks it.** Phase 0 is the judgment call described above: this `/implement` starts fresh work rather than continuing a thread, so the right move is to say so and have the user open a new session (or `/clear`) before Phase 0.5 creates anything.

### Example 3: A row whose spec is not settled

User types `/implement sync-engine r3`. Row R3's `specs/003-backfill/spec.md` still reads `FR-004 [NEEDS CLARIFICATION: keep or drop tombstoned rows?]`. `setup-worktree.sh` refuses before creating anything, printing that line; the answer is `/project sync-engine`, which settles the question and edits the marker out.

### Example 4: Parallel sessions on different rows of the same project

A close printed two blocks, `/implement sync-engine r4` and `/implement sync-engine r5` — both rows' dependencies are `done`. Session 1 runs r4: `setup-worktree.sh --slug sync-engine --shard r4` creates a worktree named `sync-engine-r4` on its own branch, prints `SLUG=sync-engine` + `SHARD=r4`, and flips R4 to `in-progress`. Session 2 runs r5 the same way in its own composite worktree. Sessions are isolated (disjoint dirs + branches); each `/close` lands its own branch and flips its own row to `done`.

## Troubleshooting

| Failure | Symptom | Fix |
|---|---|---|
| Worktree missing or wrong branch (Phase 2) | `git -C "${WORKTREE_DIR}" rev-parse --abbrev-ref HEAD` doesn't return the branch `setup-worktree.sh` made, or directory doesn't exist | Phase 0.5 didn't run cleanly. Re-run `bash .agents/skills/implement/scripts/setup-worktree.sh <slug>` from the repo (script is idempotent). Do NOT create alternative branches in the main repo. |
| `setup-worktree.sh` exits 1 "could not record … for the close" | This thread already has a different worktree of this repo | Build in that one: `bash .agents/skills/close/scripts/write-root.sh --existing .` names it. |
| No spec to run | `detect-stage.ts` says `needs-planning` or `all-specs-reported`, and `setup-worktree.sh` refused | Run `/project <slug>` — the row has no spec yet, or its spec has open clarifications, or nothing is ready. |
| `r99` refused | No such row in ROADMAP.md; the refusal lists the IDs | Re-run with an ID from the list. |
| Wrong spec picked | Several rows are ready and the bare slug took the first (in-progress before planned) | Name the row: `/implement <slug> <id>`. |
| Type check fails (Phase 3.3 / Phase 4) | `FAIL: layer-1 typecheck (<package>)` | Read the error, fix at the source, re-run. |
| Tests fail (Phase 4) | `FAIL: layer-2 <package>` | Fix implementation or the test; observe RED first; re-run until green. |
| Lint fails (Phase 3.3) | `FAIL: layer-1 lint (<package>)` | Use the package's own fixer if it has one (`npm run lint -- --fix`, `biome check --write`, …); then manual fixes for anything it left. Do NOT add to an exclude list. |
| `validate.ts` prints `NEED_FIX=1` | the reviewer left a `[must-fix]`/`[should-fix]` open, or a layer failed | Fix it, then re-enter the same phase with `--since $PRE_TREE`. Do not proceed on a non-zero exit; there is no "note it in the report" path. |
| `validate.ts` prints `NEED_E2E=1` | the tree moved after the layers ran | Re-walk the E2E before continuing. The bytes that were tested are not the bytes that ship. |
| `--phase qa-list` exits 2 | `detect-app.ts` crashed, or is missing | HALT. Run `detect-app.ts` on the target by hand and fix it. Never read a detector failure as "no UI changed" — that is the one path by which a UI ships unreviewed with a green run. |
| `--require-qa` exits 1 | a web target has no `/qa` marker for the tree about to ship | Run `/qa` on that target to completion. If it already ran, a LATER `/qa` moved the tree and invalidated this one's marker — run it again. Never `touch` a marker by hand. |
| E2E fails (Phase 4) | A test task against the running app does NOT match expected output | Diagnose; class-fix if it's a shared pattern; if the approach itself is wrong, revise the SPEC and re-run /implement. NEVER declare complete with E2E red. |
| SPEC reference doesn't exist (Phase 3.1) | A function, KV key, or path the SPEC names is missing | Document in §Deviations; check if the SPEC was based on stale state; if so, revise the SPEC and re-run. |
| Phase 4.5 mismatch | "Agreed to X. Diff does Y." | Either fix the diff to actually implement X, OR ask the user whether the divergence is acceptable. MUST NOT proceed to Phase 5 with a known mismatch. |
