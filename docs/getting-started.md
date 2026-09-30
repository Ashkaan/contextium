# Getting Started

This walks you from an empty folder to your first trip through the loop. It's short because the
methodology is short. The interesting part is the habit, and you pick that up by doing it once.

## What you need

- git, and somewhere to push: `/close` lands every session by pushing to your workbench's `origin`.
- bash, on macOS or Linux. On Windows, use WSL.
- jq. The installer uses it to merge its guards into your tool's settings, and the review scripts
  read their policy table with it.
- Node 22.6 or later. Every script in `.agents/` except the guards and the worktree setup is
  TypeScript, run as `node --experimental-strip-types <script>.ts`, which Node has accepted since
  22.6 (earlier releases of that line print an ExperimentalWarning for it, which is harmless). `/qa` assumes 22.18 or later.
  Without Node the installer still lays the layer down, but it cannot check it, and says so.
- An AI tool to drive the loop. T3 Code is the recommended one; Claude Code, Codex, Cursor, VS Code
  with Copilot, Gemini CLI, Antigravity and Grok Build all work.
- For reviews that are independent of the model writing your code: the Codex CLI or the Grok CLI,
  signed in, and not the same family as the agent you write with. Without one, reviews still run in a
  fresh context and are recorded as not independent.

There's no service to stand up and nothing to deploy.

## Install

```bash
curl -sSL contextium.ai/install | bash
```

Or clone the template and keep it around as the thing you update from later:

```bash
git clone https://github.com/Ashkaan/contextium.git
cd contextium
bash install.sh
```

The questions come in this order:

1. Which tool you drive the workbench with. T3 Code is the default.
2. For T3 Code, which agent it runs: Claude Code, Codex, or both. The first one you name is recorded
   as the model family that writes your code.
3. If the tool or agent isn't installed, whether to install it now. The answer defaults to no, and
   the installer prints the vendor's own install command either way.
4. Where your workbench is. The default is `~/code/workbench`, and the folder is created if it
   doesn't exist.
5. Your name, and whether the agent should ask before changing infrastructure or act and report.
6. Which integration starters to copy in, if any. The rest stay in the Contextium repo; re-run the
   installer with `--integrations "<name>"` to pull one in later.
7. If the workbench has no `origin`, a remote URL for it (Enter skips). When you skip and the GitHub
   CLI (`gh`) is signed in, it offers to create a private GitHub repo named after the folder and push
   to it, defaulting to no.

To skip the interview, pass the answers as flags. `--yes` takes the default for anything you didn't
pass, never installs software unless you add `--install-missing`, and never creates a remote:

```bash
bash install.sh ~/code/workbench --yes --harness t3 --agents claude --name "Your Name"
```

It's safe to re-run. A second run replaces each skill, agent, hook, check and generator Contextium
ships, leaves alone anything you added beside them, replaces only the Contextium sections of
`AGENTS.md`, keeps everything else you wrote, and remembers your tools from `.agents/harness`.

A workbench can be driven by more than one tool, so every tool a run wires is recorded on the
`tools=` line of `.agents/harness`, and a later run wires the union of the recorded tools and the ones
you name then. Picking a different harness never unwires the old one. The only way a tool leaves is
`--drop-tool <name>` (repeatable): it comes off `tools=`, and its file in `.agents/` —
`hooks.json` for Antigravity, `gemini-settings.json` and the `.gemini/settings.json` link for Gemini
CLI — is removed while it is still as installed, or kept and named if you changed it. The drop
it also undoes that tool's home wiring, touching only what points at this workbench or carries
Contextium's `: contextium;` mark: Grok Build's `~/.grok/hooks/contextium.json` link; Codex's
`~/.codex/hooks.json` link, or Contextium's entries in a hooks file of your own; Claude Code's merged
entries in `~/.claude/settings.json` and its three `~/.claude` links; Antigravity's
`~/.gemini/config/skills` link. A dropped tool stays dropped on later runs until you name it again.
A tool the same run names — the harness, and under T3 Code its agents — stays wired, so to drop
the tool you drive the workbench with, name a different `--harness` (or `--agents`) in that run.

## What you get

In the workbench:

```
AGENTS.md               a link to .agents/AGENTS.md, the working agreement
.agents/
  AGENTS.md             your preferences and stack, plus Contextium's sections
  harness               harness=<your tool>  agent=<the model family that writes code>
                        tools=<every tool wired in this workbench>
  skills/               the eleven skills and their scripts
  agents/               four agent prompts the skills dispatch in a fresh context
  checks/               the checks /close runs before it commits
  hooks/                the pre-tool guards, and claude-hooks.json: the guards in the shape
                        Claude Code, Codex and Grok Build read
  hooks.json            the guards in Antigravity's shape, only while Antigravity is wired
  gemini-settings.json  Gemini CLI's settings: AGENTS.md as its context file, and the
                        guards, only while Gemini CLI is wired
  generators/           the index generators: apps/README.md, and printed project and
                        integration indexes
  output-styles/        empty until /author writes a response style there
apps/  integrations/  knowledge/  journal/  projects/  decisions/
.gitignore              ignores .claude/worktrees/ and .gemini/worktrees/
```

Each folder under `.agents/` that Contextium fills carries a `.contextium-manifest`, the list of what
it installed there with a checksum per file. That list is how a re-run tells its own files from
yours.

In your home folder, `~/.agents/skills` links to the workbench's `.agents/skills`, and the tools that
look elsewhere are linked to that: `~/.claude/skills`, `~/.claude/agents` and
`~/.claude/output-styles` when Claude Code is wired, and `~/.gemini/config/skills` when Antigravity
is wired. A tool is wired only while `tools=` names it; having `~/.claude` or `~/.gemini/config` on
disk is not enough.

The guards reach each wired tool through the file that tool reads. For Claude Code they are merged
into `~/.claude/settings.json`. For Codex, `~/.codex/hooks.json` becomes a link to
`.agents/hooks/claude-hooks.json`, or has the guards merged in when it is a file of your own; Codex
runs them only after you accept its hook-trust prompt once. For Grok Build, `~/.grok/hooks/contextium.json`
links to that same file. For Gemini CLI, the workbench's `.gemini/settings.json` links to
`.agents/gemini-settings.json`; a settings file you already had there becomes
`.agents/user-gemini-settings.json` and is merged in on every run. Antigravity reads
`.agents/hooks.json` where it is. The first merge into a file you already had saves the original
beside it as `<file>.pre-contextium`; a file the installer creates gets no backup. Every later run
replaces only the entries Contextium made. `--all-tools` wires Claude Code, Codex, Gemini CLI, Grok
Build and Antigravity at once.

If something already sits where a link goes, it is moved aside to `<path>.pre-link` and the installer
says so. Nothing is deleted.

## The repo and its remote

A folder that isn't a git repo yet is made one, on `main`, and the installed tree becomes its first
commit. If git doesn't know your name and email yet, the commit is skipped and the installer prints the
two `git config` commands to run first. An existing repo is left as it is; the installer doesn't
commit into it.

If you gave no remote during the install, add one before your first `/close`, which refuses to land
without it:

```bash
cd ~/code/workbench
git remote add origin <your-remote-url>
git push -u origin main
```

The installer ends by checking the home links and guard manifests, and you can run the same check any
time:

```bash
node --experimental-strip-types .agents/checks/check-harness-config-links.ts
```

## Open it in your tool

In T3 Code, add the workbench as a project, start a thread, and type `$project`. T3 Code can give each
thread its own worktree, and the skills adopt it. In the other tools, open the workbench and run
`/project` (in Codex, `$project`). Gemini CLI and Grok Build load a project's files only in a folder
you have trusted; for Gemini CLI the installer adds the workbench to `~/.gemini/trustedFolders.json`.

A session that starts in the main checkout instead of a worktree gets one on its first write, placed
where your tool keeps its own. The shared checkout is where every session's work lands, so nothing is
written there directly.

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
about the choices still open — at most four at a time, each with its recommended answer first, so
most replies are "yes". It splits the work into roadmap rows, and hands the design to `/spec`.

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

Each spec goes through `/spec-audit`, and then `/spec` closes the session itself — there's no pause to
sign off. Anything the spec couldn't settle is marked `[NEEDS CLARIFICATION: …]` in place, and
`/implement` won't start on that row until you settle it with `/project`. You can also call `/spec`
directly when a change turns out to need a spec mid-session.

### Do: `/implement`

Here's the move that makes the methodology work. Start a fresh session before you implement.

The thinking session is full of dead ends and revisions, and feeding all of that into the build step
makes the work worse. The spec is the clean handoff. So you let the thinking session close, start a
new one (in T3 Code, a new thread), and run the command the close printed:

```
/implement morning-briefing r1
```

It reads the row's spec back and builds against it, checking each file as it goes. Then
`validate.ts` runs the checks in a fixed order — lint and typecheck, tests, the workbench's own
checks, then the code review — and, if you changed a web app, `/qa` takes screenshots and checks the
design. It writes `report.md` beside the spec and closes the session itself.

When two rows don't depend on each other, the close prints a command for each. Run each in its own
session. Each session builds in its own worktree, so their edits and commits stay apart until each
one lands. Both flip their own row in the same `ROADMAP.md`, and `/close` merges that file row by row
and re-derives `next:` afterwards, so the second landing doesn't stop on a conflict neither session
made.

### Wrap: `/close`

You usually don't type this one. `/spec` and `/implement` each invoke `/close` once they finish
cleanly. It runs in five steps:

1. Verify: run the checks and tests of every app and skill folder the session changed. A failure stops
   the close here, before anything is recorded.
2. Project: mark each finished row `done` and re-derive the project's `next:`.
3. Journal: write this session's file, `journal/YYYY-MM-DD/HHMM-<slug>.md`, and check its shape.
4. Land: run the workbench checks, commit, merge your trunk, push, and prove against a fresh fetch
   that the work is on `origin`. A worktree the close made is removed; one your tool made (a T3 Code
   thread's) is left for the tool to clean up, and checked to hold nothing unlanded.
5. Report: copy the block `land.ts` printed — what shipped, a link to the journal entry, the next
   `/implement` command for every ready row, and the last line:

```
origin/main is at 3f9c2e1 — closing this tab loses nothing.
```

Only `land.ts` prints that line. If anything fails it prints `NOT CLOSED: <reason>` instead, leaves
the worktree as it is, and a re-run picks up where it stopped.

You can still run `/close` by hand, for a session that didn't go through `/spec` or `/implement` — a
quick fix, some notes, a question you want journaled. A session that changed nothing still gets a
journal entry.

## The two reviewers

`/spec-audit` attacks the spec before any code exists — the cheapest review you get, because a missing
edge case costs one line to add here and a rewrite to add later. `/spec` runs it for you. It also
checks the spec against your own words, which catches the failure a design review can't: a spec that is
excellent and solves the wrong problem.

`/implement-audit` attacks the finished code. `/implement` runs it for you, and you can call it directly
any time you want a second look before you trust something. It reviews once per session; a second call
repeats the first verdict instead of paying for the same review twice.

Both try to run on a model other than the one that writes your code. The table is
`.agents/skills/review/policy.json`: code and spec reviews try the Codex CLI, then the Grok CLI, and
skip whichever is your `agent=`. When neither can answer, the review still happens: a fresh-context
agent in your own session does it, and the recorded line says
`claude-fallback (fresh context, NOT independent)`. That is still worth running. What it is not is
independent, and the label is there so you never mistake one for the other.

Each writes its verdict where the work lives — `spec-audit:` into the spec's `plan.md`,
`implement-audit:` into the row's `report.md` — and the journal entry quotes it.

## Decisions worth keeping

When a choice would be expensive to reverse — a database, a data format, a boundary between two
systems — write it down as a decision record in `decisions/`. The format is
[MADR](https://adr.github.io/madr/)'s minimal one, described in `decisions/README.md`: the problem,
the options, the one chosen and why. A record only says `accepted` when it quotes the words that
accepted it; otherwise it is `proposed`. `/close` checks that before it commits, so a conversation
can't quietly turn into a decision nobody made.

## Two more skills worth knowing early

`/explain` is for understanding before touching. When you inherit a tangle and need to know why it's
shaped that way, `/explain` investigates until it's confident and hands you the root cause instead of a
guess.

`/qa` looks at a running web app the way a user would: it serves it, screenshots it at desktop, tablet
and phone widths, runs impeccable's design checks and fixes what they find, then has a fresh agent
review the screenshots. It installs Playwright and impeccable the first time it needs them, and says
"skipped" rather than "clean" when it couldn't run one.

## Where to go next

Read `docs/architecture.md` for how the pieces fit, especially the fresh-context boundary and where
each check runs. Then build something small with the loop. The first real value shows up when you
start adding your own standards: the agent does something wrong, you correct it, and you write the
correction into `AGENTS.md` — a bold-led bullet in a section of your own, outside the Contextium
blocks — so the next session doesn't repeat it. That loop, more than any single feature, is what makes
the setup yours.
