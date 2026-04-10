# Onboarding Guide

Contextium's onboarding happens during installation — not in a separate step.

## What the Installer Does

When you run `curl -sSL contextium.ai/install | bash`, the installer handles:

1. **Your name** — creates your profile at `knowledge/people/{name}/`
2. **Your AI agent** — installs the correct instruction file (CLAUDE.md, GEMINI.md, Modelfile, .cursorrules, etc.)
3. **Your integrations** — keeps only the connectors you need, removes the rest
4. **Communication style** — configures `preferences/user/preferences.md` with your preference
5. **Professional context** — added to your profile and preferences
6. **Primary AI goal** — what you want AI to help with most
7. **First knowledge domain** — creates your first `knowledge/{domain}/` directory
8. **GitHub backup** — optionally creates a private repo
9. **CLI install + launch** — installs your agent's CLI and opens your first session

## After Install

When your AI opens for the first time, you're already fully configured. No "let's onboard" step needed.

Your AI will:

- Read your preferences file and match your communication style
- Use the context router to lazy-load files as needed
- Start the session lifecycle: classify work → do work → journal → commit → push

## Deeper Configuration

For more advanced setup, check the app and integration templates in `templates/`:

- **App templates** — example automations you can copy into `apps/` and customize
- **Integration templates** — connector scaffolds for external services

Just ask your AI what you'd like to set up — it knows the templates and will walk you through it.

## For Contributors

If you want to improve the onboarding experience, see [CONTRIBUTING.md](../CONTRIBUTING.md). The installer source is
`install.sh` at the repo root.
