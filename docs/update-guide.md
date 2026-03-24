# Updating Contextium

## How Updates Work

Contextium uses git's merge system to deliver framework updates without overwriting your personal data.

**Protected paths** (your data, never overwritten):

- `preferences/user/` — your preferences
- `knowledge/` — your knowledge base
- `journal/` — your session logs
- `projects/` — your projects

**Updated paths** (framework files, merged from upstream):

- `apps/` — app protocols and patterns
- `integrations/` — integration documentation
- `docs/` — documentation
- `agent-configs/` — AI agent instruction templates
- `preferences/rules/` — behavioral and governance rules
- `preferences/templates/` — project/journal/app templates

## Quick Update

```bash
cd your-contextium-repo
./install.sh update
```

This will:

1. Fetch the latest from upstream
2. Show you what changed (new apps, updated docs, etc.)
3. Merge safely, protecting your data
4. Report any conflicts (rare)

## Manual Update

```bash
git fetch upstream
git merge upstream/main
```

If you get merge conflicts in protected paths, your version always wins:

```bash
git checkout --ours preferences/user/preferences.md
git add preferences/user/preferences.md
git commit
```

## Versioning

Contextium uses semantic versioning:

- **Major** (2.0): Breaking changes to directory structure or CLAUDE.md format
- **Minor** (1.1): New apps, integrations, or enhanced onboarding
- **Patch** (1.0.1): Documentation fixes, template tweaks

Check the [CHANGELOG](../CHANGELOG.md) for release details.
