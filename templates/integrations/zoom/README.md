---
name: Zoom
description: Meeting summaries via AI Companion
hosts:
  - api.zoom.us
  - zoom.us
aliases:
  - zoom meeting
  - zoom call
  - zoom recording
typed_client:
  - none
access:
  - api
uses: none
base_url: https://api.zoom.us/v2
auth: oauth2 account_credentials grant (server-to-server), then bearer token
onepassword_item: none
rate_limit: per-endpoint tiers; see the vendor's rate-limit table
cli: REST API
---

# Zoom Integration

**Access via:** REST API v2 **Base URL:** `https://api.zoom.us/v2` **Auth:** Server-to-Server OAuth 2.0 (Account
Credentials grant) **Credentials:** secrets vault (`op item get "<zoom-item-id>" --vault "<your-vault>" --reveal`)

## If you write a client

Nothing here ships one; the `curl` calls below cover it. If a scheduled job syncs summaries, this is its shape: a session that mints a fresh token per run (tokens last an hour, and there is no refresh token), one GET helper against `https://api.zoom.us/v2` that retries 429/5xx with backoff, and a helper that double-encodes meeting UUIDs (see [Get Meeting Summary Detail](#get-meeting-summary-detail-ai-companion)).

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
   - Item name: **Zoom OAuth - <consumer>**
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
TOKEN=$(curl -fsS -X POST "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" \
  -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" | jq -r '.access_token')

# Test
curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.zoom.us/v2/users/me"
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

Every snippet assumes `$TOKEN` from [Authentication](#authentication) is loaded, and a double-encoding helper for meeting UUIDs:

```bash
enc2() { jq -rn --arg u "$1" '$u | @uri | @uri'; }
```

### Smoke / auth check
```bash
curl -fsS -H "Authorization: Bearer $TOKEN" https://api.zoom.us/v2/users/me | jq '{account_id, email}'
```

### Refresh / re-auth
Server-to-Server OAuth — no user interaction, no refresh token. Mint a new token (the `curl` under [Authentication](#authentication)) whenever the last one is over an hour old. Credentials live in your vault (`Zoom OAuth - <consumer>`); rotate via Zoom Marketplace if compromised, then update the `account_id` / `client_id` / `client_secret` fields. The token response also shows the scopes the app actually holds:
```bash
curl -fsS -X POST "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=$ZOOM_ACCOUNT_ID" -u "$ZOOM_CLIENT_ID:$ZOOM_CLIENT_SECRET" | jq '{scope, expires_in}'
```

### Common queries / actions
- List AI Companion summaries in a date range: `curl -fsS -H "Authorization: Bearer $TOKEN" 'https://api.zoom.us/v2/meetings/meeting_summaries?from=YYYY-MM-DD&to=YYYY-MM-DD&page_size=30' | jq '{total: (.summaries | length), sample: [.summaries[:3][] | {meeting_topic, meeting_start_time, meeting_uuid}]}'`
- Full summary detail for one meeting (UUID, double-encoded): `curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.zoom.us/v2/meetings/$(enc2 "$MEETING_UUID")/meeting_summary" | jq '{meeting_topic, overview: (.summary_overview // "" | .[:200]), next_steps: (.next_steps | length), sections: (.summary_details | length)}'`
- Past meetings (current user, last 30): `curl -fsS -H "Authorization: Bearer $TOKEN" 'https://api.zoom.us/v2/users/me/meetings?type=previous_meetings&page_size=30' | jq '[.meetings[:5][] | {id, uuid, topic, start_time, duration}]'`
- Participants of a past meeting: `curl -fsS -H "Authorization: Bearer $TOKEN" "https://api.zoom.us/v2/past_meetings/$(enc2 "$MEETING_UUID")/participants?page_size=300" | jq '{count: (.participants | length), sample: [.participants[:5][] | {name, email}]}'`

### Common failures
- Token request → HTTP 400 `invalid_client` → client ID/secret mismatch in your vault. Verify `client_id` / `client_secret` against the Zoom Marketplace app credentials page.
- Token request → HTTP 400 `unsupported_grant_type` or `invalid_request` → `account_id` field missing or wrong; the grant URL needs `?account_id=...` and Zoom rejects empty values.
- API → code 300 `Invalid meeting id` → the endpoint requires a meeting **UUID** (not the numeric ID), and UUIDs containing `/` or `=` MUST be double URL-encoded.
- API → HTTP 401 → access token expired (1h TTL) or a scope is missing on the Zoom app; mint a new token, or add the missing `meeting:read:*:admin` scope in the Zoom Marketplace app settings and re-activate.
- HTTP 429 or 5xx that persists → upstream throttling or outage; wait several minutes, narrow the date window, or lower `page_size`.
