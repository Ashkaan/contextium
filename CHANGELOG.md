# Changelog

All notable changes to Contextium are documented here.

## [1.1.0] — 2026-03-20

### Interactive Installer

- **Full onboarding baked into installer** — name, AI agent, integrations, communication style, profession, goals, and first knowledge domain all configured before first session
- **9 AI agents supported** — Claude Code, Gemini, Codex, Cursor, Windsurf, Cline, Aider, Continue, GitHub Copilot
- **Sectioned integration picker** — 6 categories (AI delegation, productivity, automation, infrastructure, business, interfaces) with contextual explanations
- **Beautiful TUI** — powered by [gum](https://github.com/charmbracelet/gum) with auto-install
- **GitHub backup** — inline gh CLI install + browser auth flow with QR code support
- **Agent CLI install** — automatically installs and launches your chosen AI agent
- **Codespace detection** — graceful handling with AI prompt fallback instead of CLI commands

### Agent Configs

- **All 9 agent instruction files** — `agent-configs/` now contains templates for every supported agent
- **Correct filenames** — each agent gets its native instruction file (CLAUDE.md, GEMINI.md, .cursorrules, .windsurfrules, .clinerules, CONVENTIONS.md, .continue/rules, copilot-instructions.md)
- **Post-install cleanup** — `agent-configs/` removed after copying, keeping the user's repo clean

### Polish

- **Social preview image** — branded 1280x640 for GitHub/Twitter/LinkedIn sharing
- **Expanded root CLAUDE.md** — useful even without running the installer
- **Fixed WSL docs links** — updated to learn.microsoft.com
- **App README template** — aligned with actual app README structure
- **Integration READMEs improved** — 10 of 27 substantially rewritten with real setup commands and examples
- **Git history preserved** — upstream merges now work (no more `rm -rf .git`)
- **Agent-agnostic update detection** — `./install.sh update` works regardless of which agent was chosen

---

## [1.0.0] — 2026-03-19

### Initial Release

**Core Framework:**
- Structured repo architecture with 6 layers (instruction files, apps, knowledge, integrations, preferences, projects + journal)
- Context router with lazy loading — loads only what's relevant per session
- Behavioral rules (delegation-first, context efficiency, depth policy)
- Governance rules (credentials, repo hygiene, project lifecycle, session discipline)
- `.gitattributes` merge strategy protecting user data during updates

**Onboarding:**
- 5-minute quick onboarding flow ("let's onboard")
- Dynamic agent config selection (Claude Code, Cursor, Codex)
- 5 pre-loaded setup projects (integrations, people cards, health tracking, automation, daily briefing)

**Sample Apps (6):**
- Shared Utilities (Utility pattern)
- Goals (Reference pattern)
- Health Tracker (Data Sync pattern)
- News Digest (Timer + Email pattern)
- Error Remediation (System/Event pattern)
- Today's Agenda (Briefing pattern)

**Integration Connectors (27):**
- Credential management (1Password)
- Productivity (Google Workspace, Todoist)
- Automation (Windmill, n8n)
- Infrastructure (Cloudflare, TrueNAS, Garage, Daedalus)
- AI agents (Codex, Gemini, Browse)
- Business tools (Autotask, NinjaOne, QuickBooks, Monarch, Strety, Hudu, MSPBots)
- Smart home (Home Assistant)
- Interfaces (TRMNL, Remote Control, HAPI, VS Code)

**Templates:**
- Journal entry format
- Project README format
- App README format
- Email template guide

**Installer:**
- `install.sh` with init (fresh install) and update (pull upstream) modes
- Protected path merging for user data
