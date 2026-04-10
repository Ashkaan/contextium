---
name: Health Tracker
description: >-
  Health tracking: biomarkers, supplements, genetics, diet, fitness, sleep.
  Includes testing frameworks and intervention decision logs.
category: personal
schedule: Staleness check (configurable)
runtime: Your automation platform
trigger: Timer
outputs:
  - Alert email on stale data
integrations:
  - Gmail or SMTP
---

# Health Tracker

Comprehensive health tracking with biomarkers, supplements, and intervention logging.

## Pattern: Data Sync

External health data syncs into the repo. Staleness monitoring alerts when data hasn't been updated.

## Data

Health data lives in `knowledge/health/`:

- `biomarkers/` — Lab results, blood work
- `supplements/` — Current supplement stack
- `genetics/` — Genetic profile and risk factors
- `sleep/` — Sleep tracking data
- `fitness/` — Exercise logs
- `body-composition/` — Weight, measurements

## Protocol

### Adding Lab Results

1. Record results in `knowledge/health/biomarkers/{year}.md`
2. Compare against targets and previous results
3. Note any supplement or protocol changes needed

### Supplement Changes

1. Update `knowledge/health/supplements/current.md`
2. Check for interactions with existing stack
3. Note evidence level (strong/moderate/weak)

### Staleness Monitoring

Configure an automation to check file modification dates. Alert if key files haven't been updated within expected
intervals.
