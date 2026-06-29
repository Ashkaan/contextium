# Updating

A newer version of the template will ship better skills, refined rules, new hooks, and fixes. Pulling
those in should never put your own work at risk. The installer is built around exactly that split: it
refreshes the methodology layer and leaves your data alone.

## What gets refreshed, what stays yours

The installer treats two sets of paths differently.

Refreshed on every run (the methodology, replaced wholesale with the newer version):

- `.claude/rules/`
- `.claude/skills/`
- `.claude/agents/`
- `.claude/hooks/`
- `.claude/templates/`
- `.claude/settings.json`
- `.githooks/`
- the template-owned `apps/` helpers (the index generators, `quality/`, `shared/`)

Protected, never clobbered once they exist:

- `.claude/CLAUDE.md`
- your own apps under `apps/`
- `integrations/`
- `knowledge/`
- `journal/`
- `projects/`

So your code, your connectors, your knowledge, your journal, your projects, and your customized
`CLAUDE.md` all survive. The AI layer that drives them gets the upgrade.

## How to update

Pull the newer template, then re-run the installer pointed at your project.

```bash
cd ~/code/contextium      # the template clone
git pull

bash install.sh ~/code/my-project
```

It detects the existing `.claude/` and switches to refresh mode. You'll see it refresh each methodology
path and report that it kept your data directories and your `CLAUDE.md` untouched. That's the whole
update.

If you've never cloned the template separately, clone it once and keep it around as your update source.
It's the thing you pull and re-run; your project is the thing it installs into.

## Your CLAUDE.md is protected

Your `.claude/CLAUDE.md` is yours to customize, and the installer won't overwrite it. That's
deliberate. It holds your preferences, your tech-stack notes, whatever you've added to the router. The
cost is that genuinely new router content from a template release won't appear there automatically.

If you want to fold in the newer starter router, look at the freshly refreshed copy the template ships
and merge in by hand what you want. Or, if your `.claude/CLAUDE.md` hasn't drifted much from the
starter, back it up and take the new one:

```bash
cp ~/code/my-project/.claude/CLAUDE.md ~/code/my-project/.claude/CLAUDE.md.bak
bash install.sh ~/code/my-project --force
```

The `--force` flag replaces `.claude/CLAUDE.md` and writes a `.bak` first, so you can diff the two and
lift back any customizations you'd added. Without `--force`, your `.claude/CLAUDE.md` is left exactly as
it is.

## Keeping your own rules and skills across updates

This is the one place to be careful, because `.claude/rules/` and `.claude/skills/` are refreshed
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
