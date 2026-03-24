# NinjaOne

Device inventory and remote monitoring/management (RMM) platform.

## Requirements

- NinjaOne account
- OAuth2 client credentials (client ID + client secret)

## Setup

1. Go to Administration > Apps > API
2. Create a new API application (Client Credentials grant type)
3. Store client ID and secret in your vault
4. Token endpoint: `https://app.ninjarmm.com/oauth/token`
5. API base: `https://app.ninjarmm.com/api/v2`

## Key Endpoints

| Resource      | Endpoint         | Use                   |
| ------------- | ---------------- | --------------------- |
| Devices       | `/devices`       | Full device inventory |
| Organizations | `/organizations` | Client/org list       |
| Alerts        | `/alerts`        | Active alerts         |
| Activities    | `/activities`    | Activity log          |

## Use Cases

- Pulling device inventory for hardware lifecycle planning
- Monitoring device health and alert status
- Generating security assessment reports
- Tracking warranty and hardware age data
