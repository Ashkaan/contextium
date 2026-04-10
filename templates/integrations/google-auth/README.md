# Google Auth

OAuth2 credential management for Google APIs. Handles the initial authorization flow and token storage.

## Requirements

- Google Cloud project with OAuth2 credentials
- Client ID and client secret stored in your vault

## Setup

1. Retrieve OAuth2 credentials from your vault
2. Run the auth flow script to generate tokens
3. Store the resulting refresh token in your vault
4. Configure token auto-refresh in your automation platform

## How It Works

1. **Initial auth** — Opens a browser for consent, returns an authorization code
2. **Token exchange** — Exchanges the code for access + refresh tokens
3. **Storage** — Refresh token is stored securely in your vault
4. **Auto-refresh** — Access tokens are refreshed automatically when expired

## Multiple Accounts

Supports separate token sets for different Google accounts (e.g., personal and work). Each account gets its own
credential entry in the vault.

## Use Cases

- Initial setup of Google Workspace integration
- Re-authorization when refresh tokens expire
- Adding new Google accounts
