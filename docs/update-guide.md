# Updating

A newer version of the template will ship better skills, refined standards, new checks, and fixes.
Pulling those in should never put your own work at risk. The installer is built around exactly that
split: it refreshes the methodology layer and leaves your data alone.

## Upgrading to v9.0.2: local QA without a Cloudflare account

Re-run the installer; nothing in your data changes.

- `/qa`'s local sign-in for an app behind Cloudflare Access takes the token's issuer from the
  app's own `ACCESS_ISSUER` var in its wrangler config when it declares one, so a teammate with
  no Cloudflare account can serve and check the app locally. Without the var it still reads the
  account's Access organization, which needs `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
- For an app with a `qa:seed` script (a masked sample of every database, say), a database with no
  migrations folder is reported as left to that seed rather than as starting empty, and the
  evidence label names the seed.

## Upgrading to v9.0.1: building in another repo, status from the roadmap

Re-run the installer; nothing in your data changes.

- `/implement` and `/implement-audit` say how to build a row whose code lives in another repo (a
  product you work on from this workbench): that repo gets its own worktree from `write-root.sh`,
  and every check and review takes it (`validate.ts --repo`, `CODEX_REVIEW_REPO`,
  `run-automated-checks.ts --repo-dir`). Before, they checked and reviewed this workbench's diff,
  which holds only the spec.
- With Claude Code or Gemini CLI, the shared-checkout guard no longer refuses writes into the
  session's own worktree under `.claude/worktrees/` or `.gemini/worktrees/`. Before, every write a
  session made there was refused as a write into the checkout.
- `.gitignore` gains `.agents/skills/synced/`: Claude Code syncs skills from your account into
  `~/.claude/skills/synced/`, which the home link puts in the workbench, where it left the
  checkout dirty and stopped `/close` from updating it.
- A project with a `ROADMAP.md` has its `status:` derived from its rows by `/close`
  (`roadmap.ts --derive`); to change what a project is, change a row.
- The close's script-language check judges the scripts under `.agents/` only; your own apps may be
  written in any language.

## Upgrading to v9.0.0: the scripts are TypeScript

Re-run the installer. Every script the layer ships is now TypeScript, run by Node 22.6 or later as
`node --experimental-strip-types <script>.ts`: the checks in `.agents/checks/`, the generators, and
the skills' scripts (`land.ts`, `roadmap.ts`, `validate.ts` and the rest). A few stay bash,
because a tool fires them as hooks or they make the worktree a session runs in: the two guards in
`.agents/hooks/` (with their `lib/`), and `write-root.sh`, `harness.sh`, `lock.sh` and
`setup-worktree.sh`. The helpers the TypeScript scripts share install to `.agents/packages/`, and
`.agents/package.json` marks the layer as ES modules so Node 22 does not warn on every run.

- Install Node 22.6 or later before you re-run. Without it the installer still lays the layer down,
  but it cannot run the check at the end, so it does not call the install ready; and it keeps every
  per-tool copy an earlier release generated, since it cannot regenerate one to compare it with.
- The `.sh` checks v8.0.1 installed in `.agents/checks/` are removed while they are still as it
  installed them. One you edited is kept and named; nothing runs it now, so carry your change over
  to its `.ts` successor and delete it.
- A command you had written down changes with the file name: the link check, for example, is now
  `node --experimental-strip-types .agents/checks/check-harness-config-links.ts`.
- A script of your own under `.agents/` still needs a test beside it, `.test.sh` or `.test.ts`.

## Upgrading to v8.0.1

Re-run the installer; nothing moves. Two things behave differently afterwards:

- `/close` now runs `.agents/checks/check-scripts.ts` before it commits. A script you add or change
  under `.agents/` must carry a test (`<name>.test.sh` or `.test.ts` beside it, or in a `tests/`
  folder), and the test must run the script rather than `source` or `import` it. Scripts Contextium
  shipped pass as long as you have not edited them; once you do, the script is yours, test included.
- With Gemini CLI wired, the installer adds the workbench to `~/.gemini/trustedFolders.json`, because
  Gemini reads `AGENTS.md` and runs the guards only in a trusted folder.

## Upgrading to v8.0.0

v8.0.0 makes the install your workbench: one git repo that holds every project, its records and the
skills that work on them. Everything shared now lives once, in `AGENTS.md` and `.agents/`, and reaches
each tool either directly or through a link in your home folder. There is no in-repo `.claude/`, no
`.githooks/`, and no generated copy per tool any more. Re-run the installer against your existing
repo and it migrates you. Nothing you wrote is deleted; the one thing overwritten is an edit you made
inside a skill Contextium ships, as in every earlier release (see Keeping your own skills, below).

The installer's default target is now `~/code/workbench`. If your repo lives somewhere else, pass its
path: `bash install.sh ~/code/my-project`.

### The first question is your tool

The installer now starts by asking which tool you drive the workbench with — T3 Code (recommended),
Claude Code, Codex, Cursor, VS Code with Copilot, Gemini CLI, Antigravity or Grok Build — and, for
T3 Code, which agent it runs. If the tool isn't installed it offers to install it, defaulting to no;
`--yes` never installs anything unless you add `--install-missing`. The answer is written to
`.agents/harness` as three lines: `harness=` decides where a new session worktree goes, `agent=` is
the model family that writes your code, which the reviewers leave out, and `tools=` lists every tool
wired in this workbench. A later run offers the recorded harness as the default.

`--harness` and `--agents` answer these without the prompt. The older `--tools "a b"` still works: its
first entry becomes the harness and each named tool is wired, and `--all-tools` now wires Claude
Code, Codex, Gemini CLI, Grok Build and Antigravity. `--hooks` and `--no-hooks` are accepted and
ignored.

A re-run never unwires a tool: it wires every tool on `tools=` plus any you name now. To stop wiring
one, pass `--drop-tool <name>` (repeatable). That removes it from `tools=`, and removes its file in
`.agents/` (`hooks.json` for Antigravity, `gemini-settings.json` and the `.gemini/settings.json` link
for Gemini CLI) only while the file is still as installed; a changed one is kept and named. The
drop it also undoes that tool's home wiring, touching only what points at this workbench or carries
Contextium's `: contextium;` mark: Grok Build's `~/.grok/hooks/contextium.json` link; Codex's
`~/.codex/hooks.json` link, or Contextium's entries in a hooks file of your own; Claude Code's merged
entries in `~/.claude/settings.json` and its three `~/.claude` links; Antigravity's
`~/.gemini/config/skills` link. A dropped tool stays dropped on later runs until you name it again.
A tool the same run names — the harness, and under T3 Code its agents — stays wired, so to drop
the tool you drive the workbench with, name a different `--harness` (or `--agents`) in that run.

### What moves

| v7 | v8 |
|---|---|
| `.agents/rules/*.md` | `AGENTS.md` § Standards, a fenced block the installer refreshes |
| `.agents/reviewers/` | `.agents/agents/` |
| `.agents/scripts/` (the review scripts) | `.agents/skills/review/`, with `policy.json` choosing the reviewer |
| `.githooks/` and `core.hooksPath` | `.agents/checks/`, run by `/close` before every commit it makes |
| `.claude/hooks/`, `.claude/settings.json` | two guards in `.agents/hooks/`, merged into `~/.claude/settings.json` and wired for Codex, Grok Build, Gemini CLI and Antigravity |
| `.claude/skills`, `.claude/agents` links | `~/.claude/skills` and `~/.claude/agents` in your home folder |
| `.claude/CLAUDE.md` | nothing: Claude Code 2.1.277 and later reads `AGENTS.md` itself |
| `GEMINI.md`, `.gemini/commands/` | `.gemini/settings.json`, a link to `.agents/gemini-settings.json`, which points Gemini CLI at `AGENTS.md` and carries the guards; made when Gemini CLI is wired |
| `.cursor/rules/contextium.mdc`, `.cursor/commands/`, `.github/copilot-instructions.md`, `.github/prompts/`, `.codex/skills` | nothing: those tools read `AGENTS.md` and `.agents/skills/` directly |
| `.claude/output-styles/` | `.agents/output-styles/`, reached through `~/.claude/output-styles`. It starts empty: the two styles v7 shipped are removed when unchanged, and `/author` writes new ones there |

Claude Code reads `AGENTS.md` only while no `CLAUDE.md` sits at or above the folder it started in. If
you keep a `CLAUDE.md` of your own, Claude Code reads that instead, so move what you need into
`AGENTS.md`. When Claude Code is wired, the installer warns if yours is older than 2.1.277; `claude
update` fixes it.

Test suites no longer ship into your workbench. The skills are copied without their `*.test.*` files
and their `tests/`, `fixtures/` and `evals/` folders, which stay in the Contextium repo.

The review scripts changed with the move. Code and spec reviews run on the Codex CLI, then the Grok
CLI, and skip whichever one is your `agent=`; `CONTEXTIUM_REVIEWER_CMD` no longer does anything. When
neither can answer, the review runs in a fresh-context agent of your own, as before, and its recorded
line now says `claude-fallback (fresh context, NOT independent)`. `/debate`
takes no options: it always runs three seats, and when a model is missing another argues its seat and
the synthesis says so.

Two skills are new: `/qa`, which screenshots and design-checks a web app you changed, and `/review`,
the folder of review scripts the other skills call. Roadmap rows replaced the old shard tables for
good: nothing writes a `## Shard Status` table any more, though the scripts still read one in an old
project.

### What the installer removes, and when it keeps a file

It removes what earlier versions installed only when it can prove the file is still theirs:

- A file in `.agents/rules/`, `.agents/reviewers/`, `.agents/scripts/`, `.githooks/`,
  `.claude/hooks/`, `.claude/output-styles/`, `.claude/settings.json` or `.claude/CLAUDE.md` goes
  only while it matches, byte for byte, a file that v6.0.0 or v7.0.0 shipped. The checksums are in
  `install-legacy.tsv` in the template.
- A generated copy — `GEMINI.md`, `.cursor/rules/contextium.mdc`, `.github/copilot-instructions.md`,
  a `.gemini/commands/*.toml` or `.github/prompts/*.prompt.md` — goes only when it carries the marker
  the old generator wrote.
- A link goes only when it still points where Contextium pointed it.
- `core.hooksPath` is unset only when it was `.githooks` and that folder is now gone.
- A folder goes only when this run emptied it.

Anything else is yours and stays, and the installer names it and says what to do. A rule file you
wrote or edited is kept in `.agents/rules/`: no tool loads that folder, so move each rule into
`AGENTS.md` as a standard, in a section outside the Contextium blocks, then delete the folder. A
`.claude/settings.json` you edited is kept, and the installer points out that it wires hooks from
`.claude/hooks/`, which v8 no longer ships. The one-line summary at
the end lists everything removed, a folder's files counted rather than listed.

### Your AGENTS.md

v8's `AGENTS.md` has two kinds of section. Your preferences and your Stack section are yours. The
rest — what lives where, records, skills, skill shape and the Standards — sit between
`<!-- contextium:<name> -->` and `<!-- /contextium -->`, and a re-run replaces those blocks and nothing
else.

On the upgrade itself the installer looks at the `.agents/AGENTS.md` you have:

- Unchanged from the v6 or v7 template: replaced whole, keeping your name and autonomy answer.
- Edited: kept, with the v8 blocks appended at the end and your original saved as
  `.agents/AGENTS.md.bak`. Delete the old sections the blocks replace — What lives where, The Loop,
  Memory, Enforcement, Principles — and keep yours.
- With `--force`: replaced by the fresh template, the old one saved as `.agents/AGENTS.md.bak`.

### Your home folder

The installer now writes outside the repo, and only these paths:

- Links: `~/.agents/skills` → `<workbench>/.agents/skills`, always; `~/.claude/skills` →
  `~/.agents/skills`, `~/.claude/agents` → `<workbench>/.agents/agents` and
  `~/.claude/output-styles` → `<workbench>/.agents/output-styles` when Claude Code is wired;
  `~/.gemini/config/skills` → `~/.agents/skills` when Antigravity is wired;
  `~/.grok/hooks/contextium.json` → `<workbench>/.agents/hooks/claude-hooks.json`
  when Grok Build is wired. A real folder or file already at one of those paths is moved aside to
  `<path>.pre-link` and named; nothing is deleted.
- `~/.claude/settings.json`: the guards are merged into its hooks with jq. If the file existed
  before, the first merge copies it to `settings.json.pre-contextium`; one the installer creates gets
  no backup. Your other settings and hooks stay, and
  a later run replaces only the entries Contextium made (each command starts with `: contextium;`). A
  file that isn't valid JSON is left alone and the installer says so.
- `~/.codex/hooks.json`, when Codex is wired: a link to `.agents/hooks/claude-hooks.json`, or the
  same merge when it is a file of your own. Codex runs the guards only after you accept its
  hook-trust prompt once.

Without jq the installer skips the merges and tells you. Your own hooks go in
`.agents/user-hooks.json`, in the Claude Code shape and for any hook event; every run adds them to
`.agents/hooks/claude-hooks.json`, so they reach every tool that file reaches, and never writes
`user-hooks.json` itself. A file that isn't valid JSON is skipped and said, and the last run's
manifest, with your entries in it, is kept when there is one.

Inside the workbench, when Gemini CLI is wired, `.gemini/settings.json` becomes a link to
`.agents/gemini-settings.json`. A settings file of your own already there is moved to
`.agents/user-gemini-settings.json`, and every run merges it into `.agents/gemini-settings.json`, so it
stays in force. (If `.agents/user-gemini-settings.json` already exists, the file is moved aside to
`.gemini/settings.json.pre-link` instead, and the installer asks you to merge it by hand.) Gemini CLI
loads that file — `AGENTS.md`, the skills and the guards — only in a trusted folder, so wiring Gemini CLI
also adds the workbench to `~/.gemini/trustedFolders.json`, keeping every folder already there, and
`--drop-tool gemini` takes back that entry if the installer added it. `--skip-trust` does not load the
settings; `GEMINI_CLI_TRUST_WORKSPACE=true` does.

### Sessions now land themselves

Every session works in its own git worktree, and `/close` lands it: it runs the checks, commits,
merges your trunk, pushes, and proves against a fresh fetch that the work is on the remote. Two
sessions that finished different rows of one project land without a conflict: `/close` merges
`ROADMAP.md` row by row and re-derives `next:` afterwards.

`/close` refuses to land without an `origin`. An upgrade leaves your git history alone; if the repo
has no `origin`, the installer asks for a URL, and with the GitHub CLI signed in it offers to create a
private repo, defaulting to no and never under `--yes`. The installer adds `.claude/worktrees/` and
`.gemini/worktrees/` to `.gitignore`, because Claude Code and Gemini CLI keep session worktrees inside
the repo.

## What gets refreshed, what stays yours

Refreshed on every run:

- every skill, agent, hook, check and generator Contextium ships, each replaced whole, and each
  folder's `.contextium-manifest`, the list of what it installed there
- `.agents/hooks/claude-hooks.json`, rendered from the template's guards and your
  `.agents/user-hooks.json`
- `.agents/hooks.json` while Antigravity is wired, and `.agents/gemini-settings.json` while Gemini
  CLI is wired, with `.agents/user-gemini-settings.json` merged in
- `.agents/harness`, rewritten with this run's answers; `tools=` only grows, unless you pass
  `--drop-tool`
- the Contextium blocks of `.agents/AGENTS.md`, and the `AGENTS.md` link at the root
- the home links of every tool on `tools=`, and Contextium's own entries in
  `~/.claude/settings.json` and a `~/.codex/hooks.json` of yours

Protected, never clobbered once they exist:

- everything in `.agents/AGENTS.md` outside the Contextium blocks
- anything you added in `.agents/skills/`, `.agents/agents/`, `.agents/hooks/`, `.agents/checks/`,
  `.agents/generators/` or `.agents/output-styles/`
- `.agents/user-hooks.json` and `.agents/user-gemini-settings.json`
- `apps/` — all of it, including the generated `apps/README.md` index
- `integrations/` — a starter you already have is kept as it is
- `knowledge/`, `journal/`, `projects/`
- `decisions/` — only its `README.md` is added, when missing
- `.gitignore` — missing lines are appended, nothing is removed

So your code, your connectors, your knowledge, your journal, your projects, and your own text in
`AGENTS.md` all survive. The AI layer that drives them gets the upgrade.

## How to update

Commit your work, pull the newer template, then re-run the installer pointed at your workbench.

```bash
cd ~/code/contextium      # the template clone
git pull

bash install.sh ~/code/workbench
```

It detects the existing layer and refreshes it. It takes the harness you recorded last time as the
default, wires every tool on `tools=` again, prints each path it refreshed and each one it kept, and ends by checking the home links and
the guard manifests. That's the whole update. You can also re-run
`curl -sSL contextium.ai/install | bash` and give it your workbench's path when it asks.

If you've never cloned the template separately, clone it once and keep it around as your update source.
It's the thing you pull and re-run; your workbench is the thing it installs into.

## Keeping your own skills across updates

A skill, agent, hook, check or generator you add beside Contextium's is yours: the installer reads the
folder's `.contextium-manifest`, replaces only what it shipped, and never looks at the rest. An entry
a newer release stops shipping is removed only while every file in it still matches the checksum it
was installed with; one you edited is kept, and the installer names it.

The one place to be careful is an edit inside something Contextium ships. A skill it ships is
replaced whole on every run, so a change you made to, say, `.agents/skills/close/SKILL.md` is
overwritten. Your own standards are safe in `AGENTS.md`, outside the Contextium blocks, and your own
hooks in `.agents/user-hooks.json`. For the rest, git is the safety net:

- Commit before every update. Then the update is just a diff you review.
- After an update, `git diff` shows exactly what the refresh changed. An edit of yours it overwrote
  can be restored from git, or better, moved into a skill of your own under a new name.

Because the whole workbench is version-controlled, an update is a reviewable change, not a leap of
faith. Run the installer, look at `git diff`, keep what you want, and restore anything of yours the
refresh stepped on.

## When in doubt

The update model assumes git, so use it. Commit your work, run the installer, review the diff. Your
data directories are protected by the installer, your customizations are protected by git history, and
between the two there's no version of an update that quietly eats your work.

## Earlier releases

The sections below describe each earlier release as it shipped, and are kept as history. Where v8.0.0
changed something, the sections above are current: there are no rule files, git hooks, in-repo
`.claude/` or per-tool generated files any more, and `--force` is no longer needed to pick up a new
template section.

### Upgrading to v7.0.0

v7.0.0 changes how work is written down. Re-run the installer; the skills, rules and hooks refresh, and
nothing you wrote is touched.

- **Projects follow spec-kit.** A project folder now holds `README.md` (`## Goal`, `## Outcome`, and a
  `next:` derived from the roadmap), `ROADMAP.md` (rows `R1`, `R2`, … with dependencies and status —
  the only list of outstanding work), and one `specs/NNN-name/` folder per row with `spec.md`,
  `plan.md`, `tasks.md`, `research.md` and `/implement`'s `report.md`. The templates sit beside the
  skills that write them (`.agents/skills/project/references/templates/`,
  `.agents/skills/spec/references/templates/`), pinned to a spec-kit release. The lean 4-section
  template is gone, and so is `.agents/templates/`. Existing projects with a loose `*.spec.md` keep
  working: every script still reads that layout, and the next spec a project gets is written in the
  new one.
- **Decision records.** `decisions/` holds MADR records for choices that would be expensive to
  reverse; `decisions/README.md` is the format, and the installer seeds it on upgrade too. A
  pre-commit check refuses a malformed record, and an `accepted` one that does not quote the words
  that accepted it.
- **Journal days are folders.** `/close` writes `journal/YYYY-MM-DD/HHMM-<slug>.md`, one file per
  session, with a fixed set of sections a pre-commit check enforces. Old `journal/YYYY-MM-DD.md` files
  stay as they are.
- **The review trailer gate is gone.** `/spec-audit` writes its line into the spec's `plan.md` and
  `/implement-audit` into `report.md`; nothing refuses a commit for a missing trailer, and
  `CONTEXTIUM_SKIP_AUDIT_GATE` no longer does anything.
- **Skills use the Agent Skills frontmatter** (`name`, `description`, `allowed-tools`, `metadata.peers`
  and a few optional keys). A skill you wrote with `steps:`, `enforces:` or `handoffs_to:` will fail
  the skill-format check at its next commit; move `peers` under `metadata` and drop the rest.
- **Four new rules:** `read-before-asserting`, `red-before-green`, `fix-the-cause` and
  `decision-records`.

Your `.agents/AGENTS.md` is kept, so its Loop section still describes v6; the installer warns when it
does. Take the new one with `--force` (it writes a `.bak` first) or merge the new Loop and Memory
sections by hand.

### Upgrading to v6.0.0

Everything shared now lives once, in `.agents/` — the working agreement, the rules, the skills, the
review scripts, the index generators. Claude Code, Codex and Cursor read it through
symlinks; Gemini and Copilot get files generated from it. `.claude/` keeps only what has no
counterpart in another tool: subagents, in-session guards, output styles, `settings.json`, and a
`CLAUDE.md` that now imports `.agents/AGENTS.md` instead of restating it.

Re-running the installer migrates you. Where a real `.claude/skills/`, `.claude/rules/`,
`.claude/templates/` or `.claude/agents/` sits in the way of the new symlink, it is moved aside as
`<name>.pre-agents` rather than deleted — move anything you wrote yourself into `.agents/` and
delete the leftover. A root `AGENTS.md` we did not generate is moved aside the same way, and the
installer says so: `AGENTS.md` becomes the Contextium working agreement, and merging your own
content back into it is your call, not the installer's.

Two fixes come with it:

- **The piped install actually asks its questions.** `curl -sSL contextium.ai/install | bash` leaves
  the installer's stdin pointing at the pipe carrying the script, so every prompt used to take its
  default without ever appearing. Prompts now read from the terminal directly.
- **Selecting more than one tool installs all of them.** The check for whether Claude Code was among
  your choices compared against a newline-separated list as though it were space-separated, so any
  multi-tool install silently skipped the `.claude/` half.

### Upgrading from v3.x or earlier

Through v3.4.0 the template put its own machinery inside your `apps/`: three index generators, a
`quality/` folder, and a `shared/` folder of helpers. That was wrong — `apps/` is for code you write.
In v4.0.0 the generators moved to `.agents/generators/` and the commit checks to
`.githooks/checks/`, beside the hooks that call them.

Re-running the installer migrates you. It deletes those five folders if you never touched them, and
keeps any folder you added your own files to, telling you which one and why. Nothing you wrote is
removed. If you kept an extended `quality/`, move your own checks somewhere that suits you (they run
from wherever the hook points) and delete what's left.

### Upgrading to v5.1.0

v5.1.0 is additive: the skills gained the scripts they previously only described,
and `/author` gained a fifth artifact type (response styles). Re-run the installer
and nothing you wrote is touched.

Two things worth knowing:

- **`/debate` renamed a flag.** `--config claude|cross|duo` only ever set how many
  agents there were, so it is now `--agents 2|3`. The old names still work and map
  to a seat count. (v8.0.0 removed both: `/debate` always runs three seats.)
- **Two more commit checks fire** when you have the layer installed: one refuses a
  commit that cites a rule which no longer exists, the other checks the frontmatter
  of any skill the commit touches. Both skip silently if you trimmed those files
  away.

### Upgrading to v5.0.0

v5.0.0 adds a commit gate, so this upgrade changes what git lets you do. After you re-run the
installer, a commit that changes a SPEC, or more than about 50 lines of code, is refused unless the
message carries a review trailer (`spec-audit:` or `implement-audit:`). The loop produces those lines
for you — `/spec` and `/implement` each run their review and hand the trailer to `/close`. What the
gate catches is a commit made outside the loop.

Two things to know before you upgrade:

- **A commit in flight will be refused.** If you were mid-change when you upgraded, either run the
  matching review, or commit that one with `CONTEXTIUM_SKIP_AUDIT_GATE=1`.
- **The threshold is tunable.** `CONTEXTIUM_AUDIT_LINE_THRESHOLD` (default 50) sets how many changed
  lines of code make a commit substantial enough to need a review.

v5.0.0 also changes the default response style from `brevity` to `decision-only`. Both ship; if you
prefer the old one, set `"outputStyle": "brevity"` in `.claude/settings.json`. Note that
`settings.json` is refreshed on every install, so a preference there needs re-applying after an
upgrade — or move it to `.claude/settings.local.json`, which is yours and never touched.

If you want the reviews to run on a model other than Claude, install the Codex CLI or set
`CONTEXTIUM_REVIEWER_CMD` to any CLI that reads a prompt on stdin. Without one, reviews still run —
they fall back to a fresh-context Claude agent and label themselves as such.
