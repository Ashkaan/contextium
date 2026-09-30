---
name: explain
description: Deep research into a topic or issue — investigates until confident, then presents an executive summary and root-cause analysis. Use when you need to understand WHY something happens. Takes [topic, question, or issue description].
allowed-tools: Bash Read Grep Glob Task WebSearch WebFetch AskUserQuestion
metadata:
  peers: ".agents/agents/research-agent.md .agents/skills/explain/scripts/parallel-research.ts .agents/skills/debate/scripts/dispatch-agents.ts .agents/skills/review/policy.json .agents/skills/implement/SKILL.md"
---

# Explain — Deep Research & Root Cause Analysis

Investigate a topic until confident in root cause or core understanding. Produce
an actionable executive summary plus deeper analysis.

**Steps:** step-0-validate-input → step-1-classify-complexity → step-2-frame → step-3-research → step-4-synthesize → step-5-next-action-gate

## Critical

- **Validate input first.** If `$ARGUMENTS` is empty or too vague, ask ONE clarifying question before launching research. Vague input wastes parallel-agent budget on the wrong target.
- **A class-level flaw becomes work, by default.** If the explanation identifies a flaw in a shared mechanism (one affecting several files), the Step 5 question's default option is "Ship class fix now" per `AGENTS.md § Standards → A class fix is atomic`. Do NOT silently end at explanation — surface the chain.

## step-0-validate-input

If `$ARGUMENTS` is empty or too vague, ask ONE clarifying question first. Do not
launch research on an ambiguous target.

## step-1-classify-complexity

- **Quick** — well-scoped factual, single concept. Skip to Step 4 using own
  knowledge + one targeted lookup if needed.
- **Standard** — requires tracing code/docs/external sources; single likely
  answer. Steps 2-4 sequentially.
- **Deep** — cross-cutting, multiple possible causes, systems-level "why".
  Steps 2-4 with parallel research agents.

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
files, git log). If it references a production incident, gather the same context
you would to explain it — logs, the recent diff, the alert itself — but do not
start fixing: this skill's job is to say WHY, and the fix is a separate decision
someone should make with the explanation in hand.

## step-3-research

### Standard complexity

- **Codebase**: Dispatch a fresh-context research agent with the investigation question + scope hint + hypotheses from Step 2. In Claude Code that is `Task(subagent_type="research-agent", ...)`; if the agent-type is not loaded (it caches agent names at session start) or you are in a tool with no subagents, prepend the body of `.agents/agents/research-agent.md` (minus frontmatter) to the prompt and run it as an ordinary fresh-context investigation. Either way it returns structured findings with exact file:line citations, so the main conversation synthesizes without absorbing the search traffic.
- **External concepts**: use WebSearch/WebFetch. These are out of the `research-agent`'s scope — it reads this repo, not the internet. When you already know the URL, fetch it with `curl` and read the page yourself: WebFetch answers through a small summarizing model, and per `AGENTS.md § Standards → Read before asserting` a model's summary of a page is a claim, not a reading.
- **Runtime behavior**: logs, job history, deployment state — handled in the main conversation, which has the credentials and live-system access the agent does not.

### Deep complexity

Launch 2-3 parallel research sources, each on a different hypothesis. Different models are worth more than one model asked three times — a model asked the same question three ways tends to agree with itself. `scripts/parallel-research.ts` seats the three voices of the `panel` row of `.agents/skills/review/policy.json` — the same three `/debate` seats — and runs them through `/debate`'s `dispatch-agents.ts`, so a seat whose CLI is missing or fails is argued by another voice. It warns when fewer than three panel CLIs are installed, so it still runs on a single-model machine, just with less independence between the three answers. You MAY replace one seat with the in-repo `research-agent` for focused code tracing.

Invoke the parallel-research script — it owns the parallel CLI orchestration, per-source 120s timeout, partial-success collection, and 10KB output cap:

```bash
node --experimental-strip-types .agents/skills/explain/scripts/parallel-research.ts \
  --h1 "Investigate: {H1}. Specific, cite evidence, <500 words." \
  --h2 "Investigate: {H2}. Specific, cite evidence, <500 words." \
  --h3 "Investigate: {H3}. Specific, cite evidence, <500 words." \
  --timeout 120
```

Read the SUMMARY line at the end to see how many sources returned cleanly; the script emits each result block prefixed by the CLI name — and a `(… stood in for …)` line when another voice argued that seat — so synthesis can attribute claims. Proceed with remaining sources if one fails (gap-tolerant by design). Run local research (Grep/Read, git log) in parallel — or dispatch the `research-agent` if the investigation is deep enough in the repo that the caller shouldn't absorb the search traffic.

### Verify findings

Check for contradictions across sources. If sources conflict, launch targeted
research agents to resolve — do not guess. If the topic touches this session's
work, use `/implement-audit` to verify against actual state.

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

## step-5-next-action-gate

If the explanation identified a **class-level design flaw** (a mechanism
affecting multiple files/scripts — not just the presenting symptom), the
default next action is to fix it in the same session and ship
the full class fix now per `AGENTS.md § Standards → A class fix is atomic`. Do NOT recommend
"minimum fix + defer class fix to a project" as a model-initiated path.
That pattern is what produces the same bug three days running: the symptom gets
patched, the mechanism does not, and the next sibling fails next.

Before stopping at explanation, ask the user (a numbered list, recommendation
first; in Claude Code, `AskUserQuestion`):

- **Ship class fix now** (default) — fix every instance this session per `AGENTS.md § Standards → A class fix is atomic`, starting from the root
  cause already identified; all peers ship this session
- **Explain only, no fix** — user has other priorities; explanation is
  the output
- **Defer with reason** — user-initiated; requires a reason, and the work
  becomes a row in the project's `ROADMAP.md` so it is not lost

If the explanation was for a concept, design rationale, or research question
(not a class-level bug), Step 5 is "ready for next question" — no fix
chaining needed.

## Examples

### Example 1 — Quick concept

User: `/explain what is the difference between a queue worker and a scheduled job in our runner?` — well-scoped factual, single concept. step-1 classifies as Quick; step-2 frame is one-line; step-3 skips the parallel-research script (the answer is in one doc page); step-4 emits a 3-section synthesis (Executive Summary + Core Concept + Implications).

### Example 2 — Standard root-cause

User: `/explain why is the budget alert firing every hour for the last 3 days?` — requires tracing logs + recent commits + alert config. step-1 classifies Standard; step-2 frames hypotheses (cron drift, threshold change, data source change); step-3 dispatches `research-agent` for repo trace + reads recent journal entries; step-4 produces full synthesis identifying the proximate cause. If the cause is a class flaw (e.g., alert threshold logic shared by 4 other alerts), step-5 default = "Ship class fix now", and all five call sites are fixed this session.

### Example 3 — Deep cross-cutting

User: `/explain why does our deploy keep failing on the step that copies files to the server?` — cross-cutting, multiple plausible causes. step-1 classifies Deep; step-2 frames 3 hypotheses (a network path that is not open, a rotated credential, a key format the server rejects); step-3 invokes `scripts/parallel-research.ts` with H1/H2/H3 prompts mapped to each hypothesis, plus parallel local Read/Grep; step-4 reconciles and emits synthesis with Competing Explanations section; step-5 offers to ship the class fix when one is identified.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `$ARGUMENTS` is empty or one ambiguous word | User invoked `/explain` without a target | Per step-0, ask ONE clarifying question first. Do NOT pick a target yourself — vague input wastes parallel-research budget. |
| Sources contradict each other in step-3 | Different model recall, different doc versions, or one source is wrong | Do NOT guess. Launch a targeted secondary research call (single-source) or dispatch `research-agent` to resolve. Document the contradiction in the synthesis's Competing Explanations section. |
| Fewer than three model CLIs installed | One or two of the `panel` row's CLIs are on PATH | The script still runs — the dispatcher has an installed voice argue the missing seat — and warns; say in the synthesis that the answers are less independent. With no panel CLI at all it exits 1 — investigate the hypotheses yourself. |
| Parallel-research script times out | One CLI is unusually slow (or model auto-routing is degraded) | Increase `--timeout` (max 600). For repeatedly slow sources, consider swapping that CLI for the in-repo `research-agent` per Step 3 Deep guidance. |
| Step 5 defaulted to shipping a class fix when no class flaw exists | step-4 over-classified the symptom as class-level | Re-read the synthesis; if only a single file/script is affected, change the question's default to "Explain only, no fix" — don't synthesize a class fix where none exists. |
| Parallel-agent cost is too high | Deep complexity is expensive (~$0.20-0.40 per invocation) | Reclassify as Standard if the question can be answered with one source. Reserve Deep for cross-cutting questions where source diversity changes the answer. |
