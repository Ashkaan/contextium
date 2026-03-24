# Todoist

Task management via the Todoist REST API.

## Requirements

- Todoist account (free or premium)
- API token

## Setup

1. Go to Todoist Settings > Integrations > Developer
2. Copy your API token
3. Store the token in your credential vault
4. Test: `curl -H "Authorization: Bearer $TOKEN" https://api.todoist.com/rest/v2/tasks`

## Key Endpoints

| Action        | Method | Endpoint                       |
| ------------- | ------ | ------------------------------ |
| List tasks    | GET    | `/rest/v2/tasks`               |
| Create task   | POST   | `/rest/v2/tasks`               |
| Complete task | POST   | `/rest/v2/tasks/{id}/close`    |
| List projects | GET    | `/rest/v2/projects`            |
| Get stats     | GET    | `/sync/v9/completed/get_stats` |

## Use Cases

- Creating tasks from journal entries or project plans
- Pulling completion stats for weekly reviews
- Syncing project milestones with task due dates
- Building daily agendas from today's tasks
