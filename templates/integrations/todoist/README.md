---
name: Todoist
description: Task management via Unified API
hosts:
  - api.todoist.com
aliases:
  - task management
  - personal tasks
  - todoist task
typed_client:
  - none
access:
  - api
uses: none
base_url: https://api.todoist.com/api/v1
auth: bearer token
onepassword_item: none
rate_limit: 450 requests per 15 minutes per user
cli: curl (direct API)
---
# Todoist Integration

**Access via:** Unified API v1 (REST v2 and Sync v9 are deprecated/410)
**API Token:** stored in your secrets vault as `Todoist - <consumer>`, field `api_key` (`op item get "<todoist-item-id>" --vault "<your-vault>" --reveal --fields api_key`)
**Base URL:** `https://api.todoist.com/api/v1`

## If you write a client

Nothing here ships one; the `curl` reference below covers it. If your code files tasks, keep it thin: a session holding the Bearer token (read from the vault, or passed explicitly by callers that have no vault access), GET / POST helpers against `https://api.todoist.com/api/v1/`, and a retry on 429/5xx with backoff. Page through list endpoints with `next_cursor`.

## Usage (raw curl reference)

```bash
# Load token
TODOIST_TOKEN=$(op item get "<todoist-item-id>" --vault "<your-vault>" --reveal --fields api_key)

# List tasks due today (use /tasks/filter, NOT /tasks?filter= which ignores filters)
curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/tasks/filter?query=today"
# Response: {"results": [...], "next_cursor": null}

# Get all tasks (paginated, 200 per page)
curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/tasks"

# Create a task
curl -fsS -X POST -H "Authorization: Bearer $TODOIST_TOKEN" -H "Content-Type: application/json" \
  -d '{"content": "Review PR", "due_string": "tomorrow", "priority": 3}' \
  "https://api.todoist.com/api/v1/tasks"

# Complete a task
curl -fsS -X POST -H "Authorization: Bearer $TODOIST_TOKEN" \
  "https://api.todoist.com/api/v1/tasks/TASK_ID/close"

# Delete a task (for test cleanup — does NOT count as completion)
curl -fsS -X DELETE -H "Authorization: Bearer $TODOIST_TOKEN" \
  "https://api.todoist.com/api/v1/tasks/TASK_ID"

# Get all labels
curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/labels"

# Get all projects
curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/projects"
```

**Priority mapping:** p1 (urgent/highest) = `priority: 4`, p2 = `3`, p3 = `2`, p4 (default) = `1` (API values are inverted from UI labels)

**Filter syntax:** Use `/tasks/filter?query=...` with Todoist filter language (e.g., `today`, `overdue`, `p1`, `#ProjectName`, `@LabelName`). Do NOT use `/tasks?filter=` — it silently ignores the parameter and returns all tasks.

## Critical Rules

**Protecting completion statistics:**
- If you track productivity via completion counts, test tasks inflate stats
- **NEVER create test tasks** that count toward your stats
- If testing, immediately DELETE (not complete) test tasks
- **NEVER complete recurring tasks** the user hasn't finished

**Recurring task limitations:**
- API cannot snooze recurring tasks while preserving recurrence
- Updating due date removes recurrence pattern
- Re-adding recurrence resets date to today
- **Best practice:** Let the user snooze recurring tasks manually in the Todoist UI
- OK to complete recurring tasks the user has actually finished (triggers next recurrence)

## When to Use

**Use Todoist (direct API):**
- The user explicitly asks to create a Todoist task
- Real, actionable tasks that need to persist
- Tasks beyond the current session

**Use in-session task tracking instead:**
- Tracking progress within the current session
- Breaking down complex tasks during implementation
- Temporary task management

## Common invocations

Every snippet assumes the token is loaded:

```bash
TODOIST_TOKEN=$(op item get "<todoist-item-id>" --vault "<your-vault>" --reveal --fields api_key)
T=https://api.todoist.com/api/v1
```

### Smoke / auth check
```bash
curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "$T/projects" | jq '{projects: (.results | length)}'
```

### Refresh / re-auth
The Todoist API uses a long-lived personal API token (no OAuth refresh). If the smoke check returns 401/403, rotate the token in Todoist Settings → Integrations → Developer, then update your vault:
```bash
op item edit <todoist-item-id> --vault '<your-vault>' api_key='NEW_TOKEN_HERE'
```
If a scheduled job holds the token in its environment, restart it after rotation.

### Common queries / actions
- Tasks due today (use `/tasks/filter`, NOT `/tasks?filter=`): `curl -fsS -G -H "Authorization: Bearer $TODOIST_TOKEN" "$T/tasks/filter" --data-urlencode 'query=today' | jq '{today: (.results | length), sample: [.results[:3][] | {id, content, due}]}'`
- Overdue tasks: `curl -fsS -G -H "Authorization: Bearer $TODOIST_TOKEN" "$T/tasks/filter" --data-urlencode 'query=overdue' | jq '.results | length'`
- All projects (id + name): `curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "$T/projects" | jq '[.results[] | {id, name}]'`
- Create a task (priority `4` = urgent, `1` = default; due via natural language): `curl -fsS -X POST -H "Authorization: Bearer $TODOIST_TOKEN" -H 'Content-Type: application/json' -d '{"content": "Smoke probe — DELETE ME", "due_string": "tomorrow", "priority": 1}' "$T/tasks" | jq -e 'select(.id) | {id, content}'` (`-f` makes an HTTP error exit non-zero; `jq -e` exits non-zero when no task id came back)
- Delete a test task (NEVER complete test tasks — it inflates completion stats, see [Critical Rules](#critical-rules)): `curl -sS -X DELETE -H "Authorization: Bearer $TODOIST_TOKEN" "$T/tasks/$TASK_ID" -w 'HTTP %{http_code}\n'`
- All tasks (200 per page; first page here, pass `cursor=<next_cursor>` for the next): `curl -fsS -H "Authorization: Bearer $TODOIST_TOKEN" "$T/tasks" | jq '{count: (.results | length), next_cursor}'`

### Common failures
- HTTP 401 → token revoked or rotated in the Todoist UI, or `TODOIST_TOKEN` is empty; rotate per [Refresh / re-auth](#refresh--re-auth), update your vault, retry.
- HTTP 410 from REST v2 or Sync v9 paths → old endpoint surface; switch to `api/v1/...` (Unified API).
- Filter returns the full task list instead of a subset → used `api/v1/tasks?filter=...` (silently ignored). Use `api/v1/tasks/filter?query=...` instead.
- HTTP 429 or 5xx → back off and retry with a narrower filter.
