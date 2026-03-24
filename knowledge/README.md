# Knowledge Base

Domain-organized reference data — the persistent facts your AI needs across sessions.

## What Belongs Here

Static and semi-static information organized by topic:

- Things that don't change often (genetics, property details, historical records)
- Things that change periodically (goals, biomarkers, supplement stacks)
- People (relationship context, preferences, connections)

## What Doesn't Belong Here

- Session logs → `journal/`
- Active work → `projects/`
- Protocols and SOPs → `apps/`
- External service config → `integrations/`

## Suggested Domains

| Domain     | Content                                    |
| ---------- | ------------------------------------------ |
| `growth/`  | Goals, reflections, coaching, assessments  |
| `health/`  | Biomarkers, supplements, genetics, fitness |
| `finance/` | Tax, insurance, assets, budgets            |
| `people/`  | Relationship cards (see below)             |
| `home/`    | Property, vehicles, maintenance            |
| `work/`    | Strategy, clients, industry knowledge      |

Create domains as needed during onboarding or as topics arise.

## Year-Based Data

For data that accumulates over time (health metrics, financial records), use year-based files:
`knowledge/{domain}/{topic}/{year}.md`
