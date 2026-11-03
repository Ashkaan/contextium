---
name: debate
description: Adversarial debate — three agents (Claude, Codex, Grok) argue a question from three positions, then the strongest conclusion is synthesized. Use when the user says "debate this", "I'm torn between X and Y", "red-team this plan", or "council on this".
allowed-tools: Bash Read
metadata:
  peers: ".agents/skills/implement-audit/SKILL.md .agents/skills/review/policy.json .agents/skills/debate/scripts/build-agent-prompts.ts .agents/skills/debate/scripts/dispatch-agents.ts .agents/skills/debate/scripts/parse-agent-output.ts"
---

# Debate — Multi-Agent Adversarial Reasoning

Three agents argue one question from three positions; the synthesis weighs them.
There are no options: request three seats, always the same three models, so
there is no choice to get wrong before the debate starts.

| Seat | Model | Position |
|---|---|---|
| 1 | Claude | Pragmatist — feasibility, cost, what works today |
| 2 | Codex | Skeptic — hidden costs, second-order effects |
| 3 | Grok | Visionary — long-term impact, the best possible outcome |

The models are the `panel` row of `.agents/skills/review/policy.json`; a voice
whose `tracks` is empty runs its CLI's default model, and a non-empty `tracks`
is passed to the CLI as the model. The positions are
`scripts/build-agent-prompts.ts`. Dispatch and unavailable-seat handling follow
step 3's harness branch. In T3 an unavailable seat stays unargued and appears
in Gaps; never fill it through the CLI dispatcher or another provider.

**Step graph**: step-1-parse-input → step-2-build-prompts → step-3-dispatch-agents → step-4-synthesize → step-4-5-hand-back-to-the-project → step-5-optional-round-2

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
- The user's own words: [what they said about it, quoted, not paraphrased]
- Facts: [what was read or measured, each with where it came from]
- Any answer is allowed, including change nothing or remove something.
```

No constraints and no leaning: a constraints slot that prefers a shape
("scripts with tests preferred") and a leaning slot that carries a position
pull all three seats toward that answer, so they agree on more machinery where
the same question put as the user's words, the facts and the line above can
come back "add nothing".

Save this block to a temp file and pass it as `--context-file` to the build
script — every agent argues from the same facts. Keep under 200 words.

## step-2-build-prompts

```bash
node --experimental-strip-types .agents/skills/debate/scripts/build-agent-prompts.ts \
  --question "$QUESTION" \
  --context-file "$CTX_FILE"   # optional
# stdout: prompts_dir=/tmp/debate-prompts-XXXXXX
 # Remove only the literal temporary path returned by the builder.
```

The role instructions, steel-man line and output schema live in the script's
`TEMPLATES` table (SSOT).

## step-3-dispatch-agents

In T3 Code, use its delegation tool for each seat. Give each child only its generated role prompt and context; request the named model and collect its answer and actual model identity. Do not run the CLI dispatcher in the parent. Follow T3’s capability and unavailable-provider rules; report any unavailable seat rather than silently changing providers. Use returned child answers directly in synthesis; the CLI parser below is unnecessary for structured T3 results. The stand-in algorithm below applies only where that fallback is authorized and available.

Outside T3, the existing CLI dispatcher is the implementation:

Only in this branch, a failed model's seat — its CLI is not installed, it
times out, it errors — can be argued by its existing stand-in: **Claude fails →
Codex doubles; Grok fails → Claude doubles; Codex fails → Claude doubles**, then
the remaining model if that one also failed. `scripts/dispatch-agents.ts` owns
this fallback, so a machine with one model CLI still gets a three-position
debate, argued by one model. Identify the actual speaker and reduced
independence in synthesis.

```bash
node --experimental-strip-types .agents/skills/debate/scripts/dispatch-agents.ts \
  --prompts-dir "$PROMPTS_DIR"
# stdout: output_dir=/tmp/debate-outputs-XXXXXX
# stderr: one line per stand-in and per unargued seat
 # Remove only the literal prompts directory returned by the builder.
```

Per seat the output dir holds `<role>.output` and `<role>.voice` (who argued
it), or `<role>.gap` when nobody could. It exits non-zero only when no seat was
argued. The default timeout is 600s for each seat; `--timeout-s` overrides it.
Each seat starts in an empty folder, so it argues from the brief alone and reads
no repo's rules; the Claude seat also loads no home skills, hooks or MCP
servers, and the Codex seat no home skills.

The prompts dir is removed here rather than by the dispatcher, because a
caller of its own may still need the prompts dir after the dispatch returns. The output dir is removed by step-4's parse,
its last reader, so it can be parsed only once.

## step-4-synthesize

For CLI results only:

```bash
node --experimental-strip-types .agents/skills/debate/scripts/parse-agent-output.ts \
  --output-dir "$OUTPUT_DIR"
# stdout: one block per seat — `=== <role> ===`, `argued by: …`, then the answer
```

An answer that ignored the output schema arrives marked `(unstructured …)`
rather than being dropped; read it like the others.

Read each available seat's answer and the actual unavailable-seat result;
preserve every missing seat in Gaps. Then produce a structured synthesis.
Do NOT just summarize — add analytical value:

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

## step-4-5-hand-back-to-the-project

When the context scaffold drew on a project (`projects/<domain>/<slug>/`), the
synthesis goes back into that project before the reply ends, or the project
keeps telling the user the old answer: a debate that changes a project's
recommendation and lives only in that day's journal leaves the project's
`research.md` and ROADMAP on the old one, and the question gets asked again.

Under the matching heading of the project's `research.md`
(`.agents/skills/spec/references/templates/research.md` is the format), add one
bullet:

    - Debated <YYYY-MM-DD>, not accepted: <the If Forced to Pick line, one sentence>. Open: <each Key Tension the user still has to decide>.

Leave the `Decision:` line as it is. A debate is three models' advice, and
their agreement is not the user's approval: the Decision line and any ROADMAP
row it drives change only when the user accepts, in the session where they say so. When the
recommendation contradicts the current Decision line, say that in the reply in
one sentence, naming the file. A debate with no project behind it skips this
step.

## step-5-optional-round-2

If the user says "another round" or "go deeper": write one rebuttal prompt per
seat, named `pragmatist.prompt`, `skeptic.prompt` and `visionary.prompt` so each
lands on the same seat, asking for `## Rebuttal` / `## Underweighted Argument` /
`## Revised Position`. Save them to a fresh prompts dir. In T3, delegate those prompts through the same seat/model path as round 1. Outside T3:

```bash
node --experimental-strip-types .agents/skills/debate/scripts/dispatch-agents.ts \
  --prompts-dir "$ROUND2_PROMPTS_DIR"
 # Remove only the literal returned temporary directory.
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

User: `/debate red-team this plan: ship a repo-write service as an HTTP daemon with bearer auth so other automations can request a git commit on the build server`. The build writes the three role prompts; dispatch runs Claude (pragmatist), Codex (skeptic) and Grok (visionary) in parallel. Grok times out, so Claude argues the visionary seat as well and the parse block reads `argued by: claude (default model) — stood in for grok (timeout after 600s (grok))`. The skeptic's strongest point: "the use case is 'shared SSH execution' — a 30-line bash function would do this; an HTTP daemon with TLS, auth, allowlists, and worktree GC is 100× over-engineered." The synthesis weighs it against the visionary's "future automations might need it", recommends the shared SSH function, and names the stand-in under Gaps.

## Troubleshooting

| Error | Cause | Solution |
|---|---|---|
| A seat's `.voice` says a model stood in | That seat's own model failed (timeout, quota, missing CLI, a model the CLI rejects) | Expected; name it under Gaps. The reason is in the `.voice` line. |
| A seat ends as `.gap` | Its model failed and so did every eligible stand-in | Name it under Gaps; dispatch's stderr line for the seat carries both reasons. |
| Codex output has header/footer noise leaking into synthesis input | `parse-agent-output.ts` is supposed to strip it — fixtures cover the known patterns | If a new Codex log shape leaks through, add a fixture under `scripts/fixtures/` and extend the `FOOTER` pattern in `answer-block.ts` (the one reading both the parser and the dispatcher use). |
| A round re-runs the same arguments | The loop should have ended on the work | Stop and synthesize. Do not fire a question; the count was never the signal. |
| No seat argued → `dispatch-agents.ts` exits non-zero | Network outage, all three CLIs degraded, or invalid prompts | Halt and clean the literal returned output directory (step-4 never runs to remove it). Surface the failure to the user; do NOT emit a synthesis with zero inputs. |
