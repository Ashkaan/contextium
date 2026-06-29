---
name: explain
description: Deep research into a topic or issue — investigate until confident, then present executive summary and root cause analysis. Use when you need to understand WHY.
argument-hint: "[topic, question, or issue description]"
disable-model-invocation: false
allowed-tools:
  - Bash
  - Read
  - Grep
  - Glob
  - Task
  - WebSearch
  - WebFetch
peers:
  - .claude/agents/research-agent.md
enforces:
  - "@rule:mechanisms-not-prose"
steps:
  - id: step-0-validate-input
    kind: action
    action: If ARGUMENTS empty or vague, ask one clarifying question before launching research.
  - id: step-1-classify-complexity
    kind: action
    action: State Quick | Standard | Deep and a one-sentence restatement of the question.
  - id: step-2-frame
    kind: action
    action: Write INVESTIGATION FRAME (question, type, scope, hypotheses, unknowns) before investigating.
  - id: step-3-research
    kind: action
    action: Execute research — sequential for Standard, multiple research-agent dispatches for Deep — then verify with contradictions resolved.
  - id: step-4-synthesize
    kind: action
    action: Emit Explain output with Executive Summary + Root Cause + Evidence + Implications sections.
---

# Explain — Deep Research & Root Cause Analysis

Investigate a topic until confident in root cause or core understanding. Produce
an actionable executive summary plus deeper analysis.

**Step graph** (mirrors frontmatter `steps:`): step-0-validate-input → step-1-classify-complexity → step-2-frame → step-3-research → step-4-synthesize

## Critical

- **Validate input first.** If `$ARGUMENTS` is empty or too vague, ask ONE clarifying question before launching research. Vague input wastes the research budget on the wrong target.
- **Research until confident, then stop.** The output is understanding, not a fix. If the investigation surfaces a flaw the user will want fixed, say so in Implications and let them decide — don't silently start fixing.

## step-0-validate-input

If `$ARGUMENTS` is empty or too vague, ask ONE clarifying question first. Do not
launch research on an ambiguous target.

## step-1-classify-complexity

- **Quick** — well-scoped factual, single concept. Skip to Step 4 using own
  knowledge + one targeted lookup if needed.
- **Standard** — requires tracing code/docs/external sources; single likely
  answer. Steps 2-4 sequentially.
- **Deep** — cross-cutting, multiple possible causes, systems-level "why".
  Steps 2-4 with multiple research agents, one per hypothesis.

State the classification and a one-sentence restatement before proceeding.

## step-2-frame

```
INVESTIGATION FRAME:
- Question: [precise restatement]
- Type: [concept | root-cause | failure-mode | design-rationale | comparison]
- Scope: [in scope vs out of scope]
- Hypotheses: [1-3 ranked by likelihood]
- Key unknowns: [what confirms/rejects each]
```

If the question references files, a project, or recent work, pull context (read
files, git log) before forming hypotheses.

## step-3-research

### Standard complexity

- **Codebase**: Dispatch the `research-agent` via `Task(subagent_type="research-agent", ...)` with the investigation question + scope hint + hypotheses from Step 2. If the agent-type isn't loaded (fresh-agent-file gap — the harness caches agent names at session start), fall back to `Task(subagent_type="general-purpose", ...)` with the full body of `.claude/agents/research-agent.md` (minus frontmatter) prepended to the prompt. The agent returns structured findings with exact file:line citations; the main conversation synthesizes without absorbing the search traffic.
- **External concepts**: use `WebSearch` / `WebFetch` — external facts are out of the research-agent's scope (it operates on this repo).
- **Runtime behavior**: logs, job history, deployment state — handle in the main conversation, which has the live-system access the agent doesn't.

### Deep complexity

Dispatch 2-3 `research-agent` instances in parallel, each scoped to a different hypothesis/angle from Step 2. Each agent gets one hypothesis to confirm or reject, with a "be specific, cite evidence, stay under 500 words" instruction. Run your own local Grep/Read + git log in parallel so the main conversation isn't idle. When an agent times out or returns nothing, proceed with the remaining sources and name the gap in synthesis — the flow is gap-tolerant by design.

### Verify findings

Check for contradictions across sources. If sources conflict, dispatch a targeted
follow-up research-agent to resolve the specific disagreement — do not guess. If the
topic touches this session's work, run `/implement-audit` to verify against actual state.

## step-4-synthesize

```markdown
## Explain: {TOPIC}

**Complexity**: {quick|standard|deep}

---

### Executive Summary

[2-3 sentences. What is the answer? What should the user do? A busy person
reading only this section should know what matters.]

### Root Cause / Core Concept

[Detailed explanation. For issues: what went wrong and WHY at the deepest level
— not symptoms, not proximate cause, the actual root. For concepts: the mental
model that makes this click. Concrete examples.]

### Evidence

[Bulleted specific evidence: file paths, log entries, code snippets, external
sources. Each item verifiable.]

### Implications

[What follows? What should change? What else is affected? What prevents
recurrence if this is a failure mode?]
```

### Adjustments by complexity

- **Quick**: Skip Evidence/Implications if trivial; exec summary may suffice.
- **Standard**: All sections, concise.
- **Deep**: Add `### Competing Explanations` between Evidence and Implications
  — hypotheses considered and rejected (and why).

## Examples

### Example 1 — Quick concept

User: `/explain what is the difference between a hook and a skill in this repo?` — well-scoped factual, single concept. step-1 classifies as Quick; step-2 frame is one-line; step-3 skips agent dispatch (the answer is in one doc page); step-4 emits a 3-section synthesis (Executive Summary + Core Concept + Implications).

### Example 2 — Standard root-cause

User: `/explain why does the commit gate reject my last three commits?` — requires tracing the gate script + recent commits + the rejected messages. step-1 classifies Standard; step-2 frames hypotheses (subject-format violation, banned token, a dangling `@rule:` ref); step-3 dispatches `research-agent` for the repo trace + reads recent journal entries; step-4 produces full synthesis identifying the proximate cause and the fix.

### Example 3 — Deep cross-cutting

User: `/explain why do new sessions keep missing context that earlier sessions had?` — cross-cutting, multiple plausible causes. step-1 classifies Deep; step-2 frames 3 hypotheses (rules not loaded, journal not written, project README stale); step-3 dispatches three `research-agent` instances (one per hypothesis) plus parallel local Read/Grep; step-4 reconciles and emits synthesis with a Competing Explanations section.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `$ARGUMENTS` is empty or one ambiguous word | User invoked `/explain` without a target | Per step-0, ask ONE clarifying question first. Do NOT pick a target yourself — vague input wastes the research budget. |
| Sources contradict each other in step-3 | Different doc versions, or one source is wrong | Do NOT guess. Dispatch a targeted follow-up `research-agent` scoped to the specific disagreement. Document it in the synthesis's Competing Explanations section. |
| `research-agent` type not found | Session pre-dates the agent file or the harness hasn't auto-loaded it | Fall back to `Task(subagent_type="general-purpose", ...)` with the full agent body prepended to the prompt. |
| A research agent times out or returns nothing | One angle was slow or hit a dead end | Proceed with the remaining sources (gap-tolerant) and name the gap in synthesis. |
| Step classified Deep but the question has one obvious answer | Over-classified the symptom | Reclassify as Standard if one source answers it. Reserve Deep for cross-cutting questions where source diversity changes the answer. |
