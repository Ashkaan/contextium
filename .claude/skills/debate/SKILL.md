---
name: debate
description: Adversarial debate — dispatch competing review agents to argue a question from independent sides, then synthesize the strongest conclusion. Use when the user says "debate this", "I'm torn between X and Y", "red-team this plan", or "council on this".
disable-model-invocation: true
argument-hint: "[question] [--format dialectic|redteam|council]"
allowed-tools:
  - Read
  - Task
  - AskUserQuestion
peers:
  - .claude/skills/probe/SKILL.md
  - .claude/skills/explain/SKILL.md
enforces:
  - "@rule:mechanisms-not-prose"
  - "@rule:depth-policy"
steps:
  - id: step-1-parse-input
    kind: gate
    gate:
      tool: AskUserQuestion
      on_fail: continue
      condition: Fires only when the question is unclear or too vague to debate. Otherwise extract question + auto-detect format + assemble the shared context block.
  - id: step-2-dispatch-agents
    kind: action
    action: Dispatch one fresh-context agent per role with the shared context + that role's argue-this-side brief. Collect each agent's structured position.
  - id: step-3-synthesize
    kind: action
    action: Read every agent's output and produce the structured synthesis — judgment, not summarization. Name failed agents in the Gaps section.
  - id: step-4-optional-round-2
    kind: action
    action: If the user asks for another round, re-dispatch agents with rebuttal briefs and re-synthesize. Capped at 3 rounds; round 3 fires AskUserQuestion (ship | redesign | defer).
---

# Debate — Multi-Agent Adversarial Reasoning

Dispatch 2-3 fresh-context agents with competing perspectives on a question, collect
their arguments, and synthesize the strongest conclusion.

**Step graph** (mirrors frontmatter `steps:`): step-1-parse-input → step-2-dispatch-agents → step-3-synthesize → step-4-optional-round-2

## Critical

- **Synthesis (step-3) is where the value is — don't just summarize.** Read every agent's output, identify genuine tensions, name what they agree on. The orchestrator's authorship of the synthesis IS the skill; if all you do is concatenate, you wasted the dispatch.
- **Gaps MUST be named when an agent fails.** If an agent never returns (timeout, error), the Gaps section MUST say "The {role} agent failed. Synthesis reflects N of M positions — the {role} side may be underrepresented." Do not silently emit a 2-agent synthesis labeled 3-agent.
- **Cap at 3 rounds per ship.** Round 3 MUST invoke `AskUserQuestion` (ship | redesign | defer) before proceeding. Round 4+ is forbidden — diminishing returns turn negative.

## step-1-parse-input

Extract the question from `$ARGUMENTS`. Parse the optional `--format` flag:

- `dialectic` (default) — two roles, FOR and AGAINST a position.
- `redteam` — two roles, advocate and critic of a plan/proposal.
- `council` — three roles, each taking a distinct angle on an open-ended question.

Auto-detect format if not specified:
- Binary choice / "X or Y" / "X vs Y" → **dialectic**
- Evaluating a plan/proposal/design → **redteam**
- Open-ended, multi-dimensional → **council**

If the question is unclear or too vague, ask ONE clarifying question first.

### Context Scaffold

Before dispatching, assemble a context block every agent will share. If the user gave a
bare question, check whether it references a known project/file/decision and pull key
facts. Structure (keep under 200 words):

```
CONTEXT FOR DEBATE:
- Decision: [one sentence framing the choice]
- Constraints: [timeline, budget, dependencies, blockers]
- Stakes: [what's at risk if the wrong choice is made]
- Current leaning: [user's position, if any — agents should challenge this]
```

The point of a single shared block is that every agent argues from the same facts, so
divergence reflects reasoning, not different starting information.

## step-2-dispatch-agents

Dispatch one fresh-context agent per role using the Agent tool. There is no dispatch
script — you assemble each role's brief inline and call `Task` once per role. Run the
dispatches in parallel (issue them in one batch). A general-purpose agent is the right
subagent type here; the role comes from the brief, not the agent's identity.

Each role brief contains:

1. The shared CONTEXT FOR DEBATE block from step-1.
2. The role assignment and the side to argue. By format:
   - **dialectic**: agent A argues FOR the position, agent B argues AGAINST.
   - **redteam**: agent A is the advocate (defend the plan), agent B is the critic (find the fatal flaw).
   - **council**: each of the three agents takes one named angle (e.g. cost, correctness, maintainability).
3. A steel-man instruction: argue the strongest version of your side, and end with the
   single best argument against your own position.
4. The required output schema so synthesis can parse uniformly:

```markdown
## Position
[the core argument, strongest form]
## Key Points
[3-5 numbered points]
## Acknowledged Weaknesses
[the best argument against this position]
```

Collect each agent's returned block. If an agent errors or times out, record it as a gap
for step-3; proceed with the rest (partial success is acceptable — a 2-of-3 synthesis is
fine as long as the gap is named).

## step-3-synthesize

Read each agent's `## Position` ... `## Acknowledged Weaknesses` block. Then produce a
structured synthesis. Do NOT just summarize — add analytical value:

```markdown
## Debate: {QUESTION}

**Format**: {format} | **Agents**: {N roles}

---

### Debate Summary
[One paragraph: what was argued, where agents diverged]

### Strongest Arguments
[3-5 best points from ANY side, attributed to which agent made them]

### Points of Agreement
[Where agents converge — these are likely true]

### Key Tensions
[Genuine tradeoffs that remain — these are the decision points. Present each
as a named tension with both sides. This is the core output.]

### If Forced to Pick
[One-paragraph recommendation with confidence: high/moderate/low. Frame as
"given X assumptions, Y is stronger because Z" — not a directive]

### Strongest Counter
[The best argument against the "if forced to pick" position — steel-man the
other side]

### Gaps (if any)
[Name each failed agent: "The critic agent failed (timeout). Synthesis reflects
1 of 2 positions — the critic side may be underrepresented." Omit if all succeeded.]
```

## step-4-optional-round-2

If the user says "another round", "go deeper", or "rebut":

Build a rebuttal brief for each agent — give it the OTHER agents' positions from round 1
and ask it to rebut, then state what argument it now finds most underweighted, then give
a revised position. Re-dispatch (one `Task` per role), collect, and re-synthesize.

After collecting rebuttals, update Key Tensions and "If Forced to Pick" if the rebuttals
exposed genuine weaknesses, or reinforce them if they didn't land. Note what changed.

**Cap: 3 rounds total.** Round 3 MUST invoke `AskUserQuestion` (ship | redesign | defer)
before proceeding. Round 4+ is forbidden.

## Examples

### Example 1 — Dialectic on a binary choice

User: `/debate Should we keep the rule set lean or add a rule for every recurring nit?` — binary; auto-detected as **dialectic**. step-2 dispatches two agents: one argues FOR a minimal rule set, one argues FOR comprehensive rules, each from the shared context block. Both return the `## Position` schema. step-3 synthesis emits Strongest Arguments + Points of Agreement (both agreed a rule with no mechanism is noise) + Key Tensions (coverage vs. attention cost) + "If Forced to Pick: lean set, moderate confidence, because every loaded rule costs attention per @rule:simplest-solution-default". Strongest Counter: "if corrections recur and aren't written down, the same mistake repeats."

### Example 2 — Redteam on a proposal with fatal-flaw output

User: `/debate red-team this plan: stand up a long-running daemon so other scripts can request a git commit`. Auto-detected as **redteam**. step-2 dispatches an advocate agent and a critic agent. step-3 synthesis shows the Critic's Fatal Flaw: "the need is shared commit logic — a small shared function does this; a daemon with auth, allowlists, and lifecycle management is far heavier than the requirement per @rule:simplest-solution-default." Advocate's strongest counter: "future callers might need a network boundary." Synthesis weighs it: the critic wins; recommendation is the shared function, not the daemon.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| An agent never returns | Timeout or dispatch error | Record it as a gap; synthesis names it in the Gaps section. To retry, re-invoke `/debate` with the same question. |
| `council` requested but only two angles make sense | The question isn't actually 3-dimensional | Switch to `dialectic` — two perspectives suffice. Don't pad a third agent with a redundant angle. |
| Round 3 attempted without `AskUserQuestion` gate | Recursion-cap violation | Hard stop. Fire AskUserQuestion (ship | redesign | defer). Do not auto-continue. |
| All agents fail | Every dispatch errored | Halt the skill. Surface the failure to the user; do NOT emit a synthesis with zero inputs. |
| Synthesis reads like a summary | Skipped the judgment work in step-3 | Re-do step-3: name the tensions, take a position in "If Forced to Pick", steel-man the counter. Concatenation is not synthesis. |
