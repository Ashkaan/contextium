<div align="center">

<a href="https://contextium.ai">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/logo-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/logo.svg" />
  <img src="docs/images/logo.svg" alt="Contextium" width="520" />
</picture>
</a>

<br/><br/>

### AI that doesn't learn isn't intelligence.

**Give your AI an operating system.**

<br/>

[![Open Source](https://img.shields.io/badge/Open_Source-Apache_2.0-00b4d8.svg?style=for-the-badge)](LICENSE)
[![Version](https://img.shields.io/badge/v2.0.0-1a1a2e.svg?style=for-the-badge)](CHANGELOG.md)

[![Claude Code](https://img.shields.io/badge/Claude_Code-cc785c.svg?style=flat-square)](agent-configs/claude/)
[![Cursor](https://img.shields.io/badge/Cursor-7c3aed?style=flat-square)](agent-configs/cursor/)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-10a37f?style=flat-square)](agent-configs/codex/)
[![Gemini CLI](https://img.shields.io/badge/Gemini_CLI-4285F4?style=flat-square)](agent-configs/)
[![Windsurf](https://img.shields.io/badge/Windsurf-0ea5e9?style=flat-square)](agent-configs/)
[![Cline](https://img.shields.io/badge/Cline-f97316?style=flat-square)](agent-configs/)
[![Aider](https://img.shields.io/badge/Aider-14b8a6?style=flat-square)](agent-configs/)
[![Continue](https://img.shields.io/badge/Continue-8b5cf6?style=flat-square)](agent-configs/)
[![GitHub Copilot](https://img.shields.io/badge/GitHub_Copilot-24292e?style=flat-square)](agent-configs/)
[![Ollama](https://img.shields.io/badge/Ollama-808080?style=flat-square)](agent-configs/ollama/)

</div>

---

## The Problem

You can _see_ what AI should be — a genuine multiplier across everything you do. But every session starts from zero. You
re-explain who you are, what you're working on, and what you already decided. Decisions evaporate. Context vanishes.
Knowledge never compounds.

Native AI "memory" stores a flat list of facts in a black box. That's not intelligence — it's a sticky note.

## The Solution

Contextium is an open-source operating system for your AI. A structured git repo with persistent context, behavioral
rules, and session compounding — so every session builds on the last.

The more you use it, the richer the context becomes. Your AI learns your goals, tracks your projects, knows your
relationships, follows your rules, and compounds knowledge with every session.

## Quick Start

```bash
curl -sSL contextium.ai/install | bash
```

The installer asks your name, which AI agent you use, how you like to communicate, and how autonomous your AI should be.
Then it installs your agent's CLI and opens your first session. Under 5 minutes.

See [GETTING-STARTED.md](GETTING-STARTED.md) for what to do after installation.

## Key Innovations

| Innovation                     | What It Does                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **Context Router**             | Lazy-loads only the files relevant to the current session — no token bloat                                       |
| **Behavioral Enforcement**     | Hooks prevent AI drift — your preferences are enforced, not suggested                                            |
| **Session Compounding**        | Journal entries + git history = every session builds on every previous session                                    |
| **You Own Your Context**       | Plain markdown on your machine — switch AI agents, change providers, or leave entirely. Your context stays yours |
| **Your AI Actually Knows You** | After a month, your AI knows your goals, relationships, decisions, and style. Not a generic assistant — _yours_  |

## Architecture

```
your-context/
├── CLAUDE.md              # Instruction file (auto-configured for your agent)
├── GETTING-STARTED.md     # Post-install guide
│
├── preferences/           # Your rules, voice, and standards
│   ├── user/              # Who you are, how you communicate
│   ├── rules/             # Behavioral and governance rules
│   ├── style_guides/      # Email, code, presentation standards
│   └── templates/         # Project, journal, app README templates
│
├── knowledge/             # Your domain data (people, goals, etc.)
├── apps/                  # Your automations (starts empty)
├── integrations/          # Your connected tools (starts empty)
├── projects/              # Your tracked initiatives (starts empty)
├── journal/               # Your session logs (grows automatically)
│
└── templates/             # Reference catalog
    ├── apps/              # 6 example app patterns to learn from
    └── integrations/      # 30 integration connectors to configure
```

Your working directories (`apps/`, `integrations/`, `projects/`) start clean. Templates are reference material — copy
what you need, when you need it, or just ask your AI to set things up.

## How It Works

### Session Lifecycle

1. **Start a session** — Your AI reads its instruction file, loads your preferences, and classifies the work.
2. **Work on a task** — The context router lazy-loads relevant files as needed: people cards, project READMEs, prior
   journal entries.
3. **End the session** — Say "close this out." Your AI journals what happened, commits, and pushes.
4. **Next session** — Full history of what you did, decided, and why. No repetition. No context loss.

### Context Router

Your AI doesn't preload your entire repo. It loads files based on what you're doing:

| When you...            | AI loads...                             |
| ---------------------- | --------------------------------------- |
| Start any session      | `preferences/user/preferences.md`       |
| Mention a person       | `knowledge/people/{name}/`              |
| Work on a project      | `projects/{domain}/{project}/README.md` |
| Need credentials       | `templates/integrations/1password/`     |
| Reference prior work   | `journal/` (latest entries)             |

### Templates Catalog

30 integration connectors and 6 example apps ship as templates — reference material your AI uses when you ask it to set
something up. You never need to browse them manually.

> "Set up Google Calendar" → AI reads `templates/integrations/google-workspace/` and guides you through setup
> "I want a daily briefing email" → AI scaffolds from `templates/apps/news-digest/`

## Update System

Framework updates without losing your data:

```bash
./install.sh update
```

Your personal data in `preferences/user/`, `knowledge/`, `journal/`, and `projects/` is protected during updates via
`.gitattributes` merge strategies.

## Philosophy

**Context as infrastructure.** Your AI's effectiveness is directly proportional to the context it has. Contextium treats
context as persistent, structured, version-controlled infrastructure.

**You own your context.** Every other AI tool locks your accumulated context inside their platform. Contextium is plain
markdown on your machine. Switch providers tomorrow — your context comes with you.

**Sessions compound.** Every journal entry, every project README, every people card makes the next session richer.

**Start clean, grow organically.** No pre-installed apps or integrations cluttering your workspace. Your AI sets things
up as you need them — from conversation, not configuration.

## Contributing

We welcome contributions — especially new app templates and integration connectors. See
[CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[Apache 2.0](LICENSE) — use it, modify it, share it.
