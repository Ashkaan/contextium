# TRMNL

E-ink dashboard display for at-a-glance information.

## Requirements

- TRMNL device
- API key from your TRMNL account

## Setup

1. Set up your TRMNL device and connect it to Wi-Fi
2. Get your API key from the TRMNL dashboard
3. Store the API key in your credential vault
4. Configure webhook URL for pushing data

## How It Works

TRMNL displays are updated by pushing data via webhook. Your automations format the data and send it to the TRMNL API,
which renders it on the e-ink screen.

## Data Push Format

```bash
curl -X POST https://usetrmnl.com/api/custom_plugins \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"merge_variables": {"title": "Dashboard", "content": "..."}}'
```

## Use Cases

- Displaying today's focus items and calendar
- Showing business metrics (scorecard, KPIs)
- Weather and agenda at a glance
- Custom dashboards updated by automations
