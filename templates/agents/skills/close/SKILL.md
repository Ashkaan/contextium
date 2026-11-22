---
name: close
description: Ends the session — verifies what changed, records it, and lands every worktree this thread owns. Use when the user says "close", "wrap up", "let's close", or otherwise asks to end the session, and when a producer skill's auto-close gate fires.
allowed-tools: "Bash Read Edit Write"
metadata:
  peers: ".agents/skills/close/scripts/harness.sh .agents/skills/close/scripts/transcripts.ts .agents/skills/close/scripts/thread.ts .agents/skills/close/scripts/write-root.sh .agents/skills/close/scripts/trunk.ts .agents/skills/close/scripts/verify.ts .agents/skills/close/scripts/corrections.ts .agents/skills/close/scripts/session.ts .agents/skills/close/scripts/journal-file.ts .agents/skills/close/scripts/land.ts .agents/skills/close/scripts/await-push-checks.ts .agents/skills/close/scripts/live-checks.ts .agents/skills/close/scripts/check-roadmap-decisions.ts .agents/skills/close/scripts/project-status.ts .agents/skills/close/scripts/project-remaining-work.ts .agents/skills/close/scripts/next-implement-command.ts .agents/skills/close/scripts/roadmap.ts .agents/skills/close/scripts/roadmap-merge.ts .agents/skills/close/scripts/spec-state.ts .agents/skills/close/scripts/end-of-turn.ts .agents/skills/close/references/journal-entry.md .agents/skills/close/references/auto-close-gate.md"
---

# /close — verify, project, journal, land, report

Five steps in this order: verify first in case it forces further fixes, then
update the project, then journal, then land, then report. A fix forced by the
verify would otherwise post-date the entry describing it. The scripts decide
what there is to do; nothing below names a repo, a branch or a session
variable, so it runs on T3 Code, Claude Code, Codex, Grok Build and Antigravity
unchanged.

**A clean `git status` is not "nothing to close."** A session that only
answered a question still gets a journal entry (step 3) and a landed close
(step 4). Steps 1, 3, 4 and 5 always run their script; only step 2 has nothing
to run, and only when no project folder was touched.

**Where this session's files are.** Code, records (`knowledge/`, `journal/`,
`projects/`) and skills (`.agents/skills/`) all live in the workbench, in the
worktree its harness gave this session (a T3 Code thread, `claude -w`, a Codex
app thread), or one made for it on first ask when it started in the main
checkout. Ask before writing any file — a write into the shared checkout is in
no worktree, so nothing lands it:

```bash
bash .agents/skills/close/scripts/write-root.sh .   # or an absolute repo path
```


## 1 — Verify

```bash
node --experimental-strip-types .agents/skills/close/scripts/verify.ts
```

It runs the checks and tests of everything this thread's worktrees changed and
records the content it passed on. **A `FAIL` halts here** — fix it and re-run;
`unverified` is a gap in that folder, not a failure. Any edit after a pass,
other than the records steps 2 and 3 write, means running it again: `land.ts`
refuses to commit content verify did not pass.

A `FAIL review: …` means the independent review no longer covers what would
ship. Recover by reviewing that change within the remaining allowance or by
restoring the reviewed bytes — never by resetting a counter or opening another
thread for the same change. A file it names in the shared checkout is a write
that escaped the write guard: move it into this thread's worktree.
Only the user can override it, for one landing: run `verify.ts` and `land.ts`
with `CLOSE_REVIEW_OVERRIDDEN_BY='"<their words>" — <their name>, <YYYY-MM-DD>'`,
their own words with their name and the date
(`.agents/skills/review/authorized-by.ts`), and quote them under
`**Corrections:**`; both print what the review does not cover, then the
override.

## 2 — Project

```bash
node --experimental-strip-types .agents/skills/close/scripts/project-remaining-work.ts <project-folder>
```

For each project this session touched, under `projects/` of this worktree:

1. **Anything still outstanding for a later session becomes a row**, never a
   README bullet. A `planned` row rides the close, `manual` or not, and so does
   a watch dated today or later (`blocked: <YYYY-MM-DD> <what>`,
   `blocked: until <YYYY-MM-DD> <why>`). What is still this session's holds
   it: the row it is working, a step for the user with no date, a past or
   undated wait. A choice the user has not made is asked in the reply, and the run halts,
   whatever its date. `auto-close-gate.md` precondition (iii) is the one
   definition. New IDs continue from the highest one; a row that will not be
   done is `closed: <why>`.
2. **A finished spec's row is `land.ts`'s to set `done`**, when this push writes
   its `report.md` `complete` — or, for a spec this close holds for its live
   checks, only when `--release` has proved every one (§ Hold for the live
   checks); until then its row stays as it was, `in-progress` included. A
   row set `in-progress` for a spec the landing owes no check (finished
   earlier, its checks unchanged) is refused as half-built. A
   `partial` report is refused unless its row is `closed:` or `absorbed by`:
   finish the spec, or narrow it to what was built
   (`.agents/skills/implement/SKILL.md` § Phase 5).
3. **Never hand-write `status:`, `next:`, `blocked-on:` or
   `monitoring-until:`** — `land.ts` re-derives them from the rows. To change
   what a project is, change a row. When it derives `completed`, write the
   README's `## Outcome` in the same pass:

```bash
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --sync-next
```

A project with no `ROADMAP.md` gets one with `/project <slug>` first.

4. **Keep the README true now.** When this session changed what the project
   is (a deliverable retired, scope added or dropped, a constraint lifted, a
   finished project reopened), rewrite `## Goal`, and every section or
   `## Outcome` that now contradicts it, to state the current plan. Replace a
   superseded ruling rather than adding a dated paragraph after it; how it
   changed is the journal's. A goal that still promises a deliverable retired
   the day before misleads every session that reads it.

### Steps for the user's hands

A step only the user can do stays a `manual` row; nothing adds it to their task
list on its own.

- **Check first.** The session working such a row looks for whether it is
  already done (sent mail, the vendor's record, the repo) and whether the agent
  can do all of it, and does that.
- **Part of the row being worked** (`in-progress`): finished together before
  the close.
- **When the user asks for a task**, add it to their task list with a pointer
  back to the project folder and row, and close the row in the same session as
  `closed: moved to the task list <YYYY-MM-DD>`. First set each `planned` row
  whose `Depends on` names it `blocked: <due date> the user <does the step>`:
  a watch, which no job releases on its date, unlike `blocked: until`; the
  session that reads it on that date releases it only when the task's own
  record shows it done; a search that finds nothing is never that evidence.

## 3 — Journal

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts --existing \
  || node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts "<filename-stem>"
```

In a T3 Code thread, then read the session back from T3:

```bash
node --experimental-strip-types .agents/skills/close/scripts/session.ts            # page 1, and the page count
node --experimental-strip-types .agents/skills/close/scripts/session.ts --page 2   # each page its footer names
```

Read every page when page 1's header counts a compaction, when your context
opens with a summary of earlier conversation, or on any harness but Claude
Code; write Changes, Findings, Lessons and the `rejected:` lines from those
pages, not from a summary, which is where dead ends go missing. Outside T3
there is no such record (`session.ts` says `no T3 database`): write the entry
from your context, and say in it when that context began with a summary.

Read [references/journal-entry.md](references/journal-entry.md) before writing
— it is the schema the check enforces. `open_items: none` has no other value:
if this run still holds a question for the user, ask it as a numbered list and
halt; this close runs after they answer. A step for the user's hands that is
this session's — the row it is working, or one it raised with no date — halts
the same way: list what they do, and close once they say it is done. `--existing`
reuses the entry from an earlier close; update it if work continued, and never
allocate a second one. For `**Corrections:**`:

```bash
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts          # one row per turn
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts --full   # a turn that spans lines
```

Keep the rows where the user corrected, redirected or rejected something; drop the
ones that only move work along; quote what you keep **verbatim**. That filter is
the only judgment here.

`land.ts` quotes each changed spec's `spec-audit:` and `implement-audit:`
lines under `**Changes:**` itself;
a standalone `/implement-audit` with no `report.md` quotes its own line there.
Then validate the entry, repair what it reports in this thread's entry only,
and repeat:

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts --check
```

## 4 — Land

First note this thread's id and its own worktree, which no landing removes,
and pick the one copy of the close's scripts this step uses throughout — the
landing and a release — so the script that records the close and the one that
reads it are the same version: for a thread opened on the workbench, the
noted worktree's own `<worktree>/.agents/skills/`; for one opened on another
repo, the installed copy, `~/.agents/skills/`. Run each command below from
the noted worktree with that copy's paths.

```bash
# a thread opened on workbench
node --experimental-strip-types .agents/skills/close/scripts/thread.ts --id && node --experimental-strip-types .agents/skills/close/scripts/thread.ts --worktree
# a thread opened on another repo (it has no .agents/skills/ of its own)
node --experimental-strip-types ~/.agents/skills/close/scripts/thread.ts --id && node --experimental-strip-types ~/.agents/skills/close/scripts/thread.ts --worktree
```

```bash
node --experimental-strip-types <that copy>/close/scripts/land.ts "<verb-led subject, ≤72 chars>"
```

It commits, merges the trunk, checks the merged tree, pushes, waits for what
the push started, proves the landing, and removes the worktrees (a held close
keeps them until `--release`; T3's own is never removed). On any failure
it prints one `NOT CLOSED: <reason>` and exits 3, the work intact; a re-run
resumes. For a repairable error within the authorized work, fix the cause,
re-run what it affects, update the journal, and land again. Never retry an
unchanged failure, bypass a check, or print the success line yourself; when
recovery needs the user's input, a permission or an outside change, report the exact
`NOT CLOSED` line and the blocker.

- **Something left open** (`something left open in a roadmap or report`, or
  the journal's F12) is reported as the list of every line above it — what the
  user does, what is left to build — and the session stays open until each is done,
  or set for a later session as a `planned` row or a date.
- **A helper not reported back**: wait for its result, or cancel it with T3's
  task cancel if it is no longer needed, then land again.
- **A `harness-links:` line** naming a `.pre-link` file: inspect that file.

### Hold for the live checks

A spec whose `tasks.md` declares a `live-checks` block (the form is
`.agents/skills/close/scripts/live-checks.ts`'s) holds the landing that finishes it
after the deploy: `land.ts` prints each owed check, then `HELD:`, and stops
with no report. `--hold` holds a landing that owes nothing. While held:

- **An evidence check**: record what is live, capture it, then record the
  capture with what it shows. A deploy between the two voids it.

  ```bash
  node --experimental-strip-types .agents/skills/close/scripts/land.ts --live-start <spec>/<id>
  # take the screenshot or capture now
  node --experimental-strip-types .agents/skills/close/scripts/land.ts --live-pass <spec>/<id> <file> --saw "<what it shows>"
  ```

- **A problem you can fix**: every worktree the landing used is still there,
  product repos' included, so make the fix in it, review it there, add it to
  the journal entry, and land again with `--hold`. A fix that removes a
  spec's last live check sets its row `done` on that landing.
- **Something only the user can decide**: record it first with
  `end-of-turn.ts --pause "<question>"` (§ After the report), then ask it in
  those words as a numbered list and stop. No time ends a hold.

```bash
node --experimental-strip-types <that copy>/close/scripts/land.ts --release   # the report and the line
```

`--release` runs every command check, accepts each evidence check only from a
record taken on the deployment live now, and refuses, keeping the hold, until
all pass. It publishes nothing but the rows it sets, so it first refuses any
work a worktree holds that has not landed, committed or not: land it with
`--hold`, then release. The held spec's row stays as it was through the hold;
once every check passes, `--release` sets it `done`, re-derives the project's
`next:`, and pushes that like any landing. A push that fails takes that commit
back out of the worktree, keeps the hold and says why; release again.

## 5 — Report

Copy the final Markdown block `land.ts` printed verbatim — Shipped, the
journal link, Project, Next, Harness links, Live checks and the proof line,
each its own paragraph. Never reconstruct or condense it. Each `/implement
<slug> <row>` in it is a handoff, not a start: nothing builds a row on its own.
The user runs each in a fresh session (a new thread, tab or terminal), so the
build starts from its spec rather than from this session's context; each
command is its own fenced block, and rows listed together can run in parallel
sessions. When the user asks about a record later in the session, hand back
that journal line rather than retyping a path.

The last line, `origin/<trunk> is at <sha> — closing this tab loses nothing.`,
is **only `land.ts`'s to print**, after proving every merge SHA is on a freshly
fetched trunk, the journal is in the tree, and no worktree holds anything.
Writing it yourself is a false claim with a checkable SHA in it.

### After the report

On Claude Code, Codex and Grok an end-of-turn check (`scripts/end-of-turn.ts`)
refuses a reply that ends the turn without the saved report's last line, and
every turn end of a thread that closed and then changed something until a new
close lands it. To ask the user something — after the close has finished, while
it is held, or in a session that has not closed yet — record the question
first, then ask it in those words:

```bash
node --experimental-strip-types .agents/skills/close/scripts/end-of-turn.ts --pause "<question>"
```

Record a question with choices exactly as the reply will show it: the question
on its own line, numbered (`1. …`), then each choice on its own line, lettered
(`a. …`, `b. …`); one line with the choices inside it forces them into a
paragraph. Every later turn end is refused until the user's answer is dealt
with and a new close lands, or another `--pause` asks the next question.

## What this close does not do

Each was removed deliberately; re-adding one needs a reason this table lacks.

| Not here | Because |
|---|---|
| Attestation markers or a `closed-by:` trailer | One ancestry check proves what they did |
| Reading audit lines off commits | They are records in the artifact |
| A repo-to-trunk table | `trunk.ts` reads what the remote says |
| Committing in a shared checkout | It holds other sessions' files |
| A check that caught nothing in 60 days | Each check stays only while it still catches real problems |
