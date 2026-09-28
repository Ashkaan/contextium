# Journal entry shape

The one definition of a journal entry: where it goes, its front matter, its
heading, and the sections it may hold. `/close` § 3 reads this before writing,
and `scripts/check-journal-entry.sh` (run by `journal-file.sh --check`)
enforces the parts marked **checked**.

The journal records WHY; the git log records WHAT. An entry records the
session — what was done, what was found and from which reading, what was
learned, what the user corrected, what waits on someone else. It is not a
second home for decisions: a choice lives where the work that made it lives,
and the entry links it.

## One file per session

A journal day is a FOLDER, `journal/<YYYY-MM-DD>/`, and a session is one file
inside it: `journal/<YYYY-MM-DD>/<HHMM>-<stem>.md`. `HHMM` is the session's start
in local time when the harness knows it, else the moment the close allocated the
file; `<stem>` is a short kebab-case label, at most 60 characters. Two sessions
never write the same file, so concurrent sessions cannot merge into one another.

Do not assemble the path by hand. The script owns it: it reserves the name by
creating the file empty (so two sessions racing for one name get different
ones), moving a taken name to `-2`, `-3`:

```bash
bash .agents/skills/close/scripts/journal-file.sh "checkout-retry-fix"
```

A day file from an older install, `journal/<YYYY-MM-DD>.md`, stays as it is;
nothing rewrites it and the check does not read it.

## Front matter and heading (checked)

```markdown
---
date: 2026-01-12
time: "14:32"
title: web/2026-01-10_checkout-flow — R2 retry on declined cards
project: projects/web/2026-01-10_checkout-flow
tags: [payments, retries]
---

### web/2026-01-10_checkout-flow — R2 retry on declined cards
**Action:** shipped

Declined cards now retry once with the fallback processor.

**Changes:**
- ...
```

- One front matter block, with `date:`, and no key twice (checked). YAML keeps
  the last of two keys, so the first one's value vanishes without an error.
- `title:` is the first heading, verbatim (checked). Quote it when it contains
  `: `. By convention it is `<domain>/<date>_<slug> — <what>` for project work
  and `one-off (<what>)` otherwise, so a grep for a project finds its sessions.
- `project:` is the project folder path, or `null` for a one-off.
- `time:` is quoted, because YAML reads an unquoted `14:32` as a number.

## Section set (checked)

A section is a line at column 0 of the form `**Label:**`. The set is closed:
these seven, in this order when present, and the check refuses any other label
at column 0. A `**bold lead.**` inside a bullet is not a label, and a label
inside a fenced code block is not read. Only `**Action:**` and the one-line
summary after it are required; a light session is heading, Action, summary.

| Section | Holds |
|---|---|
| `**Action:**` | the verb, on the same line: `completed`, `progressed`, `fixed`, `investigated`, `planned`, `shipped`, `removed` or `updated` |
| `**Changes:**` | what changed: files, systems, records. A one-off session's small choice goes here, beside the change it explains, and so does any audit line (below) |
| `**Findings:**` | what was found, each bullet naming the reading it came from |
| `**Decisions:**` | links to where a choice lives, and `rejected:` lines. Nothing else |
| `**Corrections:**` | the user's own words, one quoted bullet per correction |
| `**Lessons:**` | what surprised, and what to do differently |
| `**Blocked:**` | work waiting on the user or an outside party, and what it waits for |

**Retired.** `**Next:**` — outstanding project work is the project's
`ROADMAP.md`, and the close prints the next command from it; work waiting on
someone is `**Blocked:**`. `**Issues:**` — what an investigation turned up is
`**Findings:**`. The check refuses both and says where the content goes.

## Decisions (checked)

Each bullet is one line, in one of two shapes:

```markdown
**Decisions:**
- [0003-retry-once](../../projects/web/2026-01-10_checkout-flow/decisions/0003-retry-once.md)
- [spec 002 § Clarifications](../../projects/web/2026-01-10_checkout-flow/specs/002-retry/spec.md)
- rejected: retrying three times — the processor bills each attempt
```

1. **A markdown link and nothing after it.** The reasoning lives at the target;
   a link followed by `because …` fails the check.
2. **A `rejected:` line**, `- rejected: <what was not done> — <why>`, at most
   500 characters after the `- `. It keeps its reasoning in the entry because
   `grep -rh '^- rejected:' journal/` is how a later session finds an option
   that was already turned down. It does not wrap.

Where a choice lives:

| While | The choice lives in |
|---|---|
| designing | `spec.md` § Clarifications, or a `research.md` decision |
| building | `report.md` § Deviations from Plan |
| anything expensive to reverse | a `decisions/NNNN-<title>.md` record, format and placement per `decisions/README.md` |
| a one-off session, no project | `**Changes:**`, beside the change — not Decisions |

## Findings

Each bullet states what was found and names the reading it came from: a command
that was run, a `file:line`, a URL. A README, a summary or an earlier write-up
is a claim, not a reading, until it was read this session.

```markdown
**Findings:**
- the retry fired twice on a timeout — `grep -c retry logs/checkout.log` returned 2 per order
```

## Corrections

The one section the agent does not author. Keep the user's messages where they
corrected, redirected or rejected something — a format they could not read, an
approach they sent back, a premise they overturned — and copy each **verbatim,
inside quotes**, one bullet per message. Drop messages that only moved the work
along ("go ahead", "next"). Never summarize, soften or re-word a quote, and never
append a defence; the fix belongs in `**Changes:**`. A paraphrase turns the one
independent signal in the entry back into the agent's account of itself. An
option the user picked from a list the agent wrote is reported as a choice
("chose X"), never quoted, because the words are the agent's. No corrections →
omit the section.

## Audit lines

A session that wrote or audited a spec quotes that spec's `spec-audit:` line —
the one `/spec-audit` wrote into plan.md's Constitution Check — under
`**Changes:**`. A session that ran `/implement-audit` standalone, with no
`report.md` to hold its `implement-audit:` line, quotes that line the same way.
These lines are records in the artifact and the journal; nothing checks a commit
for them.
