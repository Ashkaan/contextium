# 1Password

Secure credential vault for storing API keys, tokens, and secrets.

## Requirements

- 1Password account with a dedicated vault
- `op` CLI installed
- Service account token

## Setup

1. Install the `op` CLI: `brew install 1password-cli` (or platform equivalent)
2. Create a service account in your 1Password admin console
3. Export the token: `export OP_SERVICE_ACCOUNT_TOKEN="your-token"`
4. Verify: `op vault list`

## Key Commands

```bash
op read "op://VaultName/ItemName/field"        # Read a single field
op item get "ItemName" --vault "VaultName"      # Get full item
op item edit "ItemName" field=value             # Update a field
op item create --category=login --title="Name"  # Create new item
```

## Conventions

- Store all integration credentials here — never on disk
- Use descriptive item names: `ServiceName - Purpose`
- Keep a dedicated vault for AI agent credentials
- Reference credentials by vault path in automation scripts

## Use Cases

- Retrieving API keys for integration scripts
- Rotating credentials without editing code
- Sharing secrets across automation platforms
