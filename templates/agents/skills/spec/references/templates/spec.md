<!-- source: github/spec-kit templates/spec-template.md @ v1.0.10, commit b5d97b41a3ad703800179eab0e711c1d7173422e -->
# Feature Specification: [FEATURE NAME]

**Feature Branch**: `[###-feature-name]`

**Created**: [DATE]

**Status**: Draft

**Input**: User description: "$ARGUMENTS"

<!-- contextium: header -->
**Type**: [NEW_CAPABILITY | ENHANCEMENT | REFACTOR | BUG_FIX | AUDIT]

**Complexity**: [LOW | MEDIUM | HIGH]

**Systems Affected**: [the code, docs, rules or records this touches]

**Roadmap**: [ROADMAP.md](../../ROADMAP.md) row [R#] — [Sub-feature]

<!--
  CONTEXTIUM: **Input** holds the user's words VERBATIM — every quoted turn that
  shaped this spec, in order, dated — never a paraphrase; it is what the finished
  work is checked against. **Roadmap** points back at the parent row, per
  spec-kit's spec-of-specs. Input is never removed.
-->

## Clarifications

<!--
  CONTEXTIUM: open with 2-3 sentences on how we interpreted the ask, then
  one Session per day the grill ran, holding its decision ledger — one row per
  decision, including the ones adopted without asking. The Rejected column is
  what stops a later session re-litigating a settled choice. User's words is
  the user's reply exactly as typed, dated and quoted the way decisions/README.md
  requires of an accepted record: "1) a" stays "1) a", and Chosen carries the
  option's text beside it, which is the AI's wording and never the user's —
  a reviewer that sees "1) a" without its option cannot check any decision
  built on it. A row whose Source is `user` without a quote is not a decision
  the user made on the record. A question asked and answered may also be written as spec-kit's clarify bullet,
  `- Q: <question> → A: <final answer>`. When no grill ran this section reads
  `N/A — no grill (ad-hoc spec)`; it is never removed. Any item still open
  stays in the spec as `[NEEDS CLARIFICATION: …]` where it belongs; no
  `/implement` runs while one remains. This sentence lives in a comment because
  .agents/skills/close/scripts/open-clarifications.ts counts the marker anywhere outside
  one: written as prose, a filled spec reports itself open.
-->

[How we interpreted this, in 2-3 sentences]

### Session YYYY-MM-DD

| Decision | Chosen | Source | User's words | Rejected + why |
|---|---|---|---|---|
| [the choice in plain English] | [the option picked, in the option's own wording — the AI's words] | user \| adopted (recommendation) \| adopted (user waved off) \| adopted (ceiling) | [`Your Name YYYY-MM-DD: "<the reply, exactly as typed>"`, or `—` when adopted] | [the alternative and why it lost] |

<!-- /contextium -->
## User Scenarios & Testing *(mandatory)*

<!-- contextium: behavior -->
<!--
  CONTEXTIUM: the behavior contract lives here and in Requirements — the
  stories say what the work does and for whom, the FR-### lines say what must be
  true. For non-app work (an audit, a rule edit, a reorganisation) a story is
  the artifact produced and what success looks like.
-->

<!-- /contextium -->
<!--
  IMPORTANT: User stories should be PRIORITIZED as user journeys ordered by importance.
  Each user story/journey must be INDEPENDENTLY TESTABLE - meaning if you implement just ONE of them,
  you should still have a viable MVP (Minimum Viable Product) that delivers value.

  Assign priorities (P1, P2, P3, etc.) to each story, where P1 is the most critical.
  Think of each story as a standalone slice of functionality that can be:
  - Developed independently
  - Tested independently
  - Deployed independently
  - Demonstrated to users independently
-->

### User Story 1 - [Brief Title] (Priority: P1)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently - e.g., "Can be fully tested by [specific action] and delivers [specific value]"]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]
2. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 2 - [Brief Title] (Priority: P2)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

### User Story 3 - [Brief Title] (Priority: P3)

[Describe this user journey in plain language]

**Why this priority**: [Explain the value and why it has this priority level]

**Independent Test**: [Describe how this can be tested independently]

**Acceptance Scenarios**:

1. **Given** [initial state], **When** [action], **Then** [expected outcome]

---

[Add more user stories as needed, each with an assigned priority]

### Edge Cases

<!-- contextium: boundaries -->
<!--
  CONTEXTIUM: cover every boundary shape (AGENTS.md § Standards → Plan the four before building) — 0 / empty,
  1, empty / null, max, error / invalid — one bullet each, or `N/A — <reason>`.
  A bullet describing existing code cites `file:line`, read, not remembered.
-->

<!-- /contextium -->
<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right edge cases.
-->

- What happens when [boundary condition]?
- How does system handle [error scenario]?

## Requirements *(mandatory)*

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right functional requirements.
-->

### Functional Requirements

- **FR-001**: System MUST [specific capability, e.g., "allow users to create accounts"]
- **FR-002**: System MUST [specific capability, e.g., "validate email addresses"]
- **FR-003**: Users MUST be able to [key interaction, e.g., "reset their password"]
- **FR-004**: System MUST [data requirement, e.g., "persist user preferences"]
- **FR-005**: System MUST [behavior, e.g., "log all security events"]

*Example of marking unclear requirements:*

- **FR-006**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method not specified - email/password, SSO, OAuth?]
- **FR-007**: System MUST retain user data for [NEEDS CLARIFICATION: retention period not specified]

### Key Entities *(include if feature involves data)*

- **[Entity 1]**: [What it represents, key attributes without implementation]
- **[Entity 2]**: [What it represents, relationships to other entities]

## Success Criteria *(mandatory)*

<!--
  ACTION REQUIRED: Define measurable success criteria.
  These must be technology-agnostic and measurable.
-->

### Measurable Outcomes

- **SC-001**: [Measurable metric, e.g., "Users can complete account creation in under 2 minutes"]
- **SC-002**: [Measurable metric, e.g., "System handles 1000 concurrent users without degradation"]
- **SC-003**: [User satisfaction metric, e.g., "90% of users successfully complete primary task on first attempt"]
- **SC-004**: [Business metric, e.g., "Reduce support tickets related to [X] by 50%"]

<!-- contextium: acceptance -->
### Acceptance

<!--
  CONTEXTIUM: the command, or short sequence, that demonstrates the work
  is done, with its expected output inline. It is what the Measurable Outcomes
  above are checked by; for non-app work it may be a file check, a grep count or
  a manual step with a precise expected result.
-->

```bash
[command]   # expected: [output]
```

<!-- /contextium -->
## Assumptions

<!--
  ACTION REQUIRED: The content in this section represents placeholders.
  Fill them out with the right assumptions based on reasonable defaults
  chosen when the feature description did not specify certain details.
-->

- [Assumption about target users, e.g., "Users have stable internet connectivity"]
- [Assumption about scope boundaries, e.g., "Mobile support is out of scope for v1"]
- [Assumption about data/environment, e.g., "Existing authentication system will be reused"]
- [Dependency on existing system/service, e.g., "Requires access to the existing user profile API"]
