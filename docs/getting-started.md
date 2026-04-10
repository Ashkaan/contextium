# Getting Started

## Install

```bash
curl -sSL contextium.ai/install | bash
```

The installer walks you through everything:

- Your name and professional context
- Which AI agent you use (Claude Code, Gemini, Codex, Cursor, Windsurf, Cline, Aider, Continue, Copilot, Ollama)
- Which integrations to include
- Your communication style and AI goals
- First knowledge domain

It then installs your AI agent's CLI and launches your first session — fully configured.

## Requirements

- **git** — for version control (the foundation of Contextium)
- **npm** or **Node.js** — needed for some AI agent CLIs (Claude Code, Codex, Gemini)
- **Ollama** — needed only if you choose Ollama as your agent (the installer handles installation)
- **macOS or Linux** — Windows users should use [WSL](https://learn.microsoft.com/en-us/windows/wsl/)

## After Install

Your AI is ready immediately. The context router in your instruction file (CLAUDE.md, GEMINI.md, Modelfile, etc.) tells
your AI how to navigate the repo. It will:

1. Load your preferences on every session
2. Lazy-load files based on what you're working on
3. End sessions with a journal entry and git commit

## Deeper Configuration

After the initial setup, check `GETTING-STARTED.md` at the repo root for guided next steps:

- Connecting external services with API credentials
- Building your relationship directory (people cards)
- Setting up health tracking
- Building your first automation
- Configuring a morning briefing email

Just ask your AI what to work on next — it will guide you through it.

## Updating

Pull framework updates without losing your data:

```bash
./install.sh update
```

Your personal data in `preferences/user/`, `knowledge/`, `journal/`, and `projects/` is protected during updates. Only
framework files get updated.

See [Update Guide](update-guide.md) for details.

## Windows

Contextium requires a Unix-like environment. On Windows, use
[WSL (Windows Subsystem for Linux)](https://learn.microsoft.com/en-us/windows/wsl/):

1. Install WSL: `wsl --install`
2. Open your WSL terminal
3. Run the installer as normal
