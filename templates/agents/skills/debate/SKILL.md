---
name: debate
description: Adversarial debate — three agents (Claude, Codex, Grok) argue a question from three positions, then the strongest conclusion is synthesized. Use when the user says "debate this", "I'm torn between X and Y", "red-team this plan", or "council on this".
allowed-tools: Bash Read AskUserQuestion
metadata:
  peers: ".agents/skills/implement-audit/SKILL.md .agents/skills/review/policy.json .agents/skills/debate/scripts/build-agent-prompts.ts .agents/skills/debate/scripts/dispatch-agents.ts .agents/skills/debate/scripts/parse-agent-output.ts"
---

# Debate — Multi-Agent Adversarial Reasoning

Three agents argue one question from three positions; the synthesis weighs them.
There are no options: always three seats, always the same three models, so
there is no choice to get wrong before the debate starts.

| Seat | Model | Position |
|---|---|---|
| 1 | Claude | Pragmatist — feasibility, cost, what works today |
| 2 | Codex | Skeptic — hidden costs, second-order effects |
| 3 | Grok | Visionary — long-term impact, the best possible outcome |

The models are the `panel` row of `.agents/skills/review/policy.json`; a voice
whose `tracks` is empty runs its CLI's default model, and a non-empty `tracks`
is passed to the CLI as the model. The positions are
`scripts/build-agent-prompts.ts`. When a model fails — its CLI is not installed,
it times out, it errors — another argues its seat too, so the debate keeps three
positions: **Claude fails → Codex doubles; Grok fails → Claude doubles; Codex
fails → Claude doubles** (and the remaining model when that one failed as well).
`scripts/dispatch-agents.ts` owns that rule, so a machine with one model CLI
still gets a three-position debate, argued by one model.

**Step graph**: step-1-parse-input → step-2-build-prompts → step-3-dispatch-agents → step-4-synthesize → step-5-optional-round-2

## Critical

- **Synthesis (step-4) is where the value is — don't just summarize.** Read every agent's output, identify genuine tensions, name what they agree on. The orchestrator's authorship of the synthesis IS the skill; if all you do is concatenate, you wasted the cost.
- **Say who argued each seat.** Every block from the parse script carries an `argued by:` line. When it says a model *stood in*, the Agents line and the Gaps section say so — two seats argued by one model are less independent than three.
- **Gaps MUST be named.** A seat nobody could argue leaves a `.gap` file; the Gaps section MUST surface "The {role} seat was not argued ({reason}). Synthesis reflects N of 3." Never label a 2-position synthesis as 3.
- **Stop when a round adds nothing.** The loop ends on the work: a round that surfaces no argument already on the table is the last one. There is no round number to hit and no question to fire — rounds here are requested by the user in the first place.

## step-1-parse-input

Extract the question from `$ARGUMENTS`. If it is unclear or too vague, ask ONE
clarifying question first.

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

```bash
node --experimental-strip-types .agents/skills/debate/scripts/build-agent-prompts.ts \
  --question "$QUESTION" \
  --context-file "$CTX_FILE"   # optional
# stdout: prompts_dir=/tmp/debate-prompts-XXXXXX
rm -f "$CTX_FILE"   # its only reader has run
```

The role instructions, steel-man line and output schema live in the script's
`TEMPLATES` table (SSOT).

## step-3-dispatch-agents

```bash
node --experimental-strip-types .agents/skills/debate/scripts/dispatch-agents.ts \
  --prompts-dir "$PROMPTS_DIR"
# stdout: output_dir=/tmp/debate-outputs-XXXXXX
# stderr: one line per stand-in and per unargued seat
rm -rf "$PROMPTS_DIR"   # nothing reads it again
```

Per seat the output dir holds `<role>.output` and `<role>.voice` (who argued
it), or `<role>.gap` when nobody could. It exits non-zero only when no seat was
argued. The default timeout is 300s for each seat; `--timeout-s` overrides it.

The prompts dir is removed here rather than by the dispatcher, because a
caller of its own may still need the prompts dir after the dispatch returns. The output dir is removed by step-4's parse,
its last reader, so it can be parsed only once.

## step-4-synthesize

```bash
node --experimental-strip-types .agents/skills/debate/scripts/parse-agent-output.ts \
  --output-dir "$OUTPUT_DIR"
# stdout: one block per seat — `=== <role> ===`, `argued by: …`, then the answer
```

An answer that ignored the output schema arrives marked `(unstructured …)`
rather than being dropped; read it like the others.

Then produce a structured synthesis. Do NOT just summarize — add analytical value:

```markdown
## Debate: {QUESTION}

**Agents**: {who argued each seat, naming any stand-in}

---

### Debate Summary
[One paragraph: what was argued, where agents diverged]

### Strongest Arguments
[3-5 best points from ANY seat, attributed to the seat and model that made them]

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
[Each stand-in and each unargued seat. Omit entirely if all three models
argued their own seats.]
```

## step-5-optional-round-2

If the user says "another round" or "go deeper": write one rebuttal prompt per
seat, named `pragmatist.prompt`, `skeptic.prompt` and `visionary.prompt` so each
lands on the same seat, asking for `## Rebuttal` / `## Underweighted Argument` /
`## Revised Position`. Save them to a fresh prompts dir, then:

```bash
node --experimental-strip-types .agents/skills/debate/scripts/dispatch-agents.ts \
  --prompts-dir "$ROUND2_PROMPTS_DIR"
rm -rf "$ROUND2_PROMPTS_DIR"
node --experimental-strip-types .agents/skills/debate/scripts/parse-agent-output.ts \
  --output-dir "$ROUND2_OUTPUT_DIR" \
  --round 2
```

After collecting rebuttals, re-synthesize: update Key Tensions and "If Forced
to Pick" if rebuttals exposed genuine weaknesses, or reinforce them if they
didn't land. Note what changed.

**Stop on a round that adds nothing.**,
the loop ends on the work rather than at a round number, and fires no
question — the user asked for these rounds.

## Example

User: `/debate red-team this plan: ship a repo-write service as an HTTP daemon with bearer auth so other automations can request a git commit on the build server`. The build writes the three role prompts; dispatch runs Claude (pragmatist), Codex (skeptic) and Grok (visionary) in parallel. Grok times out, so Claude argues the visionary seat as well and the parse block reads `argued by: claude (default model) — stood in for grok (timeout after 300s (grok))`. The skeptic's strongest point: "the use case is 'shared SSH execution' — a 30-line bash function would do this; an HTTP daemon with TLS, auth, allowlists, and worktree GC is 100× over-engineered." The synthesis weighs it against the visionary's "future automations might need it", recommends the shared SSH function, and names the stand-in under Gaps.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| A seat's `.voice` says a model stood in | That seat's own model failed (timeout, quota, missing CLI, a model the CLI rejects) | Expected; name it under Gaps. The reason is in the `.voice` line. |
| A seat ends as `.gap` | Its model failed and so did every eligible stand-in | Name it under Gaps; dispatch's stderr line for the seat carries both reasons. |
| Codex output has header/footer noise leaking into synthesis input | `parse-agent-output.ts` is supposed to strip it — fixtures cover the known patterns | If a new Codex log shape leaks through, add a fixture under `scripts/fixtures/` and extend the `FOOTER` pattern in `answer-block.ts` (the one reading both the parser and the dispatcher use). |
| A round re-runs the same arguments | The loop should have ended on the work | Stop and synthesize. Do not fire a question; the count was never the signal. |
| No seat argued → `dispatch-agents.ts` exits non-zero | Network outage, all three CLIs degraded, or invalid prompts | Halt the skill after `rm -rf "$OUTPUT_DIR"` (step-4 never runs to remove it). Surface the failure to the user; do NOT emit a synthesis with zero inputs. |
