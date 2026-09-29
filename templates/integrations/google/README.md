---
name: Google
description: Drive, Sheets, Docs, Gmail, Calendar access + OAuth2 authorization flow
hosts:
  - sheets.googleapis.com
  - www.googleapis.com
  - docs.google.com
  - drive.google.com
  - mail.google.com
  - calendar.google.com
  - gmail.googleapis.com
  - people.googleapis.com
  - oauth2.googleapis.com
  - accounts.google.com
aliases:
  - google workspace
  - google auth
  - gsuite
  - gmail
  - google sheet
  - google sheets
  - google doc
  - google docs
  - google drive
  - google calendar
  - spreadsheet
  - spreadsheets
typed_client:
  - none
access:
  - api
  - browser
uses: none
base_url: https://www.googleapis.com
auth: oauth2 refresh token / service account
onepassword_item: none
rate_limit: per-API daily quotas set in the Google Cloud project
cli: API / scripts
---

# Google Integration

**Access order:** api, browser — the Workspace APIs cover every Drive, Sheets, Docs, Gmail and Calendar operation below, and the browser is needed only for the OAuth consent click.

Access Google Workspace APIs (Drive, Sheets, Gmail, Calendar, Contacts, Docs,
Slides) and the OAuth2 authorization flow used to mint and refresh the tokens
those APIs need. Every call below is plain REST with a Bearer access token;
tokens live in your secrets vault, never in local files.

## Credentials and scopes

You may register more than one OAuth client with different scope sets. Pick the
right one for the job — `gmail.send` alone is NOT enough to read inboxes.

| Vault item | Scopes | Use for |
| --- | --- | --- |
| `Google OAuth (<account>) - <consumer>` | drive, spreadsheets, gmail.readonly, gmail.send, calendar.readonly, contacts, documents, presentations | The full grant for one account (`<account>` = `personal`, `work`, …) — inboxes, Drive, Sheets, Calendar |
| `Google OAuth (send-only) - <consumer>` | `gmail.send` only (a separate OAuth client) | Flows that only send mail |

Each item carries `client_id`, `client_secret`, `refresh_token` (rotated),
`access_token`, `expires_at`, `token_url`. The titles contain parentheses, so
reference them by UUID in `op://` paths (`<google-item-id>` below).

When a call gets `403 insufficientPermissions`, the fix is usually "use the
full grant", not "re-auth with a broader scope". Check the existing items first.

### OAuth scopes

| API | Scope | Access |
| --- | --- | --- |
| Drive | `drive` | Read/write all files |
| Sheets | `spreadsheets` | Read/write spreadsheets |
| Gmail | `gmail.readonly` | Read-only |
| Calendar | `calendar.readonly` | Read-only |
| Contacts | `contacts` | Read/write |
| Docs | `documents` | Read/write |
| Slides | `presentations` | Read/write |

Each is prefixed `https://www.googleapis.com/auth/` in the authorize URL.

## OAuth flow

### Authorize an account (one time per account)

Create a **Desktop app** OAuth client in Google Cloud Console → APIs & Services
→ Credentials, so a loopback redirect (`http://localhost:<port>`) is allowed.

1. Open the authorize URL. `access_type=offline` and `prompt=consent` are both
   required to get a refresh token back; without `prompt=consent` Google omits
   it on every authorization after the first.
   ```
   https://accounts.google.com/o/oauth2/v2/auth?client_id=<client-id>&redirect_uri=http%3A%2F%2Flocalhost%3A<port>&response_type=code&access_type=offline&prompt=consent&scope=<space-separated-scopes, url-encoded>
   ```
2. After you approve, the browser lands on `http://localhost:<port>/?code=...`
   (nothing needs to be listening; copy `code` from the URL bar).
3. Exchange the code (single-use — do it in one shell):
   ```bash
   CODE='...paste here...'
   curl -fsS -X POST https://oauth2.googleapis.com/token \
     --data-urlencode "grant_type=authorization_code" \
     --data-urlencode "code=${CODE}" \
     --data-urlencode "client_id=$(op read 'op://<your-vault>/<google-item-id>/client_id')" \
     --data-urlencode "client_secret=$(op read 'op://<your-vault>/<google-item-id>/client_secret')" \
     --data-urlencode "redirect_uri=http://localhost:<port>"
   # → { "access_token": "...", "refresh_token": "...", "expires_in": 3599, ... }
   ```
4. Write `refresh_token`, `access_token` and `expires_at` into the vault item
   with `op item edit`.

### Keeping the access token fresh

Access tokens last an hour. A small refresher job on a short cron (e.g.
`*/15 * * * *`) posts `grant_type=refresh_token` to
`https://oauth2.googleapis.com/token` and writes the new `access_token` +
`expires_at` back to the vault. Consumers read `access_token` straight from the
vault on every call (no in-process cache), so they pick up each rotation and
never call Google's token endpoint themselves. Run only one refresher: two
concurrent writers to the same item collide (see failures below).

## If you write a client

Nothing here ships one; the REST calls below cover it. If you do, these are the
pieces worth having:

- **Token reader** — maps an account name to its vault item and reads
  `access_token` uncached.
- **Gmail send** — base64url-encode an RFC 822 message and `POST` it as `raw` to
  `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`. Return the
  message id and treat a 200 with no `id` as a failure. Accept an optional
  `From:` send-as alias; omit it for the account default. Prefer routing sends
  through one scheduled or deployed job rather than ad-hoc shells, so every
  send is logged and rate-controlled.
- **Sheets v4** — values get / update / append / clear, `batchUpdate`, and
  spreadsheet metadata.
- **Calendar v3** — list events, validating each event and collecting the ones
  that fail rather than dropping the whole page.

---

## Drive API

### Shared Drives

For files on shared drives, add
`supportsAllDrives=true&includeItemsFromAllDrives=true` to the query:

```
https://www.googleapis.com/drive/v3/files?q='<folder-id>'+in+parents&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,size)
```

Without these params, shared drive files return empty results.

### Export Formats

| Google Type | mimeType |
| --- | --- |
| Docs | `text/plain` |
| Sheets | `text/csv` |
| Slides | `application/pdf` |

---

## API reference

All calls send `Authorization: Bearer $GOOGLE_TOKEN`.

| API | Call |
| --- | --- |
| Sheets — read | `GET https://sheets.googleapis.com/v4/spreadsheets/<sheet-id>/values/<SheetName>` |
| Sheets — write | `PUT https://sheets.googleapis.com/v4/spreadsheets/<sheet-id>/values/<SheetName>!A1?valueInputOption=RAW` with body `{"values": [["Header1","Header2"],["Row1","Row2"]]}` |
| Sheets — clear | `POST https://sheets.googleapis.com/v4/spreadsheets/<sheet-id>/values/<SheetName>:clear` |
| Gmail — list | `GET https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=10` |
| Gmail — one message | `GET https://gmail.googleapis.com/gmail/v1/users/me/messages/<message-id>` |
| Calendar — calendars | `GET https://www.googleapis.com/calendar/v3/users/me/calendarList` |
| Calendar — events | `GET https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=10` |
| People — profile | `GET https://people.googleapis.com/v1/people/me?personFields=names,emailAddresses` |

## Troubleshooting

| Error | Fix |
| --- | --- |
| 401 Unauthorized | Access token expired — check the refresher job ran, then re-read from the vault |
| 403 Forbidden | Scope not authorized — use the full-grant item, or re-authorize with the scope |
| 404 Not Found | File/resource ID incorrect or not shared with this account |
| Token refresh failed | Refresh token expired or revoked — re-run [Authorize an account](#authorize-an-account-one-time-per-account) |

## Common invocations

Every snippet assumes the token is loaded:

```bash
GOOGLE_TOKEN="$(op read 'op://<your-vault>/<google-item-id>/access_token')"
```

### Smoke / auth check
```bash
curl -fsS "https://oauth2.googleapis.com/tokeninfo?access_token=$GOOGLE_TOKEN" | jq '{email, scope, expires_in}'
```

### Common queries / actions
- Query the inbox (needs the full-grant token): `curl -fsS -H "Authorization: Bearer $GOOGLE_TOKEN" 'https://gmail.googleapis.com/gmail/v1/users/me/messages?q=newer_than:7d&maxResults=5' | jq '.resultSizeEstimate // 0'`
- List a spreadsheet's tabs: `curl -fsS -H "Authorization: Bearer $GOOGLE_TOKEN" 'https://sheets.googleapis.com/v4/spreadsheets/<sheet-id>?fields=sheets.properties.title' | jq -r '.sheets[].properties.title'`
- Read a column: `curl -fsS -H "Authorization: Bearer $GOOGLE_TOKEN" 'https://sheets.googleapis.com/v4/spreadsheets/<sheet-id>/values/Summary!B:B' | jq '.values | length'`

### Common failures
- `messages.list` → HTTP 403 `insufficientPermissions` → the token came from the send-only client; read with the full-grant item.
- Sheets → HTTP 404 `Requested entity was not found` → spreadsheet ID is wrong, or the sheet is not shared with the account behind the token.
- Refresh → HTTP 400 `{"error":"invalid_grant"}` → refresh token is expired or revoked; re-run [Authorize an account](#authorize-an-account-one-time-per-account) and rewrite `refresh_token` in the vault.
- `op error: ... invalid character in secret reference: '('` → titles with parentheses do not parse in `op://` refs; use the item UUID path instead.
- `op error: (409) Conflict: Internal server conflict` during refresh → two concurrent token writers collided; rerun a single refresh (avoid parallel refreshes).
