# AGENTS.md

The working surface for {{NAME}}'s repo, and the canonical one: every other tool's instruction file is
generated from this file plus the rules in `.agents/rules/`, so none of them can drift. Read this
first each session.

Nothing here assumes a particular AI tool. Where one has a feature another lacks, the difference is
named in the sentence that needs it rather than left for you to discover.

## What lives where

| Path | Holds |
|---|---|
| `.agents/AGENTS.md` | this file — the working agreement |
| `.agents/rules/` | the principle rules, always in effect |
| `.agents/skills/` | the Loop and its reviewers, as runnable procedures; each skill carries the templates it writes |
| `.agents/scripts/` | the review machinery every tool can run (`code-review.sh`, `spec-review.sh`, `reviewer-chain.sh`) |
| `.agents/generators/` | the index generators for `apps/`, `integrations/`, `projects/` |
| `.claude/` | the Claude Code half only: subagents, in-session guards, output styles, settings |
| `.githooks/` | native git hooks, firing on every commit whoever made it |
| `apps/`, `integrations/`, `projects/`, `journal/`, `knowledge/`, `decisions/` | your work — the layer never overwrites these |

Claude Code, Codex and Cursor read `.agents/skills/` through symlinks, so there is exactly one copy of
every skill on disk. Gemini and Copilot need a different file format, so their command files are
generated from the same source at install time.

## Working preferences

Replace these with your own once the layer is installed.

- Be concise, direct, practical. Technical depth welcome.
- Name in plain English anything the reader has not seen this session — a project, a rule, a tool, an
  acronym — the first time it appears. When something is unclear the fix is plainer words, never more
  of them.
- Pick the shortest format that stays clear. Never add structure the answer does not need.
- Push back with a better approach when you have one; never agree by default.
- Default to doing the work over planning it. Match the weight of the solution to the problem — an
  inline script beats a service that does the same thing.
- Land the full scope in the session. Do not defer in-scope work to "later".
- {{AUTONOMY}}
- Never call something shipped while a known blocker remains.

## The Loop

Three moves, with a deliberate context break between thinking and doing. Each producer move runs its
own review and then closes itself, so "wrap" is not something you type. The Loop stops for you only on
a hard blocker or a decision that is genuinely yours.

| Move | Command | Runs automatically | Stops for you only on |
|---|---|---|---|
| Think | `/project` → `/spec` | `/spec-audit`, then `/close` | a decision the grill needs from you |
| Do | `/implement` | `/implement-audit`, then `/close` | a failed end-to-end check or mechanism mismatch; a decision |
| Wrap | `/close` | — | invoked by the two moves above (`.agents/skills/close/references/auto-close-gate.md`) |

`/project` does the thinking. Before any design it grills you: every decision the work depends on,
one at a time, its recommendation first, until nothing is left to guess. Then it cuts the work into
roadmap rows and hands one row at a time to `/spec`, which writes that row's spec folder, audits it,
and closes. `/implement` builds one spec folder, audits it, and closes. In a tool without slash
commands, run the same procedure by reading the matching file under `.agents/skills/`.

The break between Think and Do is the point. A chat that wrote the plan and grew attached to its
choices is the wrong one to judge the implementation. Open a new conversation for the Do move; the
spec folder holds everything it needs.

### A project, on disk

The layout is [spec-kit](https://github.com/github/spec-kit)'s; the templates for each file live
beside the skill that writes it, with a `SOURCE.md` naming the spec-kit commit they came from.

| Path, under `projects/<domain>/<YYYY-MM-DD>_<slug>/` | Holds | Written by |
|---|---|---|
| `README.md` | status frontmatter, `## Goal`, `## Outcome` | `/project`, `/close` |
| `ROADMAP.md` | rows R1, R2… with Depends on, Status and Sub-spec — the project's only list of outstanding work | `/project`, `/close` |
| `specs/NNN-name/` | one per row: `spec.md`, `plan.md`, `tasks.md`, `research.md`, then `report.md` | `/spec`, then `/implement` |
| `decisions/NNNN-title.md` | the project's decision records | whoever made the decision |

The README's `next:` is never typed: `/close` derives it from the first ready roadmap row, by the
rule written once in `.agents/skills/project/references/templates/README.md`. A question nobody has
answered is written into the spec where it applies as `[NEEDS CLARIFICATION: <question>]`, and
`/implement` refuses to start while one is open — building past it is guessing.

### One review per artifact, and not by its author

Each artifact gets exactly one review, fired by whatever produced it. The verdict is a record, not a
gate: `/spec-audit` writes its `spec-audit:` line into the spec's `plan.md`, `/implement` writes
`implement-audit:` into its `report.md`, and the close's journal entry quotes both. Nothing refuses a
commit for a missing line; the skills dispatch the review every time instead.

One model writes nearly all the code and nearly all the specs here, so that same model reviewing its
own work shares the blind spots that produced it. `.agents/scripts/reviewer-chain.sh` puts the review
on a different model when one is installed — the Codex CLI out of the box, or any CLI you point
`CONTEXTIUM_REVIEWER_CMD` at. With none installed, the review falls back to a fresh context on the
authoring model and says so, in the report and in the audit line. That is a weaker review, not a
failed one; what would make it a failure is reporting it as though it were independent.

## Memory: three layers

- **Git log** records WHAT changed. Keep commit subjects verb-led so the log reads as memory.
- **Journal** records WHY. A day is a folder, `journal/YYYY-MM-DD/`, holding one file per session
  that `/close` writes; its shape is defined once, in `.agents/skills/close/references/journal-entry.md`.
- **Decision records** hold choices that would be expensive to reverse, in a `decisions/` folder — at
  the repo root, or in the project or subsystem the choice binds. Format and placement:
  `decisions/README.md`.

Reconstructing a past decision needs all three: the log says when and what, the journal says why and
what you learned, the record says what was chosen over what and who agreed.

## Enforcement travels with the repo

The rules that matter are backed by mechanisms, not by hoping the model remembers. Two fire as git
hooks, so they hold no matter which tool drove the change:

- **commit-msg** checks the subject is verb-led and a reasonable length, and blocks AI co-author
  trailers.
- **pre-commit** scans the staged diff for obvious secrets, holds staged decision records and
  journal entries to their formats, and checks the skills and rules a commit touches.

Turn them on with `git config core.hooksPath .githooks` if you skipped that step at install. One
guard — refusing destructive git commands before they run — exists only for Claude Code, because git
offers no hook that fires early enough; every other tool leans on the same caution in prose.

## Tech stack

Document your runtime, orchestration, storage and credentials here. A fresh session reads this before
it reads any code, so it is the cheapest place to prevent a wrong assumption.

## Principles

The rules in `.agents/rules/` are always in effect. They expand on everything above, and every tool's
generated instruction file carries them verbatim.
