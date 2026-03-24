# Gemini

AI research agent for web research, content summarization, and tasks requiring real-time internet access. Used as a
delegated sub-agent when Claude needs to browse the web or interact with external services.

## Requirements

- Node.js 18+ (for npm install)
- Google AI API key (Gemini API) or Google Cloud project with Vertex AI enabled
- Network access to Google APIs

## Setup

1. Install the Gemini CLI:
   ```bash
   npm install -g @anthropic-ai/gemini-cli
   # Or if using the Google-native CLI:
   npm install -g @google/gemini-cli
   ```
2. Get an API key from [aistudio.google.com](https://aistudio.google.com/apikey)
3. Store the key in your credential vault:
   ```bash
   op item create --category=login --title="Gemini - API Key" \
     --vault="AI" api_key="your-key-here"
   ```
4. Export for CLI use:
   ```bash
   export GEMINI_API_KEY=$(op read "op://AI/Gemini - API Key/api_key")
   ```
5. Verify: `gemini "What is the current date and time?"`
6. See `agent-configs/claude/GEMINI.md` for delegation rules and prompt templates

## When to Delegate to Gemini

Use Gemini when the task requires capabilities Claude does not have natively:

| Scenario                   | Why Gemini                              |
| -------------------------- | --------------------------------------- |
| Web research               | Can browse live URLs and search the web |
| Current events             | Has real-time internet access           |
| URL content extraction     | Can fetch and parse web pages           |
| Fact-checking with sources | Can verify claims against live sources  |
| Todoist operations         | Can interact with Todoist API directly  |

**Do NOT delegate** when the task only requires reasoning over data already in context -- that is faster to do directly.

## Key Commands

```bash
# Basic research query
gemini "Research the latest pricing changes for Cloudflare Workers and summarize"

# URL summarization
gemini "Summarize this article: https://example.com/article"

# Multi-step research
gemini "Find the top 5 S3-compatible storage providers, compare pricing, and output a markdown table"

# Task management via Todoist
gemini "Create a Todoist task: Review Q1 financials, due next Friday, priority 2"
```

## Prompt Tips

- Be specific about output format: "output as a markdown table" or "summarize in 3 bullet points"
- Include scope limits: "focus only on pricing, not features"
- Request sources: "include URLs for each claim"
- For complex research, break into steps rather than one mega-prompt

## Use Cases

- Gathering competitive research for business decisions
- Summarizing long articles, reports, or documentation pages
- Getting current information beyond the AI's training data
- Managing Todoist tasks through natural language
- Verifying facts and claims against live sources
