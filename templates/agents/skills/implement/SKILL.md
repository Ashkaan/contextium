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
- **The check ORDER is a script, not a table.** Phase 4 calls `scripts/validate.ts`, which runs lint → tests → quality → review → re-lint-if-dirty in one fixed sequence. You do not choose the order and there is no argument that spells "review before lint". The table that used to live here put the code review at layer 4, ahead of E2E — so a clean review landed on a session that had run none, and the old session-only audit marker then no-op'd the real review when it finally came (a review receipt is now reused only for the content it covered).
- **E2E (Phase 4) is a hard gate, and it always runs.** Static checks + unit tests are never sufficient. Re-read the spec's E2E walk (tasks.md's test tasks) and execute every step against a running app before claiming complete — once after `--phase checks`, and again every time a later phase prints `NEED_E2E=1`. An unchanged review does not buy a skipped E2E.
- **If it is a UI, `/qa` runs fully before the first code review (Phase 4.6).** `validate.ts --phase qa-list` says whether a web app changed; that is a lookup, not a judgment. Any target it prints gets a complete `/qa` — the installed impeccable, screenshots, sight-check, visual review — and `--require-qa` refuses the close until every target has a marker for the tree that is about to ship.
- **Mechanism-match (Phase 4.5) is a hard gate.** Before reporting done, write the one-line verification — agreed mechanism vs. what the diff did. If they don't match, fix the diff or surface the divergence; never paper over it.
- **implement-audit (Phase 4.7) is a hard gate.** The built diff gets its ONE machine review via `/implement-audit` — the single code reviewer for the repo, the diff-side mirror of `/spec-audit`. Fix every blocking finding inside this row (phase-4.7 § findings-stay-in-row) and handle cosmetic suggestions by the audit skill's nit rule. This writes the `implement-audit:` line the report carries.
- **Auto-close (Phase 6) is the loop tail.** On clean completion `/implement` invokes `/close` itself per `close/references/auto-close-gate.md` — the user does not type `/close`. It HALTS instead only on a deferral or a mechanism-match FAIL.
- **Golden Rule:** if validation fails, fix it before moving on. Never accumulate broken state.

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

It prints `WORKTREE_DIR=<path>` (and `SLUG=` + `SHARD=` for the two-arg form); Phase 1+ uses absolute paths under `WORKTREE_DIR`. The script is idempotent: a resumed session re-runs it and gets the same tree. In a T3 Code thread (or any session already standing in a linked worktree of its own) it reuses that worktree rather than making another. It records the worktree in this thread's ledger (`write-root.sh --adopt`), so `/close` lands it like any other; a worktree made any other way is one no close commits.

The session's cwd may stay in the original checkout, so every `validate.ts` call below names the worktree as `--repo "$WORKTREE_DIR"`, and every `code-review.ts --snapshot` as `CODEX_REVIEW_REPO="$WORKTREE_DIR"`: left to their defaults, both read `CLAUDE_PROJECT_DIR` or the cwd's repo, which may be the original checkout, and a check run there finds nothing changed and passes.

**Worktree naming**:
- A session that already has a worktree of this repo — the one its harness started it in (a T3 Code thread, `claude -w`, a Codex app thread), or one an earlier call made — builds there, and no second one is made.
- Otherwise single-arg `/implement <slug>` → a worktree named `<slug>` where the recorded harness keeps its own (`close/scripts/harness.sh`; `CLAUDE_WORKTREE_HOME` overrides the folder), on branch `worktree-<slug>` under Claude Code and `session/<slug>` elsewhere.
- Two-arg `/implement <slug> <row>` → the same, named `<slug>-<row>`. The script prints `SLUG=<slug>` + `SHARD=<row>` so Phase 1 resolves the spec without re-splitting the composite (composite is ambiguous when either part has hyphens). `<row>` is the ROADMAP.md row ID lowercased (`r4`); the flag keeps its old name, `--shard`. A project with no ROADMAP.md, or a `<row>` it does not have, is refused before anything is created.
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
- Every `validate.ts` phase takes `--repo "$PRODUCT_WT"` in place of `"$WORKTREE_DIR"`, and its `--scope` is a
  pathspec relative to `$PRODUCT_WT` (a glob such as `src/**`);
  a project slug or `apps/<app>` names nothing there.
- Every `code-review.ts --snapshot` runs, in place of the `$WORKTREE_DIR` form, as
  `CODE_REVIEW_LOOP_ID="<audit-owner thread id>" CODEX_REVIEW_REPO="$PRODUCT_WT" node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot`.
- `/implement-audit` takes the same `$PRODUCT_WT` (its own steps say where).
- Each repo the row changes gets its own review-coverage declaration (phase-5
  says what one holds), written before that repo's first review: `report.md`
  for this repo, and `report-<product repo name>.md` beside it in the spec
  folder for the product, its block's paths relative to `$PRODUCT_WT`. One
  block cannot serve both, because its paths resolve in the repo under
  review. Every review of a repo — the audit, `qa-revalidate`, any later
  round — passes that repo's file as `--report`, never the other's. A
  recorded run kept in this repo's `evidence/` is named from the product's
  file with `"repo": "$WORKTREE_DIR"`, on a claim's `negativeTest` as on a
  dependency. `--phase report` still reads `report.md`.

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
| `/implement <slug>` | `active-spec:` from `detect-stage.ts`, whose `next-row:` names the row — the first ready row (in-progress before planned) whose spec is still owed work and carries no open `NEEDS CLARIFICATION`. |
| `/implement <slug> r4` | Row `R4`, matched case-insensitively; its Sub-spec is column 4 of `node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder>`. No such row → HALT listing the IDs. When `setup-worktree.sh` made the worktree, it printed `SLUG=<slug>` + `SHARD=r4` — read those, never re-split the composite `<slug>-<shard>`. |
| A spec path | Use it directly. |
| Stage is not `ready-to-implement` | HALT: "`<slug>` is at stage `<stage>` — run `/project <slug>`" (`setup-worktree.sh` refuses the same case before creating anything). |
| No project matches the slug | HALT: "no project matches `<name>`" + list nearest slugs. |

**The clarification gate runs here, whoever made the worktree.** `setup-worktree.sh` refuses the same cases before creating anything, but nothing guarantees it ran — a harness may have made this session's worktree, and the spec may have changed since:

```bash
node --experimental-strip-types .agents/skills/close/scripts/open-clarifications.ts <project-folder>/specs/NNN-name   # exit 1 → HALT
node --experimental-strip-types .agents/skills/close/scripts/rows-taken.ts <project-folder>                          # a line for <ID> → HALT
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --set <ID> in-progress      # once both pass
```

A `rows-taken.ts` line whose first field is this row's ID (`<ID>\t<title>\t<thread id>\t<worktree>`) means another open T3 thread is already building it. HALT before the flip, one line per holder: `BLOCKED: <ID> is being built in thread "<title>" (<worktree>) — settle that thread if it is finished` — the words `setup-worktree.sh` refuses a named row with. The `in-progress` mark lives only in each thread's own worktree, so without this check two threads build the same row and learn it only when their landings conflict.

Exit 1 prints each open `NEEDS CLARIFICATION` marker as `file:line: text`. HALT with those lines and `run /project <slug>` — a marker is a decision nobody made, and building past it is the misalignment the grill exists to prevent. The `in-progress` flip is informational: `/close` writes `done`, from the report. **`<project-folder>` for the flip is under `projects/` of this thread's worktree (`write-root.sh .`), never the shared workbench checkout:** a flip written there is a dirty file no close commits, and `land.ts` then refuses to fast-forward that checkout on every later close, so `detect-stage.ts` keeps reading a row as `in-progress` after its landing set it `done` — and routes the next `/implement` to work that already shipped.

`apps/{name}/SPEC.md` is read as context when the work targets an existing app, and is never the build spec.

**What to read.** A spec is a folder, `specs/NNN-name/`, written from spec-kit's
templates (`.agents/skills/spec/references/templates/`). Read it by SECTION
NAME; the rest of this skill uses these names:

| Name used below | In the spec folder |
|---|---|
| the verbatim ask | spec.md `**Input**` |
| the interpretation + settled decisions | spec.md `## Clarifications` |
| the simplest shape | plan.md `### Simplest shape` |
| the behavior contract | spec.md `## User Scenarios & Testing`, `## Requirements` |
| the boundary cases | spec.md `### Edge Cases` |
| the supported inputs | spec.md `### Supported inputs` |
| the acceptance commands | spec.md `### Acceptance` |
| the E2E walk (hard gate) | tasks.md's test tasks |
| the tasks | tasks.md's task lines |
| the patterns to mirror | plan.md `### Patterns to follow` |
| the inputs and data sourcing | plan.md `## Technical Context` → Inputs / Outputs, `### Data sourcing` |
| the validation commands | plan.md `## Validation Commands` |

A loose `*.spec.md` or `*.plan.md` is not a spec this skill runs: that layout
is retired, and nothing here reads it.

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

For each task in tasks.md:

### 3.1 Verify Assumptions (this is the failure-class fix)

Before writing any code:
- **Read the target file** you're about to create or modify
- **Read adjacent files** — what it imports from, what imports it
- **Verify SPEC references** — do the functions, interfaces, KV keys, hosts, integrations the SPEC mentions actually exist? Match the SPEC's expectations?
- **If assumptions are wrong**, adapt before implementing. Document what differs from the SPEC in the §Deviations section of the report.

This step is root `AGENTS.md` § Standards, **Read before asserting**, applied before each edit.

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
- Write the supported inputs' tests first and see them fail (Phase 4 § Write tests)
- Make the change as specified in the SPEC
- **Check integration**: does your change connect correctly to adjacent code? Imports resolve? Callers/callees still work? Data flows correctly across boundaries?

### 3.3 Validate Immediately

After EVERY task:

```bash
# Layer 1 of Phase 4's ladder (don't skip): the package's own lint, then its
# typecheck — its `lint` / `typecheck` / `check` npm script or make target.
# Its stdin is NUL-separated paths, as validate.ts writes them.
printf '%s\0' <file> | node --experimental-strip-types .agents/skills/implement/scripts/layer-1.ts
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
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$WORKTREE_DIR" --phase checks --scope <arg>
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

If this file ever disagrees with the script about the order, the script is
right and this file is the bug (§ Critical says why the order is a script).

`validate.ts` ends every phase with two machine fields:

| Field | Meaning |
|---|---|
| `NEED_FIX=1` | the reviewer left `[must-fix]` / `[should-fix]` open, or a layer failed. Fix, then re-enter the phase. |
| `NEED_E2E=1` | the tree moved, so the E2E walk has to be done again. `--phase checks` always prints this — the first E2E is unconditional. |
| `NEED_FALLBACK_REVIEW=1` | no independent reviewer answered (`code-review.ts` exit 3), and the phase exits 3: the review is **pending**, not passed. Run `.agents/agents/implement-audit-reviewer.md` in a fresh context on the same diff, save its output to a file as it is (its verdicts and its "Zero findings." line are read; so are triage lines with `NO_FINDINGS` — an empty file is a review that did not happen), and run `validate.ts --fallback-review <file>` — its exit 0 is the pass, its exit 1 the findings to fix. Record the line with `claude-fallback (fresh context, NOT independent)`. Weaker, not failed. |

The remaining phases: **E2E** (below) → **phase-4.5** mechanism-match →
**phase-4.6** `/qa` if the diff touched a UI → **phase-4.7** `/implement-audit` →
**phase-4.8** confirm QA still covers the final tree → phase-5.

### Write tests

You MUST write tests for new code:
- **The supported inputs come first.** Each example under spec.md `### Supported inputs` becomes a test with that example as its fixture, and its expected result as the assertion, written and run before the code that handles it (Phase 3.2), so its first run is the red one. The fallback for anything else gets a test too; a `Not covered:` item gets none.
- Every new function gets at least one test
- Error cases and boundary cases get tests
- Update existing tests if behavior changed
- **Test across boundaries** — endpoint shape + service integration, not just isolated unit
- Observe RED first; the excerpt goes into `report.md` as its `test-failure-observed:` line, and Phase 5's `validate.ts --phase report` refuses the run when a test changed and the line is missing or `none`

### REQUIRED: End-to-End Verification

> **⚠️ Do NOT proceed to Phase 4.5 until all E2E steps below pass.**

**This runs once here, unconditionally, and again on every later `NEED_E2E=1`.**
It does not wait for the review and it is not skipped when the review comes back
clean — a clean review says the code reads right, which is a different claim from
the thing working. `--phase checks` prints `NEED_E2E=1` on every run for exactly
this reason.

Re-read the E2E walk — tasks.md's test tasks. Execute every one as a checklist:

- [ ] Start the application (worker, dev server, etc.)
- [ ] For EACH test task:
  - [ ] Execute the test exactly as described
  - [ ] Verify expected outcome matches the SPEC
  - [ ] If it fails: fix, re-run, confirm
- [ ] Confirm all E2E tests pass before proceeding

If the spec has no test tasks, perform a basic smoke test of the new behavior.

#### Checks only the deployed thing can answer

A walk step that needs the change deployed — the live page, a deployed Worker
or task, a screen judged by eye — cannot pass before the push. When the work
touches a deployed surface, its spec's `tasks.md` declares those steps in a
`live-checks` block (the form is in `.agents/skills/spec/references/templates/tasks.md`
§ Live checks); add the block when the spec lacks one. The close then owes
them: it holds after the deploy, runs each command check itself on
`--release`, and takes each evidence check from a recorded capture
(`.agents/skills/close/SKILL.md` § Hold for the live checks).

A task or success criterion that waits on the user's acceptance ("show them the stills and take their acceptance before deploy") is done as "verify it is good" unless their own words asked for the stop — in spec.md `**Input**`, or quoted in a `## Clarifications` row (§ 0 / § 0a in a single-file SPEC): full `/qa`, a fresh-context sighted review, every finding fixed, then ship. A stop the user never asked for leaves finished work waiting on an answer they already gave: make sure it is good.

#### Run it now, don't wait for the schedule

A verification step that says "the morning after", "the next nightly run" or
"after the next scheduled run" is a wait, and a wait ends the session with the
thing unproven. Before accepting one, read the task's timing and effects. When
triggering it now is equivalent to the scheduled run, trigger it now (through
the scheduler's own on-demand trigger, on the project that owns the task) and
verify against that run. Wait only for what a run cannot produce on demand:

- data that does not exist yet (a day's readings, a vendor's next export);
- elapsed time itself (a staleness window, a billing period, a TTL);
- an effect keyed to the date it runs — an early run of a daily revenue sync
  would book the wrong day.

The user would rather see the run now than be told to come back tomorrow.

What remains on that list never holds the close, and is never a live check.
Prove the changed behavior now with what can be run — a test, a replay of real
inputs, a triggered run — land it, and set the outside event as a dated watch
row in the project's `ROADMAP.md` (`blocked: <YYYY-MM-DD> <what to look for>`),
which rides the close. Its report says that part is not yet seen. A live check
is only what the deployed thing answers when asked: a build held for incoming
traffic or a market forecast is a build that never lands.

**This is a hard gate.** Static checks + unit tests alone are never sufficient.

## Phase 4.5 — MECHANISM-MATCH GATE (hard gate) (phase-4.5-mechanism-match)

> **⚠️ Do NOT proceed to Phase 5 until the mechanism-match line is written and passes.**

Phase 4 verifies the diff WORKS (tests pass, E2E succeeds, code review clean). Phase 4.5 verifies the diff is the **right mechanism** — the one the user agreed to in conversation, not a shortcut that solves the surface symptom another way. The agreement it checks against is the spec's `**Input**` and `## Clarifications`.

Procedure:

1. Re-read the verbatim ask (spec.md `**Input**`) and the interpretation (`## Clarifications`).
2. Name the agreed mechanism in plain English in ONE sentence — use the user's own words where possible (e.g., "read the token from the secrets manager", "use a shared SSH function", "make it persistent across token rotation").
3. Run `git diff --stat HEAD` (or `git log --oneline ${BASE_SHA}..HEAD` for multi-commit work) to inspect what was actually shipped.
4. Write ONE verification line:
   - PASS: `Agreed to X. Diff does X.` → proceed to Phase 5.
   - FAIL: `Agreed to X. Diff does Y.` → halt. Surface the divergence. Either fix the diff to actually implement X, OR ask the user, as a numbered list in the reply, recommendation first, whether the divergence is acceptable. MUST NOT proceed to Phase 5 with a known mismatch.

Common drift patterns to watch for:

- User said "use the library" → I called the REST API directly because it was faster.
- User said "make it persistent" → I added a one-shot fix instead of a daemon / cron / scheduled task.
- User said "read it from the secrets manager" → I replaced the static token with another static token instead.
- User said "shared function" → I built a deployed service.

If the Input is paraphrased rather than verbatim, the front-gate already locked the mechanism in Clarifications — use that as the source of truth. If neither captures the mechanism cleanly, that itself is spec drift to surface before claiming done.

## Phase 4.6 — QA IF IT IS A UI (hard gate) (phase-4.6-qa-if-ui)

> **⚠️ `/close` does NOT run while `--require-qa` exits 1.**

Write the review-coverage block and save its evidence before QA. Phase 5
defines what it holds. The final QA snapshot includes those records.

Whether a UI changed is a **lookup**, not a judgment you make from the file
paths:

```bash
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$WORKTREE_DIR" --phase qa-list --base "$BASE_SHA"
```

For a row whose code is in another repo, every snapshot in the QA phases takes
`CODEX_REVIEW_REPO="$PRODUCT_WT"` and every `validate.ts` call `--repo
"$PRODUCT_WT"` (§ "A row whose code is in another repo") — the UI that changed
is in that repo, and `qa-list` run against this one finds none.

**Pass `--base`.** Without it the enumerator reads `git diff HEAD` plus
untracked, which is blind to everything the session already COMMITTED — and
phase-4.7 reviews `BASE_SHA..HEAD` plus uncommitted. A session that committed its
UI change would get `skipped-not-web` for a diff that was all pixels.

`qa-targets.ts` walks up from each changed file to the nearest directory owning a
`package.json`, asks `detect-app.ts` what it is, and keeps the ones it calls web
(`astro-cf`, `astro`, `next`, `vite`, `static`, `node-server`). A change outside
any web app — a shared component, or a document a page imports — fans out to the
web apps that import it, so one edit to a shared component still sends both
consumers through `/qa`. A
detector that CRASHES is a HALT, never "not web" — reading a failure as "no UI
here" is how a UI ships with no QA and a green run.

**No nonempty `QA_TARGETS` values** → skip `/qa`, record `qa: skipped-not-web` in the
report, go to phase-4.7.

**One or more** → run `/qa --before <target>` on each, to COMPLETION. "Fully"
means all of it: `/qa`'s own `impeccable-detect.ts` against the live page and
its fixes, then screenshots, then the sight-check, then the fresh-context visual
review. That script runs the `impeccable` npm shim, which the script installs
if it is missing from PATH and upgrades when a newer version is published; there is no skill folder. Do not pin impeccable, do not
skip the detect step, and do not let the visual reviewer stand in for it.

If QA edits source, rerun `--phase checks`, walk the E2E steps, check
mechanism-match, and update the review-coverage evidence before QA takes its
final snapshot. Proceed to phase-4.7 on the tree QA marked.

## Phase 4.7 — IMPLEMENT-AUDIT (hard gate) (phase-4.7-implement-audit)

> **⚠️ Do NOT proceed to Phase 5 until `/implement-audit` returns a clean pass.**

The code is built, validated, and mechanism-matched. Now it gets its ONE machine review — `/implement-audit`, the single code reviewer for the whole repo. This is the diff-side mirror of the SPEC-side `/spec-audit`: each artifact the loop produces gets exactly one machine reviewer, fired automatically by the producer.

Use the review-coverage block prepared in phase-4.6. Invoke /implement-audit once, passing this worktree, BASE_SHA, scope, that report's path and verified original authors (.agents/skills/review/SKILL.md § Where things are found). That skill owns the review driver, snapshots, fix rounds and trailer. Do not also call validate.ts --phase review here: doing both spends two reviews on the same work.

For a product worktree, pass PRODUCT_WT and its merge-base as described above. Include authors of any QA fixes in the writer set and preserve all authors through fixes. The audit runs deterministic checks before each vendor call, reviews only fixes after round 1, and sends NEED_E2E=1 back to the E2E walk. Fix every blocking finding in this session.

When no independent vendor can answer (most installs have one model CLI), the review driver exits 3 with `NEED_FALLBACK_REVIEW=1`: the review is pending, not passed. `/implement-audit` § step-2 runs the implement-audit-reviewer agent in a fresh context and records its reply with `validate.ts --fallback-review <file>`, as `claude-fallback (fresh context, NOT independent)` — a weaker review the receipt and the report both say is not independent. `--phase qa-revalidate` does the same for /qa's edits.

Proceed to Phase 4.8 only on a clean audit pass. The `implement-audit:` line goes into `report.md` § Validation Results at Phase 5; nothing reads it off a commit — a trailer is a record, not a gate.

### Every finding is fixed inside this row (findings-stay-in-row)

This is the one statement of where a finding goes; `/implement-audit` and `/qa`
point here. A row is an outcome the user would notice
(`.agents/skills/project/SKILL.md` § think-step-3.6-row-split), and what its review and
its QA find is part of building it. Every valid finding within the row's
outcome that describes a defect — must-fix, should-fix, P0 to P3 — is fixed in
this row before it lands. For cosmetic review suggestions, follow
`.agents/skills/implement-audit/SKILL.md` step 4. A row named for findings ("fixes from
R4's QA", "R23: deck fixes at projector and tablet sizes (from R17's QA)") is
never created: a dependency sweep planned as nine rows grew to 25 that way, each follow-up paying for its own plan, plan review, build and
review rounds. A reviewer's `IDEA:` line is not a finding: it is something the
spec did not ask for, and it goes to Phase 5 § Not built, never into this
row's fixes. A `DISPROVED:` blocker is settled, and is recorded there too. The
cases:

- **Zero, one, or many defects of mixed severity**: all are fixed and
  re-validated before Phase 5; severity orders the work, it never schedules any
  of it for later.
- **A finding outside the row's outcome** (a page or app this row did not
  touch), which is what the driver's `NOTED:` lines are: it is a new outcome.
  File it in the project that owns that page, as a
  row named for what the user would notice and passing the row-split test, or
  fix it here when that is smaller than filing it; ask the user only when no project owns
  it. It is never a "fixes from Rn" row in this project. Its § Not built line
  says which.
- **A fix too large for this row** (a redesign): it becomes a row of its own
  only when it is a new outcome the user would notice, named as that outcome.
  Otherwise it is this row's work, and the row is not done until it is.
- **A finding in a file another open row owns**: this row does not land until
  the fix is made and validated — here, or by the owning thread after you
  coordinate with it — and the report's Deviations says which, naming the
  commit or thread.
- **A fix blocked on someone else** (a vendor's patch, a third party's reply):
  first look for a fix this row can make itself — a workaround, a version pin,
  a patch carried in the repo, another library. That is a technical call, and
  usually the answer. When none exists, this row is the one that waits: its
  code does not land while the finding is open, because the review receipt
  cannot approve it and `land.ts` refuses unapproved content whatever the row
  says. The close holds, and the reply says what the fix waits on and the date
  it is expected, when one is known. Never move the fix to a new row, never
  invent a date.

Phase 5's "narrow the spec" route moves spec scope that was never built; it
never carries a finding.

## Phase 4.8 — CONFIRM QA COVERS THE FINAL TREE (phase-4.8-final-qa)

Rerun the phase-4.6 target lookup on the audited tree. If it lists UI targets,
save the nonempty target paths without their `QA_TARGETS=` prefixes, one per
line, and check their markers:

```bash
AUDITED_TREE=$(CODE_REVIEW_LOOP_ID="<audit-owner thread id>" CODEX_REVIEW_REPO="$WORKTREE_DIR" node --experimental-strip-types .agents/skills/review/code-review.ts --snapshot)
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$WORKTREE_DIR" --require-qa \
  --targets-file <the QA_TARGETS list> --tree "$AUDITED_TREE"
```

If a target has no marker for that tree, run its QA again. If that QA edits
source, run `validate.ts --phase qa-revalidate --since "$AUDITED_TREE"` with
the same repo and coverage report as the audit. Add any writers of the new QA
fixes to the author set. Follow its fix and E2E results, then repeat this phase
on the resulting tree.
A marker is written only by `/qa` itself at full completion. If a later edit
invalidates another target's marker, that target runs again.

## Phase 5 — REPORT (phase-5-report)

Write `report.md` INSIDE the spec folder, `specs/NNN-name/report.md`, with
`spec: NNN-name`.

**The frontmatter is not decoration — it is how every later reader knows whether this spec is finished.** `spec-status:` is `complete` only when nothing in the spec is still owed; anything else (a slice done, code done but not shipped, a task list half-run, a rejected approach) is `partial`. `close/scripts/spec-state.ts` reads it — for a folder, ONLY that folder's `report.md` frontmatter counts — and `/close`, `/project` and this skill's own spec resolution all read spec-state. Asking the filesystem "does `<name>-report.md` exist?" instead calls a SPEC finished the moment any report is filed under its exact name, and unstarted forever when the report is named for the slice it covered.

**The review-coverage block is written in phase-4.6.** The
report's one `<!-- review-coverage:v1 -->` … `<!-- /review-coverage -->` block
declares what the independent review must check: the entry points that reach
the changed code, the unchanged files whose assumptions it relies on (callers,
every `AGENTS.md` at or above each changed path — the root included — and the
instructions and contracts it honors), and each important claim with the concrete input that makes it
fail, the failure expected and the recorded run that shows it. Write it from
the behavior contract, the applicable instructions, `.agents/skills/review/find-peers.ts`
and the blast-radius pack; those are discovery aids, not proof it is complete.
The review receipt hashes those exact bytes, so later report prose is free and
an edit inside the block needs a new review. The template shows the shape;
`.agents/skills/implement-audit/scripts/audit-dedupe.ts` validates it.

The report's format is [`references/templates/report.md`](references/templates/report.md). Fill it in, setting `spec-status:` and `**Status**` by the rule above — the template shows `complete`, which is right only when nothing in the spec is still owed.

Then check that every test the work added or changed was seen failing:

```bash
node --experimental-strip-types .agents/skills/implement/scripts/validate.ts --repo "$WORKTREE_DIR" --phase report \
  --base "$BASE_SHA" --report "$WORKTREE_DIR/<project-folder>/specs/NNN-name/report.md"
```

The report path is absolute because the report is in this worktree whatever
`--repo` names. For a row whose code is in another repo, `--repo "$PRODUCT_WT"`
replaces `"$WORKTREE_DIR"` and `BASE_SHA` is that repo's; the report path stays
(§ "A row whose code is in another repo").

Exit 1 prints `FAIL: red-first <path>` for each test file changed since the base
while the report's `test-failure-observed:` line is missing, empty, `none` or
the template's placeholder. Go back and see each one fail: break the code or the
fixture on purpose, run the named test, check the failure names the thing the
test claims, restore it, put that failure's excerpt on the line, and re-run. A
test or fixture moved, renamed or trimmed without changing what any test expects
gets `not-applicable — <why>`; a fixture that changes an expected result needs
the excerpt. Never write the line without having seen the failure.

**The roadmap row is not yours to finish.** Phase 0.5 set it `in-progress`;
`/close` sets it `done` once `spec-state.ts` reads your report as `complete`
(a spec with live checks: once its `--release` has proved them), and
re-derives the README's `next:`. A `partial` report does not land: the
close refuses a half-built piece (`.agents/skills/close/references/auto-close-gate.md`
precondition (iii)). Finish the spec; or narrow it — move spec scope that was
not built (never a review or QA finding: § findings-stay-in-row)
out of spec.md and tasks.md into a new `planned` row's Intent (Sub-spec `—`
passes the close; what Intent holds is the ROADMAP template's rule,
`.agents/skills/project/references/templates/ROADMAP.md`), re-run `/spec-audit` on the narrowed folder, and only then
write the report `complete`; or, when the approach is dropped, set the row
`closed: <why>`. Do not edit ROADMAP.md's Status otherwise.

### Not built, and the improvements row

Nothing a review raised is lost. The review driver
prints three kinds of line that this build does not act on in code; collect
every one from every review round, the audit's and any later one's, and write
`report.md`'s `## Not built` section, one short line each, `None.` when there
are none:

```markdown
## Not built

- IDEA (review round 2): <the line as printed>
- NOTED (review round 1): <the line> — filed as <slug> R<n> | fixed here
- DISPROVED Fa1b2c3 (review round 1): <the finding> — <the evidence, a few words>
```

Write each as what was found, never as a step waiting on the user: the close
refuses a report line worded that way (precondition (iii)).

**The improvements row.** When the section holds an `IDEA` line, add ONE
`planned` row to this project's `ROADMAP.md`, unless this row is itself an
improvements row. Whether it is one is a lookup — its Sub-feature starts
`Improvements found building R`:

```bash
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> | awk -F'\t' '$1=="<ID>"{print $5}'
```

The row, with `<n>` the highest numeric ID plus one and `R<k>` this row:

```markdown
| R<n> | Improvements found building R<k> | Build what R<k>'s reviews suggested beyond its spec (the improvements row builds automatically) | in: the IDEA lines in specs/NNN-name/report.md § Not built | R<k> | planned | — |
```

It rides this close and turns ready when this row lands, so the next
`/project <slug> plan` plans it (`.agents/skills/project/SKILL.md` § Lanes). An improvements row's
own `IDEA` lines stay in its § Not built and add no row: one link, never a
chain. A later spec in the project still reads them (`.agents/skills/spec/SKILL.md`
step-1).

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
| implement-audit | ✅ ({rounds} round(s), blocking findings resolved) |
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
- Report: `{project-folder}/specs/NNN-name/report.md`
- Spec: `{project-folder}/specs/NNN-name/` (in place)
```

Then the auto-close gate:

- **Precondition (all five must hold):** (i) no deferral question is outstanding (a mechanism-match FAIL at phase-4.5 halts here and auto-close does NOT fire — the user must see it); (ii) phase-4.8 found no web target or `validate.ts --require-qa` exited 0 — an incomplete `/qa` on a changed UI is a halt, not a note on the report; (iii) the gate's open-items sweep is empty — every question, issue and improvement the run surfaced is done or asked, a reviewer's `IDEA` recorded per phase-5 § Not built (precondition (iii) of the SSOT); (iv) `node --experimental-strip-types .agents/skills/close/scripts/land.ts --gate` returns `not-fired`; (v) `validate.ts --phase report` exited 0 on the report as written.
- **Action when all hold:** run `/close` per the gate. `/close` verifies, updates the project, journals, and lands every worktree this thread owns. The `implement-audit:` line is already in the report — see phase-5. The user does NOT type `/close`.
- `/close` runs its own internal gates unchanged. See the SSOT for the full halt-case table.

For work explicitly using a pull request, follow that repo’s workflow and prepare the pull request yourself; preserve its required merge gate in the close.

## Examples

### Example 1: Fresh-context invocation (the golden path)

User opens a new session (or T3 Code thread) and types the `/implement <slug>` command a close printed. The context is fresh. Phase 0.5 runs `setup-worktree.sh <slug>`, which validates the slug, reuses the thread's own worktree or creates one named `<slug>` where the harness keeps its worktrees, records it in the thread's ledger, and prints `WORKTREE_DIR=...`. Phase 1 asks `detect-stage.ts`, which names row R2 and `specs/002-sync/spec.md`; it reads spec.md, plan.md and tasks.md by section name. Phase 3 executes each task with Verify-Assumptions → Implement → Validate-Immediately. Phase 4 runs `validate.ts --phase checks`; E2E is exercised against the running surface because `NEED_E2E=1` always comes back from that phase. Phase 4.5 writes "Agreed to X. Diff does X." Phase 4.7 runs `/implement-audit` — the reviewer reads the diff plus a blast-radius pack, and its receipt approves. Phase 4.8 runs `--phase qa-list`; a toolchain-only change prints `QA_TARGETS=` with nothing after it, so `/qa` is skipped and the report records `skipped-not-web`. Phase 5 writes `specs/002-sync/report.md` with `spec-status: complete`, and `validate.ts --phase report` passes; the close sets R2 `done` and verifies the landing.

### Example 2: Long context

User types `/implement <slug>` in a session already carrying 260,000 tokens, most of it the conversation that wrote the SPEC. **Nothing blocks it.** Phase 0 is the judgment call described above: this `/implement` starts fresh work rather than continuing a thread, so the right move is to say so and have the user open a new session (or `/clear`) before Phase 0.5 creates anything.

### Example 3: A row whose spec is not settled

User types `/implement sync-engine r3`. Row R3's `specs/003-backfill/spec.md` still reads `FR-004 [NEEDS CLARIFICATION: keep or drop tombstoned rows?]`. `setup-worktree.sh` refuses before creating anything, printing that line; the answer is `/project sync-engine`, which settles the question and edits the marker out.

### Example 4: Parallel sessions on different rows of the same project

A close printed two blocks, `/implement sync-engine r4` and `/implement sync-engine r5` — both rows' dependencies are `done`. The user runs each in a fresh session (or T3 Code thread) of its own. Session 1 runs r4: `setup-worktree.sh --slug sync-engine --shard r4` creates (or, in T3, reuses) a worktree on its own branch, prints `SLUG=sync-engine` + `SHARD=r4`, and flips R4 to `in-progress`. Session 2 runs r5 the same way in its own worktree; had it named r4 while session 1's T3 thread was building it, `setup-worktree.sh` would have refused. Sessions are isolated (disjoint dirs + branches); each `/close` lands its own branch and sets its own row `done`.

## Troubleshooting

| Failure | Symptom | Fix |
|---|---|---|
| Worktree missing or wrong branch (Phase 2) | `git -C "${WORKTREE_DIR}" rev-parse --abbrev-ref HEAD` doesn't return the branch `setup-worktree.sh` made, or directory doesn't exist | Phase 0.5 didn't run cleanly. Re-run `bash .agents/skills/implement/scripts/setup-worktree.sh <slug>` from the repo (script is idempotent). Do NOT create alternative branches in the main repo. |
| `setup-worktree.sh` exits 1 "could not record … for the close" | This thread already has a different worktree of this repo | Build in that one: `bash .agents/skills/close/scripts/write-root.sh --existing .` names it. |
| No spec to run | `detect-stage.ts` says `needs-planning`, `manual-steps` or `all-specs-reported`, and `setup-worktree.sh` refused | Run `/project <slug>` — the row has no spec yet, its spec has open clarifications, the ready rows are manual steps, or nothing is ready. |
| `r99` refused | No such row in ROADMAP.md; the refusal lists the IDs | Re-run with an ID from the list. |
| Row held by another thread | `BLOCKED: <ID> is being built in thread "<title>" (<worktree>)`, or `detect-stage.ts` says `taken` | Another open T3 thread marked the row `in-progress` in its own worktree. If that thread is finished, settle it in T3 and re-run; otherwise pick another row. |
| Wrong spec picked | Several rows are ready and the bare slug took the first (in-progress before planned) | Name the row: `/implement <slug> <id>`. |
| Type check fails (Phase 3.3 / Phase 4) | `FAIL: layer-1 typecheck (<package>)` | Read the error, fix at the source, re-run. |
| Tests fail (Phase 4) | `FAIL: layer-2 <package>` | Fix implementation or the test; observe RED first; re-run until green. |
| Lint fails (Phase 3.3) | `FAIL: layer-1 lint (<package>)` | Use the package's own fixer if it has one (`npm run lint -- --fix`, `biome check --write`, …); then manual fixes for anything it left. Do NOT add to an exclude list. |
| `validate.ts` prints `NEED_FIX=1` | the reviewer left a `[must-fix]`/`[should-fix]` open, or a layer failed | Fix it, then re-enter the same phase with `--since $PRE_TREE`. Do not proceed on a non-zero exit; there is no "note it in the report" path. |
| `validate.ts` prints `NEED_E2E=1` | the tree moved after the layers ran | Re-walk the E2E before continuing. The bytes that were tested are not the bytes that ship. |
| `--phase qa-list` exits 2 | `detect-app.ts` crashed, or is missing | HALT. Run `detect-app.ts` on the target by hand and fix it. Never read a detector failure as "no UI changed" — that is the one path by which a UI ships unreviewed with a green run. |
| `--phase report` exits 1 | a test file changed since the base, and the report has no red excerpt for it | See it fail now, as Phase 5 says, then re-run. Never set the line just to make the step pass. |
| `--require-qa` exits 1 | a web target has no `/qa` marker for the tree about to ship | Run `/qa` on that target to completion. If it already ran, a LATER `/qa` moved the tree and invalidated this one's marker — run it again. Never `touch` a marker by hand. |
| E2E fails (Phase 4) | A test task against the running app does NOT match expected output | Diagnose; class-fix if it's a shared pattern; if the approach itself is wrong, revise the SPEC and re-run /implement. NEVER declare complete with E2E red. |
| SPEC reference doesn't exist (Phase 3.1) | A function, KV key, or path the SPEC names is missing | Document in §Deviations; check if the SPEC was based on stale state; if so, revise the SPEC and re-run. |
| Phase 4.5 mismatch | "Agreed to X. Diff does Y." | Either fix the diff to actually implement X, OR ask the user, as a numbered list in the reply, recommendation first, whether the divergence is acceptable. MUST NOT proceed to Phase 5 with a known mismatch. |
