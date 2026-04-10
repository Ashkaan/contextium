# MSPBots

MSP-specific analytics platform for business metrics, KPI dashboards, and automated reporting. Aggregates data from PSA
and RMM tools into unified dashboards.

## Requirements

- MSPBots account with API access enabled
- API key
- Connected data sources (Autotask, NinjaOne, etc.) configured in MSPBots

## Setup

1. Log in to MSPBots and go to Settings > API
2. Generate an API key
3. Store the key and base URL in your credential vault:
   ```bash
   op item create --category=login --title="MSPBots - API" \
     --vault="Business" api_key="your-key" base_url="https://api.mspbots.ai"
   ```
4. Ensure your PSA/RMM data sources are connected and syncing in the MSPBots dashboard
5. Test: `curl -H "Authorization: Bearer $API_KEY" https://api.mspbots.ai/v1/dashboards`

## Key Endpoints

| Resource       | Method | Endpoint                   | Use                                 |
| -------------- | ------ | -------------------------- | ----------------------------------- |
| Dashboards     | GET    | `/v1/dashboards`           | List available dashboards           |
| Dashboard data | GET    | `/v1/dashboards/{id}/data` | Pull data from a specific dashboard |
| Reports        | GET    | `/v1/reports`              | List available reports              |
| Report data    | GET    | `/v1/reports/{id}/export`  | Export report data                  |
| Metrics        | GET    | `/v1/metrics`              | Query specific KPI metrics          |

## Key Metrics Available

| Category     | Metrics                                                       |
| ------------ | ------------------------------------------------------------- |
| Service desk | Ticket volume, response time, resolution time, SLA compliance |
| Revenue      | MRR, revenue per endpoint, revenue by client                  |
| Operations   | Technician utilization, tickets per tech, backlog age         |
| Clients      | Client profitability, agreement coverage, endpoint count      |

## Use Cases

- Pulling weekly scorecard metrics for L10 meetings
- Generating KPI reports for monthly business reviews
- Monitoring service desk performance trends
- Tracking revenue, profitability, and client health metrics
- Comparing period-over-period performance
