# Architecture

Contextium is a methodology, not a framework you import. It gives your AI coding tool an operating
layer: a set of rules, skills (or their command equivalent), agents, and hooks, plus a handful of plain
directories where your work and your knowledge accumulate over time. The whole thing is markdown and
small shell scripts in a git repo. You can read every file, change any of it, and move to a different
tool tomorrow without asking anyone's permission.

Everything shared lives once, in `.agents/`. Claude Code, Codex and Cursor read it through symlinks —
same files, different names — so there is exactly one copy of every rule and skill on disk. Gemini and
Copilot need a different file format, so `scripts/projector/project-rules.sh` generates theirs from the
same source at install time and regenerates it on every re-run. `.claude/` holds only what has no
counterpart elsewhere. The git-hook enforcement travels to every tool; the fresh-context review agents
and the guards that stop a bad command before it runs are Claude Code only.

The point is to make working with an AI agent feel less like chatting and more like running a small
shop with a routine. There's a way you start work, a way you do it, and a way you wrap up. Each of
those is a verb you can invoke, and the methodology gives each one a sensible default behavior.

## What's in the repo

Two halves. One is the AI layer, which is the methodology itself. The other is your data, which starts
empty and fills in as you use it.

| Path | What it holds |
|---|---|
| `.agents/AGENTS.md` | The working agreement, read first every session, shared by every tool |
| `.agents/rules/` | Behavioral rules the agent loads every session |
| `.agents/skills/` | The loop verbs and supporting skills, as slash commands |
| `.agents/scripts/` | The review machinery any tool can run |
| `.agents/generators/` | The index generators for `apps/`, `integrations/`, `projects/` |
| `.agents/reviewers/` | Fresh-context reviewer prompts the skills dispatch; Claude Code reaches them as subagents via `.claude/agents` |
| `.claude/hooks/` | Scripts the harness runs at edit, commit, and prompt time (Claude Code only) |
| `.claude/settings.json` | Wires the hooks to harness events (Claude Code only) |
| `.claude/CLAUDE.md` | Imports `.agents/AGENTS.md`, then adds the Claude-only notes |
| `apps/` | Code you write |
| `integrations/` | External services you connect to |
| `knowledge/` | Reference data, organized by domain |
| `projects/` | Multi-session work, one dated folder each, laid out the way spec-kit lays out a feature |
| `decisions/` | Decision records in MADR format, for choices that would be expensive to reverse |
| `journal/` | Session logs, one folder per day and one file per session |

`.agents/AGENTS.md` is the working surface, reachable as `AGENTS.md` at the repo root. It's short on
purpose: it tells a fresh session where things live, names the loop, and points at the rules.
Everything else loads on demand. `.claude/CLAUDE.md` imports it rather than restating it, so there is
no second copy to drift.

The data directories ship as empty skeletons with a README each. They aren't part of the methodology,
they're where the methodology puts things. The installer never touches them once they exist, which is
how your work survives template updates.

## The Loop

Three verbs. You start work by thinking, you do the work, you wrap up. What makes this more than a
slogan is the boundary between thinking and doing.

| Verb | Skill | What it does |
|---|---|---|
| Think | `/project` → `/spec` | Agree the goal, settle the open decisions, split the work into roadmap rows, then write one spec folder per row — reviewed by `/spec-audit` and committed automatically |
| Do | `/implement` | Build one row's spec, validating as it goes — code-reviewed and committed automatically |
| Wrap | `/close` | Mark finished rows done, journal the session, then commit — auto-fired by the two verbs above, or run by hand |

The third verb isn't one you usually type. Each producer verb runs its own review — `/spec-audit` on
the design, `/implement-audit` on the code — and then invokes `/close` itself on a clean finish, so the
loop wraps itself. It only stops for you when a real decision needs your call. You can still run
`/close` by hand for an ad-hoc session that didn't go through a producer verb.

Here is the part that matters. `/implement` runs in a fresh context. When you've spent a long
conversation thinking through a problem with `/project`, that context is full of dead ends, revisions,
and half-formed ideas. Handing all of that to the implementation step makes the work worse, not
better. So you think in one session, the spec is written and committed, and you start a new session to
build. The spec is the handoff. It carries the decisions forward without the noise.

This is the single most useful idea in the methodology. A plan written by a tired context and then
executed by that same tired context tends to drift, because the model is still arguing with itself
about choices it already made. Cut the context between the two and each step does one job well.

### Before the design: the grill

`/project` opens by stating the goal and the simplest mechanism it can see, and waits for you to say
that is what you meant. Then it reads the code, and only then asks about the choices still open —
each question with its recommended answer first, so the usual reply is "yes". A choice that would not
change a file, an edge case, a data source or the scope is not asked; it is adopted and written down.
Every answer, asked or adopted, lands in the spec's `## Clarifications` with the alternative it beat.
That table is what stops a later session from re-arguing a settled choice.

### The project folder

A project is `projects/<domain>/YYYY-MM-DD_<slug>/`, and its files follow
[spec-kit](https://github.com/github/spec-kit)'s templates, pinned to a release and kept beside the
skill that writes each one:

| File | Holds |
|---|---|
| `README.md` | Front matter, `## Goal`, `## Outcome`. Its `next:` is derived from the roadmap by a script, never typed |
| `ROADMAP.md` | The rows (`R1`, `R2`, …) with what each depends on and its status — the project's only list of outstanding work |
| `specs/NNN-name/` | One folder per row: `spec.md` (your words verbatim, the clarifications, the behavior contract), `plan.md` (the simplest shape, data sources, validation commands), `tasks.md` (what `/implement` executes, tests included), `research.md` (what was looked up, with sources), then `report.md` from `/implement` |
| `decisions/` | MADR records for choices inside this project that would be expensive to reverse |

Rows with no unmet dependency can run at the same time: a close prints one `/implement <slug> r4` block
per ready row, each for its own session in its own `git worktree`, so two builds never share a working
tree. Anything a spec leaves unsettled is written in place as
`[NEEDS CLARIFICATION: …]`, and `/implement` refuses to start while one is open — the project routes
back to `/project` to settle it. `/spec` can also be called on its own when work mid-session turns out
to need a spec, without running the full think flow.

### The two reviewers

Both reviews exist for the same reason: the author is the worst reviewer of their own work, and in this
methodology the author is almost always Claude. A Claude reviewer of Claude's output shares the blind
spot that produced it.

So both reviewers run through `.agents/scripts/reviewer-chain.sh`, which looks for a model that is
not the author. Out of the box it tries the Codex CLI; `CONTEXTIUM_REVIEWER_CMD` points it at any other
CLI that reads a prompt on stdin. If nothing is installed — the common case on a Claude-only machine —
the chain reports that, and the skill falls back to a fresh-context Claude agent and labels the result
`claude-fallback` in the line it records. That fallback is a weaker review, and the point
of labelling it is that a weaker review reported as a strong one is worse than no review at all.

`/spec-audit` runs before any code exists, which makes it the cheapest review in the loop: a missing
edge case costs one line to add to a spec and a rewrite to add after the implementation. It runs two
checks with different jobs — an independent reviewer attacking the design, and a `spirit-check` agent
that reads only your verbatim ask and the behavior contract and asks whether the spec describes the
thing you actually asked for. The second catches what the first structurally cannot: a spec that is
internally excellent and solves the wrong problem. It skips non-material edits on its own, so fixing a
typo in a spec doesn't spend a reviewer call.

`/implement-audit` is the code reviewer, and it runs **once per session**. It writes a marker when it
runs, and `/close` reads that marker rather than judging for itself whether a review already happened —
which is what a prose instruction asks a closing session to do, and what it gets wrong often enough
that people watch the same diff get reviewed twice. Its later rounds review only the fixes, not the
whole diff again: re-reading everything each round makes the reviewer re-decide settled code and turns
each round's own fixes into the next round's findings, which is how a fix loop reaches fifteen rounds.
The loop stops when a round changes nothing, or at four rounds, whichever comes first.

Each reviewer records a one-line verdict where the artifact lives: `/spec-audit` writes its
`spec-audit:` line into the spec's `plan.md`, and `/implement-audit` writes `implement-audit:` into the
row's `report.md`, naming who reviewed, how many rounds, and what is still open. The close's journal
entry quotes it. No hook refuses a commit for a missing line: the skills that produce a spec or a diff
dispatch its review unconditionally, and a gate that can only check that a line exists — not that the
review behind it happened — added friction without adding proof.

### Supporting skills

The loop is the spine. A few other skills hang off it.

`/spec-audit` and `/implement-audit` are the loop's two reviewers, and they are described in their own
section below.

`/implement-audit` is an adversarial pass over code you just finished. It looks for what you missed,
what's inconsistent, what breaks at the edges. `/implement` runs it automatically for substantial
changes, so the review happens before the commit rather than after a bug ships.

`/explain` is for the times you need to understand why something is the way it is before you touch it.
It investigates until it's confident, then gives you a root-cause summary instead of a guess.

There's also `/debate` for talking through a decision from more than one side, and `/author`
for scaffolding a new rule, skill, hook, agent or output style in the shape the existing ones already use.

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
deferral, the journal format, read before asserting (a claim about the code needs a reading from this
session), red before green (a test never seen failing proves nothing), fix the cause rather than the
symptom, and decision records. There's also `write-your-own-rules`, which is the meta-rule that
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
What it does include is `templates/integrations/`, a set of 14 docs-only connector starters for common
services the installer lets you pick from. They're READMEs, not working code: a place to record how you authenticate, where the service
lives, and how you call it. Copy one into `integrations/` when you actually wire that service up, and
fill in the real details.

## Memory in three layers

Memory is split across three surfaces, and each answers a different question.

The git log answers what changed and when. Every commit subject is a one-line record, verb-first, of a
real change. Months later, `git log` is a searchable history of the work.

The journal answers why this session went the way it did. A day is a folder under `journal/`, and each
session `/close` wraps is one file in it, `journal/YYYY-MM-DD/HHMM-<slug>.md`, so two sessions on the
same day never write into each other. The sections are fixed — what was done, what changed, what was
found and from which reading, what you corrected — and a checker refuses an entry that drifts from the
schema, because the fixed labels are what make a year of entries greppable.

Decision records answer why the system is the way it is. A choice that would be expensive to reverse
gets a file in `decisions/`, in [MADR](https://adr.github.io/madr/)'s minimal format: the problem, the
options considered, the one chosen and why. An `accepted` record quotes the words that accepted it,
dated; a record that cannot is `proposed`. A pre-commit check enforces the format, so a discussion
cannot be written down as a decision. Records live in the narrowest folder containing everyone who
could act against them — the repo root for a repo-wide choice, a project folder for one inside a
project — and `decisions/README.md` is the one place the format is written.

You need all three. The git log tells you a file changed on a Tuesday. The journal tells you what that
session learned. The decision record tells you why the obvious alternative was rejected, which is the
thing you'll have forgotten and the thing that saves you from redoing the same argument.

## Advanced patterns, not wired in

This template ships lean on purpose. It is a starting methodology, not a finished fortress. There's a
whole class of heavier machinery that a mature setup grows into, and none of it is wired in here,
because most people don't need it on day one and bolting it on early just gets in the way.

A few of the patterns you can grow toward when the need is real:

- A scheduled orchestration platform for jobs that have to run on a clock and survive a crashed
  session, rather than scripts you trigger by hand.
- A declarative reconciler that watches for drift across many checks and fixes it, instead of
  one-off scripts.
- Per-session git worktrees, so concurrent sessions on parallel roadmap rows never step on each
  other's staged changes.
- Runtime and dependency pinning rules, once you have enough code that version drift starts to bite.

Each of those earns its weight only at a certain scale. Add the mechanism when the failure mode it
prevents has actually happened to you. Until then, the loop and a few wired rules are plenty, and the
lean version is the one that stays out of your way.

## Enforcement travels through git

The Claude-only half under `.claude/` is built on Claude Code primitives (subagents, in-session hooks). The
enforcement that matters, though, is wired through git rather than through the tool, so it fires no
matter who or what made the commit. The commit-subject check, the secret scan, the skill and rule
format checks, and the decision-record and journal-entry checks live once in `.githooks/checks/`, called by the hooks in `.githooks/` (turn them on
with `git config core.hooksPath .githooks`, which the installer offers to do). They sit outside both `.agents/` and `.claude/`
on purpose: a repo set up for a non-Claude tool never gets a `.claude/` directory, and the gate still
has to fire. A commit made by hand or by Claude passes the same one.
