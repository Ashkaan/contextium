---
name: spec-audit
description: Adversarial review of a freshly written or materially rewritten SPEC or spec folder, for correctness and for fidelity to the user's own words, before it is committed. Run by /spec right after it writes a SPEC, by /implement when it revises one, and by any other caller that writes a SPEC.
allowed-tools: "Bash(.agents/skills/spec-audit/scripts/*:*) Bash(.agents/skills/review/spec-audit.ts:*) Bash(.agents/skills/review/policy-review.ts:*) Bash(node --experimental-strip-types .agents/skills/spec-audit/scripts/*:*) Bash(node --experimental-strip-types .agents/skills/review/spec-audit.ts:*) Bash(node --experimental-strip-types .agents/skills/review/policy-review.ts:*) Read Edit Task"
metadata:
  peers: ".agents/agents/spirit-check.md .agents/skills/review/spec-audit.ts .agents/skills/review/policy-review.ts .agents/skills/spec-audit/scripts/write-audit-line.ts .agents/skills/spec/references/templates/plan.md .agents/skills/spec-audit/scripts/spirit-input.ts"
---

# /spec-audit — adversarial SPEC pre-review

Run reviewer consensus (correctness) + spirit-check (fidelity to user's ask) on a freshly-written or materially-rewritten SPEC, BEFORE it is committed. There is no sign-off halt (`.agents/skills/spec/SKILL.md` § Critical); the user reads it on main.

Invoked by `/spec` immediately after it writes the SPEC (UNCONDITIONAL — every SPEC goes through this review), by `/implement` when revising a SPEC mid-flight, or by any subagent that writes a SPEC. The verdict is a record, not a gate: the single consolidated `spec-audit:` line is written into the spec's `plan.md` Constitution Check by `scripts/write-audit-line.ts`, and the close's journal entry quotes it.

**Works on any SPEC shape.** The common one is a project **spec folder**, `projects/<domain>/<date>_<slug>/specs/NNN-name/`, holding `spec.md`, `plan.md`, `tasks.md` and `research.md` from `.agents/skills/spec/references/templates/`. Pass the FOLDER: every script here accepts one wherever it accepts a file — `check-materiality.ts` diffs the whole folder, and `spec-audit.ts` hands the reviewer all four files, each under a `=== <file> ===` header. A single file still works for the single-file shapes: app SPECs (`apps/<name>/SPEC.md`) and feature SPECs (`apps/<name>/specs/YYYY-MM-DD_<feature>.md`) when an existing one is materially rewritten. Spirit-check's required input is always present: in a folder it is spec.md's `**Input**`, `## Clarifications`, `## User Scenarios & Testing` and `## Requirements` plus plan.md's `### Simplest shape`; in a single-file SPEC it is § 0, § 0a, § 0b and § 1. This skill audits whatever it is handed and does not choose the location.

## Critical

- **No silent revision.** What step 6 presents MUST be byte-identical to what gets committed. Zero edits between step 6 and `git commit`.
- **`defer` is forbidden** as an annotation on reviewer findings. If you want to defer a finding, ask the user instead, as a numbered list in the reply, recommendation first.
- **Materiality is a script result, not a judgment.** Run `scripts/check-materiality.ts` to decide; don't infer from prose.

## Steps

### `step-1-materiality-gate`

Run `node --experimental-strip-types .agents/skills/spec-audit/scripts/check-materiality.ts [spec-folder | spec-path]` ([source](scripts/check-materiality.ts)). Output is one line: `material:[reason]` or `non-material:[reason]`.

- `non-material:*` → skip the protocol; record `spec-audit: skipped — non-material ([reason])` from `format-trailer.ts skipped-non-material [reason]` through `write-audit-line.ts`, exactly as step-6 writes its verdict — into the spec's `plan.md` `- spec-audit:` line. Over the placeholder or an earlier skip the skip line replaces it; over a real verdict the script keeps that verdict and its reviewer and appends `; re-check <date> non-material`, so the line stays the current record and never erases who reviewed the spec. For a single-file SPEC with no plan.md, print it with the summary so the close's journal entry carries it — then exit.
- `material:*` → proceed to `step-2-skip-clause`.

### `step-2-skip-clause`

If invoked with `--skip-reason '[verbatim user quote]'`, write `spec-audit: skipped — user authorized "[verbatim quote]"` from `format-trailer.ts skipped-user '[quote]'` through `write-audit-line.ts`, where step-6 writes its verdict (plan.md's `- spec-audit:` line, or printed for a single-file SPEC), then exit.

The verbatim quote is the audit trail.

### `step-3-spirit-check`

The fidelity check asks whether the SPEC misread the user — a `judgment`
work-type, which the review policy (`.agents/skills/review/policy.json`) routes
to a model other than the one that wrote the SPEC
(model assignment follows the policy). A SPEC judged for misreading by the
model that wrote it is the weakest possible pairing; the adversarial reviewer already covers
correctness at step-4, so the fidelity half is where a third perspective pays.

```bash
node --experimental-strip-types .agents/skills/spec-audit/scripts/spirit-input.ts <spec-folder | single-file SPEC> <scratch>/spirit-input.md
node --experimental-strip-types .agents/skills/review/policy-review.ts judgment <scratch>/spirit-input.md <brief-file>
```

`spirit-input.ts` ([source](scripts/spirit-input.ts)) cuts out exactly the
sections the fidelity check reads, verbatim, and nothing else: spec.md's
`**Input**`, `## Clarifications`, `## User Scenarios & Testing` and
`## Requirements` plus plan.md's `### Simplest shape` for a folder; § 0, § 0a,
§ 0b and § 1 for a single-file SPEC. That file, never spec.md itself, is the
artifact: the reviewer refuses a SPEC's full body, and excerpts cut by hand
drift. Exit 1 names a missing section: the SPEC lacks what the check needs, so
fix the SPEC rather than the input.

The brief demands one of MATCH / DRIFT / AMBIGUOUS from those sections alone;
`.agents/agents/spirit-check.md` is the SSOT for its wording. Exit 3 (no
independent judgment vendor answered, or the chain reached the authoring
model's slot) → dispatch the `spirit-check` subagent in a FRESH context with
that same `spirit-input.md` instead, and say it answered as a fresh-context
fallback, NOT independent.

**The fidelity check runs once per `/spec-audit` run.** Never run it again in
the same run: not after folding its points, not after the user rules on one,
not "to confirm". A later material rewrite is a new `/spec-audit` run (step-1
decides), and that run gets its own one check. Each DRIFT or AMBIGUOUS point is settled one of two ways: the spec is
changed back to the user's words and the summary says what changed, or, when settling
it needs a choice only they can make, it goes to them at `step-6-present-converged`.
A second run reads the revised spec as new ground and nearly always finds one
more small point, so a re-run loop has no natural end.

DRIFT findings not folded get surfaced to the user with the converged SPEC at
`step-6-present-converged` — except one that disputes a reading the user already
ruled on in `## Clarifications` (their quoted words): record the reviewer's
reading in that row's Rejected column and do not surface it, unless it carries
a fact they did not have. Asking again what the user already answered costs
their trust and settles nothing.

### `step-4-review-round-1`

Supply verified original authors after reading `.agents/skills/review/SKILL.md` § Where things are found (including T3 execution lineage) before adversarial review. Preserve that input in every follow-up and any child brief; include providers that write revisions. Do not infer authorship from the review executor. Missing provenance is a caller error, not permission to assume Claude.

Run the review — in T3 Code, in the same delegated child as `step-3-spirit-check`: one child runs the fidelity check's command, then this one, and returns both outputs, rather than one child each, which doubles the child threads every spec costs. Give the original writer inputs in the literal command:

```bash
POLICY_CHAIN_AUTHOR_THREAD_ID="<writing thread id>" POLICY_CHAIN_AUTHOR_VENDORS="<all writer providers>" \
node --experimental-strip-types .agents/skills/review/spec-audit.ts <spec-path> <brief>
```

Outside T3, `POLICY_CHAIN_AUTHOR_THREAD_ID` may be left empty.

Exit 3 means no independent reviewer answered. It is not a failed audit: run the same attack with a fresh-context agent of your own, work its findings the same way, and record the reviewer as `claude-fallback` — `format-trailer.ts` then writes `claude-fallback (fresh context, NOT independent)` into the line, so it is never read as independent. Exit 1 or 124 is a failed audit: report it, write no passing line.

Number the findings `F1`, `F2`, … in the order the script printed them. For each, choose `accept` (edit the SPEC in place) or `pushback` (a rationale); `defer` is NOT a valid annotation. The review also attacks the spec's `### Supported inputs` (each input class the work must handle, its example, its expected result, and the fallback for anything else), because a spec that never says which inputs matter leaves every code review to invent one.

`[idea] <section>: <improvement>` lines are not findings and get no ID. An idea that serves the user's verbatim ask (spec.md's `**Input**`) is accepted into the spec; every other one goes under the spec's `Not covered:` list, one line each, marked "(raised in review)".

### `step-5-follow-up-rounds`

Runs whenever round 1 returned a finding. Write one line per finding still open to a temp file, opening with its ID and disposition, then the finding as printed — `F2 accepted: <what changed in the spec> — <the finding>` or `F3 pushback: <rationale> — <the finding>` — and run, with the same author prefix:

```bash
node --experimental-strip-types .agents/skills/review/spec-audit.ts <spec-path> <brief> --follow-up <file>
```

The reviewer re-reads the current spec and returns one `[resolved] F<n>` or `[open] F<n> <why>` per ID, plus new `[must-fix]`/`[should-fix]` lines only for defects the accepted edits introduced; it raises no ideas. The script refuses a missing, doubled or unknown ID (exit 1: re-run the round unchanged). Pipe its stdout to `node --experimental-strip-types .agents/skills/spec-audit/scripts/parse-review-output.ts --expected <the IDs sent>` ([source](scripts/parse-review-output.ts)) and read `verdict:`:

- `consensus` → nothing open and no new must-fix; go to `step-6-present-converged`. A new should-fix is dispositioned (accept or pushback) without another round.
- `open` → number new findings on from the last ID, disposition every `[open]` and new finding the same way, and run the next follow-up with only those lines.
- `incomplete` (exit 3) → a finding got no verdict, two, or an ID you did not send; re-run the round unchanged.

`spec-audit.ts` exiting 3 on a follow-up is the same condition as in round 1 — no independent reviewer answered — and on a machine with one CLI it always will. Dispatch a fresh-context agent of your own (never the context that wrote the pushbacks) with the SPEC path and the follow-up file, and ask for exactly the follow-up shape — one `[resolved] F<n>` or `[open] F<n> <why>` line per ID, plus new `[must-fix]`/`[should-fix]` lines only for defects the accepted edits introduced — then parse it as above, and record the reviewer as `claude-fallback`.

At most 3 follow-ups (four reviews) per spec in one thread: the script counts them and exits 5 on a fourth. At the cap with findings open, settle each yourself: re-read the rule, file or fact each side cites, correct whichever side misread it, and where both concerns are real, revise the spec to address both. A technical choice (a library, a file location, a schema, a transport) is yours: decide it and name the rule applied. Only what the user alone can answer reaches them — their preferences, money, an account in their name, an outbound message, infrastructure they have not allowed. Ask those, and only those, as a numbered list in the reply, recommendation first, each with options `accept the reviewer's finding | accept the agent's pushback | revise to address both`. Count every item you settled as accepted, not escalated, in the `format-trailer.ts` arguments.

The fidelity check (`step-3-spirit-check`) still runs once per `/spec-audit` run; follow-up rounds never re-run it.

### `step-6-present-converged`

FIRST write the `spec-audit:` line from [`format-trailer.ts`](scripts/format-trailer.ts) into the spec's `plan.md` Constitution Check with [`write-audit-line.ts`](scripts/write-audit-line.ts), never by hand:

```bash
node --experimental-strip-types .agents/skills/spec-audit/scripts/write-audit-line.ts <spec-folder> "$(node --experimental-strip-types .agents/skills/spec-audit/scripts/format-trailer.ts round-1 <vendor> <MATCH|DRIFT|AMBIGUOUS>)"
```

It replaces the whole `- spec-audit: [...]` list item the plan template holds with `- ` plus the script's output (which carries its own `spec-audit:` prefix — the script refuses a second one), and exits 1 when plan.md has lost the item (a single-file SPEC has no plan.md: print the line with the summary, and the close's journal entry carries it). The write comes before the presentation so that what the user reviews is what gets committed, plan.md included — step-7's contract. Pass the ANSWERING vendor first (read it off `spec-audit.ts`'s `answered: <vendor>/<model>` stderr line; the chain may have fallen through to the backup) and the spirit-check verdict last:
- Round-1 consensus: `format-trailer.ts round-1 <vendor> <MATCH|DRIFT|AMBIGUOUS>`
- After follow-ups: `format-trailer.ts follow-up <vendor> <follow-ups run, 1-3> <pushbacks the reviewer accepted> <escalated> <MATCH|DRIFT|AMBIGUOUS>` (the vendor that answered the last round)

THEN emit to the user:
- The converged SPEC (revised in place, plan.md's audit line included)
- DRIFT findings from `step-3-spirit-check` (if spirit-check returned DRIFT) that need the user's choice, minus those step-3 recorded as Rejected because the user already ruled on the reading; a point already folded back to their words is listed as a correction, never as a decision for them
- One-line summary: `reviewer consensus after F follow-ups: N findings, M accepted, K pushbacks accepted by the reviewer, L escalated; I ideas (J taken, the rest under Not covered). Spirit-check: MATCH | DRIFT | AMBIGUOUS.`

### `step-7-no-silent-revision`

What `step-6-present-converged` presents MUST be byte-identical to what gets committed. No edits between the presentation and the commit.

## Scripts

| Script | Purpose | Inputs → Output |
|---|---|---|
| [`scripts/check-materiality.ts`](scripts/check-materiality.ts) | Decide material vs non-material from a diff | `<spec-folder \| spec-path> [<git-ref>]` → `material:<reason>` or `non-material:<reason>` |
| [`scripts/parse-review-output.ts`](scripts/parse-review-output.ts) | Check a follow-up holds exactly one `[resolved]`/`[open]` verdict per finding sent, and count new findings | `--expected <ids>`, stdin → `verdict:` + counts + verbatim lines |
| [`scripts/format-trailer.ts`](scripts/format-trailer.ts) | Build the consolidated `spec-audit:` line for plan.md | `<mode> <vendor> [args...]` → the line |
| [`scripts/write-audit-line.ts`](scripts/write-audit-line.ts) | Write that line into plan.md's `- spec-audit:` item; a non-material skip keeps a real verdict and appends `; re-check <date> non-material` | `<spec-folder> "<line>"` → plan.md rewritten; exit 1 if the item is missing, 2 on a usage error |

Each has a `*.test.ts` beside it (`node --test --experimental-strip-types .agents/skills/spec-audit/scripts/*.test.ts`).

## Cost

Each review round: 30-90s blocking on the reviewer CLI. Round 1 always runs; a follow-up runs whenever round 1 returned a finding, at most three. Spirit-check: ~10-30s, once. Typical total: ~2-3 minutes; up to ~6 minutes at the cap.

## Examples

### Example 1: new app SPEC just written

`/spec` just produced `apps/{example-app}/SPEC.md`.

Actions:
1. Caller invokes `/spec-audit apps/{example-app}/SPEC.md`.
2. `check-materiality.ts` → `material:new-file`. Proceed.
3. Dispatch spirit-check agent → MATCH.
4. Run review round 1 → 4 findings and 2 ideas; the agent accepts 3, pushes back on 1. One idea serves the ask and goes into the spec; the other goes under `Not covered:` "(raised in review)". Note which vendor answered.
5. Apply 3 accepts by editing SPEC.
6. Follow-up 1 with `F1 accepted: …`, `F2 accepted: …`, `F3 pushback: …`, `F4 accepted: …` → the reviewer returns four `[resolved]` lines.
7. `parse-review-output.ts --expected F1,F2,F3,F4` → `verdict: consensus`.
8. Emit converged SPEC + summary. `format-trailer.ts follow-up codex 1 1 0 MATCH` → `spec-audit: codex round-1 + 1 follow-up (1 pushback accepted by codex, 0 escalated); spirit MATCH; user-ask-verbatim in spec.md Input`. Had the chain fallen through, the vendor — and therefore the trailer — would say `grok`.
9. The folder is committed as presented, plan.md's line included; the close's journal entry quotes it.

### Example 2: typo fix in SPEC

User edits one typo in `apps/daily-report/SPEC.md`.

Actions:
1. Caller invokes `/spec-audit apps/daily-report/SPEC.md`.
2. `check-materiality.ts` → `non-material:minor-text-edit-1-lines`.
3. `format-trailer.ts skipped-non-material typo` → `spec-audit: skipped — non-material (typo)`. Exit.

### Example 3: user pre-authorized skip

User: "skip codex on this one, I'm just renaming fields".

Actions:
1. Caller invokes `/spec-audit apps/daily-report/SPEC.md --skip-reason "skip codex on this one, I'm just renaming fields"`.
2. Skip-clause fires immediately. `format-trailer.ts skipped-user "skip codex on this one, I'm just renaming fields"` → `spec-audit: skipped — user authorized "skip codex on this one, I'm just renaming fields"`. Exit.

### Example 4: wording fix in an audited spec folder

A later edit rewords an Assumptions bullet in `specs/001-retry-queue/`, whose plan.md reads `- spec-audit: codex round-1; spirit MATCH; user-ask-verbatim in spec.md Input`.

Actions:
1. `check-materiality.ts specs/001-retry-queue/` → `non-material:minor-text-edit-2-lines`.
2. `write-audit-line.ts specs/001-retry-queue "$(format-trailer.ts skipped-non-material wording-polish)"` → plan.md keeps the verdict and its reviewer, with `; re-check YYYY-MM-DD non-material` appended. No reviewer call. Exit.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `check-materiality.ts` returns `non-material` when you expected `material` | Trigger list doesn't cover this change shape | Check the script's heuristics in `scripts/check-materiality.ts`; add a new trigger pattern if the change shape recurs |
| The reviewer script exits 3 | No vendor other than the author answered — every CLI in the row is down, missing, or not signed in | Expected on a machine with only one model: run that round — the audit in round 1, the verdicts in a follow-up — in a fresh context and record it as `claude-fallback`. To get an independent review instead, run each CLI the policy row names by hand to see which fails, fix or install one, and retry |
| spirit-check agent not loaded ("agent type not found") | `.agents/agents/spirit-check.md` missing, or the harness does not load that agent type | Confirm the file exists; then dispatch a general-purpose subagent (in T3 Code, a delegated child) with that file's body as its brief, and say so in the step-6 summary |
| `parse-review-output.ts` returns `verdict: consensus` despite obvious disagreements | The reviewer's output did not use line-anchored `[resolved]`/`[open]` prefixes | Check `.agents/skills/review/spec-audit.ts`'s output contract; if the format shifted, update the parser and its test |
| `spec-audit.ts` exits 5 | This spec has had its 3 follow-ups in this thread | Settle what is still open yourself per `step-5-follow-up-rounds`; ask the user only what they alone can answer |
| `format-trailer.ts` error "invalid non-material reason" | Reason string not in canonical 6-value list | Use one of: typo / formatting / link / wording-polish / section-reorder / clarification |
| plan.md still holds the `- spec-audit: [...]` placeholder, or reads `spec-audit: spec-audit: …` | step-6 printed the line but did not write it, or it was hand-edited | Re-run `write-audit-line.ts <spec-folder> "<format-trailer.ts output>"` — don't hand-edit the line |
| `write-audit-line.ts` exits 1 | plan.md lost its `- spec-audit:` item | Restore the item from the plan template, then re-run |
