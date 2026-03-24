# Gemini Research Agent Guide

## When to Use Gemini

Use Gemini (via `gemini -p "..."`) for tasks that require external information:

| Task                        | Why Gemini                                             |
| --------------------------- | ------------------------------------------------------ |
| Web research                | Accesses current information                           |
| Large content summarization | Processes externally, only summary enters your context |
| Todoist operations          | Direct task management integration                     |
| YouTube analysis            | Handles JS-rendered content                            |

## How to Invoke

```bash
# Research query
gemini -p "research: what are the latest best practices for OAuth2 token rotation in 2026?"

# Todoist operations
gemini -p "todoist: add task 'Review quarterly goals' due tomorrow"

# YouTube (requires oEmbed first)
# 1. Fetch metadata: youtube.com/oembed?url=<URL>&format=json
# 2. Pass title + author to gemini
gemini -p "summarize this video: [title] by [author]"
```

## Conventions

- Gemini results are summaries — verify critical facts
- Use for research-heavy tasks to preserve Claude's context for strategy
- Log delegations in journal entries

## Delegation Logging

When delegating non-trivial research, log in the journal:

- `gemini: researched OAuth2 best practices -> 5 key recommendations`
- `gemini: summarized 3 competitor products -> comparison matrix`
