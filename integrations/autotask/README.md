# Autotask

PSA/ticketing system for service desk and business operations.

## Requirements

- Autotask PSA account
- API credentials: username, secret, integration code

## Setup

1. Generate API credentials in Autotask Admin > API User
2. Note the integration code for your API user
3. Store all credentials in your vault
4. API base URL: `https://webservicesX.autotask.net/atservicesrest/` (zone-specific)

## Key Endpoints

| Resource     | Endpoint       | Use                    |
| ------------ | -------------- | ---------------------- |
| Tickets      | `/Tickets`     | Service desk tickets   |
| Companies    | `/Companies`   | Client/company records |
| Resources    | `/Resources`   | Team member data       |
| Time entries | `/TimeEntries` | Billable time tracking |

## Query Format

Autotask uses a custom query filter format:

```json
{ "filter": [{ "field": "status", "op": "noteq", "value": 5 }] }
```

## Use Cases

- Pulling ticket data for SLA reporting
- Querying company and contact information
- Analyzing resource workload and utilization
- Generating business metrics and dashboards
