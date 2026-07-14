# Getting Started

This walks you from a clone to your first trip through the loop. It's short because the methodology is
short. The interesting part is the habit, and you pick that up by doing it once.

## What you need

- git, since the whole thing is a git repo.
- An AI coding tool to drive the loop: Claude Code, Gemini CLI, Codex, Cursor, or GitHub Copilot.
- bash, on macOS or Linux. On Windows, use WSL.

That's the list. There's no service to stand up and nothing to deploy.

## Install

Clone the template, then run the installer pointed at the project you want to set up.

```bash
git clone https://github.com/Ashkaan/contextium.git
cd contextium
bash install.sh ~/code/my-project
```

The installer asks which AI tools you use (default Claude Code), your name, and whether the agent should
ask before changing infrastructure or act and report on its own. Then it writes each tool's native
config into the target, creates the empty data directories, and wires the git hooks. It's safe to
re-run. On a second run it refreshes the config and leaves your data and your customized `CLAUDE.md`
alone.

To skip the prompt, pass `--tools "claude gemini codex cursor copilot"` (or `--all-tools`). If you'd
rather install into the current directory, run `bash install.sh .` from inside it.

## Open it in your tool

```bash
cd ~/code/my-project
claude          # or: gemini, codex, cursor, or open the repo in VS Code with Copilot
```

The first thing a session does is read the instructions file for your tool: `CLAUDE.md` for Claude Code,
`GEMINI.md` for Gemini, `AGENTS.md` for Codex, the `.cursor/` rules for Cursor, or
`.github/copilot-instructions.md` for Copilot. They all carry the same methodology and rules, projected
from one source. The Loop verbs below are slash-command skills in Claude Code and native commands in the
other tools, so `/project`, `/implement`, and `/close` work the same everywhere.

## Your first loop

The loop is three verbs. Walk through all three once and the rest is muscle memory.

### Think: `/project`

Run `/project` with no arguments and you'll get the project index. On a fresh install it's empty,
which is expected. The index is where active work shows up once you have some.

To start something, describe it:

```
/project set up a morning briefing that emails me my calendar and todos
```

The think flow does what its name says: it thinks. It asks the questions it needs, pushes back if the
idea is half-baked, and lands on a plan. Then it hands the plan to `/spec`, which writes the SPEC with
the lean template. Four sections: what you actually asked for in your own words, what success looks like
including the edge cases, the files to touch, and the exact check that proves it works. `/spec`
sanity-checks its own interpretation against your ask, then commits the SPEC automatically — there's no
pause to sign off. You review it in the next `/implement` session and revise on the branch if it drifted.
(You can also call `/spec` directly when a change turns out to need a SPEC mid-session.)

Resist the urge to make the SPEC long. Four sections is enough to build against and enough to review.
The template even says so. Heavier sections come later, when a real project demands them.

### Do: `/implement`

Here's the move that makes the methodology work. Start a fresh session before you implement.

`/implement` refuses to run in a long context. That's not a quirk, it's the design. The thinking
session is full of dead ends and revisions, and feeding all of that into the build step makes the work
worse. The SPEC is the clean handoff. So you close the thinking session, open a new one, and run:

```
/implement my-project
```

It reads the SPEC back, builds against it, and validates as it goes. Because it starts cold, it builds
what the SPEC says rather than re-litigating the choices you already made. When it finishes cleanly it
runs an adversarial code review and then wraps the session itself — see below.

### Wrap: `/close`

You usually don't type this one. `/spec` and `/implement` each invoke `/close` themselves once they
finish cleanly, so the loop closes without a manual step. `/close` writes the day's journal entry,
updates any project it touched, and commits (and for substantial ad-hoc work it wasn't already reviewing,
it runs an adversarial pass first, so blind spots surface before the commit rather than after a bug
ships). The journal records why you did things the way you did, which the git log can't capture. Together
they're your memory: the log for what changed, the journal for why.

You can still run `/close` by hand:

```
/close
```

for an ad-hoc session that didn't go through `/spec` or `/implement` — a quick fix, some notes, a
config change you want journaled and committed.

## Two more skills worth knowing early

`/implement-audit` is a standalone adversarial pass over code you just finished. `/implement` runs it
for you on substantial changes, but you can call it directly any time you want a second look before you
trust something.

`/explain` is for understanding before touching. When you inherit a tangle and need to know why it's
shaped that way, `/explain` investigates until it's confident and hands you the root cause instead of a
guess.

## Where to go next

Read `docs/architecture.md` for how the pieces fit, especially the fresh-context boundary and the way
rules are backed by hooks. Then build something small with the loop. The first real value shows up when
you start adding your own rules: the agent does something wrong, you correct it, and you write the
correction down so the next session doesn't repeat it. That loop, more than any single feature, is what
makes the setup yours.
