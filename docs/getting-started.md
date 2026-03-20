# Getting Started with Contextium

> Give your AI an operating system.

Contextium gives your AI persistent context, behavioral rules, and cross-domain knowledge — so every session builds on the last.

## Prerequisites

- Git installed
- An AI coding agent (Claude Code, Cursor, or Codex CLI)
- 5 minutes for initial setup

## Installation

### Option 1: Installer Script
```bash
curl -sSL https://raw.githubusercontent.com/Ashkaan/contextium/main/install.sh | bash
```

### Option 2: GitHub Template
```bash
gh repo create contextium --template Ashkaan/contextium --private --clone
cd contextium
```

### Option 3: Manual Clone
```bash
git clone https://github.com/Ashkaan/contextium.git contextium
cd contextium
rm -rf .git && git init
git remote add upstream https://github.com/Ashkaan/contextium.git
git add -A && git commit -m "Initial Contextium setup"
```

## Onboarding

Open your AI agent in the repo directory and say:

> **"let's onboard"**

Your AI will walk you through a 5-minute setup:
1. Your name and role
2. Which AI agent you're using
3. What you do professionally
4. What you want to track first

That's it. Your Contextium is ready.

## What Happens Next

After onboarding, your AI knows:
- Your preferences (communication style, working patterns)
- Your repo structure (where to find and store things)
- Your rules (behavioral patterns, session discipline)

Every session builds on the last. The more you use it, the richer your context becomes.

## Deeper Setup

Check `projects/setup/` for self-paced configuration guides:
- **Integrations** — Connect external services (Google, Todoist, etc.)
- **People Cards** — Build your relationship directory
- **Health Tracking** — Set up biomarker and supplement tracking
- **Automation** — Build your first scheduled automation
- **Daily Briefing** — Configure a morning email briefing

## Updating

Pull framework updates without losing your data:
```bash
./install.sh update
```

See [update-guide.md](update-guide.md) for details.
