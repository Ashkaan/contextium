---
name: spec-audit
description: Adversarial review of a freshly-written or materially-rewritten SPEC, before any code is written. Runs an independent reviewer against the SPEC's design and the spirit-check agent against the user's verbatim ask, in one pass. Auto-fired by /spec; also callable standalone after any SPEC edit. Emits the `spec-audit:` commit trailer the git hook requires.
disable-model-invocation: false
argument-hint: "[spec-path] [--skip-reason 'verbatim user authorization']"
allowed-tools: "Bash(.agents/skills/spec-audit/scripts/*:*) Bash(.agents/scripts/spec-review.sh:*) Bash(git *:*) Read Edit Task AskUserQuestion"
peers:
  - .agents/reviewers/spirit-check.md
  - .agents/scripts/spec-review.sh
  - .agents/scripts/reviewer-chain.sh
  - .agents/skills/spec/SKILL.md
  - .githooks/checks/check-audit-trailers.sh
enforces:
  - "@rule:no-deferral"
  - "@rule:simplest-solution-default"
handoffs_from:
  - .agents/skills/spec/SKILL.md
  - .agents/skills/implement/SKILL.md
reads:
  - projects/{domain}/{date}_{slug}/{name}.spec.md
  - apps/{name}/SPEC.md
writes:
  - the same SPEC file, revised in place with accepted findings folded in
steps:
  - id: step-1-materiality
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Run scripts/check-materiality.sh <spec-path>. If stdout starts with `non-material:`, emit the skipped trailer via scripts/format-trailer.sh skipped-non-material <reason> and exit the skill. Otherwise continue."
  - id: step-2-skip-clause
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "If invoked with --skip-reason, emit scripts/format-trailer.sh skipped-user '<the user's verbatim words>' and exit. The quote must be what the user actually said this session, not a paraphrase."
  - id: step-3-spirit-check
    kind: action
    action: "Dispatch the spirit-check agent on the SPEC. It reads ONLY the user's verbatim ask (§ 1) and the behavior contract (§ 2). Capture MATCH | DRIFT | AMBIGUOUS for step 6."
  - id: step-4-review-round-1
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Run .agents/scripts/spec-review.sh <spec> '<brief>'. Exit 0 = reviewed (findings on stdout, empty = clean). Exit 3 = no external reviewer: dispatch a fresh-context general-purpose agent with the same attack dimensions and SAY SO in the summary and the trailer (reviewer `claude-fallback`). Exit 1 or 124 = the review did NOT happen; report it unavailable rather than passing the gate. For each finding, either accept it (Edit the SPEC) or push back with a written rationale. Deferring a finding is not an option per @rule:no-deferral."
  - id: step-5-review-round-2
    kind: gate
    gate:
      tool: shell
      on_fail: continue
      condition: "Only if you pushed back on anything: write the pushbacks to a file NUMBERED one per disputed finding, re-run spec-review.sh <spec> '<brief>' <pushback-file>, pipe through scripts/parse-review-output.sh --expected <how many you pushed back on>, and read the `verdict:` line. consensus → fold and continue. escalate → ask the user once, listing every [disagree] item. incomplete → the reviewer skipped some pushbacks; re-run once, then escalate what is still unadjudicated."
  - id: step-6-present
    kind: action
    action: "Print the converged SPEC's changes, the spirit verdict, and the one-line trailer built by scripts/format-trailer.sh. Hand the trailer to the caller (/spec rides it into the close commit)."
  - id: step-7-no-silent-revision
    kind: gate
    gate:
      tool: halt
      on_fail: halt
      condition: "The SPEC the user sees at sign-off MUST be byte-identical to the SPEC that gets committed. No edits between presenting and committing. If something must change after presenting, re-present it."
---

# /spec-audit — review the design before it becomes code

A SPEC is the cheapest place in the loop to be wrong. A missing boundary case
costs one line to add here and a rewrite to add after the code exists. This skill
attacks the SPEC while fixing it is still cheap.

Two reviewers run, and they have different jobs:

- **The independent reviewer** (`spec-review.sh`) attacks the design — gaps,
  boundary cases, peers left inconsistent, a shape bigger than the ask.
- **The spirit-check agent** reads only the user's verbatim ask and the behavior
  contract, and answers one question: does the SPEC describe the thing that was
  actually asked for? It catches the failure the design reviewer structurally
  cannot — a SPEC that is internally excellent and solves the wrong problem.

## Critical

- **The reviewer should not be the author.** One model wrote the SPEC, so a same-model
  reviewer shares the blind spot that produced it. `spec-review.sh` runs the
  review on a different model when one is installed. When none is
  (`exit 3`), fall back to a fresh-context agent — and **say so**, in the summary
  and in the trailer, so nobody reads reduced independence as full independence.
- **A reviewer that could not run is a FAILED audit, not a clean one.** Exit 1
  and 124 mean the review did not happen. Report it unavailable; do not emit a
  passing trailer.
- **Findings get fixed or argued, never deferred.** Accept and Edit, or push back
  with a reason and let round 2 settle it. "Track it for later" is not a third
  option per `@rule:no-deferral`.
- **Non-material edits skip.** A typo fix does not spend a reviewer call. Step 1
  decides that deterministically so the judgment is not re-litigated each time.

## step-1-materiality — is this change worth a review?

```bash
bash .agents/skills/spec-audit/scripts/check-materiality.sh <spec-path>
```

`material:<reason>` runs the audit. `non-material:<reason>` emits the skipped
trailer and exits:

```bash
bash .agents/skills/spec-audit/scripts/format-trailer.sh skipped-non-material wording-polish
```

## step-2-skip-clause — the skip clause

`--skip-reason` exists for one case: the user, this session, told you to skip the
audit. Quote their actual words — the trailer is the record that the skip was
authorized, and a paraphrase is not evidence.

```bash
bash .agents/skills/spec-audit/scripts/format-trailer.sh skipped-user "just write it, I'll review it myself"
```

## step-3-spirit-check — does it match the ask?

Dispatch the `spirit-check` agent with the SPEC path. It returns `MATCH`,
`DRIFT`, or `AMBIGUOUS`. On DRIFT, fix the SPEC to match the ask. If the
divergence is a real choice only the user can make, surface it and halt.

## step-4-review-round-1 — attack the design

```bash
bash .agents/scripts/spec-review.sh <spec-path> "<one-line brief of what this SPEC is for>"
```

Findings arrive one per line, triaged `[must-fix]` / `[should-fix]` / `[nit]`.
For each one, decide:

- **Accept** — Edit the SPEC now. Most findings land here.
- **Push back** — write down why the finding is wrong, in one or two sentences.
  Pushing back is legitimate; a reviewer working from a prompt cannot see
  everything you can, and a finding built on a wrong assumption should not
  reshape the SPEC.

If the reviewer returns `NO_FINDINGS`, that is a clean round — nothing to do.

Read the reviewer note on exit 3 carefully: with no external reviewer installed,
you review your own SPEC with a fresh-context agent. Do it, and label it. Users
who want a genuinely independent reviewer install the Codex CLI or point
`CONTEXTIUM_REVIEWER_CMD` at another one; see `.agents/scripts/reviewer-chain.sh`.

## step-5-review-round-2 — only if you pushed back

Write your pushbacks to a scratch file outside the repo, **numbered, one per
finding you disputed**:

```
1. <finding you disputed> — <why it is wrong>
2. <finding you disputed> — <why it is wrong>
```

Then run the round, telling the parser how many verdicts to expect:

```bash
bash .agents/scripts/spec-review.sh <spec-path> "<brief>" /tmp/pushbacks.txt \
  | bash .agents/skills/spec-audit/scripts/parse-review-output.sh --expected 2
```

The count is what makes the round honest. Without it, a reviewer that concedes
one pushback and never mentions the second reads as full agreement, and the
finding still in dispute vanishes.

- `verdict: consensus` — every pushback was conceded. Fold and move on.
- `verdict: escalate` — the reviewer restated at least one finding, so the two of
  you genuinely disagree about the design. That goes to the user once, with both
  positions stated plainly.
- `verdict: incomplete` — fewer verdicts came back than pushbacks. Re-run the
  round once. If it comes back incomplete again, escalate whatever is still
  unadjudicated to the user rather than assuming agreement.

Do not run a round 3 of argument. Two rounds either converge or produce a
decision that belongs to the user.

## step-6-present — present, and the trailer

Print what changed in the SPEC, the spirit verdict, and the trailer:

```bash
bash .agents/skills/spec-audit/scripts/format-trailer.sh round-1 codex MATCH
bash .agents/skills/spec-audit/scripts/format-trailer.sh round-2 codex 2 1 MATCH
```

The reviewer name is whoever actually answered — `spec-review.sh` prints
`answered: <slot>` on stderr — or `claude-fallback` when no external reviewer was
available. `/spec` carries this line into the close commit, where the git hook
requires it on any commit touching a SPEC.

## step-7-no-silent-revision — what you showed is what you commit

The SPEC the user signs off on is the SPEC that gets committed, byte for byte. If
something has to change after you present it, present it again. A revision
between sign-off and commit means the thing they approved is not the thing that
landed, and nobody can see the difference afterwards.

## Examples

**Clean SPEC.** `/spec` writes the SPEC and fires this skill. Materiality says
`material:new-file`. Spirit-check returns MATCH. Round 1 returns two
`[should-fix]` findings about missing boundary rows; both are accepted and the
SPEC is edited. No pushbacks, so no round 2. The trailer reads
`spec-audit: codex round-1; spirit MATCH`.

**A finding you disagree with.** Round 1 says the SPEC should validate a config
value that the caller already validates. You push back citing the caller. Round 2
returns `[concede]`, verdict `consensus`. Trailer:
`spec-audit: codex round-2 (1 conceded, 0 escalated); spirit MATCH`.

**Drift.** Spirit-check returns DRIFT: the user asked for a script, the SPEC
describes a scheduled service. You rewrite § 2 and § 3 down to a script, note the
correction, and continue. The trailer records `spirit DRIFT` so the correction is
in the record.

**Typo fix.** Someone fixes a misspelling in the SPEC and re-runs the skill.
Materiality returns `non-material:minor-text-edit-2-lines`; the skill emits
`spec-audit: skipped — non-material (typo)` and exits without a reviewer call.

**No external reviewer installed.** Round 1 exits 3. You dispatch a fresh-context
agent with the same attack dimensions, fold its findings, and report: "reviewed by
a fresh-context agent — same model as the author, so independence is
reduced; install the Codex CLI or set CONTEXTIUM_REVIEWER_CMD for a genuinely
independent review." Trailer reviewer: `claude-fallback`.

## Troubleshooting

| Failure | Symptom | Fix |
|---|---|---|
| Review did not happen | `spec-review.sh` exits 1 or 124 | The chain was exhausted or timed out. Report the audit unavailable — do NOT emit a passing trailer. Re-run once the reviewer is reachable. |
| No reviewer configured | exit 3 | Expected on a single-model machine. Fall back to a fresh-context agent and label the reduced independence in the summary and trailer. |
| Round 2 parse error | `parse-review-output.sh` exits 1 | The round produced no verdicts, which means it crashed rather than agreed. Re-run round 2; if it fails again, escalate the open findings to the user. |
| Round 2 says `incomplete` | fewer verdicts came back than pushbacks | The reviewer answered some pushbacks and ignored others. Re-run once; if it repeats, escalate the unadjudicated ones. Never read a partial answer as agreement on the rest. |
| Trailer rejected | `format-trailer.sh` exits 1 | The reviewer name or spirit verdict is malformed. Reviewer is lowercase letters, digits and dashes; verdict is MATCH, DRIFT or AMBIGUOUS. |
| Commit blocked, missing trailer | the git hook rejects a SPEC commit | Run this skill on the SPEC, then put its trailer line in the commit message. |
