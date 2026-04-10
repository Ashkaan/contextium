# Hudu

IT documentation platform for knowledge base and client information.

## Requirements

- Hudu instance (self-hosted or cloud)
- API key

## Setup

1. Go to Admin > API Keys in your Hudu instance
2. Generate a new API key
3. Store the key and instance URL in your vault
4. Test: `curl -H "x-api-key: $KEY" https://your-hudu-instance/api/v1/companies`

## Key Endpoints

| Resource      | Endpoint                        | Use                     |
| ------------- | ------------------------------- | ----------------------- |
| Companies     | `/api/v1/companies`             | Client list             |
| Articles      | `/api/v1/articles`              | Knowledge base articles |
| Asset layouts | `/api/v1/asset_layouts`         | Documentation templates |
| Assets        | `/api/v1/companies/{id}/assets` | Client assets           |

## Use Cases

- Looking up client documentation
- Backing up knowledge base articles
- Searching for configuration details
- Cross-referencing client info with other systems
