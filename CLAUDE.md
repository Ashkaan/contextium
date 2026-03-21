# Contextium

> Give your AI an operating system.

This is a Contextium repo. If you're seeing this default file, the installer hasn't been run yet. Run it to configure your profile, choose your AI agent, and replace this file with your full agent-specific instruction set.

## Install

```bash
curl -sSL contextium.ai/install | bash
```

The installer will:
1. Gather your name, professional context, and communication style
2. Ask which AI agent you use (Claude Code, Gemini, Codex, Cursor, Windsurf, Cline, Aider, Continue, Copilot, Ollama)
3. Select integrations (calendar, email, task manager, etc.)
4. Replace this file with the full context router and instruction set for your chosen agent

## Repo Structure

Once installed, the repo is organized as follows:

| Directory | Purpose |
|-----------|---------|
| `/apps/{name}/` | Self-contained apps: protocol (README) + automation scripts |
| `/apps/shared/` | Shared utilities (notifications, email, etc.) |
| `/knowledge/{domain}/` | Data organized by domain |
| `/knowledge/people/{name}/` | People & entities |
| `/projects/{domain}/` | Self-contained projects: `YYYY-MM-DD_brief-description/` |
| `/journal/` | Daily session logs: `YYYY-MM-DD.md` |
| `/preferences/` | User preferences, rules, templates, style guides |
| `/integrations/` | External service connectors (auth, APIs, docs) |
| `/agent-configs/` | Agent-specific instruction files for all supported AI agents |

## Without the Installer

If you prefer to set up manually, copy the instruction file from `agent-configs/` for your agent (e.g., `agent-configs/claude/CLAUDE.md`) to the repo root, then populate `preferences/user/preferences.md` with your profile.
