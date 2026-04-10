# Apps

Each app is a self-contained capability — a protocol (README) and optionally automation code.

**What belongs here:** Protocols, SOPs, and automation scripts.
**What doesn't:** Data, records, entries, logs. Those live in `knowledge/`.

## Your Apps

*No apps installed yet. Apps appear here as you build them.*

## Example Apps

Browse `templates/apps/` for patterns you can use as starting points — or just ask your AI:

> "I want a daily morning briefing email"
> "Set up goal tracking"
> "I want to automate my weekly report"

Your AI will scaffold the right app structure for you.

| Template | Pattern | Purpose |
|----------|---------|---------|
| [goals](../templates/apps/goals/) | Reference | Personal and professional goal tracking |
| [health](../templates/apps/health/) | Data Sync | Health biomarker tracking with staleness alerts |
| [news-digest](../templates/apps/news-digest/) | Timer + Email | AI-curated daily news digests |
| [todays-agenda](../templates/apps/todays-agenda/) | Briefing | Morning briefing with calendar, tasks, and goals |
| [error-remediation](../templates/apps/error-remediation/) | System/Event | Auto-recovery for failed automation workflows |
| [project-index](../templates/apps/project-index/) | System | Generates projects/README.md from frontmatter |

## Shared Utilities

The `shared/` directory contains reusable functions for notifications, email, and other common operations.
