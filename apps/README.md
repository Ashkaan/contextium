# Apps

Each folder is a self-contained app — a capability with a protocol (README) and optionally automation code.

**What belongs here:** Protocols, SOPs, and automation scripts.

**What doesn't:** Data, records, entries, logs. Those live in `knowledge/`.

**Boundary test:** Delete `knowledge/{domain}/` and the app still works (no data). Delete `apps/{name}/` and you have data with no protocol.

## Sample Apps

These apps demonstrate the core patterns. Use them as templates for your own.

| App | Pattern | Purpose |
|-----|---------|---------|
| [shared](shared/) | Utility | Reusable notification and email functions |
| [goals](goals/) | Reference | Personal and professional goal tracking |
| [health](health/) | Data Sync | Health biomarker tracking with staleness alerts |
| [news-digest](news-digest/) | Timer + Email | AI-curated daily news and opinion digests |
| [project-index](project-index/) | Generator | Builds projects/README.md from project frontmatter |
| [error-remediation](error-remediation/) | System/Event | Auto-recovery for failed automation workflows |
| [todays-agenda](todays-agenda/) | Briefing | Morning briefing with calendar, tasks, and goals |
