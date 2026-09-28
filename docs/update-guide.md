# Updating

A newer version of the template will ship better skills, refined rules, new hooks, and fixes. Pulling
those in should never put your own work at risk. The installer is built around exactly that split: it
refreshes the methodology layer and leaves your data alone.

## Upgrading to v7.0.0

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

## Upgrading to v6.0.0

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

## Upgrading from v3.x or earlier

Through v3.4.0 the template put its own machinery inside your `apps/`: three index generators, a
`quality/` folder, and a `shared/` folder of helpers. That was wrong — `apps/` is for code you write.
In v4.0.0 the generators moved to `.agents/generators/` and the commit checks to
`.githooks/checks/`, beside the hooks that call them.

Re-running the installer migrates you. It deletes those five folders if you never touched them, and
keeps any folder you added your own files to, telling you which one and why. Nothing you wrote is
removed. If you kept an extended `quality/`, move your own checks somewhere that suits you (they run
from wherever the hook points) and delete what's left.

## Upgrading to v5.1.0

v5.1.0 is additive: the skills gained the scripts they previously only described,
and `/author` gained a fifth artifact type (response styles). Re-run the installer
and nothing you wrote is touched.

Two things worth knowing:

- **`/debate` renamed a flag.** `--config claude|cross|duo` only ever set how many
  agents there were, so it is now `--agents 2|3`. The old names still work and map
  to a seat count.
- **Two more commit checks fire** when you have the layer installed: one refuses a
  commit that cites a rule which no longer exists, the other checks the frontmatter
  of any skill the commit touches. Both skip silently if you trimmed those files
  away.

## Upgrading to v5.0.0

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

## What gets refreshed, what stays yours

The installer treats two sets of paths differently.

Refreshed on every run (the methodology, replaced wholesale with the newer version):

- `.agents/rules/`
- `.agents/skills/`
- `.agents/scripts/`
- `.githooks/checks/` (where the commit-time checks live)
- `.agents/generators/`
- `.agents/reviewers/`
- `.claude/hooks/`
- `.claude/settings.json`
- `.githooks/` (including the checks it calls, under `.githooks/checks/`)

Protected, never clobbered once they exist:

- `.agents/AGENTS.md`
- `.claude/CLAUDE.md`
- `apps/` — all of it, including the generated `apps/README.md` index
- `integrations/`
- `knowledge/`
- `journal/`
- `projects/`
- `decisions/`

So your code, your connectors, your knowledge, your journal, your projects, and your customized
`AGENTS.md` all survive. The AI layer that drives them gets the upgrade.

## How to update

Pull the newer template, then re-run the installer pointed at your project.

```bash
cd ~/code/contextium      # the template clone
git pull

bash install.sh ~/code/my-project
```

It detects the existing layer and switches to refresh mode. You'll see it refresh each methodology
path, re-point each tool's symlinks at `.agents/`, and report that it kept your data directories and
your `AGENTS.md` untouched. That's the whole update.

Upgrading from a version before `.agents/` existed, your old `.claude/skills/` is a real directory
where a symlink now belongs. It is moved aside as `.claude/skills.pre-agents` rather than deleted, so
any skill you wrote yourself is still there to move into `.agents/skills/`.

If you've never cloned the template separately, clone it once and keep it around as your update source.
It's the thing you pull and re-run; your project is the thing it installs into.

## Your AGENTS.md is protected

Your `.agents/AGENTS.md` is yours to customize, and the installer won't overwrite it. That's
deliberate. It holds your preferences, your tech-stack notes, whatever you've added to the working
agreement. The cost is that genuinely new content from a template release won't appear there
automatically. `.claude/CLAUDE.md` is protected the same way, though it holds far less now — it
imports `AGENTS.md` rather than repeating it.

If you want to fold in the newer starter, look at the copy the template ships and merge in by hand
what you want. Or, if yours hasn't drifted much, take the new one:

```bash
bash install.sh ~/code/my-project --force
```

The `--force` flag replaces `AGENTS.md` and `CLAUDE.md`, writing a `.bak` of each first, so you can
diff the two and lift back any customizations you'd added. Without `--force`, both are left exactly as
they are.

## Keeping your own rules and skills across updates

This is the one place to be careful, because `.agents/rules/` and `.agents/skills/` are refreshed
wholesale. A refresh replaces the directory with the template's version.

The rules and skills you write yourself live in those same directories. So if you only drop a new file
in next to the template's files, a refresh can carry your file along (the installer copies the whole
directory in, and your file isn't in it). The safe pattern is to keep your additions identifiable and
re-applied:

- Name your own rules so they're obviously yours and easy to spot in a diff.
- Track your project in git. After an update, `git status` shows exactly what the refresh changed and
  what it removed. Anything of yours that got dropped shows up as a deletion you can restore with
  `git checkout`.
- Commit before every update. Then the update is just a diff you review, and nothing is lost that git
  can't bring back.

That last point is the real safety net. Because the whole project is version-controlled, an update is a
reviewable change, not a leap of faith. Run the installer, look at `git diff`, keep what you want, and
restore anything yours that the refresh stepped on. If a template release ever changes the rules you'd
customized, you'll see both sides in the diff and decide.

## When in doubt

The update model assumes git, so use it. Commit your work, run the installer, review the diff. Your
data directories are protected by the installer, your customizations are protected by git history, and
between the two there's no version of an update that quietly eats your work.
