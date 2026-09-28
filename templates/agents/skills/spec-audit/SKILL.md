---
name: spec-audit
description: Adversarial review of a freshly written or materially rewritten spec — a spec folder (specs/NNN-name/) or a single SPEC file — before any code is written. Runs an independent reviewer against the design and the spirit-check agent against the user's verbatim ask in one pass, folds the accepted findings in, and writes a one-line `spec-audit:` record into the folder's plan.md. Invoked by /spec on every spec it writes; also callable after any spec edit ("/spec-audit <spec-folder>").
allowed-tools: "Bash(bash .agents/skills/spec-audit/scripts/*:*) Bash(bash .agents/scripts/spec-review.sh:*) Bash(git *:*) Read Edit Task AskUserQuestion"
metadata:
  peers: ".agents/reviewers/spirit-check.md .agents/scripts/spec-review.sh .agents/scripts/reviewer-chain.sh .agents/skills/spec/SKILL.md .agents/skills/spec/references/templates/plan.md"
---

# /spec-audit — review the design before it becomes code

A spec is the cheapest place to be wrong: a missing boundary case costs one line
here and a rewrite after the code exists. Two reviewers, two jobs:

- **The independent reviewer** (`spec-review.sh`) attacks the design — gaps,
  boundary cases, peers left inconsistent, a shape bigger than the ask.
- **The spirit-check agent** reads only the user's verbatim ask and the behavior
  contract, and answers one question: does the spec describe what was asked
  for? It catches the spec that is internally excellent and solves the wrong
  problem.

**Input.** Pass the spec FOLDER, `projects/<domain>/<date>_<slug>/specs/NNN-name/`
— every script here accepts one. A single file (an older `*.spec.md`, an app's
`SPEC.md`) works too; it has no plan.md, so its audit line is printed instead of
written.

## Critical

- **The reviewer should not be the author.** A same-model reviewer shares the
  blind spot that produced the spec. `spec-review.sh` uses a different model
  when one is installed; when none is (exit 3), fall back to a fresh-context
  agent and **say so** in the summary and the audit line.
- **A reviewer that could not run is a failed audit.** Exit 1 or 124 means no
  review happened: report it, write no passing line.
- **Findings are fixed or argued, never deferred** (`@rule:no-deferral`).
- **Materiality is a script result.** Step 1 decides; don't re-judge it.
- **The audit line is a record, not a gate.** Nothing refuses a commit without
  it; the close's journal entry quotes it.

## step-1-materiality

```bash
bash .agents/skills/spec-audit/scripts/check-materiality.sh <spec-folder>
```

`material:<reason>` → continue. `non-material:<reason>` → record the skip
(step 6) and stop — a prior real verdict is kept, with a re-check note:

```bash
bash .agents/skills/spec-audit/scripts/write-audit-line.sh <spec-folder> \
  "$(bash .agents/skills/spec-audit/scripts/format-trailer.sh skipped-non-material wording-polish)"
```

## step-2-skip-clause

Only when the user, this session, told you to skip the audit: pass
`--skip-reason '<their exact words>'`, record
`format-trailer.sh skipped-user "<their exact words>"` with
`write-audit-line.sh` (step 6) and stop. The
quote is the record that the skip was authorized; a paraphrase is not.

## step-3-spirit-check

Dispatch the `spirit-check` agent (`.agents/reviewers/spirit-check.md`) with a
brief holding ONLY: spec.md's `**Input**`, `## Clarifications`,
`## User Scenarios & Testing` and `## Requirements`, and plan.md's
`### Simplest shape` (for a single file: its Ask and Behavior sections). It
returns MATCH, DRIFT or AMBIGUOUS. On DRIFT, fix the spec to match the ask; if
the divergence is a real choice, it goes to the user at step 6. If the harness
has no subagents, run the agent's instructions in a fresh context and say so.

## step-4-review-round-1

```bash
bash .agents/scripts/spec-review.sh <spec-folder> "<one line: what this spec is for>"
```

The reviewer gets spec.md, plan.md and tasks.md (all three required) and any research.md, each under a
`=== <file> ===` header. Findings arrive one per line, `[must-fix]` /
`[should-fix]` / `[nit]`; `NO_FINDINGS` is a clean round. For each finding:

- **Accept** — edit the file now. Most land here.
- **Push back** — one or two sentences on why it is wrong. A reviewer working
  from a prompt cannot see everything you can.

Exit 3 → no external reviewer: run a fresh-context agent with the same attack
dimensions and label the reviewer `claude-fallback`. A genuinely independent
reviewer is the Codex CLI or any command in `CONTEXTIUM_REVIEWER_CMD`
(`.agents/scripts/reviewer-chain.sh`).

## step-5-review-round-2 — only if you pushed back

Write the pushbacks to a scratch file outside the repo, numbered, one per
disputed finding (`1. <finding> — <why it is wrong>`), then:

```bash
bash .agents/scripts/spec-review.sh <spec-folder> "<brief>" /tmp/pushbacks.txt \
  | bash .agents/skills/spec-audit/scripts/parse-review-output.sh --expected <N>
```

- `verdict: consensus` — every pushback conceded; continue.
- `verdict: escalate` — a finding stands. Ask the user once (a numbered list,
  recommendation first; in Claude Code, `AskUserQuestion`), each item with both
  positions stated plainly: accept the finding, keep the pushback, or revise to
  address both.
- `verdict: incomplete` — some pushbacks got no verdict. Re-run once; if it
  repeats, escalate what is still unadjudicated. A partial answer is never
  agreement on the rest.

No round 3: two rounds converge or produce a decision that belongs to the user.

## step-6-record

Build the line from whoever actually answered — `spec-review.sh` prints
`answered: <slot>` on stderr — or `claude-fallback`:

```bash
bash .agents/skills/spec-audit/scripts/format-trailer.sh round-1 codex MATCH
bash .agents/skills/spec-audit/scripts/format-trailer.sh round-2 codex 2 1 MATCH
```

Write it into plan.md's Constitution Check — never by hand:

```bash
bash .agents/skills/spec-audit/scripts/write-audit-line.sh <spec-folder> "<the line>"
```

It replaces the `- spec-audit:` item (the placeholder, an earlier skip, or the
previous verdict). A non-material skip never erases a real verdict: that
verdict and its reviewer stay, with `; re-check <date> non-material` appended. A
single-file spec has no plan.md; print the line with the summary instead.

Then report: the changes folded in, any DRIFT or escalation, and one line —
`reviewer <slot>: N findings, M accepted, K pushbacks conceded, L escalated;
spirit MATCH | DRIFT | AMBIGUOUS`.

## step-7-no-silent-revision

What you presented is what gets committed, plan.md's line included. If
something must change after presenting, present it again.

## Scripts

| Script | In → out |
|---|---|
| [`scripts/check-materiality.sh`](scripts/check-materiality.sh) | `<spec-folder \| spec-file> [<git-ref>]` → `material:<reason>` or `non-material:<reason>` |
| [`scripts/parse-review-output.sh`](scripts/parse-review-output.sh) | round-2 output on stdin, `--expected <N>` → counts + `verdict: consensus\|escalate\|incomplete` |
| [`scripts/format-trailer.sh`](scripts/format-trailer.sh) | `<mode> …` → the `spec-audit:` line |
| [`scripts/write-audit-line.sh`](scripts/write-audit-line.sh) | `<spec-folder> "<line>"` → plan.md's `- spec-audit:` item rewritten; exit 1 if the item is missing |

Each has a `*.test.sh` beside it.

## Examples

**Clean.** `/spec` writes `specs/001-retry-queue/` and invokes this skill.
`material:new-file`. Spirit MATCH. Round 1: two `[should-fix]` boundary rows,
both accepted. plan.md gets `- spec-audit: codex round-1; spirit MATCH`.

**Pushback.** Round 1 says to validate a value the caller already validates;
you push back citing the caller. Round 2 returns `[concede] 1`, `verdict:
consensus`. Line: `spec-audit: codex round-2 (1 conceded, 0 escalated); spirit
MATCH`.

**Wording fix.** A later edit rewords an Assumptions bullet.
`non-material:minor-text-edit-2-lines` → plan.md keeps
`- spec-audit: codex round-1; spirit MATCH` and gains
`; re-check 2026-01-12 non-material`; no reviewer call.

**No external reviewer.** Round 1 exits 3. A fresh-context agent reviews; the
report says independence was reduced; the line names `claude-fallback`.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `spec-review.sh` exits 1 or 124 | chain exhausted or timed out | report the audit unavailable; re-run when a reviewer is reachable |
| `spec-review.sh` exits 2, `spec folder has no plan.md` | the folder is incomplete | write the missing file from the templates first |
| `parse-review-output.sh` exits 1 | round 2 produced no verdicts — a crash, not agreement | re-run round 2; escalate if it repeats |
| `format-trailer.sh` exits 1 | reviewer name, verdict or reason malformed | reviewer is lowercase letters, digits, dashes; verdict MATCH, DRIFT or AMBIGUOUS |
| `write-audit-line.sh` exits 1 | plan.md lost its `- spec-audit:` item | restore it from the plan template, re-run |
| `non-material` when you expected `material` | the change sits outside the listed sections | the heading list is in `check-materiality.sh`'s header; run the audit anyway if the change matters |
