# Notion Integration

**API:** REST (`https://api.notion.com/v1/`)

Read-only integration for exporting Notion workspace content. Used for one-time migrations, not ongoing sync.

## Authentication

- **Type:** Bearer token (internal integration)
- **Credential store item:** `{YOUR_CREDENTIAL_STORE_ITEM}`
- **Field:** `api_token`
- **Setup:** Create integration at [notion.so/my-integrations](https://www.notion.so/my-integrations), copy the Internal Integration Secret

Pages must be explicitly shared with the integration via Notion's "Connect to" menu.

## Example Usage

```typescript
// Authenticated API call
const NOTION_TOKEN = "your-integration-secret";
const headers = {
  "Authorization": `Bearer ${NOTION_TOKEN}`,
  "Notion-Version": "2022-06-28",
};

// Fetch a page
const page = await fetch("https://api.notion.com/v1/pages/{page_id}", { headers });

// Fetch all blocks from a page
const blocks = await fetch("https://api.notion.com/v1/blocks/{block_id}/children", { headers });
```

## Common Operations

| Operation | Endpoint | Method |
|-----------|----------|--------|
| Get page | `/v1/pages/{page_id}` | GET |
| Get blocks | `/v1/blocks/{block_id}/children` | GET |
| Search | `/v1/search` | POST |
| List child pages | `/v1/blocks/{page_id}/children` (filter by `child_page` type) | GET |

## Rate Limits

- 3 requests/second per integration
- Implement retry with exponential backoff for 429 responses
