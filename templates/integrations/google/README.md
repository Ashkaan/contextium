---
name: Google
description: Drive, Sheets, Docs, Gmail, Calendar access + OAuth2 authorization flow
cli: API / scripts
typed_client: integrations/google/google_workspace.ts
hosts:
  - sheets.googleapis.com
  - www.googleapis.com
  - docs.google.com
  - drive.google.com
  - mail.google.com
  - calendar.google.com
  - gmail.googleapis.com
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
---

# Google Integration

Access Google Workspace APIs (Drive, Sheets, Gmail, Calendar, Contacts, Docs,
Slides) and the OAuth2 authorization flow used to mint and refresh the tokens
those APIs need.

## TypeScript Clients

All token resolution reads from your secrets vault — no local token files.

### Runtime-neutral typed clients — [`gmail.ts`](gmail.ts) + [`google_sheets.ts`](google_sheets.ts)

| Reference | Exports | Purpose |
| --- | --- | --- |
| [`gmail.ts`](gmail.ts) | `createGmailSession`, `gmailSendRaw`, `gmailSend`, `GmailSession` | Canonical Gmail send (RFC 822 raw + structured). Returns the Gmail message id (throws on 200-OK-but-empty-id). Reads `access_token` from your vault. `gmailSend(session, to, subject, html, from?)` takes an optional `from` send-as alias; omit for the account default. |
| [`google_sheets.ts`](google_sheets.ts) | `createSheetsSession`, `sheetsGet`, `sheetsUpdate`, `sheetsAppend`, `sheetsClear`, `sheetsCreate`, `sheetsBatchUpdate`, `sheetsGetMetadata`, `SheetsSession`, `SheetValues` | Full Sheets v4 surface |
| [`google_calendar.ts`](google_calendar.ts) | `createCalendarSession`, `listEvents`, `CalendarSession`, `CalendarEvent`, `CalendarEventList`, `CalendarEventSchema` | Calendar v3 list-events (Zod-validated; per-event invalidErrors) |
| [`google_workspace.ts`](google_workspace.ts) | `getToken`, `gmailApi`, `sheetsApi`, `calendarApi`, `contactsApi` | Legacy multi-API helper (see section below) |
| [`google_auth.ts`](google_auth.ts) | `main` (interactive bootstrap) | OAuth2 authorization flow — opens a browser, captures the code, writes refresh+access tokens to your vault. See "OAuth Flow" below |
| [`google_oauth.ts`](google_oauth.ts) | `getGoogleToken` | Runtime entry that maps a credential key → vault item, then reads `access_token` |

```ts
import { createGmailSession, gmailSend } from "../../integrations/google/gmail.ts";
import { createSheetsSession, sheetsGet, sheetsUpdate } from "../../integrations/google/google_sheets.ts";
```

OAuth refresh is owned by a small refresher job (see "OAuth Flow" below); consumer call sites read `access_token` directly via `getRawField(cred, "access_token", { ttlMs: 0 })`. The `ttlMs: 0` bypasses the in-process credential cache so consumers pick up the refresher's rotation on the next call.

## Path → CREDS scope map

You may register multiple OAuth clients with different scope sets. Pick the
right one for what you need to do — `gmail.send` alone is NOT enough to read
inboxes.

| Credential key | Vault item | Scopes | Use for |
| --- | --- | --- | --- |
| `googlePersonal` | `Google OAuth (Personal)` | drive, spreadsheets, gmail.readonly, gmail.send, calendar.readonly, contacts, documents, presentations | Comprehensive personal-account grant — reading inboxes, Drive, Sheets, Calendar |
| `googleGmailSend` | `Gmail Send OAuth` | `gmail.send` only (separate OAuth client) | Send-only flows |
| `googleWork` | `Google OAuth (Work)` | same scope set as personal | A second (work) account |

When a script gets `403 insufficientPermissions`, the fix is usually "use the
comprehensive grant" — not "re-auth with broader scope." Check the existing
credential entries first.

## Accounts

| Account | Email | Vault Item | Use For |
| --- | --- | --- | --- |
| personal | `<your-email>` | `Google OAuth (Personal)` | Personal files |
| work | `<your-work-email>` | `Google OAuth (Work)` | Work files |

Each item carries `client_id`, `client_secret`, `refresh_token` (rotated), `access_token`, `expires_at`, `token_url`.

## Initial Setup (One-Time per Account)

```bash
# Authorize an account (writes tokens to your vault)
node integrations/google/google_auth.ts --account personal
node integrations/google/google_auth.ts --account work
```

This opens a browser, you authorize, and tokens are written directly to your vault.

## OAuth Scopes

| API | Scope | Access |
| --- | --- | --- |
| Drive | `drive` | Read/write all files |
| Sheets | `spreadsheets` | Read/write spreadsheets |
| Gmail | `gmail.readonly` | Read-only |
| Calendar | `calendar.readonly` | Read-only |
| Contacts | `contacts` | Read/write |
| Docs | `documents` | Read/write |
| Slides | `presentations` | Read/write |

---

## Drive API

### Shared Drives

For files on shared drives, add
`supportsAllDrives=true&includeItemsFromAllDrives=true` to the query:

```ts
const url =
  `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents&supportsAllDrives=true&includeItemsFromAllDrives=true&fields=files(id,name,mimeType,size)`;
```

Without these params, shared drive files return empty results.

### Export Formats

| Google Type | mimeType |
| --- | --- |
| Docs | `text/plain` |
| Sheets | `text/csv` |
| Slides | `application/pdf` |

---

## Sheets API

### Read Sheet

```ts
import { createSheetsSession, sheetsGet } from "../integrations/google/google_sheets.ts";

const s = await createSheetsSession();
const rows = await sheetsGet(s, "<SHEET_ID>", "SheetName");
```

### Write to Sheet

```ts
import { createSheetsSession, sheetsClear, sheetsUpdate } from "../integrations/google/google_sheets.ts";

const s = await createSheetsSession();
await sheetsClear(s, "<SHEET_ID>", "SheetName");
await sheetsUpdate(s, "<SHEET_ID>", "SheetName!A1", [["Header1", "Header2"], ["Row1", "Row2"]]);
```

---

## Gmail API

```ts
import { gmailApi } from "../integrations/google/google_workspace.ts";

// List recent messages
const messages = await gmailApi("messages?maxResults=10", "personal");

// Get a specific message
const msg = await gmailApi(`messages/${messageId}`, "personal");
```

---

## Calendar API

```ts
import { calendarApi } from "../integrations/google/google_workspace.ts";

// List calendars
const calendars = await calendarApi("users/me/calendarList", "personal");

// Get events from primary calendar
const events = await calendarApi(
  "calendars/primary/events?maxResults=10",
  "personal",
);
```

---

## Contacts (People) API

```ts
import { contactsApi } from "../integrations/google/google_workspace.ts";

// Get user profile
const profile = await contactsApi(
  "people/me?personFields=names,emailAddresses",
  "personal",
);
```

---

## Token Management

A small refresher job keeps `access_token` fresh in your vault on a short cron (e.g. every 15 min). To re-authorize (if a refresh token expires):

```bash
node integrations/google/google_auth.ts --account personal
```

## Troubleshooting

| Error | Fix |
| --- | --- |
| 401 Unauthorized | Token expired - will auto-refresh on next call |
| 403 Forbidden | Scope not authorized - re-run `google_auth.ts` |
| 404 Not Found | File/resource ID incorrect or no access |
| Token refresh failed | Refresh token expired - re-run `google_auth.ts` |

## Common invocations

### Smoke / auth check
```bash
op read 'op://<your-vault>/<google-personal-item-id>/refresh_token' >/dev/null && node --input-type=module -e 'import { getToken } from "./integrations/google/google_workspace.ts"; const token = await getToken("personal"); console.log("personal token ok: " + token.slice(0, 12));'
```

### Common queries / actions
- Sending email: prefer routing mail through a deployed workflow rather than ad-hoc sends from a shell, so sends are audited and rate-controlled. The send helpers (`gmailSend`, `gmailSendRaw` in `gmail.ts`) are for workflow code.
- Query inbox with read-scope credential: `node --input-type=module -e 'import { createGmailSession, gmailListMessages } from "./integrations/google/gmail.ts"; import { CREDS } from "./integrations/1password/op_helper.ts"; const s = await createGmailSession(CREDS.googlePersonal); const r = await gmailListMessages(s, { q: "newer_than:7d", maxResults: 5 }); console.log(r.resultSizeEstimate ?? 0);'`
- Inspect sheet tabs for a spreadsheet: `node --input-type=module -e 'import { createSheetsSession, sheetsGetMetadata } from "./integrations/google/google_sheets.ts"; const s = await createSheetsSession(); const m = await sheetsGetMetadata(s, process.env.SHEET_ID); console.log((m.sheets ?? []).map((x) => x.properties?.title));' SHEET_ID=<sheet-id>`
- Read a column from a spreadsheet: `node --input-type=module -e 'import { createSheetsSession, sheetsGet } from "./integrations/google/google_sheets.ts"; const s = await createSheetsSession(); const rows = await sheetsGet(s, process.env.SHEET_ID, "Summary!B:B"); console.log(rows.length);' SHEET_ID=<sheet-id>`

### Common failures
- `Gmail messages.list failed: HTTP 403 ... insufficientPermissions` → default `createGmailSession()` uses send-only creds; for reads use `createGmailSession(CREDS.googlePersonal)`.
- `getGoogleToken: no CREDS mapping for "..."` → add the missing key in `PATH_TO_CRED` (`google_oauth.ts`).
- `Sheets ... failed: 404 ... Requested entity was not found` → spreadsheet ID is wrong or not shared to the credential behind `createSheetsSession`.
- `OAuth refresh failed ... invalid_grant` → refresh token is expired/revoked; re-run `integrations/google/google_auth.ts` for the affected account to mint a new refresh token.

---

## OAuth Flow

Google OAuth2 authorization for Workspace APIs. All tokens persist directly to your secrets vault — no local files.

Two TS surfaces:

- [`google_auth.ts`](google_auth.ts) — interactive bootstrap (opens a browser, captures the OAuth code, writes refresh + access + expires_at + token_url directly to your vault).
- [`google_oauth.ts`](google_oauth.ts) — runtime entry that maps a credential key → vault item via a static `PATH_TO_CRED` map and reads `access_token` (kept fresh by the refresher job).

### Interactive bootstrap

```bash
# Writes refresh + access tokens directly to your vault
node integrations/google/google_auth.ts --account personal
node integrations/google/google_auth.ts --account work
```

### Runtime token resolution

```ts
import { getGoogleToken } from "../../integrations/google/google_oauth.ts";
const token = await getGoogleToken("googlePersonal");
```

### Vault-canonical map

| Vault Item | CREDS key | Account / Scope |
|---|---|---|
| `Google OAuth (Personal)` | `googlePersonal` | `<your-email>` — Drive/Sheets/Calendar/Gmail.read/People |
| `Google OAuth (Work)` | `googleWork` | `<your-work-email>` — same scope set as personal |
| `Gmail Send OAuth` | `googleGmailSend` | Gmail send (separate OAuth app, gmail.compose scope) |

Each item carries `client_id`, `client_secret`, `refresh_token` (rotated), `access_token`, `expires_at`, `token_url`. **Access tokens are kept fresh by a refresher job on a `*/15 * * * *` cron.** Consumers read `access_token` directly via `getRawField(cred, "access_token", { ttlMs: 0 })` — no at-use refresh, no provider call per consumer request.

### Common failures (OAuth-flow specific)

- `getGoogleToken: no CREDS mapping for "..."` → add the missing key in `PATH_TO_CRED` (`google_oauth.ts`).
- `Google OAuth refresh failed: 400 {"error":"invalid_grant"...}` → refresh token is dead/revoked; run the interactive bootstrap script and rewrite `refresh_token` in your vault (`google_auth.ts`).
- `op error: ... invalid character in secret reference: '('` → titles with parentheses do not parse in `op://` refs; use the item UUID path instead.
- `op error: (409) Conflict: Internal server conflict` during refresh → two concurrent token writers collided; rerun a single refresh command (avoid parallel refreshes).
