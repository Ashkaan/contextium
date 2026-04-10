# Changelog

All notable changes to Contextium are documented here.

## [2.0.0] — 2026-04-09

### Restructure — Templates, Setup Projects Removed, Config Cleanup

- **`apps/project-index/generate.ts` moved to `templates/apps/`** — the project index generator is now a template, not a shipped app. AI agents can maintain project tables from instructions alone
- **`projects/setup/` removed** — setup projects replaced by templates in `templates/` and AI-guided onboarding
- **Project-index trigger removed from all agent configs** — the "Changing project status → run generate.ts" context router row removed from all 5 configs that had it (Claude, Gemini, Codex, Aider, Copilot)
- **4 agent configs completed** — Cursor, Cline, Continue, and Windsurf now include Session End, New Apps, Automation Scripts sections and the people card trigger
- **Docs updated** — getting-started, onboarding-guide, and CONTRIBUTING.md no longer reference `projects/setup/`
- **`.claude/hooks/` and `.claude/settings.json` tracked** — .gitignore updated to allow Claude Code hooks and settings while keeping other .claude/ contents ignored

---

## [1.4.0] — 2026-03-27

### Rules, Style Guide, Templates & New Integrations

**Rules — behavior.md (6 improvements):**
- **"Don't write to agent memory, use repo"** — explicit anti-pattern guidance for agents with native memory features
- **Fresh context for complex builds** — new subsection: delegate 3+ iteration builds to sub-agents with fresh context windows
- **Tracking Completions** — new section: when user marks items done, update the docs immediately (prevents stale next-steps)
- **Focused agent prompts** — new context efficiency rule: "What function handles X?" not "Read file Y and summarize"
- **Depth policy enhancement** — decisions must state why when skipping deep analysis
- **Proactive value expanded** — concrete examples: cross-project connections, timing opportunities, risk flags

**Rules — governance.md (4 new sections):**
- **"Never exclude to avoid fixing"** — .gitignore philosophy: don't add entries to work around lint/format issues, fix the actual content
- **Automation Quality** — no silent failures: a "successful" job with missing data is worse than a failed job
- **Email Policy** — AI should never send emails on behalf of the user; draft for review instead
- **Project status change workflow** — `blocked-on` for waiting status, frontmatter as source of truth, generation script integration

**Rules — incident-response.md (new file):**
- Restore-first triage protocol for monitoring alerts, failing schedules, and outages
- Six-step flow: diagnose → minimum fix → commit + push → deploy → verify → then improve

**Style guide — code-conventions.md (new file):**
- Comprehensive TypeScript conventions: type safety, naming, file structure, imports, functions, types, error handling, comments, anti-patterns
- Shell script conventions: safety flags, naming, formatting, quoting, functions, error messages
- Deno fmt formatting reference
- Sourced from Deno style guide, Effective TypeScript, and Google shell guide

**Template — automation-spec.md (new file):**
- Structured specification template for automation scripts with frontmatter, success criteria, outcome validation, architecture, error handling, credentials, and testing sections

**Agent configs — all 11 updated:**
- **"Every session" row now loads rules** — `behavior.md` and `governance.md` are loaded alongside `preferences.md` and `integrations/README.md`. Previously, rules were invisible unless manually triggered
- **Lazy-load instruction clarified** — "MUST be loaded before doing any work" for every-session items
- **3 new context router triggers** — screenshots/visual verification → browse, monitoring alerts → incident-response, TypeScript/shell → code-conventions
- Removed web app and presentation triggers (style guides not shipped in this release)

**New integrations (3):**
- **Notion** — knowledge base, wikis, and project management (API setup, authentication, usage examples)
- **Stitch** — Google's AI UI design tool (delegation-first workflow, Gemini CLI extension setup)
- **Zoom** — meeting summaries via AI Companion (Server-to-Server OAuth, scopes, API docs, double-encoding gotcha)
- All three added to installer integration picker (30 total integrations)

**Rules README updated:**
- Enforcement matrix expanded with new rules (automation quality, email policy, incident response, tracking completions)
- incident-response.md added to rule files table

**Documentation updated:**
- Capability catalogue — integration count updated to 30, new entries for Notion/Stitch/Zoom, code-conventions style guide, automation-spec template, incident-response and new governance rules added
- Architecture — trigger count updated to 18
- Templates README — new index file listing all 4 templates

---

## [1.3.2] — 2026-03-24

### Code Quality & CI Hardening

- **Shell convention compliance** — all `[ ]` tests converted to `[[ ]]` (bash best practice), error/warning messages now route to stderr (`>&2`), intentional word-splitting sites documented with `shellcheck disable` comments
- **Installer deduplication** — extracted 6 shared functions (`filter_integrations`, `create_profile`, `write_preferences`, `create_knowledge_domain`, `update_integrations_readme`, top-level `INTEGRATION_MAP`), eliminating ~150 lines of copy-paste between `init()` and `test_install()`
- **CI: shellcheck added** — `install.sh` is now linted on every push and PR
- **CI: secret scanning added** — checks for leaked AWS keys, API tokens, and GitHub PATs
- **CI: link checker fixed** — broken internal links are now properly detected (was silently passing due to pipeline subshell bug)
- **CI: `shell: bash` declared** — all CI steps now explicitly use bash, with `[[ ]]` conditionals

---

## [1.3.1] — 2026-03-23

### Project Index Generator + Status Change Trigger

- **Project Index app** — new `apps/project-index/generate.ts` script that walks `projects/`, reads frontmatter, and generates a status overview table at `projects/README.md`. Generic (no hardcoded domains), auto-discovers project directories
- **Project status change trigger** — all 11 agent configs now include "Changing project status → run `npx tsx apps/project-index/generate.ts`" in the context router. This was the last deferred item from v1.2.6
- **7 sample apps** (was 6) — Project Index added as a Generator pattern

---

## [1.3.0] — 2026-03-23

### Instruction File Refresh on Update (Breaking Fix)

- **Root instruction file now refreshed during `./install.sh update`** — previously, the root file (CLAUDE.md, .cursorrules, etc.) was copied once during install and never updated. Framework improvements to the context router, MANDATORY protocols, and governance rules never reached existing users. Now `update` detects which agent was installed and re-copies from the merged `agent-configs/`
- **Agent-specific source files** — installer now copies from each agent's native config file (e.g., `agent-configs/cursor/.cursorrules`) instead of always using `agent-configs/claude/CLAUDE.md`
- **Codex CLI fully supported** — proper `AGENTS.md` instruction file with full context router, MANDATORY protocols, and repo structure (was a placeholder since v1.0)
- **Ollama Modelfile preserved on update** — user's model choice (`FROM llama3.1`) is preserved when refreshing instructions

### Documentation Updated

- **Capability catalogue** — added MANDATORY protocols section, context repo parity rule, journal format guidelines
- **Architecture** — updated instruction file layer with MANDATORY protocols and hook-based enforcement
- **Update guide** — documents the instruction file refresh step and why it matters

---

## [1.2.7] — 2026-03-23

### All Agent Configs Updated + Automation Deploy Guard

- **All 10 agent configs updated** — Session End MANDATORY, New Apps MANDATORY, Automation Scripts MANDATORY, expanded context router triggers, and people card trigger now present in all agent instruction files (Claude, Cursor, Gemini, Windsurf, Cline, Aider, Continue, Copilot, Ollama)
- **Automation Scripts MANDATORY** — new guarded section: reminds to deploy after editing automation scripts, with "skip if no platform configured" escape hatch for users without Windmill/n8n

---

## [1.2.6] — 2026-03-23

### Governance & Router Improvements

- **Session End elevated to MANDATORY** — moved from governance.md to the main CLAUDE.md instruction file so AI agents see it immediately, not buried in rules
- **New Apps MANDATORY section** — new app directories now require a README protocol and registry entry in `apps/README.md`
- **Context Repo Parity rule** — governance now enforces that every automation script has a source file in the repo
- **Journal format guidelines** — recommended structure for journal entries (frontmatter, session headings, Decisions emphasis, target size) framed as defaults
- **Delegation pre-check trigger** — context router now loads `integrations/README.md` before delegating bulk work, ensuring the right tool is chosen
- **Style guide triggers** — router now loads style guides for web apps and presentations when relevant
- **People card trigger** — router loads `knowledge/people/README.md` when creating or updating a people card
- **Concrete hook examples** — rules README now shows actual hook implementations (block-memory-writes, session-checklist, api-docs-gate, context-efficiency) with event types and descriptions

---

## [1.2.5] — 2026-03-21

### Ollama Support

- **Ollama as 10th primary AI agent** — selectable in the installer alongside Claude Code, Gemini, Codex, Cursor,
  Windsurf, Cline, Aider, Continue, and GitHub Copilot
- **Modelfile generation** — installer creates a Modelfile with Contextium instructions baked into the SYSTEM prompt
- **Model selection** — installer prompts for which Ollama model to use (default: llama3.1)
- **Auto-install** — installer handles Ollama CLI installation, model pull, and custom model creation
- **Ollama as delegation target** — available in the AI delegation section for routing local/private/offline tasks
- **New integration** — `integrations/ollama/README.md` with setup docs, model recommendations, and usage patterns

---

## [1.1.0] — 2026-03-20

### Interactive Installer

- **Full onboarding baked into installer** — name, AI agent, integrations, communication style, profession, goals, and
  first knowledge domain all configured before first session
- **9 AI agents supported** — Claude Code, Gemini, Codex, Cursor, Windsurf, Cline, Aider, Continue, GitHub Copilot
- **Sectioned integration picker** — 6 categories (AI delegation, productivity, automation, infrastructure, business,
  interfaces) with contextual explanations
- **Beautiful TUI** — powered by [gum](https://github.com/charmbracelet/gum) with auto-install
- **GitHub backup** — inline gh CLI install + browser auth flow with QR code support
- **Agent CLI install** — automatically installs and launches your chosen AI agent
- **Codespace detection** — graceful handling with AI prompt fallback instead of CLI commands

### Agent Configs

- **9 agent instruction files** — `agent-configs/` with templates for Claude Code, Gemini, Codex, Cursor, Windsurf,
  Cline, Aider, Continue, GitHub Copilot (Ollama added in v1.2.5)
- **Correct filenames** — each agent gets its native instruction file (CLAUDE.md, GEMINI.md, .cursorrules,
  .windsurfrules, .clinerules, CONVENTIONS.md, .continue/rules, copilot-instructions.md)
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

- Structured repo architecture with 6 layers (instruction files, apps, knowledge, integrations, preferences, projects +
  journal)
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
