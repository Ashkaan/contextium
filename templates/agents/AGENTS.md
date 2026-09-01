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
| `.agents/skills/` | the Loop and its reviewers, as runnable procedures |
| `.agents/scripts/` | the review machinery every tool can run (`code-review.sh`, `spec-review.sh`, `reviewer-chain.sh`) |
| `.agents/templates/` | the lean SPEC template |
| `.agents/generators/` | the index generators for `apps/`, `integrations/`, `projects/` |
| `.claude/` | the Claude Code half only: subagents, in-session guards, output styles, settings |
| `.githooks/` | native git hooks, firing on every commit whoever made it |
| `apps/`, `integrations/`, `projects/`, `journal/`, `knowledge/` | your work — the layer never overwrites these |

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
| Think | `/project` → `/spec` | `/spec-audit`, then `/close` | a decision or a proposed deferral |
| Do | `/implement` | `/implement-audit`, then `/close` | a failed end-to-end check or mechanism mismatch; a decision |
| Wrap | `/close` | — | invoked by the two moves above (`.agents/skills/close/references/auto-close-gate.md`) |

`/project` does the thinking and hands SPEC-writing to `/spec`. `/spec` writes the SPEC, audits it, and
closes. `/implement` builds, audits, and closes. In a tool without slash commands, run the same
procedure by reading the matching file under `.agents/skills/`.

The break between Think and Do is the point. A chat that wrote the plan and grew attached to its
choices is the wrong one to judge the implementation. Open a new conversation for the Do move and
reload the SPEC.

### The SPEC stays lean

Four sections: what was asked, what success looks like (including the 0 / 1 / empty / max / error
edges), the files to touch, and the exact commands that prove it works. A heavy project grows its own
sections when a real gap bites. Do not pad it with boilerplate that degrades to "N/A".

### One review per artifact, and not by its author

Each artifact gets exactly one review, fired by whatever produced it. Both reviews put their result in
a commit trailer (`spec-audit:` / `implement-audit:`), and `.githooks/checks/check-audit-trailers.sh`
refuses a commit that changes a SPEC or a meaningful amount of code without one — the backstop for
commits made by hand, by another agent, or by anything that skipped the Loop.

One model writes nearly all the code and nearly all the SPECs here, so that same model reviewing its
own work shares the blind spots that produced it. `.agents/scripts/reviewer-chain.sh` puts the review
on a different model when one is installed — the Codex CLI out of the box, or any CLI you point
`CONTEXTIUM_REVIEWER_CMD` at. With none installed, the review falls back to a fresh context on the
authoring model and says so, in the report and in the trailer. That is a weaker review, not a failed
one; what would make it a failure is reporting it as though it were independent.

## Memory: two layers

- **Git log** records WHAT changed. Keep commit subjects verb-led so the log reads as memory.
- **Journal** (`journal/YYYY-MM-DD.md`) records WHY, one file per day, written when you wrap. Use the
  labeled markers (Action / Changes / Decisions / Issues / Lessons / Next) so a future session can skim
  it.

Reconstructing a past decision needs both: the log says when and what, the journal says why and what
you learned.

## Enforcement travels with the repo

The rules that matter are backed by mechanisms, not by hoping the model remembers. Two fire as git
hooks, so they hold no matter which tool drove the change:

- **commit-msg** checks the subject is verb-led and a reasonable length, and blocks AI co-author
  trailers.
- **pre-commit** scans the staged diff for obvious secrets (private keys, cloud credentials).

Turn them on with `git config core.hooksPath .githooks` if you skipped that step at install. One
guard — refusing destructive git commands before they run — exists only for Claude Code, because git
offers no hook that fires early enough; every other tool leans on the same caution in prose.

## Tech stack

Document your runtime, orchestration, storage and credentials here. A fresh session reads this before
it reads any code, so it is the cheapest place to prevent a wrong assumption.

## Principles

The rules in `.agents/rules/` are always in effect. They expand on everything above, and every tool's
generated instruction file carries them verbatim.
