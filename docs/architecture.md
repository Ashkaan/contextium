# Architecture

Contextium is a methodology, not a framework you import. It turns one git repo — your workbench —
into the place every project, every record of the work, and every skill your AI tool runs all live.
The whole thing is markdown and small shell scripts. You can read every file, change any of it, and
move to a different tool tomorrow without asking anyone's permission.

Everything shared lives once. The working agreement is `AGENTS.md` at the root, a link to
`.agents/AGENTS.md`; the skills, agent prompts, checks and guards are in `.agents/`. Most tools read
`AGENTS.md` and `.agents/skills/` where they are. The rest reach them through links in your home
folder, and the guards reach each tool through the hook file it reads, linked or merged. There is no in-repo `.claude/`,
no git hooks directory, and no generated copy per tool, so there is nothing to drift.

The point is to make working with an AI agent feel less like chatting and more like running a small
shop with a routine. There's a way you start work, a way you do it, and a way you wrap up. Each of
those is a verb you can invoke, and each ends by landing its work where the next session will find it.

## What's in the workbench

Two halves. One is the AI layer, which is the methodology itself. The other is your data, which starts
empty and fills in as you use it.

| Path | What it holds |
|---|---|
| `AGENTS.md` | A link to `.agents/AGENTS.md`, the working agreement every session reads first |
| `.agents/skills/` | The eleven skills, each with its scripts and the templates it writes; `review/` is the reviewer chain |
| `.agents/agents/` | Agent prompts the skills dispatch in a fresh context |
| `.agents/checks/` | The checks `/close` runs before it commits |
| `.agents/hooks/` | The pre-tool guards, plus `claude-hooks.json`: the guards in the shape Claude Code, Codex and Grok Build read, with your workbench's path and your own hooks filled in by the installer |
| `.agents/hooks.json` | The guards in Antigravity's shape; present only while Antigravity is wired |
| `.agents/gemini-settings.json` | Gemini CLI's settings: `AGENTS.md` as its context file, and the guards; present only while Gemini CLI is wired |
| `.agents/user-hooks.json` | Your own hooks, for any hook event, in the Claude Code shape; you create it, and every run merges it into `claude-hooks.json` and never writes it |
| `.agents/user-gemini-settings.json` | Your own Gemini CLI settings; every run merges them into `gemini-settings.json` |
| `.agents/generators/` | The index generators: the app index rewrites `apps/README.md`; the project and integration indexes print to the terminal |
| `.agents/output-styles/` | Response styles `/author` writes; empty on install |
| `.agents/harness` | `harness=` the tool you drive the workbench with, `agent=` the model family that writes the code, and `tools=` every tool wired in this workbench |
| `apps/` | Code you write |
| `integrations/` | External services you connect to |
| `knowledge/` | Reference data, organized by domain |
| `projects/` | Multi-session work, one dated folder each, laid out the way spec-kit lays out a feature |
| `decisions/` | Decision records in MADR format, for choices that would be expensive to reverse |
| `journal/` | Session logs, one folder per day and one file per session |

Each folder Contextium fills under `.agents/` holds a `.contextium-manifest`: every file it installed
there, with a checksum. A re-run replaces each skill, agent, hook, check or generator Contextium ships,
whole — so an edit you made inside one of those is overwritten — and never looks at an entry you
added beside them. An entry a newer release stops shipping is removed only while it still matches its
checksum; an edited one is kept and named.

The data directories ship as empty skeletons with a README each. The installer creates them once and
never touches them again, which is how your work survives template updates. `decisions/README.md` is
the one exception: it states the record format the checks enforce, so an upgrade adds it when it is
missing, and never overwrites one that is there.

## What's in your home folder

Skills and agent prompts reach the tools that don't read the workbench directly through links, so what
every tool runs is the versioned copy in your workbench:

| Link | Points to | Made when |
|---|---|---|
| `~/.agents/skills` | `<workbench>/.agents/skills` | always |
| `~/.claude/skills` | `~/.agents/skills` | Claude Code is wired |
| `~/.claude/agents` | `<workbench>/.agents/agents` | the same |
| `~/.claude/output-styles` | `<workbench>/.agents/output-styles` | the same |
| `~/.gemini/config/skills` | `~/.agents/skills` | Antigravity is wired |
| `~/.codex/hooks.json` | `<workbench>/.agents/hooks/claude-hooks.json` | Codex is wired and you have no hooks file of your own |
| `~/.grok/hooks/contextium.json` | `<workbench>/.agents/hooks/claude-hooks.json` | Grok Build is wired |
| `<workbench>/.gemini/settings.json` | `.agents/gemini-settings.json` | Gemini CLI is wired |

The guards are merged, not linked, into `~/.claude/settings.json`, and into `~/.codex/hooks.json` when
that is already a file of yours; a file you had before gets a `.pre-contextium` copy on the first
merge. Every entry Contextium adds starts with `: contextium;`, so a re-run replaces its own entries
and leaves every other key and hook as it was. A real file or folder in the
way of a link is moved aside to `<path>.pre-link`, never deleted.
`.agents/checks/check-harness-config-links.ts` checks the links, and that every hook manifest still
routes each tool's shell and write calls to both guards, any time you run it; `--fix` relinks.
A tool is wired when you pick it, and stays wired: the `tools=` line of `.agents/harness` records
every tool a run wired, and each re-run wires the union of those and the ones named then.
"Wired" here always means named on `tools=`: an existing `~/.claude` or `~/.gemini/config` on its
own wires nothing. `--all-tools` wires Claude Code, Codex, Gemini CLI, Grok Build and Antigravity.
`--drop-tool <name>` is the only way a tool leaves. It removes that tool's file in `.agents/` while
it is still as installed, and it also undoes that tool's home wiring, touching only what points at this workbench or carries
Contextium's `: contextium;` mark: Grok Build's `~/.grok/hooks/contextium.json` link; Codex's
`~/.codex/hooks.json` link, or Contextium's entries in a hooks file of your own; Claude Code's merged
entries in `~/.claude/settings.json` and its three `~/.claude` links; Antigravity's
`~/.gemini/config/skills` link. A dropped tool stays dropped on later runs until you name it again.
A tool the same run names — the harness, and under T3 Code its agents — stays wired, so to drop
the tool you drive the workbench with, name a different `--harness` (or `--agents`) in that run.

## AGENTS.md: your text and Contextium's blocks

`AGENTS.md` opens with sections that are yours: working preferences, including the autonomy line the
installer asks about, and a Stack section for your runtime, storage and credentials. Below them come
Contextium's sections, each fenced between `<!-- contextium:<name> -->` and `<!-- /contextium -->`:
what lives where, how records are written, the skills, the shape a skill must have, and the Standards.

A re-run of the installer replaces each fenced block with the template's current one, drops a block
the template no longer has, and appends a new one at the end. Every line outside the fences is copied
through untouched. So you can edit your preferences, fill in your stack, and add standards of your own
in a section outside the blocks, and an upgrade never undoes it. An edit inside a block is lost on the
next run, which is why the Standards block says to put yours elsewhere.

## The Loop

Three verbs. You start work by thinking, you do the work, you wrap up. What makes this more than a
slogan is the boundary between thinking and doing.

| Verb | Skill | What it does |
|---|---|---|
| Think | `/project` → `/spec` | Agree the goal, settle the open decisions, split the work into roadmap rows, then write one spec folder per row — reviewed by `/spec-audit` and landed automatically |
| Do | `/implement` | Build one row's spec, run the checks in a fixed order, get the code reviewed — then land it |
| Wrap | `/close` | Verify, update the project, journal the session, land it and prove it landed — fired by the two verbs above, or run by hand |

The third verb isn't one you usually type. Each producer verb runs its own review — `/spec-audit` on
the design, `/implement-audit` on the code — and then invokes `/close` itself on a clean finish. It
only stops for you when a real decision needs your call.

Here is the part that matters. `/implement` runs in a fresh context. When you've spent a long
conversation thinking through a problem with `/project`, that context is full of dead ends, revisions,
and half-formed ideas. Handing all of that to the implementation step makes the work worse, not
better. So you think in one session, the spec is written and landed, and you start a new session to
build. The spec is the handoff. It carries the decisions forward without the noise.

Nothing blocks a long session from running `/implement`; the skill checks its own context and tells
you to start fresh when it is carrying the conversation that wrote the spec. `/project` makes the same
call when it routes a project that is ready to build: in a short session it starts `/implement`
itself, and in a long one it prints the command for a new session.

### Before the design: the grill

`/project` opens by stating the goal and the simplest mechanism it can see, and waits for you to say
that is what you meant. Then it reads the code, and only then asks about the choices still open — at
most four questions a round, each with its recommended answer first, so the usual reply is "yes". A
choice that would not change a file, an edge case, a data source or the scope is not asked; it is
adopted and written down. Every answer, asked or adopted, lands in the spec's `## Clarifications`
with the alternative it beat. That table is what stops a later session from re-arguing a settled
choice.

### The project folder

A project is `projects/<domain>/YYYY-MM-DD_<slug>/`, and its files follow
[spec-kit](https://github.com/github/spec-kit)'s templates, pinned to v1.0.10 and kept beside the
skill that writes each one:

| File | Holds |
|---|---|
| `README.md` | Front matter, `## Goal`, `## Outcome`. Its `next:` is derived from the roadmap by a script, never typed |
| `ROADMAP.md` | The rows (`R1`, `R2`, …) with what each depends on and its status — the project's only list of outstanding work |
| `specs/NNN-name/` | One folder per row: `spec.md` (your words verbatim, the clarifications, the behavior contract), `plan.md` (the simplest shape, data sources, validation commands), `tasks.md` (what `/implement` executes, tests included), `research.md` (what was looked up, with sources), then `report.md` from `/implement` |
| `decisions/` | MADR records for choices inside this project that would be expensive to reverse |

`.agents/skills/close/scripts/roadmap.ts` is the one writer of a row's status and of the `next:` it
derives. `/implement` only ever sets a row `in-progress`; `/close` sets it `done` when the row's
`report.md` says the spec is complete. Anything a spec leaves unsettled is written in place as
`[NEEDS CLARIFICATION: …]`, and `/implement` refuses to start while one is open — the project routes
back to `/project` to settle it.

Rows with no unmet dependency can run at the same time. A close prints one `/implement <slug> <row>`
command per ready row, each for its own session.

## Sessions and worktrees

Every session works in a git worktree of its own, and the checkout your sessions share is where their
work lands, never where it is written.

A session whose tool already made it a worktree — a T3 Code thread, `claude -w`, a Codex app thread —
uses that one. A session that started in the main checkout gets one on its first write from
`.agents/skills/close/scripts/write-root.sh`, placed where your recorded tool keeps its own so the
tool's worktree view shows it:

| `harness=` | New worktrees go under | Branch |
|---|---|---|
| `claude` | `<workbench>/.claude/worktrees/` | `worktree-<name>` |
| `gemini` | `<workbench>/.gemini/worktrees/` | `session/<name>` |
| `codex` | `~/.codex/worktrees/<repo-key>/` (or `$CODEX_HOME/worktrees/<repo-key>/`), where `<repo-key>` is the repo's folder name plus 8 hex of its path's hash, so two repos never share a folder | `session/<name>` |
| `grok` | `~/.grok/worktrees/<workbench-name>/` | `session/<name>` |
| `t3`, `cursor`, `vscode`, `antigravity` | `<workbench-parent>/<workbench-name>.worktrees/`, beside the repo | `session/<name>` |

The two in-repo folders are git-ignored by the installer. Each worktree is recorded in a per-session
ledger under `~/.cache/workbench/threads/`, keyed on the session's id: T3 Code's thread id, read from
its own database; elsewhere the tool's session id, or one generated and remembered for that checkout.
`/close` walks that ledger, so it lands every worktree the session wrote to, including one for another
repo it touched.

`land.ts` does the landing, per worktree: it runs the checks, commits, merges the trunk into the
worktree (so a conflict stays in the session's own copy, not the shared one), pushes, and removes the
worktrees it made. It refuses to land a repo with no `origin`. Before it merges it registers a merge
driver for `ROADMAP.md`, `roadmap-merge.ts`, in the repo's `.git/info/attributes`: two sessions that
each flipped their own row merge cell by cell instead of conflicting, and `land.ts` re-derives the
README's `next:` from the merged table. The same cell changed two ways is still a conflict, and a
`next:` that can't be re-derived from the merged table stops the close too, rather than pushing a
README that names the wrong row. A worktree your tool made is left for the tool to clean up. Then it fetches again
and proves three things: every merge is on the remote trunk, the journal entry is in the tree, and no
worktree still holds anything. Only then does it print
`origin/<trunk> is at <sha> — closing this tab loses nothing.` The trunk's name is read from the
remote, not assumed to be `main`. Any failure prints `NOT CLOSED: <reason>` and leaves the worktrees
intact for a re-run.

## Checks, and when they run

Three places, each catching something the others can't.

While building, `/implement` hands its checks to `.agents/skills/implement/scripts/validate.ts`,
which runs them in one fixed order: each touched package's lint, then its typecheck; its tests; a dry
run of the workbench checks below; then the code review. No argument puts review before lint, and a
lint failure means the review never runs. When the review's fixes change the tree, lint and tests run
again and the end-to-end walk is owed again. Lint, typecheck and tests are found by convention — the
package's `lint`, `typecheck` or `check`, and `test` scripts or make targets — so there is no settings
file to keep. If the change touched a web app, `/qa` has to finish on the exact tree that ships before
the session can close.

Before each commit, `land.ts` runs the workbench checks over what the session changed:
`check-decision-records.ts`, `check-skills.ts` on any skill folder that moved,
`check-integration-manifest.ts` on any integration README that moved (its front matter, against the
schema in `integrations/README.md`), `check-scripts.ts` on any script under `.agents/` that moved
(it must carry a test, and the test must run it rather than import it; a script Contextium shipped
passes until you edit it, since its tests live in the Contextium repo), `check-secrets.ts` and
`check-standards-refs.ts` from `.agents/checks/`, and the journal checker from the close skill. A
violation refuses the close with every failing line printed. This replaces the git hooks earlier
versions shipped: a hook only fires in a clone whose hooks path points at it, and these run on every
landing because landing is the only way work reaches the trunk.

Before each tool call, in the tools where they are wired (Claude Code, Codex, Grok Build, Gemini CLI
and Antigravity), two guards run — probed firing in each, against a control run without the wiring
(Gemini CLI only in a trusted folder, which the installer sets up). `check-shared-checkout-write.sh` refuses an edit, or a shell command that writes, into the
shared checkout, and names the session's worktree to write to instead. `check-host-infra-safety.sh`
refuses commands that change shared host infrastructure — `sudo` over `ssh`, writes under `/etc/`,
network and service changes — and commands that would kill the session running them. Both are wired
whichever autonomy you chose; the autonomy answer is a line in `AGENTS.md`, not a switch on the
guards.

## The reviewers

Both reviews exist for the same reason: the author is the worst reviewer of their own work. A reviewer
running on the same model as the author shares the blind spot that produced the mistake.

So every review goes through `.agents/skills/review/`, which reads `policy.json`: one row per kind of
work, each an ordered list of model CLIs. The chain walks a row until one answers, so one vendor being
down is not an outage. A review row skips the family recorded as `agent=` in `.agents/harness` (an
Antigravity author counts as Gemini; Cursor and Copilot name no single family, so nothing is skipped).

| Row | Used by | Order |
|---|---|---|
| `adversarial-review` | code review, spec review | Codex, then Grok |
| `judgment` | the spirit check | Grok, then Codex, then your own agent |
| `panel` | `/debate`, `/explain` | Claude, Codex and Grok together, every seat kept |

Both review rows are marked `"fallback": "fresh-context"`. When no vendor in the row can answer —
most installs have one model CLI — the chain exits 3, and the skill runs the same review with a
fresh-context agent in your own session. `validate.ts` prints `NEED_FALLBACK_REVIEW=1` and exits 3:
the review is pending, not passed, until the fallback reviewer's findings are handed to
`validate.ts --fallback-review <file>`, which passes or asks for fixes the same way an independent
review does. The recorded line carries `claude-fallback (fresh context, NOT independent)`, so a weaker review is never
passed off as an independent one. A reviewer that answered in the wrong shape is not a missing one:
the code review asks the chain once more, and if nothing usable comes back either review fails and
says the work was not audited.

`/spec-audit` runs before any code exists, which makes it the cheapest review in the loop: a missing
edge case costs one line to add to a spec and a rewrite to add after the implementation. It runs two
checks with different jobs — a reviewer attacking the design, and the spirit check, which reads only
your verbatim ask and the behavior contract and asks whether the spec describes the thing you actually
asked for. The second catches what the first structurally cannot: a spec that is internally excellent
and solves the wrong problem. It skips non-material edits on its own, so fixing a typo in a spec
doesn't spend a reviewer call.

`/implement-audit` is the code reviewer, and it runs once per session. A marker records that it ran,
so a second call repeats the verdict instead of reviewing the same diff again. Its later rounds review
only the fixes: re-reading everything each round makes the reviewer re-decide settled code and turns
each round's own fixes into the next round's findings. Nits are held and fixed in one pass at the end.
The loop stops when nothing changed since the last round, at a clean round, when a round is mostly
re-opening its own fixes, or at round four, which the script enforces.

Each reviewer records a one-line verdict where the artifact lives: `spec-audit:` into the spec's
`plan.md`, and `implement-audit:` into the row's `report.md`, naming who reviewed and what is still
open. The close's journal entry quotes it. No check refuses a commit for a missing line; the skills
that produce a spec or a diff dispatch its review unconditionally.

### Supporting skills

`/qa` looks at the real running product. It serves the app, runs impeccable against the rendered page
and fixes what it finds, takes screenshots at desktop, tablet and phone widths, and hands them to a
fresh-context reviewer. Playwright and Chromium install on first use, and impeccable installs or
upgrades itself when the published version is newer than yours. A tool that cannot be installed is
reported as `skipped`, never as a pass, and `/implement` won't close a changed web app without a
complete run.

`/explain` is for the times you need to understand why something is the way it is before you touch it.
It investigates until it's confident — in parallel across the `panel` models for a deep question —
then gives you a root-cause summary instead of a guess.

`/debate` has three models argue a decision from three positions: pragmatist, skeptic and visionary.
When a model's CLI is missing or fails, another argues its seat and the synthesis says so, because two
seats argued by one model are less independent than three.

`/author` scaffolds a new skill, hook, agent prompt or response style in the shape the existing ones
use, then checks it. For a skill, that shape is the `Skill shape` block of `AGENTS.md`, checked by
`.agents/checks/check-skills.ts`.

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
What the Contextium repo does include is `templates/integrations/`, a set of 14 docs-only connector
starters for common services, which the installer lets you pick from. They're READMEs, not working
code: a place to record how you authenticate, where the service lives, and how you call it. That folder
is not copied into your workbench; to pull a starter in later, re-run `install.sh` from the Contextium
repo with `--integrations "<name>"`, then fill in the real details. `integrations/README.md` holds the
front-matter schema every integration README follows, and `/close` checks it.

## Memory in three layers

Memory is split across three surfaces, and each answers a different question.

The git log answers what changed and when. Every landing is a commit whose subject says what the
session did, and months later `git log` is a searchable history of the work.

The journal answers why this session went the way it did. A day is a folder under `journal/`, and each
session `/close` wraps is one file in it, `journal/YYYY-MM-DD/HHMM-<slug>.md`, so two sessions on the
same day never write into each other. The sections are fixed — what was done, what changed, what was
found, the decisions, what you corrected (quoted verbatim from the session's own record), the lessons,
and what is blocked — and the
close refuses an entry that drifts from the schema, because the fixed labels are what make a year of
entries greppable. The schema is `.agents/skills/close/references/journal-entry.md`.

Decision records answer why the system is the way it is. A choice that would be expensive to reverse
gets a file in `decisions/`, in [MADR](https://adr.github.io/madr/)'s minimal format: the problem, the
options considered, the one chosen and why. An `accepted` record quotes the words that accepted it,
dated; a record that cannot is `proposed`. `/close` checks the format before it commits, so a
discussion cannot be written down as a decision. Records live in the narrowest folder containing
everyone who could act against them — the repo root for a repo-wide choice, a project folder for one
inside a project — and `decisions/README.md` is the one place the format is written.

You need all three. The git log tells you a file changed on a Tuesday. The journal tells you what that
session learned. The decision record tells you why the obvious alternative was rejected, which is the
thing you'll have forgotten and the thing that saves you from redoing the same argument.

## Advanced patterns, not wired in

This template ships lean on purpose. There's a whole class of heavier machinery that a mature setup
grows into, and none of it is wired in here, because most people don't need it on day one and bolting
it on early just gets in the way.

- A scheduled orchestration platform for jobs that have to run on a clock and survive a crashed
  session, rather than scripts you trigger by hand.
- A declarative reconciler that watches for drift across many checks and fixes it, instead of
  one-off scripts.
- A deploy on every push. `land.ts` has the hook for it and leaves it off: add
  `.agents/deployable-prefixes.json` (a JSON array of path prefixes whose push deploys something) and
  your own `.agents/deploy/await-deploy-run.sh`, and a landing that touches one of those paths must see
  a deploy start before the close succeeds.
- Runtime and dependency pinning rules, once you have enough code that version drift starts to bite.

Each of those earns its weight only at a certain scale. Add the mechanism when the failure it prevents
has actually happened to you. Until then, the loop and the checks it already runs are plenty.
