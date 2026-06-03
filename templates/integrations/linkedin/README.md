---
name: LinkedIn
description: Automated content publishing and engagement on LinkedIn
cli: REST API
typed_client: integrations/linkedin/linkedin.ts
hosts:
  - api.linkedin.com
  - www.linkedin.com
aliases:
  - linkedin post
  - linkedin publish
  - linkedin company page
  - linkedin profile
---
# LinkedIn Integration

Automated content publishing and engagement on a personal LinkedIn profile and/or a company page.

## TypeScript Client

Canonical typed reference: [`linkedin.ts`](linkedin.ts).

```ts
import { createLinkedInSession, linkedInGet, linkedInPost, type LinkedInSession } from "../../integrations/linkedin/linkedin.ts";
```

### Export surface

| Function / Type | Purpose |
|---|---|
| `createLinkedInSession()` | OAuth token retrieval + Member URN; returns `LinkedInSession` |
| `linkedInGet(session, path)` | GET request with REST API headers |
| `linkedInPost(session, path, body)` | POST request for posts/shares |
| `linkedInGetUserinfo(session)` | OpenID userinfo fetch (`/v2/userinfo`) |
| `linkedInUploadBinary(session, uploadUrl, bytes)` | Image/video binary upload to LinkedIn assets |
| `LinkedInSession` | Shared session type |

## Apps

You typically register one LinkedIn developer app per capability tier:

| App | Vault Item | Products | Status |
|-----|-----------|----------|--------|
| Content Publisher | `LinkedIn - Content Publisher` | Sign In with OpenID Connect, Share on LinkedIn | Use for posting |
| Community Manager | `LinkedIn - Community Manager` | Community Management API | Optional — fuller engagement once approved |

## API Access

**Share on LinkedIn** (Content Publisher app):
- Post to personal profile (`w_member_social`)
- OpenID Connect authentication (`openid`, `profile`, `email`)

**Community Management API** (Community Manager app, requires LinkedIn approval):
- Post to personal profile and company page
- Read/reply to comments
- Track engagement (likes, shares)

**Auth flow:** OAuth 2.0 Authorization Code
- Authorize URL: `https://www.linkedin.com/oauth/v2/authorization`
- Token URL: `https://www.linkedin.com/oauth/v2/accessToken`
- Redirect URI: `https://<your-callback-host>/oauth/callback` (the host need not actually serve the callback — copy the `code` from the URL bar after LinkedIn redirects you. It must match what's configured on the LinkedIn app at https://www.linkedin.com/developers/apps; if you change it there, update the authorize URL + token-exchange `redirect_uri` below too.)
- Token storage: your secrets vault — item `LinkedIn OAuth (Content Publisher)`, fields `access_token` + `expires_at`.

## Credentials

```bash
# Content Publisher app (used for posting)
CLIENT_ID=$(op item get "<content-publisher-item-id>" --vault "<your-vault>" --fields client_id --reveal)
CLIENT_SECRET=$(op item get "<content-publisher-item-id>" --vault "<your-vault>" --fields client_secret --reveal)

# Community Manager app (optional, future engagement features)
CLIENT_ID=$(op item get "<community-manager-item-id>" --vault "<your-vault>" --fields client_id --reveal)
CLIENT_SECRET=$(op item get "<community-manager-item-id>" --vault "<your-vault>" --fields client_secret --reveal)
```

## Token Storage

All LinkedIn OAuth state lives in your secrets vault:

| Vault Field | Purpose |
|----------|---------|
| `client_id` / `client_secret` | OAuth app credentials (static) |
| `access_token` | 60-day hand-minted access token (no refresh path on Share-on-LinkedIn) |
| `expires_at` | Unix epoch SECONDS when the access token expires (readers multiply by 1000 when comparing to `Date.now()`) |

Read live every task invocation via `getCred(CREDS.linkedinContentPublisher, "accessToken" | "expiresAt")`. No env-var staging — when the 60-day token rotates in the vault, the next task run picks it up automatically.

## Automation

Wire the publisher into a scheduled job (e.g. a few mornings a week) that drafts and publishes posts. Keep a voice guide and a post log alongside it.

## OAuth Setup

### Initial authorization (one-time, every 60 days)

1. Build the authorize URL:
```
https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=<your-client-id>&redirect_uri=https%3A%2F%2F<your-callback-host>%2Foauth%2Fcallback&scope=openid%20profile%20email%20w_member_social
```

2. Visit the URL, authorize, get redirected to `<your-callback-host>/oauth/callback?code=...` (the host need not serve this path — just grab `code` from the URL bar).
3. Exchange code for tokens (single-use; do this in ONE shell, don't preview-then-run or you'll consume the code without using the result):
   ```bash
   CODE='...paste here...'
   CLIENT_ID="$(op read 'op://<your-vault>/<content-publisher-item-id>/client_id')"
   CLIENT_SECRET="$(op read 'op://<your-vault>/<content-publisher-item-id>/client_secret')"
   curl -sS -X POST 'https://www.linkedin.com/oauth/v2/accessToken' \
     -H 'Content-Type: application/x-www-form-urlencoded' \
     --data-urlencode "grant_type=authorization_code" \
     --data-urlencode "code=${CODE}" \
     --data-urlencode "client_id=${CLIENT_ID}" \
     --data-urlencode "client_secret=${CLIENT_SECRET}" \
     --data-urlencode "redirect_uri=https://<your-callback-host>/oauth/callback"
   # → { "access_token": "...", "expires_in": 5183999, ... }
   ```
4. Write `access_token` + `expires_at` to your vault (`expires_at` is **Unix epoch SECONDS**, not ms):
   ```bash
   EXPIRES_AT=$(( $(date +%s) + EXPIRES_IN ))
   op item edit <content-publisher-item-id> --vault "<your-vault>" \
     "access_token[concealed]=$NEW_TOKEN" \
     "expires_at[text]=$EXPIRES_AT"
   ```

### Token lifecycle

**Share on LinkedIn:** Access tokens expire after 60 days. **No refresh tokens issued.** Have your publisher warn several days before expiration so you can re-authorize before the next scheduled run.

**Community Management API:** Issues refresh tokens (365-day lifetime). Once approved, swap to a refresh flow for auto-refresh.

## API Reference

### Post to personal profile
```
POST https://api.linkedin.com/rest/posts
Headers:
  Authorization: Bearer {access_token}
  LinkedIn-Version: 202601
  Content-Type: application/json
  X-Restli-Protocol-Version: 2.0.0

Body:
{
  "author": "urn:li:person:{MEMBER_ID}",
  "commentary": "Post text here",
  "visibility": "PUBLIC",
  "distribution": { "feedDistribution": "MAIN_FEED" },
  "lifecycleState": "PUBLISHED"
}
```

### Get member info
```
GET https://api.linkedin.com/v2/userinfo
Headers: Authorization: Bearer {access_token}
→ returns { sub: "MEMBER_ID" }
```

## Common invocations

### Smoke / auth check
```bash
node --input-type=module -e "import { createLinkedInSession, linkedInGetUserinfo } from './integrations/linkedin/linkedin.ts'; const { execSync } = await import('node:child_process'); const token = execSync(\"op read 'op://<your-vault>/<content-publisher-item-id>/access_token'\", { encoding: 'utf8' }).trim(); const li = createLinkedInSession(token); const me = await linkedInGetUserinfo(li); console.log(JSON.stringify({ sub: me.sub, email: me.email }, null, 2));"
```

### Refresh / re-auth
```bash
CLIENT_ID=$(op read 'op://<your-vault>/<content-publisher-item-id>/client_id') && echo "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2F<your-callback-host>%2Foauth%2Fcallback&scope=openid%20profile%20email%20w_member_social"
```

### Common queries / actions
- Resolve author URN: `node --input-type=module -e "import { createLinkedInSession, linkedInGetUserinfo } from './integrations/linkedin/linkedin.ts'; const { execSync } = await import('node:child_process'); const token = execSync(\"op read 'op://<your-vault>/<content-publisher-item-id>/access_token'\", { encoding: 'utf8' }).trim(); const li = createLinkedInSession(token); const me = await linkedInGetUserinfo(li); const sub = String(me.sub ?? ''); console.log(sub.startsWith('urn:') ? sub : 'urn:li:person:' + sub);"`
- Escape post text for LITTLE_TEXT: `node --input-type=module -e "import { escapeLinkedInCommentary } from './integrations/linkedin/linkedin.ts'; console.log(escapeLinkedInCommentary('Audit your DPA (2026) before rollout. #LegalTech'));"`
- Initialize image upload: `node --input-type=module -e "import { createLinkedInSession, linkedInGetUserinfo, linkedInPost } from './integrations/linkedin/linkedin.ts'; const { execSync } = await import('node:child_process'); const token = execSync(\"op read 'op://<your-vault>/<content-publisher-item-id>/access_token'\", { encoding: 'utf8' }).trim(); const li = createLinkedInSession(token); const me = await linkedInGetUserinfo(li); const sub = String(me.sub ?? ''); const owner = sub.startsWith('urn:') ? sub : 'urn:li:person:' + sub; const resp = await linkedInPost(li, 'images?action=initializeUpload', { initializeUploadRequest: { owner } }); console.log(JSON.stringify({ status: resp.status, body: await resp.text() }, null, 2));"`
- Publish a text post: `node --input-type=module -e "import { createLinkedInSession, escapeLinkedInCommentary, linkedInGetUserinfo, linkedInPost } from './integrations/linkedin/linkedin.ts'; const { execSync } = await import('node:child_process'); const token = execSync(\"op read 'op://<your-vault>/<content-publisher-item-id>/access_token'\", { encoding: 'utf8' }).trim(); const li = createLinkedInSession(token); const me = await linkedInGetUserinfo(li); const sub = String(me.sub ?? ''); const author = sub.startsWith('urn:') ? sub : 'urn:li:person:' + sub; const commentary = escapeLinkedInCommentary('Cookbook publish probe ' + new Date().toISOString()); const resp = await linkedInPost(li, 'posts', { author, commentary, visibility: 'PUBLIC', distribution: { feedDistribution: 'MAIN_FEED' }, lifecycleState: 'PUBLISHED' }); const err = resp.ok ? null : (await resp.text()).slice(0, 500); console.log(JSON.stringify({ status: resp.status, postId: resp.headers.get('x-restli-id') ?? null, error: err }, null, 2));"`

### Common failures
- `invalid secret reference ... invalid character` from `op read` when using an item title with parentheses → use the item UUID path (`op://<your-vault>/<content-publisher-item-id>/...`).
- `LinkedIn userinfo failed: 401` or `LinkedIn GET/POST ... 401` → access token expired; run the re-auth URL flow, then update `access_token` + `expires_at` in your vault item.
- LinkedIn 429/5xx retries then failure → wait and retry with lower burst; the client retries up to 3 times with `Retry-After`/exponential backoff.
- Post publish returns 400/422 for commentary parsing → run text through `escapeLinkedInCommentary()` before `linkedInPost(..., 'posts', ...)`.
