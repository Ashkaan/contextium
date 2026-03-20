# Google Workspace

Access Google APIs including Gmail, Calendar, Drive, Sheets, and Contacts. One of the most-used integrations for daily briefings, email automation, and data tracking.

## Requirements

- Google Cloud project with relevant APIs enabled
- OAuth2 credentials (client ID + client secret)
- Authorized redirect URI configured
- Completed auth flow (see `integrations/google-auth/`)

## Setup

1. Create a Google Cloud project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the following APIs (APIs & Services > Enable APIs):
   - Gmail API
   - Google Calendar API
   - Google Drive API
   - Google Sheets API
   - People API (contacts)
3. Create OAuth2 credentials:
   - Go to APIs & Services > Credentials > Create Credentials > OAuth Client ID
   - Application type: Desktop app (for CLI) or Web app (for server-side)
   - Download the client configuration JSON
4. Store client ID and secret in your credential vault:
   ```bash
   op item create --category=login --title="Google - OAuth Client" \
     --vault="Productivity" client_id="xxx" client_secret="xxx"
   ```
5. Run the auth flow via `integrations/google-auth/` to generate tokens
6. Store the resulting refresh token in your vault

## Key APIs and Scopes

| API | Scopes | Use |
|-----|--------|-----|
| Gmail | `gmail.send`, `gmail.readonly` | Send and read emails |
| Calendar | `calendar.readonly`, `calendar.events` | Read/write events |
| Drive | `drive.readonly`, `drive.file` | File access and search |
| Sheets | `spreadsheets` | Read/write spreadsheet data |
| People | `contacts.readonly` | Contact lookup |

## Common API Calls

### Gmail: Send an Email

```bash
# Using the Gmail API (base64url-encoded message)
POST https://gmail.googleapis.com/gmail/v1/users/me/messages/send
Authorization: Bearer $ACCESS_TOKEN
Content-Type: application/json

{"raw": "<base64url-encoded RFC 2822 message>"}
```

### Calendar: List Today's Events

```bash
GET https://www.googleapis.com/calendar/v3/calendars/primary/events\
  ?timeMin=2026-03-20T00:00:00Z\
  &timeMax=2026-03-20T23:59:59Z\
  &singleEvents=true\
  &orderBy=startTime
Authorization: Bearer $ACCESS_TOKEN
```

### Sheets: Read a Range

```bash
GET https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/Sheet1!A1:D10
Authorization: Bearer $ACCESS_TOKEN
```

### Sheets: Append a Row

```bash
POST https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/Sheet1!A1:append\
  ?valueInputOption=USER_ENTERED
Authorization: Bearer $ACCESS_TOKEN
Content-Type: application/json

{"values": [["2026-03-20", "Metric", "42", "notes"]]}
```

## Token Management

- Access tokens expire in 1 hour and auto-refresh using the refresh token
- If the refresh token is revoked (user removed access, or 6-month inactivity), re-run the auth flow
- Supports multiple accounts (personal, work) -- each gets its own token set in the vault
- Token refresh is typically handled in your automation scripts (Windmill, n8n, etc.)

## Use Cases

- Sending daily briefing emails via Gmail
- Reading calendar events for agenda planning and scheduling
- Writing tracking data to Google Sheets (health, finance, metrics)
- Looking up contact information for people cards
- Pulling Drive files for document summarization
