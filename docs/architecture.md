# Architecture

Contextium is a methodology, not a framework you import. It gives Claude Code an operating layer: a set
of rules, skills, agents, and hooks under `.claude/`, plus a handful of plain directories where your
work and your knowledge accumulate over time. The whole thing is markdown and small shell scripts in a
git repo. You can read every file, change any of it, and move to a different tool tomorrow without
asking anyone's permission.

The point is to make working with an AI agent feel less like chatting and more like running a small
shop with a routine. There's a way you start work, a way you do it, and a way you wrap up. Each of
those is a verb you can invoke, and the methodology gives each one a sensible default behavior.

## What's in the repo

Two halves. One is the AI layer, which is the methodology itself. The other is your data, which starts
empty and fills in as you use it.

| Path | What it holds |
|---|---|
| `.claude/rules/` | Behavioral rules the agent loads every session |
| `.claude/skills/` | The loop verbs and supporting skills, as slash commands |
| `.claude/agents/` | Fresh-context sub-reviewers the skills dispatch |
| `.claude/hooks/` | Scripts the harness runs at edit, commit, and prompt time |
| `.claude/templates/` | The SPEC template and other starting points |
| `.claude/settings.json` | Wires the hooks to harness events |
| `CLAUDE.md` | The root router, read first every session |
| `apps/` | Code you write |
| `integrations/` | External services you connect to |
| `knowledge/` | Reference data, organized by domain |
| `projects/` | Multi-session work, one dated folder each |
| `journal/` | Daily session logs |

`CLAUDE.md` at the root is the working surface. It's short on purpose. It tells a fresh session where
things live, names the loop, and points at the rules. Everything else loads on demand.

The data directories ship as empty skeletons with a README each. They aren't part of the methodology,
they're where the methodology puts things. The installer never touches them once they exist, which is
how your work survives template updates.

## The Loop

Three verbs. You start work by thinking, you do the work, you wrap up. What makes this more than a
slogan is the boundary between thinking and doing.

| Verb | Skill | What it does |
|---|---|---|
| Think | `/project` | Plan the work and write a lean SPEC |
| Do | `/implement` | Execute the SPEC, validating as it goes |
| Wrap | `/close` | Journal the session, then commit |

Here is the part that matters. `/implement` runs in a fresh context. When you've spent a long
conversation thinking through a problem with `/project`, that context is full of dead ends, revisions,
and half-formed ideas. Handing all of that to the implementation step makes the work worse, not
better. So `/implement` refuses to run in a long or contaminated context. You think in one session,
you write the SPEC, and then you start a new session to build. The SPEC is the handoff. It carries the
decisions forward without the noise.

This is the single most useful idea in the methodology. A SPEC written by a tired context and then
executed by that same tired context tends to drift, because the model is still arguing with itself
about choices it already made. Cut the context between the two and each step does one job well.

The SPEC itself is short. The template has four sections: the ask in the human's own words, the
behavior that counts as success, the files to touch, and how you'll know it works. That's enough for a
fresh session to build against and enough for a reviewer to check. Heavier projects grow their own
sections when a real gap bites, not before.

### Supporting skills

The loop is the spine. A few other skills hang off it.

`/probe` is an adversarial pass over work you just finished. It looks for what you missed, what's
inconsistent, what breaks at the edges. `/close` runs it automatically for substantial changes, so the
review happens before the commit rather than after a bug ships.

`/explain` is for the times you need to understand why something is the way it is before you touch it.
It investigates until it's confident, then gives you a root-cause summary instead of a guess.

There's also `/debate` for talking through a decision from more than one side, and `/propose-rule`
for the moment you've corrected the agent once too often and want the correction to stick.

## Rules are mechanisms, not prose

A rule that only lives in a document doesn't fire. It gets forgotten in exactly the moment it was
written to cover. So the load-bearing rules in this template are backed by something that actually
runs.

Look at `.claude/settings.json`. It wires four hooks to harness events:

- `commit-gate.sh` checks the commit subject and scans the diff for secrets before a commit lands.
- `check-destructive-git.sh` catches the git commands you'll regret (`reset --hard`, `clean -fd`, a
  force push) and makes you confirm.
- `block-memory-writes.sh` stops the agent from scribbling into harness scratch paths instead of the
  repo, so work product ends up somewhere you can actually find it.
- `session-checklist.sh` reminds the session of the loop at prompt time.

The rule file states the reasoning, the hook does the enforcing, and the two reference each other. If
you can't wire a rule to a mechanism, the honest move is to keep it short and call it advisory. The
starter rules follow this: `mechanisms-not-prose` is the principle, and the hooks above are it in
practice.

The rest of the starter rules are principles, not policies specific to anyone's setup. Voice (how to
write for a human so it doesn't read like a bot), depth (when to present options versus just doing the
thing), boundary inputs (enumerate the edges before the happy path), simplest solution first, no
deferral, and the journal format. There's also `write-your-own-rules`, which is the meta-rule that
tells you how to grow the set with your own corrections. That growth is where the layer gets valuable.
The starter rules encode a way of working; your rules encode your work.

## Apps versus integrations

Two directories, one boundary, and people get it wrong constantly, so it's worth stating plainly.

`apps/` is code you wrote. A script, a scheduled job, a small library other code imports, a CLI. It's
named for what it does in your domain.

`integrations/` is for external services you connect to. A SaaS API, a database, a tool running
somewhere else. The folder is named for the thing at the other end, not for your code that talks to it.
An integration wraps something you don't own.

The test: if you deleted the external service, would the folder still make sense? If yes, it's an app.
If the folder only exists because that service exists, it's an integration.

The template ships both as empty skeletons, because your apps and your integrations are yours to build.
What it does include is `templates/integrations/`, a set of 15 docs-only connector starters for common
services. They're READMEs, not working code: a place to record how you authenticate, where the service
lives, and how you call it. Copy one into `integrations/` when you actually wire that service up, and
fill in the real details.

## Two-layer memory

Memory is split across two surfaces, and each answers a different question.

The git log answers what changed and when. Every commit subject is a one-line record, verb-first, of a
real change. Months later, `git log` is a searchable history of the work.

The journal answers why. One file per day under `journal/`, written by `/close` at the end of a working
session. It uses labeled markers rather than prose: what the session set out to do, what actually
changed, the decisions and the roads not taken, what went wrong, what to do differently, and the next
concrete step. The journal is the one place the no-bold writing rule is deliberately overridden,
because those markers are what make a day's entry greppable by a future session.

You need both. The git log tells you a file changed on a Tuesday. The journal tells you why you chose
that approach over the obvious one, which is the thing you'll have forgotten and the thing that saves
you from redoing the same argument.

## Advanced patterns, not wired in

This template ships lean on purpose. It is a starting methodology, not a finished fortress. There's a
whole class of heavier machinery that a mature setup grows into, and none of it is wired in here,
because most people don't need it on day one and bolting it on early just gets in the way.

A few of the patterns you can grow toward when the need is real:

- A scheduled orchestration platform for jobs that have to run on a clock and survive a crashed
  session, rather than scripts you trigger by hand.
- A declarative reconciler that watches for drift across many checks and fixes it, instead of
  one-off scripts.
- Multi-model SPEC review, where a second model adversarially attacks your SPEC before you build.
- Per-session git worktrees, so concurrent sessions never step on each other's staged changes.
- Runtime and dependency pinning rules, once you have enough code that version drift starts to bite.

Each of those earns its weight only at a certain scale. Add the mechanism when the failure mode it
prevents has actually happened to you. Until then, the loop and a few wired rules are plenty, and the
lean version is the one that stays out of your way.

## Portability across tools

The AI layer under `.claude/` is built on Claude Code primitives (skills, subagents, hooks). The
methodology those primitives express is portable, and Contextium ships it to other agents from a single
source so nothing drifts.

`apps/projector/project-rules.sh` assembles `.claude/templates/methodology.md` plus the eight rules and
writes them into whichever instruction file a tool reads: `AGENTS.md` for agents that follow the
cross-tool standard, and `.cursor/rules/contextium.mdc`, `GEMINI.md`, `.github/copilot-instructions.md`,
`.windsurfrules`, `.clinerules`, or `CONVENTIONS.md` for the rest. Edit the source, re-run, and every
tool file updates together.

Enforcement is portable too, but through git rather than through any one tool. The commit-subject and
secret-scan checks live once in `apps/quality/check-commit-subject.sh` and `apps/quality/check-secrets.sh`,
called both by the Claude Code commit-gate hook and by the git hooks in `.githooks/` (turn them on with
`git config core.hooksPath .githooks`, which the installer offers to do). A commit made by any tool, or
by hand, passes the same gate.

What does not port is the turnkey layer: the Loop as one-keystroke slash commands and the
auto-dispatched review agents. Those are Claude Code features. In other tools you run the same Loop as a
procedure you invoke in plain language. The method and the guardrails are universal; the ergonomics are
Claude's.
