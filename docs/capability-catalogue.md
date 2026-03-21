# Contextium Capability Catalogue

Every capability in the Contextium framework, organized by category.

---

## A. Integrations (28)

### Credential Management

| Integration | What It Does |
|-------------|-------------|
| **1Password** | Secure vault for API keys, secrets, and credentials. CLI-based access (`op read`, `op item get`) |

### Productivity

| Integration | What It Does |
|-------------|-------------|
| **Google Workspace** | Drive, Sheets, Gmail, Calendar, Contacts, Docs via OAuth2. Multi-account support |
| **Google Auth** | OAuth2 credential management for Google APIs |
| **Todoist** | Task management — CRUD operations, completion stats, project tracking |
| **Strety** | EOS platform — scorecards, rocks, to-dos, meeting prep |

### Automation Platforms

| Integration | What It Does |
|-------------|-------------|
| **Windmill** | Self-hosted workflow automation — scheduled jobs, webhooks, multi-step pipelines |
| **n8n** | Alternative workflow platform — complex multi-step workflows, webhook handling |

### Infrastructure

| Integration | What It Does |
|-------------|-------------|
| **Cloudflare** | Pages, Workers, DNS, Tunnels, Zero Trust access |
| **TrueNAS** | NAS and Docker container management via SSH |
| **Garage** | S3-compatible object storage for backups and assets |
| **Daedalus** | Local service management — systemd services, timers, daemons |
| **VS Code** | Remote development tunnel |

### AI Delegation Agents

| Integration | What It Does |
|-------------|-------------|
| **Codex CLI** | Code generation and bulk file editing in separate context |
| **Gemini CLI** | Web research, content summarization, Todoist operations |
| **Browse** | Browser automation via Playwright for web scraping and UI tasks |
| **Ollama** | Local AI inference — private, offline, cost-free |

### Business Tools

| Integration | What It Does |
|-------------|-------------|
| **Autotask** | PSA/ticketing — ticket data, SLA metrics, company info |
| **NinjaOne** | Device inventory, hardware lifecycle, security assessments |
| **QuickBooks Online** | Business accounting — P&L, Balance Sheet, financial reports |
| **Hudu** | IT documentation platform — knowledge base, client info |
| **MSPBots** | MSP analytics — business metrics, KPI dashboards |

### Personal Finance

| Integration | What It Does |
|-------------|-------------|
| **Monarch** | Personal finance — account balances, transactions, budgets |

### Smart Home

| Integration | What It Does |
|-------------|-------------|
| **Home Assistant** | Home automation — device control, automation triggers, sensor data |

### Interfaces

| Integration | What It Does |
|-------------|-------------|
| **TRMNL** | E-ink dashboard display — focus board, calendar, metrics |
| **Remote Control** | Mobile access to AI agent from phone/tablet |
| **HAPI** | Voice interface — speech-to-text + text-to-speech |

### Reference

| Integration | What It Does |
|-------------|-------------|
| **Host Docs Map** | Documentation hosting reference — maps which docs live where |

---

## B. Apps (6 sample protocols)

Each app follows a labeled pattern:

| App | Pattern | Category | Description |
|-----|---------|----------|-------------|
| **Shared Utilities** | Utility | System | Reusable notification and email functions used by other apps |
| **Goals** | Reference | Personal | Personal and professional goal tracking across quarterly, annual, and multi-year horizons |
| **Health Tracker** | Data Sync | Personal | Biomarker, supplement, genetic profile, and health decision tracking |
| **News Digest** | Timer + Email | Daily | AI-curated daily news and opinion digests from RSS feeds |
| **Error Remediation** | System/Event | System | Auto-retry failed operations, AI diagnosis, escalation to human |
| **Today's Agenda** | Briefing | Daily | Morning email with calendar events, tasks, focus blocks, and active projects |

### Automation Patterns

| Pattern | Flow | Example |
|---------|------|---------|
| **Timer + Email** | Cron → Fetch → Transform/Curate → Email | News Digest |
| **Data Sync** | Webhook/API → Transform → Write to repo | Health Tracker |
| **System/Event** | Error → Retry → AI Diagnose → Fix/Escalate | Error Remediation |
| **Briefing** | Cron → Aggregate multiple sources → Formatted email | Today's Agenda |
| **Reference** | Manual protocol → AI follows steps when triggered | Goals |
| **Utility** | Webhook → Process → Deliver (called by other apps) | Shared Utilities |

---

## C. Knowledge Base

Domain-organized reference data:

| Domain | Content Type |
|--------|-------------|
| **People** | Relationship cards — structured context about contacts, family, colleagues |
| **Growth** | Goals (quarterly/annual/multi-year), assessments, coaching notes |
| **Health** | Biomarkers, supplements, genetics, fitness, dietary frameworks |
| **Finance** | Tax, insurance, assets, budgets, investment strategies |
| **Home** | Property details, vehicles, maintenance records |
| **Work** | Business strategy, client data, industry knowledge |

### People Card System

Two tiers:
1. **Rich entity directories** for important people — README + goals.md + health.md + vision.md
2. **Lightweight cards** for everyone else — single README with tagged notes

---

## D. Behavioral Patterns

### Delegation-First

| Need | Route To | Why |
|------|----------|-----|
| Explore codebase (2+ files) | Sub-agent | Saves main context |
| Web research | Gemini CLI | Summarizes externally |
| Bulk edits (>2 files) | Codex CLI | Separate context window |
| Local/private inference | Ollama | Runs locally, no cost, works offline |
| Scheduled tasks | Windmill/n8n | Deterministic, no AI cost |

### Context Efficiency

- **Lazy loading** — files loaded only when triggered by the context router
- **Grep before Read** — find specific lines instead of loading entire files
- **Sub-agents for exploration** — summaries enter context, not raw data
- **Offset/limit for large files** — read only relevant sections

### Session Discipline

1. **Classify** — New Project / Existing / One-Off
2. **Work** — Read context, make changes, delegate when efficient
3. **Close** — Journal entry + git commit + push

### Depth Policy

- **Decisions** — present alternatives, trade-offs, risks
- **Execution** — stay concise, execute directly

---

## E. Preferences System

### Rules

| Rule | What It Does |
|------|-------------|
| **Delegation-first** | Prefer tools that use separate context windows |
| **Context efficiency** | Minimize token consumption, use sub-agents |
| **Depth policy** | Go deep on decisions, stay concise on execution |
| **Proactive value** | Surface adjacent insights after completing work |
| **Credential handling** | All secrets in vault, never on disk |
| **Repo hygiene** | No build artifacts, no nested .gitignore |
| **Project lifecycle** | Create with README, add to tracker, push immediately |
| **Session end** | Journal + commit + push together |

### Templates

| Template | Purpose |
|----------|---------|
| **Journal** | Structured session log format (YAML frontmatter + sections) |
| **Project README** | Standard project tracker (goal, status checkboxes, progress) |
| **App README** | App protocol format (frontmatter, protocol, data, automation) |

### Style Guides

| Guide | Covers |
|-------|--------|
| **Email Templates** | HTML email design tokens for automation-generated emails |

---

## F. Update System

- **Installer** (`install.sh`) — fresh install + update in one script
- **Protected paths** — `.gitattributes` merge=ours for user data
- **Semantic versioning** — Major (breaking), Minor (new features), Patch (fixes)
- **Upstream remote** — `git fetch upstream && git merge upstream/main`
