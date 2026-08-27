# CLAUDE.md

This file provides guidance to Claude Code when working in this repository. It is the **working
surface** — the canonical place to look for what's loaded by default and how the AI layer is shaped.
Other rule files live alongside it in `.claude/rules/`; this file is what every fresh session reads
first.

The project index is not always-loaded. Run `/project` with no arguments to render the live
priority-sorted index, or `/project <slug>` to load and route a specific one. See
`.claude/skills/project/SKILL.md`.

## User Preferences

Replace these with your actual preferences when you install this template.

- Be concise, direct, practical. Technical depth welcome.
- Name in plain English anything the reader hasn't seen this session (a project, a rule id, a tool, an
  acronym) the first time it appears; when something is unclear the fix is plainer words, never more
  of them.
- Pick the shortest format that stays clear (prose, table, or list); never add structure the answer
  doesn't need. The response format itself is set by the `decision-only` output style
  (`.claude/output-styles/decision-only.md`), which `settings.json` selects as the default. The older
  `brevity` style ships alongside it — switch with `outputStyle` if you prefer it.
- Push back with better approaches when warranted; never agree by default.
- Default to implementation over planning; don't expand a 30-minute task into a 3-hour plan.
- Fix issues silently when the fix is reversible and scoped; ask before infrastructure changes
  (`@rule:ask-before-host-infra-changes`).
- Don't declare a feature shipped while a known blocker remains.

## The Loop

Three verbs, with a fresh context between think and do. Each producer verb runs its own review and
then closes itself, so "wrap" is not a verb you type. The loop stops for you only on a hard blocker or
a decision that is genuinely yours.

| Verb | Skill(s) | Runs automatically | Stops for you only on |
|---|---|---|---|
| Think | `/project` → `/spec` | `/spec-audit`, then `/close` | a decision or a proposed deferral |
| Do | `/implement` | `/implement-audit`, then `/close` | a failed end-to-end check or mechanism-match; a decision |
| Wrap | `/close` | — | invoked by the producer verbs (see `.claude/skills/close/references/auto-close-gate.md`) |

`/project` does the thinking and hands SPEC-writing to `/spec`. `/spec` writes the SPEC, audits it via
`/spec-audit`, and closes. `/implement` builds, audits via `/implement-audit`, and closes.

**Each artifact gets exactly one review, fired by whatever produced it.** The code review runs once per
session — `/implement-audit` writes a marker, and `/close` reads it rather than deciding for itself
whether a review already happened. Both reviews put their result in a commit trailer
(`spec-audit:` / `implement-audit:`), and `.githooks/checks/check-audit-trailers.sh` refuses a commit
that changes a SPEC or a meaningful amount of code without one. The skills are the gate; the git hook
is the backstop for commits made by hand, by another agent, or by anything that skipped the loop.

**Reviews try not to be written by the author.** Claude writes most of the code and most of the SPECs
here, so a Claude reviewer shares the blind spots that produced the work. `reviewer-chain.sh` puts the
review on a different model when one is installed — the Codex CLI out of the box, or any CLI you point
`CONTEXTIUM_REVIEWER_CMD` at. With none installed, the review falls back to a fresh-context Claude
agent and says so, in the report and in the trailer. That is a weaker review, not a failed one; what
would make it a failure is reporting it as though it were independent.

## Tech Stack (customize for your stack)

Document your runtime, orchestration, storage, and credentials here. A fresh session reads this before
it reads any code, so it is the cheapest place to prevent a wrong assumption.

## Architecture

| Directory | Purpose |
|---|---|
| `/apps/{name}/` | Apps: README + SPEC + scripts. Each is self-contained. |
| `/integrations/{name}/` | External service connectors: README + client + auth helpers |
| `/projects/{domain}/` | `YYYY-MM-DD_brief-description/` — multi-session work with status frontmatter |
| `/journal/` | Daily session logs `YYYY-MM-DD.md` with structured markers |
| `/knowledge/{domain}/` | Domain data and reference material. Customize for your needs. |
| `/.claude/` | The AI layer — rules, skills, agents, hooks, output styles |
| `/.claude/hooks/checks/` | The reviewers (`code-review.sh`, `spec-review.sh`, `reviewer-chain.sh`) |
| `/.githooks/` | Native git hooks, firing on every commit regardless of who made it |

## Memory

Two layers — the git log (commit subjects plus structured trailers) for WHAT changed; the journal
(Action / Changes / Decisions / Issues / Lessons / Next, per day) for WHY.
