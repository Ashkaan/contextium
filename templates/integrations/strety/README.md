# Strety

EOS (Entrepreneurial Operating System) platform for managing scorecards, rocks, to-dos, and issues. Central hub for
weekly L10 meeting data and quarterly goal tracking.

## Requirements

- Strety account with API access
- API key or OAuth credentials
- Team and scorecard IDs (found in Strety dashboard URLs)

## Setup

1. Log in to Strety and navigate to Settings > API / Integrations
2. Generate an API key
3. Store credentials in your vault:
   ```bash
   op item create --category=login --title="Strety - API" \
     --vault="Business" api_key="your-key" base_url="https://app.strety.com"
   ```
4. Identify your key IDs from the Strety web app:
   - **Team ID**: visible in the URL when viewing your team (`/teams/{id}`)
   - **Scorecard ID**: visible when viewing scorecards
5. Test by fetching your scorecard data

## Key Endpoints

| Resource   | Method | Endpoint                  | Use                                 |
| ---------- | ------ | ------------------------- | ----------------------------------- |
| Scorecards | GET    | `/api/v1/scorecards/{id}` | Weekly KPI metrics and targets      |
| Rocks      | GET    | `/api/v1/rocks`           | Quarterly goals and status          |
| To-Dos     | GET    | `/api/v1/todos`           | Action items from L10 meetings      |
| Issues     | GET    | `/api/v1/issues`          | IDS (Identify, Discuss, Solve) list |
| Meetings   | GET    | `/api/v1/meetings`        | L10 meeting history and notes       |

## EOS Concepts

| Term      | Meaning                                            | Frequency       |
| --------- | -------------------------------------------------- | --------------- |
| Scorecard | Weekly KPIs with targets (on/off track)            | Reviewed weekly |
| Rock      | Major quarterly goal for a team member             | Set quarterly   |
| To-Do     | Action item assigned in a meeting (7-day deadline) | Created weekly  |
| Issue     | Problem to IDS (Identify, Discuss, Solve)          | Ongoing list    |
| L10       | Weekly 90-minute leadership team meeting           | Every week      |

## Use Cases

- Pulling weekly scorecard data to prep for L10 meetings
- Tracking rock completion progress against quarterly deadlines
- Reviewing to-do completion rates for team accountability
- Preparing meeting agendas with open issues and overdue items
- Generating EOS health summaries for quarterly reviews
