# Journal entry shape (/close § 3)

Detail lifted out of [close/SKILL.md](../SKILL.md) so the skill body stays
short. This file is the SSOT for the session file's shape — its path, its front
matter, its heading, its section set and what each section may hold. § 3 reads
it before writing, and `scripts/check-journal-entry.ts` (run by
`journal-file.ts --check` and by Land) enforces the parts marked **checked**
below. Nothing else defines any of this.

**A session entry records the session** — what was done, what was found and
from which reading, what was learned, what the user corrected, what waits on
them. It is not a second home for decisions: a choice lives where the work that
made it lives, and the entry links it (§ Decisions below).

### One file per session

A journal day is a FOLDER, `journal/<date>/`, and a session is one file inside
it: `journal/<date>/<HHMM>-<filename-stem>.md`, where `HHMM` is the session's own start
time in local time and `<filename-stem>` is a short filename label, normalized
to at most 60 characters by the script. There is no new-day shape and no existing-day shape. **Do not
assemble that path by hand** — `scripts/journal-file.ts "<filename-stem>"` owns it, it
creates the day folder, and it persists its answer where `land.ts` checks it:

```bash
node --experimental-strip-types .agents/skills/close/scripts/journal-file.ts "security-policy-ai"
```

The filename label above is NOT the frontmatter `slug:`. Despite its name,
`slug:` contains the full session heading, exactly matching the first body
heading. For that filename, a valid entry is:

```markdown
---
date: 2026-05-27
time: "14:32"
slug: one-off (security policy and client data in AI)
project: null
tags: []
---

### one-off (security policy and client data in AI)
**Action:** <verb>

<one-line summary>

**Changes:**
- ...

**Findings:**
- <what was found> — <the reading it came from: a command, `file:line` or URL>

**Decisions:**
- [0003-retry-once](../../projects/web/2026-01-10_checkout-flow/decisions/0003-retry-once.md)
- rejected: <the option not taken> — <why, one clause>

**Corrections:**
- "<the user's words>"

**Lessons:**
- ...

**Blocked:**
- <what waits on the user or an outside party, and for what>
```

Use the actual session date/time and heading. Do not put `security-policy-ai`
in `slug:` when the heading is `one-off (security policy and client data in AI)`.
Quote the YAML value if the heading needs it (for example, when it contains
`: `). A repair to the heading or `slug:` does not require renaming the allocated
file; keep its ledger path stable. Run the check in /close § 3 after each write.

Every field that used to sit in the day file's `sessions:` list entry — `project`,
`root_cause_status`, `implement_audit_rounds`, `rules_should_have_fired`,
`runtime_identity`, … — is now a top-level key in this file's own front matter.
The `sessions:` list is gone: a file IS a session.

**`time`** is the thread's start, in local time —
`node --experimental-strip-types scripts/thread.ts --started --local`, read from T3 Code's own record of
the thread, or recorded when a harness session outside T3 was first seen. Never the close time: a session that closes after midnight would
otherwise file under a day it did not happen on.

**Name collisions are `journal-file.ts`'s job, and it checks two places.** Two
sessions closing in the same minute with the same slug both want
`HHMM-<slug>.md`; the loser takes `HHMM-<slug>-2.md`, then `-3`. The second
place is the trunk: the other session allocated the name in ITS OWN
worktree, which this one cannot see, so a local-only check picks a name that
collides at merge time. `land.ts` re-checks against a freshly fetched
trunk and renames again if the race was lost in between. Never
overwrite: the file you would overwrite is another session's close.

**Why this shape.** A day kept as one shared file that every session appends
to is merged by concurrent closes without a git conflict — which silently drops
whole sessions from it. One file per session removes the shared write entirely.

**Prose that belongs to the day rather than to any session** — a preamble before
the first session — goes in `journal/<date>/0000-day.md`; do not add to it in
an ordinary close. A `0000-*.md` file is the day's, not a
session's, and the section checks below do not apply to it.

### Section set (checked)

A section is a line at column 0 of the form `**Label:**`. The set is CLOSED:
these eight, in this order when present, and the check refuses any other label
at column 0 (a `**bold lead.**` inside a bullet is not a label, and a label
quoted inside a fenced code block is not read). All are optional except
`**Action:**` and the summary line; a light session is heading + Action +
summary and nothing else.

| Section | Holds |
|---|---|
| `**Action:**` | the verb, on the same line — one of the closed set under § Field reference |
| `**Changes:**` | what changed: files, systems, records. A one-off session's small choice goes here, beside the change it explains |
| `**Findings:**` | what was found, each bullet naming the reading it came from — § Findings |
| `**Decisions:**` | links to where a choice lives, and `rejected:` lines — § Decisions. Nothing else |
| `**Corrections:**` | the user's verbatim words, one quoted bullet per row — § Corrections |
| `**Lessons:**` | what surprised, and what to do differently |
| `**Blocked:**` | work waiting on the user — money, an outbound message, host infrastructure, a vendor — and what it waits for |
| `**Root-Cause Status:**` | for an incident: `<status> — <detail>`, with the same status in the front matter key |

**Retired.** `**Next:**` — outstanding project work is the project's
`ROADMAP.md`, the one list of what is left, and the close prints the next
command from it; work waiting on the user is `**Blocked:**`. `**Issues:**` —
an investigation's results are `**Findings:**`. The check refuses both, naming
where the content belongs. One-off labels (`Verification`, `Result`,
`Machine review`, …) fold into Changes, Findings or Lessons.

### Decisions (checked)

A Decisions bullet is one of exactly two shapes, on one line each:

```markdown
**Decisions:**
- [0003-retry-once](../../projects/web/2026-01-10_checkout-flow/decisions/0003-retry-once.md)
- [spec 002 § Clarifications](../../projects/web/2026-01-10_checkout-flow/specs/002-retry/spec.md)
- rejected: firing a live run now — the host reboots for a kernel update at 02:00
```

1. **A markdown link, and nothing after it** — `- [title](path)`, whitespace
   only after the closing parenthesis. The link text carries the title; the
   reasoning lives at the target and is not restated here. A link followed by
   `because …` fails the check.
2. **A `rejected:` line** — `- rejected: <what was not done> — <why>`, at most
   500 characters after the `- `. The literal prefix is what a later session
   greps the journals for before re-proposing a thing
   (`grep -rh '^- rejected:' journal/`), so the line starts with it and does
   not wrap.

Anything else under `**Decisions:**` — prose, a bullet that wraps onto an
indented continuation line, a link with a tail — is refused with the line
number. An empty `**Decisions:**` label passes; so does an entry without one.

**Where a small choice goes.** Every stage of a project already has a file for
a choice, and the entry links whichever holds it:

| While | The choice lives in |
|---|---|
| designing | `spec.md` § Clarifications, or a `research.md` `Decision:` |
| building | `report.md` § Deviations from Plan |
| anything expensive to reverse | `decisions/NNNN-<title>.md`, format and placement per `decisions/README.md` in the narrowest folder containing everyone who could act contrary to it |
| a one-off session, no project | `**Changes:**`, beside the change it explains — not Decisions |

A `rejected:` line is the one shape that keeps its reasoning in the entry,
because the journal is the memory of what the user turned down.

### Findings

Optional. Each bullet states what was found and names the reading it came from
— a command that was run, a `file:line`, a URL. A README, a summary, a memory,
an earlier write-up or a subagent's report is a claim, not a reading, until it
was read this session. Nothing checks the content; the convention is what makes
a Findings bullet worth more than a sentence in Changes.

```markdown
**Findings:**
- `land.ts:366` skips the journal gate when the checker file is absent — `sed -n 360,372p close/scripts/land.ts`
- a month of front matter carries `root_cause_status` values outside the set — `grep -ho '^root_cause_status: .*' journal/2026-01-*/*.md | sort | uniq -c`
```

### Field reference

- **`<heading>`** — `one-off (<description>)` OR `<domain>/<YYYY-MM-DD>_<slug>`
  with optional ` (<parenthetical>)`, ` — <em-dash-tail>`, `/<sub-slug>`,
  or `_<sub-slug>` suffix. The pattern, for anything that wants to match it
  (not checked — no entry has failed it):
  `^(one-off \(.+\)|[a-z][a-z0-9-]+/[0-9]{4}-[0-9]{2}-[0-9]{2}_[a-z][a-z0-9_-]*( \(.+\)| — .+|/[a-z][a-z0-9-]*|_[a-z][a-z0-9-]*)?)$`.
  Any heading level is accepted by the slug check; `###` is the convention.
- **`slug:`** — the heading, verbatim (checked: the two must agree).
- **`<verb>`** — `**Action:**` is the first line under the heading, and its
  value is one of the closed set (not checked):
  `completed | progressed | scaffolded | fixed | investigated | planned | shipped | migrated | removed | updated`.
- **Summary** — one line, no embedded newlines, the next non-blank line after
  Action. Enough for a future session to decide whether to read deeper.
- **`project:`** — the project FOLDER path, `<domain>/<date>_<slug>` or
  `projects/<domain>/<date>_<slug>`, or `null` for a one-off. `land.ts` resolves
  it as a path under the repo to derive the next command, and
  refuses the close on a bare slug.
- **`root_cause_status:`** — optional; when present, one of (checked):
  `fixed` | `unknown-pending-verification` | `deferred-by-user-directive` | `n/a`.
  `fixed` means the cause is gone; `unknown-pending-verification`
  means a fix shipped and a scheduled run or a probe still has to prove it;
  `deferred-by-user-directive` means the user chose to leave the cause, in
  their words; `n/a` means no incident. There is no `deferred-with-project` —
  a project is not a place to park a cause.
- **Target size** — no minimum and no upper limit; a light session is three lines.

**What reads the body.** Anything that reports on the journal reads the front
matter, and of the body the `**Corrections:**` bullets (`- "quote"` — count,
dates and quotes) and the lines starting `rejected:`. Nothing reads Next, and
nothing ever did.

### Runtime identity capture (UI-surface sessions)

If the session shipped to a UI surface — a web app, a dashboard, a device —
populate a `runtime_identity:` list in the session file's front matter at
journal-write time, one entry per surface:

```yaml
runtime_identity:
  - target: <URL, hostname, device id, or in-repo runtime path>
    branch: <branch tested>
    head_sha: <git rev-parse HEAD from the deployed repo>
    runtime: <named runtime — e.g. Pages project, a device, a scheduler job>
    rebuilt: yes | no
    duplicates_checked: yes | no | n/a
    evidence: <repo path under docs/evidence/ or "none">
```

## Corrections — quote the user, do not paraphrase them

Every other section of a journal entry is the agent writing about its own
session — self-reported, lossy, and written by the party being graded. This
section is the one part of the entry the agent does not author.

Run it on every close:

```bash
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts          # one row per turn
node --experimental-strip-types .agents/skills/close/scripts/corrections.ts --full   # a turn that spans lines
```

One `HH:MM <TAB> text` row per thing the user said, in the order they said it.
A close never needs the third mode, `--since <iso> --until <iso> --json`, which
returns the same rows for every T3 thread in a time window as one JSON object
(its shape is in the script's header) for readers of many threads at once.

**The source is the harness's own record, never memory.** In T3 Code it is
T3's message table, `projection_thread_messages` — the one place every harness
T3 runs lands in, since T3 is what renders the conversation. Outside T3 it is
the harness's own session file (`transcripts.ts`: Claude Code's
`~/.claude/projects/*.jsonl`, Codex's `~/.codex/sessions/**/rollout-*.jsonl`).
When none exists the script says so; report that, and omit the section.

**An `AskUserQuestion` answer is something the user said.** Reading messages
alone makes every reply given through a question prompt invisible, and those
replies are often the ones that redirect a session ("Run the two serially
instead"). T3 keeps them on `projection_thread_activities` as
`user-input.resolved`, and the script reads both and merges them into one
timeline.

**Two shapes come back, and they are quoted differently:**

| Row | What it is | How to render it |
|---|---|---|
| bare text | free text the user typed into the prompt — their words | quote it verbatim, like any typed turn |
| `[chose] <label>` | an option the agent wrote that the user selected | report it as a choice — *"they chose X"* — and NEVER inside quotation marks |
| `[answered] <text>` | an answer from a Claude Code question prompt, whose record does not say which of the two it was | report it as an answer — *"they answered X"* — never as a quote |

The second rule is the same one that governs a citation: the words in an option
label were written by the agent, so quoting one back as the user's correction
is the exact defect this section exists to prevent. The decision is theirs; the
wording is not.

**A citation is not nothing.** When the user quotes the assistant back at it,
T3 writes `[Assistant quote](t3-citation://…)`. The quoted `text=` is the
agent's own prose and is dropped — but the link's `comment=` is what the USER
typed about the quote, and it is often the sharpest line in the session ("How
can we prevent that?"). The script keeps those and drops the quotes.

The script owns this half — data is fetched, judgment is prompted — and MUST
NOT be replaced by reading the conversation back from memory: a recalled quote
is a paraphrase wearing quote marks.

**The judgment left to the agent is the filter, and only the filter.** Keep
rows where the user corrected, redirected or rejected something: a format they
could not read, a question they could not answer, an approach they sent back, a
premise they overturned. Drop rows that only move work along — "next", "go
ahead", a fresh request, an answer to a question that was asked.

Then copy each kept row into `**Corrections:**` **verbatim, in the user's words,
inside quotes**, one bullet per row and nothing else on the line — anything
reporting on the journal counts every bullet:

```markdown
**Corrections:**
- "The format of this summary is hard to read. Can we try other formats? Maybe bullets?"
- "no idea what you're talking about. I need a plan, not a build."
```

MUST NOT summarize, soften, shorten, generalize or re-word the quote. MUST NOT
append a defence, an explanation of what the agent meant, or a note that it was
already fixed — the fix belongs in `**Changes:**`. A paraphrase turns the only
independent signal in the entry back into the agent's account of itself, which
is the entire defect this section exists to remove.

Zero kept rows is a real and common outcome: omit the section rather than
reaching for something to fill it. This step never halts the close — a thread
with no typed turns prints nothing and the entry is written without the
section.
