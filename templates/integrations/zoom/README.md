# Zoom Integration

**Access via:** REST API v2
**Base URL:** `https://api.zoom.us/v2`
**Auth:** Server-to-Server OAuth 2.0 (Account Credentials grant)
**Credentials:** Stored in your credential store (item: `{YOUR_CREDENTIAL_STORE_ITEM}`)

## Setup (One-Time)

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/) -> Develop -> Build App -> **Server-to-Server OAuth**
2. Name the app (e.g., "AI Context Sync")
3. Copy **Account ID**, **Client ID**, **Client Secret**
4. Add scopes:
   - `meeting:read:summary:admin` -- AI Companion meeting summary detail
   - `meeting:read:list_summaries:admin` -- List meetings with summaries
   - `meeting:read:list_meetings:admin` -- List past meetings
   - `meeting:read:list_past_participants:admin` -- Past meeting participants
   - `meeting:read:list_past_instances:admin` -- Past instances of recurring meetings
   - `report:read:list_meeting_polls:admin` -- Meeting poll results
5. Activate the app
6. Store credentials in your credential store:
   - Item name: `{YOUR_CREDENTIAL_STORE_ITEM}`
   - Fields: `account_id`, `client_id`, `client_secret`

### Enable AI Companion Summaries

In Zoom web portal -> Settings -> AI Companion:
- Enable **Meeting summary with AI Companion**
- Enable **Automatically share meeting summary** (ensures summaries are generated)

## Authentication

Server-to-Server OAuth uses the Account Credentials grant -- no user interaction, no refresh tokens. Request a new access token for each session (tokens expire in 1 hour).

```bash
# Get credentials from your credential store
ZOOM_ACCOUNT_ID="your-account-id"
ZOOM_CLIENT_ID="your-client-id"
ZOOM_CLIENT_SECRET="your-client-secret"

# Get access token
TOKEN=$(curl -s -X POST "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" \
  -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" | jq -r '.access_token')

# Test
curl -s -H "Authorization: Bearer $TOKEN" "https://api.zoom.us/v2/users/me"
```

### Programmatic Token Retrieval

```typescript
async function getZoomToken(credentials: {
  account_id: string;
  client_id: string;
  client_secret: string;
}): Promise<string> {
  const auth = btoa(`${credentials.client_id}:${credentials.client_secret}`);
  const r = await fetch(
    `https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${credentials.account_id}`,
    { method: "POST", headers: { Authorization: `Basic ${auth}` } },
  );
  if (!r.ok) throw new Error(`Zoom token request failed: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
```

## API Endpoints

### List Meeting Summaries

```
GET /meetings/meeting_summaries?from=YYYY-MM-DD&to=YYYY-MM-DD&page_size=30
```

Returns paginated list of meetings that have AI Companion summaries in the date range. Each item includes `meeting_uuid`, `meeting_id`, `meeting_topic`, `meeting_start_time`, `meeting_end_time`. Supports `next_page_token` pagination.

**Scope:** `meeting:read:list_summaries:admin`

### Get Meeting Summary Detail (AI Companion)

```
GET /meetings/{double-encoded-UUID}/meeting_summary
```

Returns full structured summary with:
- `summary_overview` -- high-level summary text
- `summary_details` -- array of topic sections with key points
- `next_steps` -- action items with assignees
- `summary_content` -- full markdown-formatted summary

**Important:** The `{meetingId}` parameter requires the **meeting UUID** (not numeric ID), and it must be **double URL-encoded** (apply `encodeURIComponent` twice) because UUIDs contain `/` and `=` characters. Using a numeric meeting ID returns code 300 "Invalid meeting id."

**Scope:** `meeting:read:summary:admin`

### List Past Meetings

```
GET /users/me/meetings?type=previous_meetings&page_size=30
```

Returns meetings with `id`, `uuid`, `topic`, `start_time`, `duration`, `participants_count`.

**Scope:** `meeting:read:list_meetings:admin`

### List Meeting Participants

```
GET /past_meetings/{double-encoded-UUID}/participants?page_size=300
```

Returns `participants[]` with `name`, `email`, `join_time`, `leave_time`.

**Scope:** `meeting:read:list_past_participants:admin`

## Rate Limits

| Category | Limit |
|----------|-------|
| Light (list/get) | 80 req/s |
| Medium | 60 req/s |
| Heavy (reports) | 40 req/s + 60k/day |

More than sufficient for batch sync operations.

## Data Destination

Meeting summaries can be synced to `knowledge/{domain}/meetings/` as markdown files. Build a sync script to automate this based on your needs.
