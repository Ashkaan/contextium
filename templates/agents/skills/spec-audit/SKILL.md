---
name: spec-audit
description: Adversarial pre-review of any freshly-written or materially-rewritten SPEC or spec folder, running reviewer consensus (correctness) plus the spirit-check agent (fidelity to the user's verbatim ask — spec.md's Input and Clarifications, or a legacy SPEC's § 0 / § 0a — and to the behavior contract) in one pass and returning a converged SPEC plus a one-line `spec-audit:` record written into the spec's plan.md. Invoked by /spec immediately after it writes the SPEC (UNCONDITIONAL), by /implement when revising a SPEC mid-flight, or by any caller that writes a SPEC, IMMEDIATELY after the SPEC is written and BEFORE presenting to the user for sign-off. Covers project spec folders (projects/{domain}/{date}_{slug}/specs/NNN-name/), app SPECs (apps/{name}/SPEC.md), feature SPECs (apps/{name}/specs/YYYY-MM-DD_{feature}.md), and legacy project SPECs (projects/{domain}/{date}_{slug}/{name}.spec.md).
allowed-tools: "Bash(.agents/skills/spec-audit/scripts/*:*) Bash(.agents/skills/review/spec-audit.sh:*) Bash(.agents/skills/review/policy-review.sh:*) Read Edit Task"
metadata:
  peers: ".agents/agents/spirit-check.md .agents/skills/review/spec-audit.sh .agents/skills/review/policy-review.sh .agents/skills/spec-audit/scripts/write-audit-line.sh .agents/skills/spec/references/templates/plan.md"
---

# /spec-audit — adversarial SPEC pre-review

Run reviewer consensus (correctness) + spirit-check (fidelity to user's ask) on a freshly-written or materially-rewritten SPEC, BEFORE presenting it to the user for sign-off.

Invoked by `/spec` immediately after it writes the SPEC (UNCONDITIONAL — every SPEC goes through this review), by `/implement` when revising a SPEC mid-flight, or by any subagent that writes a SPEC. The verdict is a record, not a gate: the single consolidated `spec-audit:` line is written into the spec's `plan.md` Constitution Check by `scripts/write-audit-line.sh`, and the close's journal entry quotes it.

**Works on any SPEC shape.** The common one is a project **spec folder**, `projects/<domain>/<date>_<slug>/specs/NNN-name/`, holding `spec.md`, `plan.md`, `tasks.md` and `research.md` from `.agents/skills/spec/references/templates/`. Pass the FOLDER: every script here accepts one wherever it accepts a file — `check-materiality.sh` diffs the whole folder, and `spec-audit.sh` hands the reviewer all four files, each under a `=== <file> ===` header. A single file still works for the older shapes: app SPECs (`apps/<name>/SPEC.md`), legacy project SPECs (`projects/<domain>/<date>_<slug>/<name>.spec.md`), and feature SPECs (`apps/<name>/specs/YYYY-MM-DD_<feature>.md`) when an existing one is materially rewritten. Spirit-check's required input is always present: in a folder it is spec.md's `**Input**`, `## Clarifications`, `## User Scenarios & Testing` and `## Requirements` plus plan.md's `### Simplest shape`; in a legacy SPEC it is § 0, § 0a, § 0b and § 1. This skill audits whatever it is handed and does not choose the location.

## Critical

- **No silent revision.** Whatever the user signs off on at step 6 MUST be byte-identical to what gets committed. Zero edits between user sign-off and `git commit`.
- **`defer` is forbidden** as an annotation on reviewer findings. If you want to defer a finding, ask the user instead (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`).
- **Materiality is a script result, not a judgment.** Run `scripts/check-materiality.sh` to decide; don't infer from prose.

## Steps

### `step-1-materiality-gate`

Run [`bash .agents/skills/spec-audit/scripts/check-materiality.sh [spec-folder | spec-path]`](scripts/check-materiality.sh). Output is one line: `material:[reason]` or `non-material:[reason]`.

- `non-material:*` → skip the protocol; record `spec-audit: skipped — non-material ([reason])` from `format-trailer.sh skipped-non-material [reason]` through `write-audit-line.sh`, exactly as step-6 writes its verdict — into the spec's `plan.md` `- spec-audit:` line. Over the placeholder or an earlier skip the skip line replaces it; over a real verdict the script keeps that verdict and its reviewer and appends `; re-check <date> non-material`, so the line stays the current record and never erases who reviewed the spec. For a single-file SPEC with no plan.md, print it with the summary so the close's journal entry carries it — then exit.
- `material:*` → proceed to `step-2-skip-clause`.

### `step-2-skip-clause`

If invoked with `--skip-reason '[verbatim user quote]'`, write `spec-audit: skipped — user authorized "[verbatim quote]"` from `format-trailer.sh skipped-user '[quote]'` through `write-audit-line.sh`, where step-6 writes its verdict (plan.md's `- spec-audit:` line, or printed for a single-file SPEC), then exit.

The verbatim quote is the audit trail.

### `step-3-spirit-check`

The fidelity check asks whether the SPEC misread the user — a `judgment`
work-type, which the review policy (`.agents/skills/review/policy.json`) routes
to a model other than the one that wrote the SPEC
(model assignment follows the policy). A SPEC judged for misreading by the
model that wrote it is the weakest possible pairing; the adversarial reviewer already covers
correctness at step-4, so the fidelity half is where a third perspective pays.

```bash
bash .agents/skills/review/policy-review.sh judgment <spec-path> <brief-file>
```

`policy-review.sh` takes ONE file. For a spec folder that file is
`<spec-folder>/spec.md` — the full path, `projects/<domain>/<date>_<slug>/specs/NNN-name/spec.md` — and the brief quotes plan.md's `### Simplest shape`
verbatim, since the fidelity check refuses without it.

The brief MUST restrict the reviewer to the user's verbatim ask, how we
interpreted it, the simplest shape and the behavior contract — spec.md's
`**Input**` + `## Clarifications` + `## User Scenarios & Testing` +
`## Requirements` and plan.md's `### Simplest shape` for a folder, § 0 / § 0a /
§ 0b / § 1 for a legacy SPEC — and demand one of MATCH / DRIFT / AMBIGUOUS.
`.agents/agents/spirit-check.md` is the SSOT for that brief's wording. Exit 3 (no
independent judgment vendor answered, or the chain reached the authoring model's
slot) → dispatch the `spirit-check` subagent in a FRESH context with the SPEC
path instead, and say it answered as a fresh-context fallback, NOT independent.

DRIFT findings get surfaced to the user with the converged SPEC at
`step-6-present-converged`.

### `step-4-review-round-1`

Run `bash .agents/skills/review/spec-audit.sh [spec-path] [brief]` synchronously. Read findings.

Exit 3 means no independent reviewer answered. It is not a failed audit (Contextium): run the same attack with a fresh-context agent of your own, work its findings the same way, and record the reviewer as `claude-fallback` — `format-trailer.sh` then writes `claude-fallback (fresh context, NOT independent)` into the line, so it is never read as independent. Exit 1 or 124 is a failed audit: report it, write no passing line.

For each finding: choose `accept` (fold into SPEC by editing the file) or `pushback ([rationale])`. `defer` is NOT a valid annotation.

Apply accepts by editing the SPEC file in place.

### `step-5-review-round-2`

Only fires if any findings were pushed back in `step-4-review-round-1`. Write pushbacks to a temp file outside the repo, re-run `bash .agents/skills/review/spec-audit.sh [spec-path] [brief] [pushback-file]`. The reviewer returns line-anchored `[concede]` (the pushback was right) or `[disagree]` (finding stands).

Pipe the reviewer's output to [`bash .agents/skills/spec-audit/scripts/parse-review-output.sh`](scripts/parse-review-output.sh). Read the `verdict:` line, and check the counts against the number of pushbacks sent — a pushback with no verdict line is unanswered, not conceded:
- `consensus` → all disagreements resolved; proceed to `step-6-present-converged`.
- `escalate` → ask the user (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`) about each `[disagree]` item with options `accept the reviewer's finding | accept the agent's pushback | revise to address both`. User adjudicates per item.

### `step-6-present-converged`

FIRST write the `spec-audit:` line from [`format-trailer.sh`](scripts/format-trailer.sh) into the spec's `plan.md` Constitution Check with [`write-audit-line.sh`](scripts/write-audit-line.sh), never by hand:

```bash
bash .agents/skills/spec-audit/scripts/write-audit-line.sh <spec-folder> "$(bash .agents/skills/spec-audit/scripts/format-trailer.sh round-1 <vendor> <MATCH|DRIFT|AMBIGUOUS>)"
```

It replaces the whole `- spec-audit: [...]` list item the plan template holds with `- ` plus the script's output (which carries its own `spec-audit:` prefix — the script refuses a second one), and exits 1 when plan.md has lost the item (a single-file SPEC has no plan.md: print the line with the summary, and the close's journal entry carries it). The write comes before the presentation so that what the user reviews is what gets committed, plan.md included — step-7's contract. Pass the ANSWERING vendor first (read it off `spec-audit.sh`'s `answered: <vendor>/<model>` stderr line; the chain may have fallen through to the backup) and the spirit-check verdict last:
- Round-1 consensus: `format-trailer.sh round-1 <vendor> <MATCH|DRIFT|AMBIGUOUS>`
- Round-2 consensus: `format-trailer.sh round-2 <vendor> [accepted] [escalated] <MATCH|DRIFT|AMBIGUOUS>`

THEN emit to the user:
- The converged SPEC (revised in place, plan.md's audit line included)
- DRIFT findings from `step-3-spirit-check` (if spirit-check returned DRIFT)
- One-line summary: `reviewer consensus: N findings, M accepted, K pushbacks accepted by the reviewer, L escalated. Spirit-check: MATCH | DRIFT | AMBIGUOUS.`

### `step-7-no-silent-revision`

What the user signs off on at `step-6-present-converged` MUST be byte-identical to what gets committed. No edits between user sign-off and commit.

## Scripts

| Script | Purpose | Inputs → Output |
|---|---|---|
| [`scripts/check-materiality.sh`](scripts/check-materiality.sh) | Decide material vs non-material from a diff | `<spec-folder \| spec-path> [<git-ref>]` → `material:<reason>` or `non-material:<reason>` |
| [`scripts/parse-review-output.sh`](scripts/parse-review-output.sh) | Count `[concede]` and `[disagree]` lines from round-2 output | stdin → `verdict:` + counts + verbatim lines |
| [`scripts/format-trailer.sh`](scripts/format-trailer.sh) | Build the consolidated `spec-audit:` line for plan.md | `<mode> <vendor> [args...]` → the line |
| [`scripts/write-audit-line.sh`](scripts/write-audit-line.sh) | Write that line into plan.md's `- spec-audit:` item; a non-material skip keeps a real verdict and appends `; re-check <date> non-material` | `<spec-folder> "<line>"` → plan.md rewritten; exit 1 if the item is missing, 2 on a usage error |

Each has a `*.test.sh` beside it.

## Cost

Each review round: 30-90s blocking on the reviewer CLI. Round 1 is the typical cost; round 2 only fires when the agent pushes back. Spirit-check: ~10-30s. Typical total: ~1-2 minutes; up to ~3-4 minutes with round 2.

## Examples

### Example 1: new app SPEC just written

`/spec` just produced `apps/{example-app}/SPEC.md`.

Actions:
1. Caller invokes `/spec-audit apps/{example-app}/SPEC.md`.
2. `check-materiality.sh` → `material:new-file`. Proceed.
3. Dispatch spirit-check agent → MATCH.
4. Run review round 1 → 4 findings; the agent accepts 3, pushes back on 1. Note which vendor answered.
5. Apply 3 accepts by editing SPEC.
6. Round 2 with the 1 pushback → the reviewer returns `[concede]`.
7. `parse-review-output.sh` → `verdict: consensus`.
8. Emit converged SPEC + summary. `format-trailer.sh round-2 codex 0 0 MATCH` → `spec-audit: codex round-2 (0 accepted by codex, 0 escalated); spirit MATCH; user-ask-verbatim in spec.md Input`. Had the chain fallen through, the first argument — and therefore the trailer — would say `grok`.
9. User signs off on the folder as presented, plan.md's line included; the close's journal entry quotes it.

### Example 2: typo fix in SPEC

User edits one typo in `apps/daily-report/SPEC.md`.

Actions:
1. Caller invokes `/spec-audit apps/daily-report/SPEC.md`.
2. `check-materiality.sh` → `non-material:minor-text-edit-1-lines`.
3. `format-trailer.sh skipped-non-material typo` → `spec-audit: skipped — non-material (typo)`. Exit.

### Example 3: user pre-authorized skip

User: "skip codex on this one, I'm just renaming fields".

Actions:
1. Caller invokes `/spec-audit apps/daily-report/SPEC.md --skip-reason "skip codex on this one, I'm just renaming fields"`.
2. Skip-clause fires immediately. `format-trailer.sh skipped-user "skip codex on this one, I'm just renaming fields"` → `spec-audit: skipped — user authorized "skip codex on this one, I'm just renaming fields"`. Exit.

### Example 4: wording fix in an audited spec folder

A later edit rewords an Assumptions bullet in `specs/001-retry-queue/`, whose plan.md reads `- spec-audit: codex round-1; spirit MATCH; user-ask-verbatim in spec.md Input`.

Actions:
1. `check-materiality.sh specs/001-retry-queue/` → `non-material:minor-text-edit-2-lines`.
2. `write-audit-line.sh specs/001-retry-queue "$(format-trailer.sh skipped-non-material wording-polish)"` → plan.md keeps the verdict and its reviewer, with `; re-check YYYY-MM-DD non-material` appended. No reviewer call. Exit.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `check-materiality.sh` returns `non-material` when you expected `material` | Trigger list doesn't cover this change shape | Check the script's heuristics in `scripts/check-materiality.sh`; add a new trigger pattern if the change shape recurs |
| The reviewer script exits 3 | No vendor other than the author answered — every CLI in the row is down, missing, or not signed in | Expected on a machine with only one model: rerun the audit in a fresh context and record it as `claude-fallback`. To get an independent review instead, run each CLI the policy row names by hand to see which fails, fix or install one, and retry |
| spirit-check agent not loaded ("agent type not found") | `.agents/agents/spirit-check.md` missing or session doesn't know about it | Confirm file exists; spirit-check is single-purpose subagent — falls back to general-purpose with agent body inlined per `.agents/skills/implement-audit/SKILL.md` pattern |
| `parse-review-output.sh` returns `verdict: consensus` despite obvious disagreements | The reviewer's output did not use line-anchored `[concede]`/`[disagree]` prefixes | The reviewer's output format may have shifted; check `.agents/skills/review/spec-audit.sh` output contract; update parser if format shifted |
| `format-trailer.sh` error "invalid non-material reason" | Reason string not in canonical 6-value list | Use one of: typo / formatting / link / wording-polish / section-reorder / clarification |
| plan.md still holds the `- spec-audit: [...]` placeholder, or reads `spec-audit: spec-audit: …` | step-6 printed the line but did not write it, or it was hand-edited | Re-run `write-audit-line.sh <spec-folder> "<format-trailer.sh output>"` — don't hand-edit the line |
| `write-audit-line.sh` exits 1 | plan.md lost its `- spec-audit:` item | Restore the item from the plan template, then re-run |

## History

- The reviewer-consensus protocol and the spirit-check are one skill, so a spec gets one review pass rather than two gates that can drift apart.
- The spirit-check exists because a spec can be internally excellent and still solve the wrong problem — a service built where the user asked for a function.
- The three separate trailers (reviewer, spirit-check, verbatim ask) became one `spec-audit:` line, and the line is a record in plan.md, never a gate on a commit.
