# Getting Started

This walks you from a clone to your first trip through the loop. It's short because the methodology is
short. The interesting part is the habit, and you pick that up by doing it once.

## What you need

- git, since the whole thing is a git repo.
- Claude Code, the agent that drives the loop.
- bash, on macOS or Linux. On Windows, use WSL.

That's the list. There's no service to stand up and nothing to deploy.

## Install

Clone the template, then run the installer pointed at the project you want to set up.

```bash
git clone https://github.com/your-org/contextium.git
cd contextium
bash install.sh ~/code/my-project
```

The installer asks two things: your name and whether the agent should ask before changing
infrastructure or act and report on its own. Then it lays the `.claude/` AI layer into the target, drops
a starter `CLAUDE.md`, and creates the empty data directories. It's safe to re-run. On a second run it
refreshes the AI layer and leaves your data and your customized `CLAUDE.md` alone.

If you'd rather install into the current directory, run `bash install.sh .` from inside it.

## Open it in Claude Code

```bash
cd ~/code/my-project
claude
```

The first thing a session does is read `CLAUDE.md`, which is the router. It's deliberately short. It
names the loop, tells the agent where things live, and points at the rules under `.claude/rules/`.
Everything else loads when it's relevant, not all at once.

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
including the edge cases, the files to touch, and the exact check that proves it works. `/spec` can
sanity-check its own interpretation against your ask before you sign off. You review the SPEC and sign
off. (You can also call `/spec` directly when a change turns out to need a SPEC mid-session.)

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
what the SPEC says rather than re-litigating the choices you already made.

### Wrap: `/close`

When the work is done:

```
/close
```

This writes the day's journal entry, updates any project it touched, and commits. For substantial
changes it runs an adversarial review first, so blind spots surface before the commit rather than after
a bug ships. The journal records why you did things the way you did, which the git log can't capture.
Together they're your memory: the log for what changed, the journal for why.

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
