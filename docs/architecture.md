# Architecture

## Core Principle: Context as Infrastructure

Contextium treats your AI's context as infrastructure — not chat history, not embeddings, not a prompt library. A structured, version-controlled repository that your AI reads and writes to.

## The Six Layers

### Layer 1: Instruction File

The AI's operating manual. The installer places **one** instruction file at the repo root based on which AI agent you chose:

| Agent | Root File |
|-------|-----------|
| Claude Code | `CLAUDE.md` |
| Codex CLI | `AGENTS.md` |
| Gemini CLI | `GEMINI.md` |
| Cursor | `.cursorrules` |
| Windsurf | `.windsurfrules` |
| Cline | `.clinerules` |
| Aider | `CONVENTIONS.md` |
| Continue | `.continue/rules` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Ollama | `Modelfile` + `CLAUDE.md` (reference) |

All contain the same core architecture — context router, session lifecycle, delegation rules — formatted for the specific agent's instruction format. Ollama uses a Modelfile with the instructions baked into the SYSTEM prompt. Templates for all agents live in `agent-configs/`.

The instruction file contains:
- **Context Router** — which files to load for which triggers
- **Session Classification** — New Project / Existing / One-Off
- **Repo Structure Map** — what each directory contains
- **Rule Index** — pointers to behavioral and governance rules

### Layer 2: Apps (`/apps/`)

Self-contained capabilities, each with:
- A protocol (README.md) defining how it works
- Optional automation scripts
- No data (data lives in `/knowledge/`)

**Boundary test:** Delete `knowledge/{domain}/` and the app still makes sense. Delete `apps/{name}/` and you have data with no context.

**App Patterns:**
| Pattern | Example | Description |
|---------|---------|-------------|
| Reference | Goals | Manual protocol, no automation |
| Data Sync | Health | Webhook/timer syncs external data to repo |
| Timer + Email | News Digest | Cron fetches data, AI curates, sends email |
| System/Event | Error Remediation | Reacts to system events, auto-remediates |
| Briefing | Today's Agenda | Daily scheduled aggregation from multiple sources |
| Utility | Shared | Reusable functions called by other apps |

### Layer 3: Knowledge (`/knowledge/`)

Domain-organized reference data. Static and semi-static information:
- `growth/` — goals, reflections, coaching
- `health/` — biomarkers, supplements, genetics
- `finance/` — tax, insurance, assets
- `people/` — relationship cards for important people
- Custom domains you create during onboarding

### Layer 4: Integrations (`/integrations/`)

External service connectors. Each maintains:
- A README explaining setup and API usage
- Optional helper scripts
- Token management docs

### Layer 5: Preferences (`/preferences/`)

Rules, templates, and style guides:
- `user/preferences.md` — your communication and working style
- `rules/` — behavioral patterns (delegation, efficiency) + governance (credentials, hygiene)
- `templates/` — project, journal, app README formats
- `style_guides/` — email design, app development conventions

### Layer 6: Projects + Journal

**Projects** (`/projects/`): Time-boxed work in dated folders with README trackers.

**Journal** (`/journal/`): Daily structured logs (YAML, not prose) that capture decisions, lessons, and next steps.

## Key Design Patterns

### Lazy Loading
The context router loads files only when triggered — not everything at session start. This prevents token bloat and keeps the AI focused.

### Delegation Architecture
Route expensive work to the right tool:
| Need | Route to | Why |
|------|----------|-----|
| Web research | Gemini | Summarizes externally, only result enters context |
| Bulk edits (>2 files) | Codex | Direct editing in separate context |
| Scheduled tasks | Automation platform | Deterministic, no AI cost |
| Local/private inference | Ollama | Runs locally, no cost, works offline |
| Quick facts | Web search | Cheapest, smallest result |

### Session Lifecycle
1. **Start** — Classify request (New Project / Existing / One-Off)
2. **Work** — Load context on demand, delegate when efficient
3. **End** — Journal entry + git commit + push

### Behavioral Enforcement
Rules aren't aspirational — they can be enforced:
- Git hooks prevent common mistakes
- Desired-state reconciliation catches drift
- Session governance ensures journal + push at session end

## Data Flow

```
You ←→ AI Agent ←→ CLAUDE.md (router)
                        ↓
           ┌────────────┼────────────┐
           ↓            ↓            ↓
        apps/      knowledge/   integrations/
           ↓            ↓            ↓
      projects/    journal/    preferences/
```

## No Vendor Lock-In

Everything is:
- Plain text markdown (human-readable)
- Version-controlled in git (full audit trail)
- YAML frontmatter (structured metadata)
- Portable (move to a different AI tomorrow)
