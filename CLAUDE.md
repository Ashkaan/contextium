# Contextium

> Give your AI an operating system.

This is a Contextium repo. If you're seeing this default file, the installer hasn't been run yet. Run it to configure
your profile, choose your AI agent, and replace this file with your full instruction set.

## Install

```bash
curl -sSL contextium.ai/install | bash
```

The installer will:

1. Gather your name, communication style, and professional context
2. Ask which AI agent you use (Claude Code, Gemini, Codex, Cursor, Windsurf, Cline, Aider, Continue, Copilot, Ollama)
3. Ask how autonomous your AI should be
4. Replace this file with the full context router and instruction set for your chosen agent

## Repo Structure

Once installed, the repo is organized as follows:

| Directory        | Purpose                                                     |
| ---------------- | ----------------------------------------------------------- |
| `/preferences/`  | Your rules, voice, templates, and style guides              |
| `/knowledge/`    | Your domain data (people, goals, business context)          |
| `/apps/`         | Your automations (starts empty — grows as you build)        |
| `/integrations/` | Your connected tools (starts empty — set up as needed)      |
| `/projects/`     | Your tracked initiatives                                    |
| `/journal/`      | Daily session logs                                          |
| `/templates/`    | Reference catalog of example apps and integration connectors |

## Without the Installer

Copy the instruction file from `agent-configs/` for your agent (e.g., `agent-configs/claude/CLAUDE.md`) to the repo
root, then populate `preferences/user/preferences.md` with your profile.
