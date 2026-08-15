# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository. It is the **working surface** — the canonical place to look for what's loaded by default and how the AI layer is shaped. Other rule files live alongside this one for path-scoped or on-demand use; this file is what every fresh session reads first.

`projects/README.md` (the project index) is no longer always-loaded — invoke `/project` (no args) to render the live priority-sorted index, or `/project <slug>` to load and route a specific project. See `.claude/skills/project/SKILL.md` for behavior.

## User Preferences

Replace these with your actual preferences when you install this template.

- Be concise, direct, practical. Technical depth welcome.
- Name in plain English anything you haven't seen this session (project, spec number, rule id, tool, acronym) the first time it appears; brevity NEVER outranks being understood.
- Pick the shortest format that stays clear (prose, table, or list); NEVER add structure the answer doesn't need. Response format is set by the `brevity` output style (`.claude/output-styles/brevity.md`), the default `outputStyle`.
- Push back with better approaches when warranted; NEVER agree-by-default.
- Default to implementation over planning; NEVER expand a 30-minute task into a 3-hour plan.
- Fix issues silently when reversible + scoped; ASK before infra changes (covered by `@rule:ask-before-host-infra-changes`).
- Do NOT declare a feature shipped while a known blocker remains.

## The Loop

Three verbs, fresh context between think and do. Each producer verb auto-runs its machine review then auto-invokes `/close` on clean completion — "wrap" is no longer a verb the user types. The loop HALTS for you only on a hard stop or a proposed deferral (the goal-alignment front gate still gates intent up front).

| Verb | Skill(s) | Auto-runs | Halts for you only on |
|---|---|---|---|
| Think | `/project` → `/spec` | `/spec-audit`, then `/close` | goal-alignment (up front); a decision or deferral |
| Do | `/implement` | `/implement-audit`, then `/close` | E2E / mechanism-match fail; a decision or deferral |
| Wrap | `/close` | — | auto-invoked by the producer verbs (see `.claude/skills/close/references/auto-close-gate.md`) |

`/project` does the thinking and hands SPEC-writing to `/spec`; `/spec` writes + audits the SPEC and auto-closes. `/implement` builds, audits (`/implement-audit`, the single code reviewer), and auto-closes. Each artifact gets exactly one machine reviewer, fired by its producer, backstopped by the commit-guard's `spec-audit:` / `implement-audit:` trailer gates.

## Tech Stack (Customize for your stack)

This section should document your runtime, orchestration, storage, and credentials. Update these sections based on your actual setup.

## Architecture

| Directory | Purpose |
|---|---|
| `/apps/{name}/` | Apps: README + SPEC + automation scripts. Each is self-contained. |
| `/integrations/{name}/` | External service connectors: README + typed client + auth helpers |
| `/projects/{domain}/` | `YYYY-MM-DD_brief-description/` — multi-session work with status frontmatter |
| `/journal/` | Daily session logs `YYYY-MM-DD.md` with structured frontmatter |
| `/knowledge/{domain}/` | Domain data and reference material. Customize for your needs. |
| `/.claude/` | The AI Layer — rules, skills, agents, hooks |
| `/.githooks/` | Native git hooks firing on every commit |

## Memory

Two layers — git log (commit subjects + structured trailers) for WHAT; journal (Action/Changes/Decisions/Issues/Lessons/Next per day) for WHY.
