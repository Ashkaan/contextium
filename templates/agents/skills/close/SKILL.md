---
name: close
description: Ends the session — verify what changed, update the project's roadmap, write the journal entry, commit and push, then report the next commands. Use when the user says "close", "wrap up", "let's close", or any plain-English request to end the session, and when a producer skill's auto-close gate fires (/spec, /implement, a standalone /implement-audit).
allowed-tools: "Bash Read Edit Write Skill Task AskUserQuestion"
metadata:
  peers: ".agents/skills/close/scripts/verify.sh .agents/skills/close/scripts/project-remaining-work.sh .agents/skills/close/scripts/roadmap.sh .agents/skills/close/scripts/spec-state.sh .agents/skills/close/scripts/journal-file.sh .agents/skills/close/scripts/check-journal-entry.sh .agents/skills/close/scripts/safe-commit.sh .agents/skills/close/scripts/push-with-retry.sh .agents/skills/close/scripts/next-implement-command.sh .agents/skills/close/references/journal-entry.md .agents/skills/close/references/auto-close-gate.md .agents/skills/implement-audit/SKILL.md .githooks/checks/check-decision-records.sh"
---

# /close — verify, project, journal, commit, report

Five steps, in this order. Verify comes first so a fix it forces lands before
the journal entry that describes the session; the report comes last so it can
name the SHA that is actually on the remote.

**A clean `git status` is not "nothing to close."** A session that only
answered a question still ran, and it still gets a journal entry. Steps 1, 3, 4
and 5 always run their script, and the script decides what there is to do. Only
step 2 is skipped, and only when no project folder was touched.

## 1 — Verify

```bash
bash .agents/skills/close/scripts/verify.sh --base <first commit before this session>
```

Omit `--base` when the session made no commits. It runs every `*.test.sh` of
each skill folder that changed, `.githooks/checks/check-decision-records.sh` on
each changed `decisions/NNNN-*.md`, and the `check` / `test` scripts of the
nearest `package.json` above each changed code file. **A `FAIL` halts here:**
fix it and re-run; nothing is recorded yet. An `unverified` line is a gap to
report in step 5, not a failure. For `unverified code`, run the project's own
test command yourself (a spec's plan.md `## Validation Commands`, when one
applies) and say what you ran.

**Audit backstop, for work that skipped `/implement`.** Ask the marker, don't
judge it:

```bash
bash .agents/skills/implement-audit/scripts/audit-dedupe.sh status
```

`done` → this session was already reviewed; nothing to run. (If no `report.md`
holds its `implement-audit:` line, printed on line 2, the journal quotes it.) `fresh` and the session changed real code (a new app
directory, or roughly 50+ changed lines) → run `/implement-audit --from-close`
now (the flag stops it closing the session itself) and fix
every ready finding before continuing. `fresh` and only docs, config or records
→ skip.

## 2 — Project

For each project this session touched:

```bash
bash .agents/skills/close/scripts/project-remaining-work.sh projects/<domain>/<date>_<slug>
```

**A project with `ROADMAP.md`** — the roadmap is its only list of outstanding
work, so the README carries no progress or next-steps list:

1. **Anything still outstanding becomes a row**, never a README bullet. A watch
   is a row with Status `blocked: <date>`; a manual step or something waiting
   on someone is a row with Sub-spec `—`. New IDs continue from the highest
   existing one and are never reused.
2. **Flip each row whose spec is finished** — `spec-state.sh` reads its
   `report.md` as `complete` — to `done`. `/close` is the only writer of
   `done`; `/implement` only ever sets `in-progress`.
3. **Re-derive `next:`.** Never hand-write it; the rule lives in the project
   README template (`.agents/skills/project/references/templates/README.md`).

```bash
bash .agents/skills/close/scripts/spec-state.sh <project-folder>             # which specs are complete
bash .agents/skills/close/scripts/roadmap.sh <project-folder> --set <ID> done
bash .agents/skills/close/scripts/roadmap.sh <project-folder> --sync-next
```

**A project without `ROADMAP.md`** (loose `*.spec.md` files, the older layout)
— update its README's `## Status`, `## Current Progress` and `## Next Steps` by
hand, as that layout always did.

**Either way, the `status:` flip:**

- `work-remains` keeps the project `active` — unless nothing remaining is work
  this repo's tooling can do (a vendor must act, someone must reply). Then it is
  `monitor` with `monitoring-until:` naming the date and what is awaited, or
  `blocked` with `blocked-on:`. `active` is a promise that `/implement` or
  `/project` has something to do, because step 5 turns it into that command.
- `no-hard-signal` AND the README's `## Goal` is met → `completed` (write
  `## Outcome`), or `monitor` when the shipped thing needs a watch window. On a
  ROADMAP project `no-hard-signal` means every row is `done` or `absorbed by …`.
- A `roadmap-error:` line is `work-remains` until the table is fixed.

## 3 — Journal

```bash
bash .agents/skills/close/scripts/journal-file.sh --existing \
  || bash .agents/skills/close/scripts/journal-file.sh "<short-stem>"
```

`--existing` returns the entry an earlier close in this session already wrote;
update that one rather than allocating a second. Read
[references/journal-entry.md](references/journal-entry.md) before writing — it
is the schema: the day folder, the front matter, the seven sections, what a
`**Decisions:**` bullet may be, and how `**Corrections:**` quotes the user
verbatim.

Quote the audit lines under `**Changes:**`: a session that wrote or audited a
spec quotes the `spec-audit:` line from that spec's plan.md Constitution
Check; a session that ran `/implement-audit` without a `report.md` to hold it
quotes the `implement-audit:` line. These lines are records; no hook checks a
commit for them.

Then validate, repair, and repeat until clean:

```bash
bash .agents/skills/close/scripts/journal-file.sh --check
```

## 4 — Commit and push

Stage only the files this session wrote — recall them from your own edits, do
not blanket-add. The guard takes a lock, unstages anything you did not name
(another session's work, left intact in the tree), and commits:

```bash
bash .agents/skills/close/scripts/safe-commit.sh "<verb-led subject>" <file> [<file>...]
bash .agents/skills/close/scripts/push-with-retry.sh "$(git rev-parse --abbrev-ref HEAD)"
```

A pre-commit refusal names what to fix; fix it and re-run the commit. The push
retries transient failures only. When origin has commits this branch lacks it
stops with exit 3; report that and let the user choose how to reconcile — never
pull, rebase or force on your own.

## 5 — Report

Say what shipped, the journal entry's path, and any `unverified` gap from
step 1. Then the next step for each touched project:

```bash
bash .agents/skills/close/scripts/next-implement-command.sh <project-folder>
```

Print each command line in **its own fenced block**, so each has its own copy
button — on a ROADMAP project every ready row with a spec is its own
`/implement <slug> <id>`, and those rows can run in parallel sessions. A line
starting `# ` is a statement (complete, monitoring, blocked); write it as a
sentence, not a command. Never compose a command by hand: the argument is the
project slug, and a spec's name there sends the next session nowhere.

End with the branch and the SHA now on the remote (`git rev-parse HEAD` after
the push), so the user knows closing the tab loses nothing. If the push did not
land, say so instead — never claim a push you did not see succeed.

## Troubleshooting

| Failure | Fix |
|---|---|
| `verify.sh` prints `FAIL` | Re-run the printed command, fix the cause, re-run `verify.sh`. Nothing is recorded until it is clean. |
| `journal-file.sh --check` exits 3 | Its message names the check and line (J1–J5); fix the entry and re-check. Never delete another session's file. |
| `roadmap.sh` exits 1 | The table is malformed (its message says how). Fix ROADMAP.md, then re-run the flip and `--sync-next`. |
| `safe-commit.sh` exits 3 | Another writer holds the lock. Nothing was staged; re-run in a moment. |
| `push-with-retry.sh` exits 3 | Origin moved or refused the push. Report it with the commands it printed; the user decides. |
| The audit ran twice | No session id was exported, so the marker could not be written. Carry the first run's line forward by hand. |
