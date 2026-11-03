---
name: close
description: Ends the session — verify what changed, update the project, journal it, land every worktree this thread owns on its repo's trunk, report a line a script proved. Use when the user says "close", "wrap up", "let's close", or any plain-English request to end the session, and when a producer skill's auto-close gate fires. The gate is in close/references/auto-close-gate.md.
allowed-tools: "Bash Read Edit Write"
metadata:
  peers: ".agents/skills/close/scripts/harness.sh .agents/skills/close/scripts/transcripts.ts .agents/skills/close/scripts/thread.ts .agents/skills/close/scripts/write-root.sh .agents/skills/close/scripts/trunk.ts .agents/skills/close/scripts/verify.ts .agents/skills/close/scripts/corrections.ts .agents/skills/close/scripts/session.ts .agents/skills/close/scripts/journal-file.ts .agents/skills/close/scripts/land.ts .agents/skills/close/scripts/await-push-checks.ts .agents/skills/close/scripts/live-checks.ts .agents/skills/close/scripts/check-roadmap-decisions.ts .agents/skills/close/scripts/project-status.ts .agents/skills/close/scripts/project-remaining-work.ts .agents/skills/close/scripts/next-implement-command.ts .agents/skills/close/scripts/roadmap.ts .agents/skills/close/scripts/roadmap-merge.ts .agents/skills/close/scripts/spec-state.ts .agents/skills/close/references/journal-entry.md .agents/skills/close/references/auto-close-gate.md"
---

# /close — verify, project, journal, land, report

Five steps in this order: verify first in case it forces further fixes, then
update the project, then journal, then land, then report. A fix forced by the
verify would otherwise post-date the entry describing it. Nothing below names a
repo, a branch or a session variable, so it runs on T3 Code, Claude Code, Codex,
Grok Build and Antigravity unchanged.

**A clean `git status` is not "nothing to close."** A session that only
answered a question still ran, and it still gets a journal entry (step 3) and
a landed close (step 4). Steps 1, 3, 4 and 5 always run their script, and the
script decides what there is to do — not a glance at the diff. Only step 2 has
nothing to run, and only when no project folder was touched.

**Where this session's files are.** One repo, one worktree: code, records
(`knowledge/`, `journal/`, `projects/`) and skills (`.agents/skills/`) all live in
the workbench, and a session writes them all in its own worktree — the one its
harness gave it (a T3 Code thread, `claude -w`, a Codex app thread), or one made
for it on first ask when it started in the main checkout. Ask before writing
any file — a write into the shared checkout is in no worktree, so nothing lands
it:

```bash
bash .agents/skills/close/scripts/write-root.sh .   # or an absolute repo path
```

## 1 — Verify

```bash
node --experimental-strip-types .agents/skills/close/scripts/verify.ts
```

Runs the `check` and `test` of every app whose files moved in this thread's
worktree, those of every integration or package (`packages/<name>`) that moved
and declares its own, those of every product repo whose worktree moved, run
from its root — a product repo whose push builds without testing is tested
here or nowhere — every `*.test.ts` of a project whose code moved, and every
`*.test.sh` and `*.test.ts` beneath every `.agents/skills/<skill>/` folder that
moved — a skill is code, and without this it would be the only code that closed
with nothing run against it. **A `FAIL` halts here** — fix it and re-run;
nothing is recorded yet, which is the point of going first. `unverified` is a
gap in the app or the skill folder, not a failure.

Each run records its result and the content it checked, and `land.ts` refuses
to commit (`verify has not passed on this worktree as it is now`) unless the
last run passed on what every worktree holds now. The records steps 2 and 3
write — a project's README and ROADMAP, the journal, `knowledge/` — do not
count; any other edit after a pass means running it again.

It also asks the review receipt (`.agents/skills/implement-audit/scripts/audit-dedupe.ts
check`) whether an independent review covers each worktree's implementation
source as it is now. A thread with no implementation work — no audit it
registered, no report carrying a review-coverage block — is judged exactly as
before. Otherwise a `FAIL review: … changed since the review: <paths>`, an
unfinished attempt or open findings halt here, and `land.ts` asks the same
reader again after merging the trunk, before the push: a merge that moves a
covered file or a dependency the review relied on stops the push with the
paths named, the merge kept. Recover by reviewing that change within the
remaining allowance or restoring the reviewed bytes — never by resetting a
counter or opening another thread for the same change.

It also reads the shared checkout the home link (AGENTS.md § Skills) points at.
A file sitting there uncommitted is in no worktree and nothing will land it;
when this thread's worktree does not account for it, that is a write which
escaped the write guard and the close halts.

## 2 — Project

```bash
node --experimental-strip-types .agents/skills/close/scripts/project-remaining-work.ts <project-folder>
```

For each project this session touched, under `projects/` of the worktree
`write-root.sh .` names:

Every project has a `ROADMAP.md`, and the roadmap is its only list of
outstanding work, so the README gets no `## Current Progress` or `## Next Steps`:

1. **Anything still outstanding becomes a row**, never a README bullet — and
   only three kinds of row may ride the close: a `planned` row that is not
   `manual` (its spec written, or not yet); a `planned` `manual` row that
   cannot start yet, because a row its `Depends on` names — here or in another
   project — is still open; and a watch, Status
   `blocked: <YYYY-MM-DD> <what>` or `blocked: until <YYYY-MM-DD> <why>` dated
   today or later, a `manual` row included in the `until` form. A step waiting
   on the user (any other `manual` row, or a wait that names them), a half-built row, a
   row whose `Depends on` names no row, and a wait with
   no date mean the session
   is not done: `land.ts` refuses every row this push adds or changes that is
   one (`scripts/check-roadmap-decisions.ts`; `auto-close-gate.md`
   precondition (iii) is the definition). A row never waits on the user's
   answer either: a choice they have not made is asked in the reply and the
   run halts. Nothing sets a `blocked: until` row back to `planned` on its
   own: once its date passes, `/project triage blocked` lists it.
   New IDs continue from the highest existing one and are never reused. A row
   that will not be done is `closed: <why>`, never left open on a finished
   project.
2. **A finished spec's row is `land.ts`'s to set.** When this push writes a
   spec's `report.md` as `complete` (`spec-state.ts`), `land.ts` sets every
   row naming that spec `done` — never a `closed:` or `absorbed by` row —
   and re-derives `next:`, before its gates and again on the merged tree,
   printing `roadmap: <project> <ID> set done`. `/implement` only ever sets
   `in-progress`. A report this push writes as `partial` is a half-built
   piece, and `land.ts` refuses it unless its row is `closed:` or
   `absorbed by`: finish the spec, or narrow it to what was built
   (`.agents/skills/implement/SKILL.md` § Phase 5).
3. **Re-derive `status:` and `next:`.** Never hand-write either, nor
   `blocked-on:` or `monitoring-until:`; the rule is the README template's,
   and `land.ts` re-runs it on every project a push touches, and on every
   project whose `Depends on` names one of them. When it derives
   `completed`, write the README's `## Outcome` in the same pass.

```bash
node --experimental-strip-types .agents/skills/close/scripts/spec-state.ts <project-folder>             # which specs are complete
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --sync-next
```

**A project with no `ROADMAP.md`** is a retired layout: the readers report it
(`roadmap-error: no ROADMAP.md`, which vetoes completion) rather than read its
loose specs or README sections. Give it a roadmap with `/project <slug>` first.

**This close never chooses `status:`** — step 3 derives it from the rows. When
a close chose it, the choice drifted from the table both ways: a project went
`monitor` while a row waited on the owner to grant access, and others sat
`completed` over rows still `planned`. To change what a project is, change a
row.

## 3 — Journal

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts --existing \
  || node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts "<filename-stem>"
```

In a T3 Code thread, then read the session back from T3, because after a
compaction your context holds only a summary of what came before it, and the
summary is where dead ends, failed readings and dropped approaches go missing:

```bash
node --experimental-strip-types .agents/skills/close/scripts/session.ts            # page 1, and the page count
node --experimental-strip-types .agents/skills/close/scripts/session.ts --page 2   # each page its footer names
```

Read every page when page 1's header counts a compaction, when your context
opens with a summary of earlier conversation, or on any harness but Claude Code
(T3 records only Claude Code's compactions). Write Changes, Findings, Lessons
and the `rejected:` lines from those pages, not from the summary. A session
that never compacted is already in your context, so page 1's header is enough.
Outside T3 there is no such record (`session.ts` says `no T3 database`): write
the entry from your context, and say in it when that context began with a
summary.

Read [references/journal-entry.md](references/journal-entry.md) before writing —
it is the schema, and the check below enforces it: eight sections and no other
label, a `**Decisions:**` bullet that is a link to where the choice lives or one
`rejected:` line, `root_cause_status` one of four values, and `open_items: none`.
That last key has no other value: if this run still holds a question for
the user, STOP here — ask it as a numbered list and halt; this close runs
after they answer. A step waiting on their hands halts the same way: list what
they do, and close once they say it is done (`auto-close-gate.md` precondition (iii)). `**Next:**` and
`**Issues:**` are retired. `--existing` reuses the entry from an earlier close;
it does not prove the entry is valid. Repair it if needed, and update it if work
continued after that close. Do not allocate a second entry. The filename stem
and the frontmatter `slug:` are different: the reference shows their exact
relationship. For `**Corrections:**`:

```bash
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts          # one row per turn
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts --full   # a turn that spans lines
```

It reads T3 Code's record of the session, or outside T3 the harness's own
transcript. Keep the rows where the user corrected, redirected or rejected
something; drop the ones that only move work along; quote what you keep
**verbatim**. That filter is the only judgment here — never re-word a row or
write the section from memory. When it finds no record, say so and omit the
section.

`land.ts` quotes, under the entry's `**Changes:**`, each `spec-audit:` line in
the `plan.md` and each `implement-audit:` line in the `report.md` of every
spec this push changed, unless the entry already does. A session that ran
`/implement-audit` standalone (no `report.md` to hold it) quotes its line
there itself. The line is a record in the artifact and the journal, never a
gate on a commit: a gate on a trailer refuses work for a missing line rather
than for a defect.

Every session needs its entry: `land.ts` refuses a thread with none
(`no journal entry for this thread`), a thread opened on a product repo too.

After writing or updating the entry, validate it before Land:

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts --check
```

Repair any reported errors in this thread's entry and repeat the check. This
uses Land's validator, `scripts/check-journal-entry.ts`; do not bypass it or
change another session's entry. Land refuses the close when the entry fails it,
and refuses too when the checker itself is missing.

## 4 — Land

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts "<verb-led subject, ≤72 chars>"
```

Runs the workbench's checks (decision records, skills, scripts, secrets,
standards citations, and `check-roadmap-decisions.ts` over the projects it
changed) and the journal check, commits, merges the repo's trunk, pushes, lets
the push deploy what the merge landed, removes the worktrees it made, then
re-fetches and checks. It waits for every check and status GitHub reports on
each pushed commit to finish — workflow runs, hosted builds such as Pages,
Workers Builds or Vercel, a deployer's commit status — and prints one line per
check (`await-push-checks.ts`, through the `gh` CLI). A failure, one still
running after 30 minutes, an unreadable answer, or no deploy where the repo's
last push had one is `NOT CLOSED`; a repo that reports nothing, and reported
nothing before, closes with `no deploy reported for <repo>`, and so does a
repo whose origin is not on GitHub. On a machine without `gh` the close says
`no push checks read` and does not wait; install it and run `gh auth login`
to have it wait. It also checks the harness home links
(`check-harness-config-links.ts`) and relinks any that drifted; the report
prints each `harness-links:` line under **Harness links:**, on the release of a
held close too. Inspect each `.pre-link` file one names; they never refuse the
close. `ROADMAP.md` merges row by row (`roadmap-merge.ts`), so two sessions
closing two rows of one project do not conflict; a real clash in one row still
does. On any failure it prints one
`NOT CLOSED: <reason>` and exits 3; the worktrees are intact and re-running resumes.
For a repairable error within the authorized work (such as this thread's journal
format), fix the cause, re-run affected checks, update the journal, and retry Land.
Do not retry an unchanged failure indefinitely or bypass a check. If recovery
requires user input, additional permission, or an external change, report the
exact `NOT CLOSED` line and the blocker; never print the success line yourself.
A refusal for something left open (`something left open in a roadmap or
report`, or the journal's F12) is reported as the list of every line above it —
what the user does, what is left to build — and the session stays open; the close
re-runs once they are done.

### Hold for the live checks

Some checks can only run after the push deploys: the deployed page, a live
smoke, a screen judged by eye. The script decides when to hold. A spec declares
those checks in a `live-checks` block of its `tasks.md` (the form is
`.agents/skills/close/scripts/live-checks.ts`'s), and a landing that writes such a
spec `complete` holds after the deploy whatever flag it was given: it prints
each owed check, then `HELD:`, and stops with no report, no last line and no
closed marker. `--hold` still holds a landing that owes nothing.

While held:

- **An evidence check**: record what is live, capture it, then record the
  capture with what it shows. A deploy between the two steps voids it.

  ```bash
  node --experimental-strip-types .agents/skills/close/scripts/land.ts --live-start <spec>/<id>
  # take the screenshot or capture now
  node --experimental-strip-types .agents/skills/close/scripts/land.ts --live-pass <spec>/<id> <file> --saw "<what it shows>"
  ```

- **A problem you can fix**: fix it, add it to this session's journal entry,
  and land again with `--hold`; a landing without it is refused while held.
- **Something only the user can decide**: ask it as a numbered list and stop.
  The hold stays until they answer; no time ends it.

```bash
node --experimental-strip-types .agents/skills/close/scripts/land.ts --release   # the report and the line
```

`--release` runs every command check itself, accepts each evidence check
only from a record taken on the deployment live now, and refuses, keeping the
hold, until all of them pass. Then it prints the report under the first held
subject, with the checks under **Live checks:**, ending on the last line.

## 5 — Report

Copy the final Markdown block from `land.ts` verbatim. It mechanically emits
`Shipped`, a clickable journal link whose target is the absolute landed path, a
`Project` sentence saying where the journal's project stands
(`scripts/project-status.ts`), the project's deterministic `Next` actions when
there are any, the `Harness links` lines when the check relinked or warned,
and the proof line, each its own paragraph. It saves the same block in the
thread's state before it marks the close closed. Do not
reconstruct or condense that block. Each `/implement <slug> <row>` in it is a
handoff, not a start: nothing builds a row on its own. The user runs each in a
fresh session (a new thread, tab or terminal), so the build starts from its
spec rather than from this session's context; each command is its own fenced
block, so each has its own copy button, and rows listed together can run in
parallel sessions. Report a verify gap or unfinished work immediately before
the block when either exists.

The journal path is absolute and points into the shared checkout because that
is the copy that survives: the worktree that held it is gone by then, and a
link into a removed worktree cannot open. When the user asks about a record
later in the session, hand back that line rather than retyping a path.

The last line is `origin/<trunk> is at <sha> — closing this tab loses nothing.`
**Only `land.ts` may produce it**, after proving against a freshly fetched trunk
that every merge SHA is an ancestor, the journal path is in the tree, and no
worktree still holds anything. Writing it yourself is a false claim with a
checkable SHA in it.

`<trunk>` is the trunk of the repo whose SHA the line carries. It reads
`origin/main` on most repos and is resolved rather than spelled, so a repo on
`master` gets a true sentence instead of a reassuring one about a branch its
work is not on.

## What this close does not do

Each was removed deliberately; re-adding one needs a reason this table lacks.

| Not here | Because |
|---|---|
| Attestation markers, a `closed-by:` trailer, and a script that checked it before each commit | Three moving parts to prove what one ancestry check proves — and a commit-hook checker never runs in a repo whose hooks path points elsewhere |
| Reading `implement-audit:` or `spec-audit:` lines off commits | The skill that produced the artifact writes its line into the artifact folder (`report.md`, `plan.md`) and § 3's journal entry quotes it |
| Mode detection, a list of known checkouts | Every repo is a worktree in the ledger; there is one path |
| A repo-to-trunk-branch table | `trunk.ts` reads `refs/remotes/origin/HEAD`, which is what the remote itself says. A table is a second copy that goes stale silently |
| Mid-session self-improvement, judgment sweeps, a root-cause prompt | Each re-checks something another skill owns |
| Committing in a shared checkout | It holds other sessions' files. That is the failure this replaced |
