<!-- source: github/spec-kit templates/plan-template.md @ v1.0.10, commit b5d97b41a3ad703800179eab0e711c1d7173422e -->
# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` | **Date**: [DATE] | **Spec**: [link]

**Input**: Feature specification from `/specs/[###-feature-name]/spec.md`

**Note**: This template is filled in by the `__SPECKIT_COMMAND_PLAN__` command; its definition describes the execution workflow.

## Summary

[Extract from feature spec: primary requirement + technical approach from research]

<!-- contextium: simplest-shape -->
### Simplest shape

<!--
  CONTEXTIUM: 1-2 sentences on the cheapest viable mechanism considered
  (@rule:simplest-solution-default); cite an existing pattern by name if one
  fits. Required — never removed.
-->

[Simplest shape that could work]

<!-- /contextium -->
## Technical Context

<!--
  ACTION REQUIRED: Replace the content in this section with the technical details
  for the project. The structure here is presented in advisory capacity to guide
  the iteration process.
-->

**Language/Version**: [e.g., Python 3.11, Swift 5.9, Rust 1.75 or NEEDS CLARIFICATION]

**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]

**Storage**: [if applicable, e.g., PostgreSQL, CoreData, files or N/A]

**Testing**: [e.g., pytest, XCTest, cargo test or NEEDS CLARIFICATION]

**Target Platform**: [e.g., Linux server, iOS 15+, WASM or NEEDS CLARIFICATION]

**Project Type**: [e.g., library/cli/web-service/mobile-app/compiler/desktop-app or NEEDS CLARIFICATION]

**Performance Goals**: [domain-specific, e.g., 1000 req/s, 10k lines/sec, 60 fps or NEEDS CLARIFICATION]

**Constraints**: [domain-specific, e.g., <200ms p95, <100MB memory, offline-capable or NEEDS CLARIFICATION]

**Scale/Scope**: [domain-specific, e.g., 10k users, 1M LOC, 50 screens or NEEDS CLARIFICATION]

<!-- contextium: inputs-outputs -->
**Inputs**: [for code: trigger, schedule, params, where credentials come from; otherwise the files, surfaces or data read or operated on]

**Outputs**: [for code: writes, stdout shape, side effects; otherwise the artifacts produced (paths), the schemas they follow, and any commit, push or deploy]

### Data sourcing

<!--
  CONTEXTIUM: REQUIRED when the work reads any external or repo data;
  otherwise `N/A — reads nothing`, and never removed. One row per input, filled
  BEFORE a transport is chosen, so the choice is made per input rather than
  inherited from a neighbour. Data is fetched, judgment is prompted: an
  authoritative deterministic source (an API, a file, a computation) beats a
  model call. Prefer an API over a shell on the remote host; a row choosing SSH
  says why no API exists — verified absent, not assumed. A path an automation
  both reads and writes is read from the place it writes, because a read that
  fails returns empty and a read-then-write commits that emptiness over real
  data.
-->

| What | Where it canonically lives | Candidate transports | Chosen + why |
|---|---|---|---|
| [input] | [URL / repo path / table / host] | [API / file / SSH / bundled] | [chosen] — [why the others don't fit] |

<!-- /contextium -->
## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

[Gates determined based on constitution file]

<!-- contextium: constitution -->
<!--
  CONTEXTIUM: the constitution is `.agents/AGENTS.md` plus the rules in
  `.agents/rules/`; spec-kit's `constitution.md` is not used. Write one line per
  rule this plan touches, PASS or the violation. The audit's verdict is a line
  here too, written by /spec-audit over the placeholder below: it carries the
  reviewer round and the spirit-check's result, which reads only the Input's
  verbatim words and spec.md's stories and requirements and flags shape, scope
  or vocabulary drift. Drift is fixed, or justified under Complexity Tracking;
  never ignored. The line is a record, not a gate on any commit.
-->

- [@rule:<id> from .agents/rules/]: [PASS | the violation]
- spec-audit: [written by /spec-audit through write-audit-line.sh — leave this item in place]

<!-- /contextium -->
## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (__SPECKIT_COMMAND_PLAN__ command output)
├── research.md          # Phase 0 output (__SPECKIT_COMMAND_PLAN__ command)
├── data-model.md        # Phase 1 output (__SPECKIT_COMMAND_PLAN__ command)
├── quickstart.md        # Phase 1 output (__SPECKIT_COMMAND_PLAN__ command)
├── contracts/           # Phase 1 output (__SPECKIT_COMMAND_PLAN__ command)
└── tasks.md             # Phase 2 output (__SPECKIT_COMMAND_TASKS__ command - NOT created by __SPECKIT_COMMAND_PLAN__)
```

### Source Code (repository root)
<!--
  ACTION REQUIRED: Replace the placeholder tree below with the concrete layout
  for this feature. Delete unused options and expand the chosen structure with
  real paths (e.g., apps/admin, packages/something). The delivered plan must
  not include Option labels.
-->

```text
# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)
src/
├── models/
├── services/
├── cli/
└── lib/

tests/
├── contract/
├── integration/
└── unit/

# [REMOVE IF UNUSED] Option 2: Web application (when "frontend" + "backend" detected)
backend/
├── src/
│   ├── models/
│   ├── services/
│   └── api/
└── tests/

frontend/
├── src/
│   ├── components/
│   ├── pages/
│   └── services/
└── tests/

# [REMOVE IF UNUSED] Option 3: Mobile + API (when "iOS/Android" detected)
api/
└── [same as backend above]

ios/ or android/
└── [platform-specific structure: feature modules, UI flows, platform tests]
```

**Structure Decision**: [Document the selected structure and reference the real
directories captured above]

<!-- contextium: patterns -->
### Patterns to follow

<!--
  CONTEXTIUM: the existing code this work mirrors, each with `file:line`
  and the actual snippet — naming, error handling, tests. `N/A — <reason>` when
  nothing is written in code.
-->

```text
// SOURCE: [file:lines]
[actual snippet]
```

<!-- /contextium -->
## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| [e.g., 4th project] | [current need] | [why 3 projects insufficient] |
| [e.g., Repository pattern] | [specific problem] | [why direct DB access insufficient] |
<!-- contextium: failure-modes -->
### Failure modes

<!--
  CONTEXTIUM: what can go wrong and how the system surfaces it — alert
  path, retry, fallback, or the check that catches drift. A row naming a repo
  path cites `file:line`.
-->

| Failure | How it surfaces |
|---|---|
| [failure] | [alert / check / symptom] |

<!-- /contextium -->
<!-- contextium: validation -->
## Validation Commands

<!--
  CONTEXTIUM: the project's own commands that prove this work — type check or
  lint, tests, and any end-to-end check — each runnable from the repo root as
  written. /implement runs every line here before it reports; a line that
  cannot run is a finding, not a skip. Delete the lines that do not apply.
-->

```bash
# Static checks (type check, lint) for the files this work touches
[e.g. npm run check | ruff check <files> | shellcheck <files>]
# Tests
[e.g. npm test | pytest tests/ | bash path/to/script.test.sh]
# End-to-end — the real behavior, with its expected output
[command]   # expected: [output]
```

<!-- /contextium -->
