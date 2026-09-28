# Decision records

A decision that would be expensive to reverse gets a file here, or in the
`decisions/` folder nearer to the work it governs. This README is the one place
the format and the placement rule are written down; `.agents/AGENTS.md` and the
rules point here and do not restate them.

## Format

[MADR](https://adr.github.io/madr/) 4.0.0 minimal, plus three frontmatter keys
taken from MADR's full template. The minimal template has no frontmatter of its
own.

```markdown
---
status: accepted
date: 2026-01-10
decision-makers: Your Name
---

# Short title, naming the problem and the answer

## Context and Problem Statement

What forced a choice, in two or three sentences.

## Considered Options

* Option one
* Option two

## Decision Outcome

Chosen option: "Option one", because the reason.

Your Name 2026-01-10: "the words that accepted it"

### Consequences

* Good, because …
* Bad, because …
```

`### Consequences` is optional. Everything else is required.

- **`status`** is one of `proposed`, `rejected`, `accepted`, `deprecated`, or
  `superseded by <path>` — the repo-relative path of the record that replaced
  it, such as `superseded by decisions/0007-some-slug.md`. MADR writes
  `superseded by ADR-0123`; that assumes one global sequence, and here every
  folder numbers its own.
- **`date`** is `YYYY-MM-DD`, the day the record last changed status.
- **`decision-makers`** names who decided. Never blank.
- **`accepted` needs the words that accepted it.** The body carries at least
  one line with a `YYYY-MM-DD` date followed by the decision-maker's words in
  quotes, straight (`"…"`) or typographic (`“…”`) — `Your Name 2026-01-10: "…"`.
  Frontmatter does not count, and neither does a quote with its date after it,
  which is how a discussion gets cited. A record that cannot quote an approval
  is `proposed`: an agent that writes `accepted` over a conversation that never
  decided anything has invented a decision.
- **Filename** is `NNNN-title-with-dashes.md`, lowercase: `NNNN` is the next
  number in this folder, zero-padded to four digits.

## Placement

A record lives in the **narrowest home containing everyone who could act
contrary to it**:

- the repo root's `decisions/`, for a choice that binds the whole repo;
- a project folder's `decisions/` (`projects/<domain>/<date>_<slug>/decisions/`),
  for a choice inside one project;
- a subsystem folder's `decisions/` (`apps/<name>/decisions/`, say), for a
  choice inside one part of the code.

A folder gets `decisions/` when it gets its first record; there is no empty
scaffolding.

Numbers are per folder, so `0003` names a different record in every folder that
has one. A record refers to another **by path**, never by bare number.

When the home turns out to be wrong, **move** the file and renumber it for its
new folder. When the content is replaced, **supersede** it: write the new record
and set the old one's status to `superseded by <new path>`. A record is not
edited into a different decision.

## The check

`.githooks/checks/check-decision-records.sh` holds every record to this format.
The pre-commit hook runs it on the staged records, and `/close` runs it on the
records it is about to commit — a violation refuses either. Each violation
names its part:

| Part | Rejects |
|---|---|
| (a) | no frontmatter, unclosed frontmatter, or a missing `status` / `date` / `decision-makers` |
| (b) | a `status` outside the five words, or `superseded by` a bare number rather than a path |
| (c) | a `date` that is not a real `YYYY-MM-DD` |
| (d) | a blank `decision-makers` |
| (e) | a filename that is not `NNNN-title-with-dashes.md` in lowercase |
| (f) | an `NNNN` already used by another record in the same folder, committed or not |
| (g) | an `accepted` record whose body has no line with a date followed by quoted words |

Placement is not checked: no script can list who could act contrary to a
decision.

Run it by hand:

```bash
bash .githooks/checks/check-decision-records.sh                     # changed since HEAD, staged or not
bash .githooks/checks/check-decision-records.sh --since origin/main # this branch's, committed or not
bash .githooks/checks/check-decision-records.sh decisions/          # every record in a folder
```
