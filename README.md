# Contextium

> Give your AI an operating system.

Contextium sets up your workbench: one git repo that holds every project you work on, the records of
that work, and the skills your AI tool runs against it. Everything shared lives once — the working
agreement in `AGENTS.md` and the rest in `.agents/` — and every supported tool reads that one copy,
either directly or through a link in your home folder. There are no per-tool copies to keep in sync.
The point is not a pile of features. The point is a way of working that holds up over months, in
whatever tool you reach for.

## The idea

Most AI coding sessions start from zero. You re-explain your preferences, the AI makes a plausible
guess, drifts halfway through a long thread, and you start over tomorrow. Contextium fixes that with
five things:

1. **The Loop.** Three verbs with fresh context between thinking and doing. Each producer verb runs
   its own review and then wraps itself — you don't type the third verb.

   | Verb | Skill | What it does |
   |---|---|---|
   | Think | `/project` → `/spec` | Agree the goal, settle the open decisions (each question with its recommended answer), split the work into roadmap rows, and write one spec per row — reviewed against both the design and your original ask, then landed automatically. |
   | Do | `/implement` | Build one row's spec from a clean context, run the checks in a fixed order, get the code reviewed, then land it. |
   | Wrap | `/close` | Verify what changed, mark finished rows done, journal the session, then land it on your trunk and prove it landed. Fired by the two verbs above; still runnable by hand. |

   The fresh-context boundary between thinking and doing is deliberate. A session that wrote the plan
   and grew attached to its choices is the wrong session to also judge the implementation. A new one
   catches what the invested one defends.

2. **A worktree per session.** Every session works in its own git worktree — the one its tool made
   for it (T3 Code can give every thread one), or one made on its first write. Roadmap rows that don't
   depend on each other run in parallel sessions without touching each other's files, and `ROADMAP.md`
   merges row by row, so two sessions landing different rows don't conflict. `/close`
   commits, merges your trunk, pushes, and ends on one line it prints only after checking a fresh
   fetch: `origin/<trunk> is at <sha> — closing this tab loses nothing.`

3. **Specs and decisions in published formats.** A project is laid out the way
   [spec-kit](https://github.com/github/spec-kit) lays out a feature: a `README.md` with a goal and
   an outcome, a `ROADMAP.md` of rows with dependencies, and one `specs/NNN-name/` folder per row
   holding `spec.md`, `plan.md`, `tasks.md`, `research.md` and the build's `report.md`. The project's
   `next:` is derived from the roadmap by a script, never typed. Anything unsettled is marked
   `[NEEDS CLARIFICATION]` and blocks the build until you settle it. Choices that would be expensive
   to reverse become [MADR](https://adr.github.io/madr/) decision records, and an `accepted` one has to
   quote the words that accepted it.

4. **Standards backed by checks.** The judgment rules a change is measured against live in
   `AGENTS.md` § Standards. The ones that can be checked are: before every commit it makes, `/close`
   runs the decision-record, journal, skill, integration-manifest, standards-citation and secrets
   checks. In the tools where
   it is wired, a pre-tool guard stops a write into the checkout your sessions share and a change to
   host infrastructure you haven't approved.

5. **Memory in three layers.** The git log records what changed. The journal records why each session
   went the way it did — one file per session, in a folder per day, written by `/close` in a fixed
   shape a checker enforces. Decision records hold why the system is the way it is.

## Works in your tool

The installer's first question is which tool you drive the workbench with. T3 Code is the recommended
one: it runs Claude Code or Codex and gives each thread its own worktree. Your answer goes to
`.agents/harness`, which decides where new session worktrees go and which model family writes your
code, so the reviews can leave it out. It also records every tool you wire, and a re-run keeps them
all wired until you drop one with `--drop-tool`.

| Tool | Reads `AGENTS.md` | Finds the skills | Guards wired |
|---|---|---|---|
| T3 Code | through the agent it runs | through the agent it runs; type `$project` | the agent's |
| Claude Code 2.1.277+ | yes | `~/.claude/skills` → `~/.agents/skills` | `~/.claude/settings.json` |
| Codex | yes | `.agents/skills`, named `$project` | `~/.codex/hooks.json`, after a one-time trust |
| Cursor | yes | `.agents/skills` | no |
| VS Code + Copilot | yes | `.agents/skills` | no |
| Gemini CLI | via `.gemini/settings.json` | `.agents/skills`, in a trusted folder | `.gemini/settings.json` |
| Antigravity | yes | `.agents/skills` | `.agents/hooks.json` |
| Grok Build | in a trusted folder | `.agents/skills`, in a trusted folder | `~/.grok/hooks/contextium.json` |

Cursor, VS Code and Gemini CLI are described from their documentation; the others were checked against
the installed tool. Three things are not verified: that Gemini CLI honors the project-level settings
file, that its guards fire, and that Antigravity fires the hooks in `.agents/hooks.json`.

## What's in the box

- Eleven skills, shared by every tool: the Loop (`/project` → `/spec`, `/implement`, `/close`), its
  two reviewers — `/spec-audit` (attacks the design before code exists) and `/implement-audit`
  (attacks the code before it lands) — `/qa` (screenshots and design checks for a web app you
  changed), `/review` (the review scripts the others call), `/explain` (deep investigation),
  `/debate` (three models argue a decision), and `/author` (scaffold a conforming skill, hook, agent
  or response style).
- **Reviews that aren't written by the author.** Code and spec reviews run on the Codex or Grok CLI,
  in the order `.agents/skills/review/policy.json` sets, and skip the model family recorded as your
  `agent=`. When no such reviewer is installed, the review still runs, in a fresh-context agent of
  your own, and its recorded line says `claude-fallback (fresh context, NOT independent)`. A weaker
  review is fine; a weaker review reported as a strong one is not.
- **Each review runs once and leaves a record.** `/implement-audit` reviews once per session, later
  rounds read only the fixes, and it stops at a clean round, or at round four at the latest. Each
  reviewer writes its verdict where the work lives — `spec-audit:` into the spec's `plan.md`, `implement-audit:` into the
  row's `report.md` — and the journal quotes it.
- **The skills ship with their machinery, not a description of it.** Stage detection, roadmap edits,
  worktree setup, the check order (`validate.sh`: lint and typecheck, tests, the workbench checks,
  then review), journal filing and landing are all scripts. The test suites stay in this repo; the install carries
  the scripts only.
- **`/qa` installs what it needs when it first needs it.** Playwright and Chromium on first use,
  impeccable when it is missing or older than the latest published version. A tool it cannot install
  is reported as a skip, never a pass.
- Four agent prompts the skills dispatch in a fresh context, a `.agents/output-styles/` folder for the
  response styles `/author` writes (Claude Code reaches it through `~/.claude/output-styles`), the
  spec-kit templates pinned to v1.0.10,
  a MADR `decisions/README.md`, and 14 docs-only integration starters you pick from at install time.

## What's not in the box (on purpose)

Orchestration platforms, reconcilers, deploy pipelines and runtime-pinning rules are not wired in.
`/close` has an opt-in check that a push started a deploy, and everything else is yours to add
when your own work demands it.

## Install

```bash
curl -sSL contextium.ai/install | bash
```

That fetches the template into a temp directory, runs the interview, and cleans up after itself. If
you would rather keep the template around to update from, clone it and run the installer from there:

```bash
git clone https://github.com/Ashkaan/contextium.git
cd contextium
bash install.sh ~/code/workbench
```

The installer asks which tool you use (and, for T3 Code, which agent it runs), offers to install it
if it is missing, then asks where your workbench is (default `~/code/workbench`), your name, and how
autonomous the AI should be. It writes `AGENTS.md` and `.agents/`, links your harness homes to them,
merges its guards into your tool's settings without touching the rest, and leaves your data
directories, and anything you added to `.agents/`, alone on re-runs. A folder that isn't a git repo
yet is made one on `main`, with the install as its first commit.

`/close` lands each session by pushing to your workbench's `origin`, and refuses to land without one.
When there is none, the installer asks for a remote URL, and with the GitHub CLI signed in it offers
to create a private repo; it does neither under `--yes`. For a run without questions, pass `--yes`
with `--harness` and the other answers; `bash install.sh --help` lists them.

See `docs/getting-started.md` for a first walk through the Loop, and `docs/architecture.md` for how
the pieces fit.

## License

MIT. See `LICENSE`.
