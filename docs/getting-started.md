# Getting Started

This walks you from a clone to your first trip through the loop. It's short because the methodology is
short. The interesting part is the habit, and you pick that up by doing it once.

## What you need

- git, since the whole thing is a git repo.
- An AI coding tool to drive the loop: Claude Code, Gemini CLI, Codex, Cursor, or GitHub Copilot.
- bash, on macOS or Linux. On Windows, use WSL.

That's the list. There's no service to stand up and nothing to deploy.

## Install

From inside the project you want to set up:

```bash
curl -sSL contextium.ai/install | bash
```

Or clone the template and keep it around as the thing you update from later:

```bash
git clone https://github.com/Ashkaan/contextium.git
cd contextium
bash install.sh ~/code/my-project
```

The installer asks which AI tools you use (default Claude Code), your name, and whether the agent should
ask before changing infrastructure or act and report on its own. Then it writes `.agents/` — the working agreement, the
rules, the skills, the review scripts — wires each tool you picked to that one copy, creates the empty
data directories, and turns on the git hooks. It's safe to re-run. On a second run it refreshes the
layer and leaves your data and your customized `AGENTS.md` alone.

To skip the prompt, pass `--tools "claude gemini codex cursor copilot"` (or `--all-tools`). If you'd
rather install into the current directory, run `bash install.sh .` from inside it.

## Open it in your tool

```bash
cd ~/code/my-project
claude          # or: gemini, codex, cursor, or open the repo in VS Code with Copilot
```

The first thing a session reads is the working agreement in `.agents/AGENTS.md`, reachable as
`AGENTS.md` at the repo root. Claude Code reaches it through a one-line `CLAUDE.md` that imports it;
Codex and Cursor read it directly; Gemini and Copilot get `GEMINI.md` and
`.github/copilot-instructions.md` generated from it. One copy, so there is nothing to keep in sync.
The Loop verbs below are slash-command skills in Claude Code, Codex and Cursor — all three reading the
same files in `.agents/skills/` — and generated command files in Gemini and Copilot, so `/project`,
`/implement`, and `/close` work the same everywhere.

## Your first loop

The loop is three verbs. Walk through all three once and the rest is muscle memory.

### Think: `/project`

Run `/project` with no arguments and you'll get the project index. On a fresh install it's empty,
which is expected. The index is where active work shows up once you have some.

To start something, describe it:

```
/project set up a morning briefing that emails me my calendar and todos
```

The think flow does what its name says: it thinks. First it states the goal and the simplest way it
sees to reach it, and waits for you to say that is what you meant. Then it reads the code, and asks
about the choices still open — each question with its recommended answer first, so most replies are
"yes". It splits the work into roadmap rows, and hands the design to `/spec`.

`/spec` writes the project folder the way [spec-kit](https://github.com/github/spec-kit) lays one out:

```
projects/personal/2026-01-12_morning-briefing/
  README.md                  goal, outcome, and a next: derived from the roadmap
  ROADMAP.md                 R1, R2, … with what each depends on and its status
  specs/001-calendar-digest/
    spec.md                  your words verbatim, the clarifications, the behavior contract
    plan.md                  the simplest shape, the data sources, the validation commands
    tasks.md                 what /implement will do, tests included
    research.md              what was looked up, with sources
```

Each spec goes through `/spec-audit` and is committed automatically — there's no pause to sign off.
You review it in the next `/implement` session and revise it if it drifted. Anything the spec couldn't
settle is marked `[NEEDS CLARIFICATION: …]` in place, and `/implement` won't start on that row until
you settle it with `/project`. (You can also call `/spec` directly when a change turns out to need a
spec mid-session.)

### Do: `/implement`

Here's the move that makes the methodology work. Start a fresh session before you implement.

The thinking session is full of dead ends and revisions, and feeding all of that into the build step
makes the work worse. The spec is the clean handoff. So you close the thinking session, open a new one,
and run the command the close printed:

```
/implement morning-briefing r1
```

It reads the row's spec back, builds against it, and validates as it goes, then writes `report.md`
beside the spec. Because it starts cold, it builds what the spec says rather than re-litigating the
choices you already made. When it finishes cleanly it runs an adversarial code review and then wraps
the session itself — see below. When two rows don't depend on each other, the close prints a command
for each. To run them at the same time, give each session its own checkout
(`git worktree add ../my-project-r2`) so their edits and commits stay apart.

### Wrap: `/close`

You usually don't type this one. `/spec` and `/implement` each invoke `/close` themselves once they
finish cleanly, so the loop closes without a manual step. `/close` runs the tests of what changed,
marks each finished row `done` and re-derives the project's `next:`, writes this session's journal
file (`journal/YYYY-MM-DD/HHMM-<slug>.md`), commits, and prints the next `/implement` command for every
row that is now ready. If the session changed real code that nothing reviewed —
a quick fix you made by hand that grew — it runs the code review first. It checks a marker rather than
guessing: if `/implement` already reviewed this session's work, `/close` reuses that result instead of
paying for a second review of the same diff. The journal records why the session went the way it did, which the git log can't capture.

You can still run `/close` by hand:

```
/close
```

for an ad-hoc session that didn't go through `/spec` or `/implement` — a quick fix, some notes, a
config change you want journaled and committed.

## The two reviewers

`/spec-audit` attacks the spec before any code exists — the cheapest review you get, because a missing
edge case costs one line to add here and a rewrite to add later. `/spec` runs it for you. It also
checks the spec against your own words, which catches the failure a design review can't: a spec that is
excellent and solves the wrong problem.

`/implement-audit` attacks the finished code. `/implement` runs it for you on substantial changes, and
you can call it directly any time you want a second look before you trust something.

Both try not to be Claude. Claude wrote the work, so a Claude reviewer shares whatever blind spot
produced it — they run on a different model when one is installed. Install the Codex CLI, or point
`CONTEXTIUM_REVIEWER_CMD` at any CLI that reads a prompt on stdin:

```bash
export CONTEXTIUM_REVIEWER_CMD='your-cli --some-flag'
```

With nothing installed, both fall back to a fresh-context Claude agent and say so in the line they
record. That is still worth running. What it is not is independent, and the label is there so you
never mistake one for the other.

Each writes its verdict where the work lives — `spec-audit:` into the spec's `plan.md`,
`implement-audit:` into the row's `report.md` — and the journal entry quotes it.

## Decisions worth keeping

When a choice would be expensive to reverse — a database, a data format, a boundary between two
systems — write it down as a decision record in `decisions/`. The format is
[MADR](https://adr.github.io/madr/)'s minimal one, described in `decisions/README.md`: the problem,
the options, the one chosen and why. A record only says `accepted` when it quotes the words that
accepted it; otherwise it is `proposed`. A pre-commit check enforces that, so a conversation can't
quietly turn into a decision nobody made.

## One more skill worth knowing early

`/explain` is for understanding before touching. When you inherit a tangle and need to know why it's
shaped that way, `/explain` investigates until it's confident and hands you the root cause instead of a
guess.

## Where to go next

Read `docs/architecture.md` for how the pieces fit, especially the fresh-context boundary and the way
rules are backed by hooks. Then build something small with the loop. The first real value shows up when
you start adding your own rules: the agent does something wrong, you correct it, and you write the
correction down so the next session doesn't repeat it. That loop, more than any single feature, is what
makes the setup yours.
