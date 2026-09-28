---
name: debate
description: Adversarial debate — spawns competing AI agents to argue a question, then synthesizes the strongest conclusion. Use when the user says "debate this", "I'm torn between X and Y", "red-team this plan", or "council on this". Takes [question] [--format dialectic|redteam|council] [--agents 2|3].
allowed-tools: Bash Read AskUserQuestion
metadata:
  peers: ".agents/skills/debate/scripts/build-agent-prompts.sh .agents/skills/debate/scripts/dispatch-agents.sh .agents/skills/debate/scripts/parse-agent-output.sh .agents/skills/implement-audit/SKILL.md .agents/skills/explain/SKILL.md"
---

# Debate — Multi-Agent Adversarial Reasoning

Spawn 2-3 AI agents with competing perspectives on a question, collect their
arguments, and synthesize the strongest conclusion.

**Steps:** step-1-parse-input → step-2-build-prompts → step-3-dispatch-agents → step-4-synthesize → step-5-optional-round-2

## Critical

- **Synthesis (step-4) is where the value is — don't just summarize.** Read every agent's output, identify genuine tensions, name what they agree on. The orchestrator's authorship of the synthesis IS the skill; if all you do is concatenate, you wasted the cost.
- **Gaps MUST be named when an agent fails.** `.gap` files written by `dispatch-agents.sh` mean an agent never returned; the Gaps section MUST surface "Agent X failed (timeout/rate-limit). Synthesis reflects N of M — the {role} position may be underrepresented." Do not silently emit a 2-agent synthesis labeled 3-agent.
- **Stop when a round adds nothing.** Per `@rule:adversarial-recursion-cap`, the loop ends on the work: a round that surfaces no argument already on the table is the last one. There is no round number to hit and no question to fire — rounds here are requested by the user in the first place.

## step-1-parse-input

Extract the question from `$ARGUMENTS`. Parse optional flags:

- `--format`: `dialectic` (default), `redteam`, `council`
- `--agents`: `2` (default) or `3` — how many seats the debate has. WHO fills them is decided at dispatch by which model CLIs you have installed, not here.

Auto-detect format if not specified:
- Binary choice / "X or Y" / "X vs Y" → **dialectic**
- Evaluating a plan/proposal/design → **redteam**
- Open-ended, multi-dimensional → **council**

If the question is unclear or too vague, ask ONE clarifying question first.

### Context Scaffold

Before building prompts, assemble a context block. If the user gave a bare
question, check whether it references a known project/file/decision and pull
key facts. Structure:

```
CONTEXT FOR DEBATE:
- Decision: [one sentence framing the choice]
- Constraints: [timeline, budget, dependencies, blockers]
- Stakes: [what's at risk if the wrong choice is made]
- Current leaning: [user's position, if any — agents should challenge this]
```

Save this block to a temp file and pass it as `--context-file` to the build
script — every agent argues from the same facts. Keep under 200 words.

## step-2-build-prompts

Invoke the build script — it owns the role-template SSOT for the three
formats × seat-count × N-role matrix:

```bash
bash "${CLAUDE_PROJECT_DIR}/.agents/skills/debate/scripts/build-agent-prompts.sh" \
  --question "$QUESTION" \
  --format "$FORMAT" \
  --agents "$AGENTS" \
  --context-file "$CTX_FILE"   # optional
# stdout: prompts_dir=/tmp/debate-prompts-XXXXXX
```

The format auto-detection decision tree stays in `step-1-parse-input` above;
the per-role role assignment + steel-man instruction + output schema all
live inside the script's heredocs (SSOT per `@rule:single-source-of-truth`).

## step-3-dispatch-agents

Run the dispatch script. It fills the seats from whatever model CLIs are on
PATH, owns the per-CLI flag shapes, the 120s per-agent timeout, and the parallel
orchestration.

**Different models are the point.** Two seats filled by the same model agree with
each other for reasons that have nothing to do with the question. The script uses
different CLIs when you have them (`codex`, `gemini`, `grok` are recognised) and
falls back to repeating the one you do have, warning as it goes. It never refuses
to run for want of a second vendor — a single-model debate is weaker, not
worthless, and it is what most installs will do:

```bash
bash "${CLAUDE_PROJECT_DIR}/.agents/skills/debate/scripts/dispatch-agents.sh" \
  --prompts-dir "$PROMPTS_DIR" \
  --agents "$AGENTS" \
  --timeout-s 120
# stdout: output_dir=/tmp/debate-outputs-XXXXXX
# stderr: per-failed-agent summary lines
```

The script writes one `.output` file per successful agent and one `.gap` file
per failed agent under the output dir. Exit non-zero only when ALL agents
failed (gap-tolerant per `## Critical` — partial-success is the design).

## step-4-synthesize

Read the cleaned agent blocks from the parse script — it strips Codex header/footer
noise and extracts the structured `## Position`...`## Acknowledged Weaknesses`
block from each `.output` file:

```bash
bash "${CLAUDE_PROJECT_DIR}/.agents/skills/debate/scripts/parse-agent-output.sh" \
  --output-dir "$OUTPUT_DIR"
# stdout: cleaned blocks delimited by `=== <role> ===`
```

Then produce a structured synthesis. Do NOT just summarize — add analytical value:

```markdown
## Debate: {QUESTION}

**Format**: {format} | **Seats**: {n} | **Filled by**: {which CLIs actually answered}

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
[Surface each `.gap` file from the output dir. Explicit: "Gemini failed
in Round 2 (rate limit). Synthesis reflects 2 of 3 — the {role} position may
be underrepresented." Omit entirely if all agents succeeded.]
```

## step-5-optional-round-2

If the user says "another round", "go deeper", or included `--rounds 2`:

Build a rebuttal prompt for each agent (`--rounds 2` schema uses
`## Rebuttal` / `## Underweighted Argument` / `## Revised Position` per
`parse-agent-output.sh --round 2`). Save to a fresh prompts dir, then:

```bash
bash "${CLAUDE_PROJECT_DIR}/.agents/skills/debate/scripts/dispatch-agents.sh" \
  --prompts-dir "$ROUND2_PROMPTS_DIR" \
  --agents "$AGENTS"
bash "${CLAUDE_PROJECT_DIR}/.agents/skills/debate/scripts/parse-agent-output.sh" \
  --output-dir "$ROUND2_OUTPUT_DIR" \
  --round 2
```

After collecting rebuttals, re-synthesize: update Key Tensions and "If Forced
to Pick" if rebuttals exposed genuine weaknesses, or reinforce them if they
didn't land. Note what changed.

**Stop on a round that adds nothing.** Per `@rule:adversarial-recursion-cap`,
the loop ends on the work rather than at a round number, and fires no
question — the user asked for these rounds.

## Examples

### Example 1 — Dialectic on a binary choice

User: `/debate should we move off our current job runner onto a managed one?` — binary X-vs-Y, auto-detected as **dialectic**. The build script emits `thesis.prompt` (FOR moving) and `antithesis.prompt` (AGAINST). Dispatch runs them in parallel on whatever model CLIs are installed; with one model CLI present, it fills both seats and the run says so. Synthesis emits Strongest Arguments, Points of Agreement (both agents accepted that the current runner's known bug is real), Key Tensions (migration cost against correctness), and "If forced to pick: move, moderate confidence." Strongest counter: "if the team already knows how to operate the current one and the bug is fixable, moving is over-investment."

### Example 2 — Redteam on a proposal with fatal-flaw output

User: `/debate red-team this plan: stand up an HTTP service with bearer auth so our other scripts can ask it to commit to the repo`. Auto-detected as **redteam**, which is structurally 2-role, so the build emits `advocate.prompt` + `critic.prompt`. With two different model CLIs installed they take one seat each, which is where this format earns its keep. Synthesis shows the critic's fatal flaw: "the actual need is shared command execution — a 30-line function does this; a service with TLS, auth, an allowlist and cleanup is over-engineered by two orders of magnitude." The advocate's strongest counter is "other scripts might need it later." The critic wins; the recommendation is the shared function.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| `dispatch-agents.sh` reports an agent timeout | Real CLI took >120s (rare but happens under load or slow model auto-routing) | The `.gap` file records the timeout; synthesis names it in the Gaps section. To retry, re-invoke `/debate` with the same question + a larger `--timeout-s`. |
| A CLI's header/footer noise leaks into the synthesis input | `parse-agent-output.sh` strips it; the fixtures cover the shapes seen so far | Add a fixture under `scripts/fixtures/` with the new shape and extend the trim pattern in `parse-agent-output.sh`. |
| A model CLI hits a rate limit | dispatch records a `.gap` for that seat | Synthesis names the gap. For a critical decision, re-run once the limit clears, or set `CONTEXTIUM_VOICES` to the CLIs that still answer so they fill every seat. |
| `council` + `--agents 2` rejected at build | a council is three positions by construction | Use `--agents 3` for a council, or switch format to `dialectic` if 2 perspectives suffice. |
| A round re-runs the same arguments | The loop should have ended on the work per `@rule:adversarial-recursion-cap` | Stop and synthesize. Do not fire a question; the count was never the signal. |
| All agents fail → `dispatch-agents.sh` exits non-zero | Network outage, all CLIs degraded, or invalid prompts | Halt the skill. Surface the failure to the user; do NOT emit a synthesis with zero inputs. |
