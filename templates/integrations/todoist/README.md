---
name: Todoist
description: Task management via Unified API
cli: curl (direct API)
typed_client: integrations/todoist/todoist.ts
hosts:
  - api.todoist.com
aliases:
  - task management
  - personal tasks
  - todoist task
---
# Todoist Integration

**Access via:** Unified API v1 (REST v2 and Sync v9 are deprecated/410)
**API Token:** stored in your secrets vault (e.g. `op item get "<todoist-item-id>" --vault "<your-vault>" --reveal --fields api_key`)
**Base URL:** `https://api.todoist.com/api/v1`

## TypeScript Client

Canonical typed reference: [`todoist.ts`](todoist.ts).

```ts
import { createTodoistSession, todoistGet, todoistPost } from "../../integrations/todoist/todoist.ts";
```

Auth: Bearer token. Callers without a configured credential source pass the token explicitly.

## Usage (raw curl reference)

```bash
# Load token
TODOIST_TOKEN=$(op item get "<todoist-item-id>" --vault "<your-vault>" --reveal --fields api_key)

# List tasks due today (use /tasks/filter, NOT /tasks?filter= which ignores filters)
curl -s -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/tasks/filter?query=today"
# Response: {"results": [...], "next_cursor": null}

# Get all tasks (paginated, 200 per page)
curl -s -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/tasks"

# Create a task
curl -s -X POST -H "Authorization: Bearer $TODOIST_TOKEN" -H "Content-Type: application/json" \
  -d '{"content": "Review PR", "due_string": "tomorrow", "priority": 3}' \
  "https://api.todoist.com/api/v1/tasks"

# Complete a task
curl -s -X POST -H "Authorization: Bearer $TODOIST_TOKEN" \
  "https://api.todoist.com/api/v1/tasks/TASK_ID/close"

# Delete a task (for test cleanup — does NOT count as completion)
curl -s -X DELETE -H "Authorization: Bearer $TODOIST_TOKEN" \
  "https://api.todoist.com/api/v1/tasks/TASK_ID"

# Get all labels
curl -s -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/labels"

# Get all projects
curl -s -H "Authorization: Bearer $TODOIST_TOKEN" "https://api.todoist.com/api/v1/projects"
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

Token resolves via `process.env.TODOIST_API_KEY`; set it inline from your vault (the `api_key` field).

### Smoke / auth check
```bash
TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistGet } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const r = await todoistGet(s, 'api/v1/projects'); console.log(JSON.stringify({ baseUrl: s.baseUrl, projects: (r.results || []).length }));"
```

### Refresh / re-auth
The Todoist API uses a long-lived personal API token (no OAuth refresh). If the smoke check returns 401/403, rotate the token in Todoist Settings → Integrations → Developer, then update your vault:
```bash
op item edit <todoist-item-id> --vault '<your-vault>' api_key='NEW_TOKEN_HERE'
```
If a scheduled job consumes `TODOIST_API_KEY` via its environment, restart it after rotation.

### Common queries / actions
- Tasks due today (use `/tasks/filter`, NOT `/tasks?filter=`):
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistGet } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const r = await todoistGet(s, 'api/v1/tasks/filter', { query: 'today' }); console.log(JSON.stringify({ today: (r.results || []).length, sample: (r.results || []).slice(0,3).map((t) => ({ id: t.id, content: t.content, due: t.due })) }, null, 2));"
  ```
- Overdue tasks:
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistGet } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const r = await todoistGet(s, 'api/v1/tasks/filter', { query: 'overdue' }); console.log(JSON.stringify({ overdue: (r.results || []).length }));"
  ```
- All projects (id + name listing):
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistGet } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const r = await todoistGet(s, 'api/v1/projects'); console.log(JSON.stringify((r.results || []).map((p) => ({ id: p.id, name: p.name })), null, 2));"
  ```
- Create a task (priority `4` = urgent, `1` = default; due via natural language):
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistPost } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const t = await todoistPost(s, 'api/v1/tasks', { content: 'Smoke probe — DELETE ME', due_string: 'tomorrow', priority: 1 }); console.log(JSON.stringify({ id: t.id, content: t.content }));"
  ```
- Delete a test task (NEVER complete test tasks — inflates productivity stats per § Critical Rules):
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) curl -s -X DELETE -H "Authorization: Bearer $TODOIST_API_KEY" "https://api.todoist.com/api/v1/tasks/$TASK_ID" -w 'HTTP %{http_code}\n'
  ```
- All tasks (paginated, 200/page — first page only here):
  ```bash
  TODOIST_API_KEY=$(op item get <todoist-item-id> --vault '<your-vault>' --reveal --fields api_key) node --input-type=module -e "import { createTodoistSession, todoistGet } from './integrations/todoist/todoist.ts'; const s = await createTodoistSession(); const r = await todoistGet(s, 'api/v1/tasks'); console.log(JSON.stringify({ count: (r.results || []).length, next_cursor: r.next_cursor }));"
  ```

### Common failures
- `Todoist token not available: pass to createTodoistSession() ...` → `TODOIST_API_KEY` not set; prefix the command with the `op item get ... --fields api_key` inline assignment shown above.
- `Todoist GET ... failed: 401 ...` → Token revoked or rotated in the Todoist UI. Rotate per § Refresh / re-auth, update your vault, retry.
- `Todoist GET api/v1/tasks failed: 410 ...` or REST v2 / Sync v9 410 responses → Old endpoint surface; switch to `api/v1/...` (Unified API).
- Filter returns full task list instead of filtered subset → Used `api/v1/tasks?filter=...` (silently ignored). Use `api/v1/tasks/filter?query=...` instead.
- `Todoist <url>: max retries exceeded` → 429/5xx exhausted 3 retries with backoff; wait, then retry with a narrower filter.
