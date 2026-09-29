---
name: LinkedIn
description: Automated content publishing and engagement on LinkedIn
hosts:
  - api.linkedin.com
  - www.linkedin.com
aliases:
  - linkedin post
  - linkedin publish
  - linkedin company page
  - linkedin profile
typed_client:
  - none
access:
  - api
  - browser
uses: none
base_url: https://api.linkedin.com/v2
auth: oauth2 access token (60-day, hand-minted)
onepassword_item: none
rate_limit: per-app daily call quotas set in the LinkedIn developer console
cli: REST API
---
# LinkedIn Integration

**Access order:** api, browser — the REST API does every post, upload and member lookup, and the browser is needed only for the 60-day OAuth consent click.

Automated content publishing and engagement on a personal LinkedIn profile and/or a company page.

## If you write a client

Nothing here ships one; `curl` covers every call below. A client is worth writing once a scheduled job posts, and this is its shape:

- A session holding the access token and the member URN (`urn:li:person:<sub>`, from `/v2/userinfo`).
- GET and POST helpers that always send the four REST headers shown under [API Reference](#api-reference), and retry 429/5xx honoring `Retry-After`.
- A binary upload for images and video (initialize the upload, then `PUT` the bytes to the returned URL).
- A commentary escaper (see [Post text is Little Text](#post-text-is-little-text)).

## Apps

You typically register one LinkedIn developer app per capability tier:

| App | Vault Item | Products | Status |
|-----|-----------|----------|--------|
| Content Publisher | `LinkedIn Content Publisher - <consumer>` | Sign In with OpenID Connect, Share on LinkedIn | Use for posting |
| Community Manager | `LinkedIn Community Manager - <consumer>` | Community Management API | Optional — fuller engagement once approved |

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
- Token storage: your secrets vault — the Content Publisher item, fields `access_token` + `expires_at`.

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

Read the token from the vault on every run (`op read "op://<your-vault>/<content-publisher-item-id>/access_token"`) rather than staging it in an environment variable, so a re-minted token is picked up by the next run without a restart.

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
   curl -fsS -X POST 'https://www.linkedin.com/oauth/v2/accessToken' \
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

### Post text is Little Text

`commentary` is parsed as LinkedIn's Little Text format, where `| { } @ [ ] ( ) < > # \ * _ ~` are reserved. Escape every one with a backslash unless you mean the markup (a mention or hashtag template), or the post is rejected (400/422) or renders wrong. In JSON the backslash itself is escaped, so `(finally)` becomes `"\\(finally\\)"`. Reference: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format

## Common invocations

Every snippet assumes the token (and, for writes, your author URN) is loaded:

```bash
TOKEN="$(op read 'op://<your-vault>/<content-publisher-item-id>/access_token')"
AUTHOR="$(curl -fsS -H "Authorization: Bearer $TOKEN" https://api.linkedin.com/v2/userinfo | jq -r '"urn:li:person:" + .sub')"
```

### Smoke / auth check
```bash
curl -fsS -H "Authorization: Bearer $TOKEN" https://api.linkedin.com/v2/userinfo | jq '{sub, email}'
```

### Refresh / re-auth
```bash
CLIENT_ID=$(op read 'op://<your-vault>/<content-publisher-item-id>/client_id') && echo "https://www.linkedin.com/oauth/v2/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=https%3A%2F%2F<your-callback-host>%2Foauth%2Fcallback&scope=openid%20profile%20email%20w_member_social"
```

Then run steps 2-4 of [Initial authorization](#initial-authorization-one-time-every-60-days).

### Common queries / actions
- Resolve author URN: `curl -fsS -H "Authorization: Bearer $TOKEN" https://api.linkedin.com/v2/userinfo | jq -r '"urn:li:person:" + .sub'`
- Initialize an image upload (returns `uploadUrl` + image URN): `curl -fsS -X POST 'https://api.linkedin.com/rest/images?action=initializeUpload' -H "Authorization: Bearer $TOKEN" -H 'LinkedIn-Version: 202601' -H 'X-Restli-Protocol-Version: 2.0.0' -H 'Content-Type: application/json' -d "{\"initializeUploadRequest\":{\"owner\":\"$AUTHOR\"}}" | jq '.value | {uploadUrl, image}'`
- Publish a text post (the new post id is in the `x-restli-id` response header): `curl -sS -D - -o /dev/null -X POST 'https://api.linkedin.com/rest/posts' -H "Authorization: Bearer $TOKEN" -H 'LinkedIn-Version: 202601' -H 'X-Restli-Protocol-Version: 2.0.0' -H 'Content-Type: application/json' -d "{\"author\":\"$AUTHOR\",\"commentary\":\"Test post, please ignore\",\"visibility\":\"PUBLIC\",\"distribution\":{\"feedDistribution\":\"MAIN_FEED\"},\"lifecycleState\":\"PUBLISHED\"}" | grep -iE '^(HTTP|x-restli-id)'`

### Common failures
- `invalid secret reference ... invalid character` from `op read` when using an item title with parentheses → use the item UUID path (`op://<your-vault>/<content-publisher-item-id>/...`).
- HTTP 401 from `/v2/userinfo` or `/rest/*` → access token expired; run the re-auth URL flow, then update `access_token` + `expires_at` in your vault item.
- HTTP 429 or 5xx → back off (honor `Retry-After`) and retry with a lower burst.
- HTTP 400/422 on publish for commentary parsing → an unescaped Little Text reserved character; see [Post text is Little Text](#post-text-is-little-text).
- A version error → the `LinkedIn-Version` header names a monthly version LinkedIn has sunset (each is retired roughly a year after release); bump it to a current `YYYYMM`.
