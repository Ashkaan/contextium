---
name: Notion
description: Read-only API for exporting Notion workspace content
cli: REST API
---
# Notion Integration

**API:** REST (`https://api.notion.com/v1/`)

Read-only integration for exporting Notion workspace content. Used for one-time migrations, not ongoing sync.

## Authentication

- **Type:** Bearer token (internal integration)
- **1Password item:** `Notion API - <your-vault>`
- **Field:** `api_token`
- **Setup:** Create integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), copy the Internal Integration Secret

Pages must be explicitly shared with the integration via Notion's "Connect to" menu.

## Usage

```typescript
import { notionApi, getBlocks, pageToMarkdown } from "../integrations/notion/notion.ts";

// Raw API call
const page = await notionApi("/pages/{page_id}");

// Get all blocks from a page
const blocks = await getBlocks("page-id-here");

// Export a page as markdown
const md = await pageToMarkdown("page-id-here");
```

## API Reference

| Function | Purpose |
|----------|---------|
| `notionApi(path)` | Generic authenticated GET request |
| `getBlocks(blockId)` | Recursively fetch all blocks from a page |
| `getChildPages(pageId)` | List all child pages under a parent |
| `pageToMarkdown(pageId)` | Convert page content to Markdown |

## Rate Limits

- 3 requests/second per integration
- Built-in retry with exponential backoff

## Common invocations

### Smoke / auth check
```bash
op read 'op://<your-vault>/Notion API - <your-vault>/api_token' >/dev/null && node --input-type=module -e "import { notionApi } from './integrations/notion/notion.ts'; const me = await notionApi('/users/me'); console.log(JSON.stringify({ ok: true, type: me.type, name: me.name, bot_owner: me.bot?.owner?.type }));"
```

### Refresh / re-auth
Notion uses a static internal-integration secret — no OAuth refresh. If `401 Unauthorized` fires, rotate the token at https://www.notion.so/my-integrations and update your vault:
```bash
op item edit 'Notion API - <your-vault>' --vault '<your-vault>' api_token='ntn_NEW_TOKEN_HERE'
```

### Common queries / actions
- Inspect a page's metadata (title + parent): `node --input-type=module -e "import { notionApi } from './integrations/notion/notion.ts'; const id=process.env.PAGE_ID; const p=await notionApi('/pages/'+id); console.log(JSON.stringify({ id: p.id, parent: p.parent, last_edited: p.last_edited_time, props: Object.keys(p.properties || {}) }));" PAGE_ID=$PAGE_ID`
- List all child pages under a parent page: `node --input-type=module -e "import { getChildPages } from './integrations/notion/notion.ts'; const pages=await getChildPages(process.env.PAGE_ID); console.log(JSON.stringify({ count: pages.length, titles: pages.map(p => p.title) }, null, 2));" PAGE_ID=$PAGE_ID`
- Export a single page to markdown (writes to /tmp): `node --input-type=module -e "import { exportPage } from './integrations/notion/notion.ts'; import { writeFileSync } from 'node:fs'; const ep=await exportPage(process.env.PAGE_ID, 0); writeFileSync('/tmp/'+ep.slug+'.md', ep.markdown); console.log(JSON.stringify({ title: ep.title, slug: ep.slug, bytes: ep.markdown.length, path: '/tmp/'+ep.slug+'.md' }));" PAGE_ID=$PAGE_ID`
- Query all pages in a database (titles + ids): `node --input-type=module -e "import { queryDatabase } from './integrations/notion/notion.ts'; const rows=await queryDatabase(process.env.DATABASE_ID); console.log(JSON.stringify({ count: rows.length, sample: rows.slice(0,5) }, null, 2));" DATABASE_ID=$DATABASE_ID`
- Count blocks on a page (sanity check before bulk export): `node --input-type=module -e "import { getBlocks } from './integrations/notion/notion.ts'; const b=await getBlocks(process.env.PAGE_ID); const types=b.reduce((a,x)=>{a[x.type]=(a[x.type]||0)+1;return a;},{}); console.log(JSON.stringify({ total: b.length, by_type: types }, null, 2));" PAGE_ID=$PAGE_ID`

### Common failures
- `Notion API 401 on /pages/...: API token is invalid` → Token rotated or revoked; rotate at notion.so/my-integrations and run the `op item edit` command above.
- `Notion API 404 on /pages/<id>: Could not find page` → Page exists but is not shared with the integration; open the page in Notion → top-right `...` → Connections → add the integration. Notion is opt-in per page.
- `Notion API 400 on /databases/<id>/query: <id> is not a valid uuid` → Database id must be the bare 32-char hex (with or without dashes); strip URL prefix `https://www.notion.so/` and any view query params.
- `Notion API 429 on /...: Retry-After: <n>` → Rate limit (3 req/s); the typed client auto-retries with the `Retry-After` header. If you see this in logs, just wait — no action needed.
- `Notion API 502/503/504 ... retrying in <n>s` → Upstream Notion outage; client retries 3× with exponential backoff. If all retries exhaust, rerun the command — Notion's status page (status.notion.so) is the source of truth.
