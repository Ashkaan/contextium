---
name: News Digest
description: >-
  Daily email digests: curated news from RSS feeds across multiple topics,
  and curated opinions from commentary sources.
category: daily
schedule: Daily (configurable time)
runtime: Your automation platform
trigger: Timer
outputs:
  - Email digest(s)
integrations:
  - RSS feeds
  - AI research agent (Gemini or similar)
  - Gmail or SMTP
---

# News Digest

Daily AI-curated news and opinion digests delivered by email.

## Pattern: Timer + Email

A scheduled job fetches sources, an AI agent curates and summarizes, then sends a formatted email.

## Architecture

```
Timer → Fetch RSS feeds → AI curation (summarize, deduplicate) → Format HTML email → Send
```

## Configuration

### News Sources

Define RSS feeds organized by topic:

- Technology, Science, Politics, World News, etc.
- Add/remove feeds as interests change

### Opinion Sources

Define commentary sources across perspectives:

- Different viewpoints ensure balanced coverage
- AI groups by debate topic, not source

### Email Format

Uses the shared email template (see `preferences/style_guides/email_templates.md`).

## Implementation

1. Set up RSS feed list (JSON or YAML)
2. Create automation workflow: fetch → AI summarize → format → send
3. Schedule for your preferred morning time
