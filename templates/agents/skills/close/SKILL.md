---
name: close
description: Ends the session — verify what changed, update the project, journal it, land every worktree this thread owns on its repo's trunk, report a line a script proved. Use when the user says "close", "wrap up", "let's close", or any plain-English request to end the session, and when a producer skill's auto-close gate fires. The gate is in close/references/auto-close-gate.md.
allowed-tools: "Bash Read Edit Write"
metadata:
  peers: ".agents/skills/close/scripts/harness.sh .agents/skills/close/scripts/transcripts.ts .agents/skills/close/scripts/thread.ts .agents/skills/close/scripts/write-root.sh .agents/skills/close/scripts/trunk.ts .agents/skills/close/scripts/verify.ts .agents/skills/close/scripts/corrections.ts .agents/skills/close/scripts/journal-file.ts .agents/skills/close/scripts/land.ts .agents/skills/close/scripts/project-remaining-work.ts .agents/skills/close/scripts/next-implement-command.ts .agents/skills/close/scripts/roadmap.ts .agents/skills/close/scripts/roadmap-merge.ts .agents/skills/close/scripts/spec-state.ts .agents/skills/close/references/journal-entry.md .agents/skills/close/references/auto-close-gate.md"
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
worktree, and every `*.test.sh` and `*.test.ts` beneath every `.agents/skills/<skill>/` folder that
moved — a skill is code, and without this it would be the only code that closed
with nothing run against it. **A `FAIL` halts here** — fix it and re-run;
nothing is recorded yet, which is the point of going first. `unverified` is a
gap in the app or the skill folder, not a failure.

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

**A project with `ROADMAP.md`** — the roadmap is its only list of outstanding
work, so the README gets no `## Current Progress` or `## Next Steps`:

1. **Anything still outstanding becomes a row**, never a README bullet. A watch
   is a row with Status `blocked: <date>`; a manual step or a waiting-on-someone
   item is a row with Sub-spec `—`. New IDs continue from the highest
   existing one and are never reused.
2. **Flip each row whose spec is finished** — `spec-state.ts` reads its
   `report.md` as `complete` — to `done`. This close is the only writer of
   `done`; `/implement` only ever sets `in-progress`.
3. **Re-derive `next:`.** Never hand-write it; the rule is the README
   template's.

```bash
node --experimental-strip-types .agents/skills/close/scripts/spec-state.ts <project-folder>             # which specs are complete
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --set <ID> done
node --experimental-strip-types .agents/skills/close/scripts/roadmap.ts <project-folder> --sync-next
```

**A project with no `ROADMAP.md`** — update `## Current Progress` and
`## Next Steps` in its README.

**Either way**, flip `status:` to `completed` or `monitor` only when
`project-remaining-work.ts` says `no-hard-signal` AND the goal is met;
`work-remains` keeps it `active`. On a ROADMAP project `no-hard-signal` means
no row is open — every row `done` or `absorbed by …` — and a `roadmap-error:`
line is `work-remains` until the table is fixed. A project whose only open rows
are `blocked:` watches is `monitor`, with `monitoring-until:` naming the first
watch's date.

**`work-remains` does not mean `active` when nothing remaining is implementable.**
`active` is a claim that a `/implement` run against this project has something to
do, because that is what step 5's generator turns it into — an `active` project
with an un-reported SPEC yields a literal `/implement <slug>`. When every open
item is external or handover work that no run of this repo's tooling can perform
— rotate a credential, have a vendor disable an account, wait on another firm —
the project is `monitor` with `monitoring-until:` naming what is being waited on,
or `completed` when nothing is owed at all. Record the items either way — as
`blocked: <what>` rows in `ROADMAP.md`, or in a legacy README's `## Next Steps`;
they are still real, they are just not this project's work.

This exists because a close that reads `work-remains` as `active` prints an
`/implement` for work that no longer exists — say, a dashboard deleted an hour
earlier. The generator is correct; `active` is the false input.

## 3 — Journal

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts --existing \
  || node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts "<filename-stem>"
```

Read [references/journal-entry.md](references/journal-entry.md) before writing —
it is the schema, and the check below enforces it: eight sections and no other
label, a `**Decisions:**` bullet that is a link to where the choice lives or one
`rejected:` line, and `root_cause_status` one of four values. `**Next:**` and
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

A session that wrote or audited a spec quotes that spec's `spec-audit:` line —
the one `/spec-audit` wrote into its plan.md Constitution Check — under the
entry's `**Changes:**`. A session that ran `/implement-audit` standalone (no
`report.md` to hold it) quotes its `implement-audit:` line the same way. The
line is a record in the artifact and the journal, never a gate on a commit.

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

Runs the workbench's checks (decision records, skills, secrets, standards
citations) and the journal check, commits, merges the repo's trunk, pushes,
confirms the push deployed where the repo opts in
(`.agents/deployable-prefixes.json`), removes the worktrees it made, then
re-fetches and checks. `ROADMAP.md` merges row by row (`roadmap-merge.ts`), so
two sessions closing two rows of one project do not conflict; a real clash in
one row still does. On any failure it prints one
`NOT CLOSED: <reason>` and exits 3; the worktrees are intact and re-running resumes.
For a repairable error within the authorized work (such as this thread's journal
format), fix the cause, re-run affected checks, update the journal, and retry Land.
Do not retry an unchanged failure indefinitely or bypass a check. If recovery
requires user input, additional permission, or an external change, report the
exact `NOT CLOSED` line and the blocker; never print the success line yourself.

## 5 — Report

Copy the final Markdown block from `land.ts` verbatim. It mechanically emits
`Shipped`, a clickable journal link whose target is the absolute landed path, the project journal's
deterministic `Next` commands when there are any, and the proof line. Do not
reconstruct or condense that block. Each `Next` command is in its own fenced
block, so each has its own copy button: on a ROADMAP project every ready row
with a spec is its own `/implement <slug> <id>`, and those rows can run in
parallel sessions.

The journal path is absolute and points into the shared checkout because that
is the copy that survives: the worktree that held it is gone by then, and a
relative path resolved against a removed worktree renders as a link that cannot
open. When the user asks about a record
later in the session, hand back that line rather than retyping a path. Report a verify
gap or unfinished work immediately before it when either exists.

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
