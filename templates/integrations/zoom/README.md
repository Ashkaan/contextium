---
name: Zoom
description: Meeting summaries via AI Companion
cli: REST API
typed_client: integrations/zoom/zoom.ts
aliases:
  - zoom meeting
  - zoom call
  - zoom recording
---

# Zoom Integration

**Access via:** REST API v2 **Base URL:** `https://api.zoom.us/v2` **Auth:** Server-to-Server OAuth 2.0 (Account
Credentials grant) **Credentials:** secrets vault (`op item get "<zoom-item-id>" --vault "<your-vault>" --reveal`)

## TypeScript Client

Canonical typed reference: [`zoom.ts`](zoom.ts).

```ts
import { createZoomSession, zoomGet, type ZoomSession } from "../../integrations/zoom/zoom.ts";
```

### Export surface

| Function / Type | Purpose |
|---|---|
| `createZoomSession()` | Server-to-Server OAuth token; returns `ZoomSession` |
| `zoomGet<T>(session, path, params?)` | GET request with retry on 429/5xx |
| `ZoomSession` | Shared session type |

## Setup (One-Time)

1. Go to [Zoom Marketplace](https://marketplace.zoom.us/) → Develop → Build App → **Server-to-Server OAuth**
2. Name the app (e.g., "Meeting Summary Sync")
3. Copy **Account ID**, **Client ID**, **Client Secret**
4. Add scopes:
   - `meeting:read:meeting:admin` — Read individual meeting details (invitees, settings)
   - `meeting:read:summary:admin` — AI Companion meeting summary detail
   - `meeting:read:list_summaries:admin` — List meetings with summaries
   - `meeting:read:list_meetings:admin` — List past meetings
   - `meeting:read:list_past_participants:admin` — Past meeting participants
   - `meeting:read:list_past_instances:admin` — Past instances of recurring meetings
   - `report:read:list_meeting_polls:admin` — Meeting poll results
5. Activate the app
6. Store credentials in your secrets vault:
   - Item name: **Zoom OAuth - <your-vault>**
   - Fields: `account_id`, `client_id`, `client_secret`

### Enable AI Companion Summaries

In the Zoom web portal → Settings → AI Companion:

- Enable **Meeting summary with AI Companion**
- Enable **Automatically share meeting summary** (ensures summaries are generated)

## Authentication

Server-to-Server OAuth uses the Account Credentials grant — no user interaction, no refresh tokens. Request a new access token for each session (tokens expire in 1 hour).

```bash
# Get credentials
ZOOM_ACCOUNT_ID=$(op item get "<zoom-item-id>" --vault "<your-vault>" --reveal --fields account_id)
ZOOM_CLIENT_ID=$(op item get "<zoom-item-id>" --vault "<your-vault>" --reveal --fields client_id)
ZOOM_CLIENT_SECRET=$(op item get "<zoom-item-id>" --vault "<your-vault>" --reveal --fields client_secret)

# Get access token
TOKEN=$(curl -s -X POST "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" \
  -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" | jq -r '.access_token')

# Test
curl -s -H "Authorization: Bearer $TOKEN" "https://api.zoom.us/v2/users/me"
```

## API Endpoints

### List Meeting Summaries

```
GET /meetings/meeting_summaries?from=YYYY-MM-DD&to=YYYY-MM-DD&page_size=30
```

Returns paginated list of meetings that have AI Companion summaries in the date range. Each item includes
`meeting_uuid`, `meeting_id`, `meeting_topic`, `meeting_start_time`, `meeting_end_time`. Supports `next_page_token` pagination.

**Scope:** `meeting:read:list_summaries:admin`

### Get Meeting Summary Detail (AI Companion)

```
GET /meetings/{double-encoded-UUID}/meeting_summary
```

Returns full structured summary with:

- `summary_overview` — high-level summary text
- `summary_details` — array of topic sections with key points
- `next_steps` — action items with assignees
- `summary_content` — full markdown-formatted summary

**Important:** The `{meetingId}` parameter requires the **meeting UUID** (not numeric ID), and it must be **double
URL-encoded** (apply `encodeURIComponent` twice) because UUIDs contain `/` and `=` characters. Using a numeric meeting
ID returns code 300 "Invalid meeting id."

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

| Category         | Limit              |
| ---------------- | ------------------ |
| Light (list/get) | 80 req/s           |
| Medium           | 60 req/s           |
| Heavy (reports)  | 40 req/s + 60k/day |

More than sufficient for batch sync operations.

## Data Destination

Sync meeting summaries wherever you keep notes (e.g. markdown files under `knowledge/`). Wire the fetch into a scheduled job.

## Common invocations

### Smoke / auth check
```bash
node --input-type=module -e "import { createZoomSession, zoomGet } from './integrations/zoom/zoom.ts'; const s=await createZoomSession(); const me=await zoomGet(s, 'users/me'); console.log(JSON.stringify({ token: s.token.slice(0,12)+'...', baseUrl: s.baseUrl, account: me.account_id, email: me.email }));"
```

### Refresh / re-auth
Server-to-Server OAuth — no user interaction, no refresh token. Tokens are minted on every `createZoomSession()` call and expire after 1h. To force a fresh token, just call `createZoomSession()` again. Credentials live in your vault (`Zoom OAuth - <your-vault>`); rotate via Zoom Marketplace if compromised, then update `accountId` / `clientId` / `clientSecret` fields.
```bash
node --input-type=module -e "import { createZoomSession } from './integrations/zoom/zoom.ts'; const s=await createZoomSession(); console.log('Zoom mint ok:', s.token.slice(0,12)+'...');"
```

### Common queries / actions
- List AI Companion summaries (last 14 days): `node --input-type=module -e "import { createZoomSession, zoomGet } from './integrations/zoom/zoom.ts'; const s=await createZoomSession(); const end=new Date(); const start=new Date(end); start.setDate(end.getDate()-14); const iso=(d)=>d.toISOString().slice(0,10); const r=await zoomGet(s, 'meetings/meeting_summaries', { from: iso(start), to: iso(end), page_size: 30 }); console.log(JSON.stringify({ from: iso(start), to: iso(end), total: r.summaries?.length || 0, sample: (r.summaries||[]).slice(0,3).map(m => ({ topic: m.meeting_topic, start: m.meeting_start_time })) }, null, 2));"`
- Get full meeting summary detail (double-encoded UUID required): `node --input-type=module -e "import { createZoomSession, zoomGet } from './integrations/zoom/zoom.ts'; const uuid=process.env.MEETING_UUID; if(!uuid) throw new Error('set MEETING_UUID'); const s=await createZoomSession(); const enc=encodeURIComponent(encodeURIComponent(uuid)); const r=await zoomGet(s, 'meetings/'+enc+'/meeting_summary'); console.log(JSON.stringify({ topic: r.meeting_topic, overview: (r.summary_overview||'').slice(0,200), nextSteps: (r.next_steps||[]).length, sectionCount: (r.summary_details||[]).length }, null, 2));" # MEETING_UUID=<uuid> first`
- List past meetings (current user, last 30): `node --input-type=module -e "import { createZoomSession, zoomGet } from './integrations/zoom/zoom.ts'; const s=await createZoomSession(); const r=await zoomGet(s, 'users/me/meetings', { type: 'previous_meetings', page_size: 30 }); console.log(JSON.stringify({ total: r.meetings?.length || 0, sample: (r.meetings||[]).slice(0,5).map(m => ({ id: m.id, topic: m.topic, start: m.start_time, duration: m.duration })) }, null, 2));"`
- List participants of a past meeting (double-encoded UUID): `node --input-type=module -e "import { createZoomSession, zoomGet } from './integrations/zoom/zoom.ts'; const uuid=process.env.MEETING_UUID; if(!uuid) throw new Error('set MEETING_UUID'); const s=await createZoomSession(); const enc=encodeURIComponent(encodeURIComponent(uuid)); const r=await zoomGet(s, 'past_meetings/'+enc+'/participants', { page_size: 300 }); console.log(JSON.stringify({ uuid, count: r.participants?.length || 0, sample: (r.participants||[]).slice(0,5).map(p => ({ name: p.name, email: p.email })) }, null, 2));" # MEETING_UUID=<uuid> first`
- Inspect raw token claims (debug auth): `node --input-type=module -e "import { createZoomSession } from './integrations/zoom/zoom.ts'; const s=await createZoomSession(); const [,payload]=s.token.split('.'); const claims=JSON.parse(Buffer.from(payload,'base64url').toString()); console.log(JSON.stringify({ aud: claims.aud, scopes: claims.scopes?.slice(0,8), exp: new Date(claims.exp*1000).toISOString(), accountId: claims.aid }, null, 2));"`

### Common failures
- `Zoom token failed: 400 ... invalid_client` → Client ID/secret mismatch in your vault. Verify `clientId` / `clientSecret` fields against the Zoom Marketplace app credentials page.
- `Zoom token failed: 400 ... unsupported_grant_type` or `... invalid_request` → `accountId` field missing or wrong; the grant URL needs `?account_id=...` and Zoom rejects empty values.
- `Zoom GET ... failed: 300 ... Invalid meeting id` → Endpoint requires a meeting **UUID** (not numeric ID), and UUIDs containing `/` or `=` MUST be double URL-encoded (`encodeURIComponent` twice).
- `Zoom GET ... failed: 401 ...` → Access token expired (1h TTL) or scope missing on the Zoom app; rerun `createZoomSession()` for expiry, or add the missing `meeting:read:*:admin` scope in the Zoom Marketplace app settings + re-activate.
- `Zoom <url>: max retries exceeded` → Upstream throttling (429) or 5xx outage past 3 retries; wait several minutes, narrow the date window, or drop `page_size`.
