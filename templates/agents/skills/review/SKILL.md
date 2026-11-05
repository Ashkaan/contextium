---
name: review
disable-model-invocation: true
description: "The vendor review chain the loop skills run and never the model itself — code-review.ts over a git diff, spec-audit.ts over a SPEC or spec folder, policy-review.ts over any artifact — each walking a row of the policy table (policy.json here: Codex first, its declared backup next, never a vendor the caller names as an original author, and a fresh-context fallback labelled NOT independent only when no eligible vendor answers), with blast-radius.ts packing the callers of what a diff changed and find-peers.ts sweeping a mechanism for the siblings a fix left behind. Invoked by /implement (Phase 4.7), /implement-audit, /spec-audit and /author through the paths in this folder; run by hand only to review a diff or SPEC outside those loops or to run the chain's own suites (run-tests.ts) and its eval (evals/)."
allowed-tools: "Bash(.agents/skills/review/*:*) Read"
metadata:
  peers: ".agents/skills/review/code-review.ts .agents/skills/review/spec-audit.ts .agents/skills/review/policy-review.ts .agents/skills/review/policy-chain.ts .agents/skills/review/policy.json .agents/skills/review/blast-radius.ts .agents/skills/review/blast-radius-symbols.ts .agents/skills/review/find-peers.ts .agents/skills/review/run-tests.ts"
---

# .agents/skills/review — the vendor review chain

A folder of scripts, not a workflow: the loop skills call these by path, and
this file exists so the folder is a skill in the shape `.agents/checks/check-skills.ts`
holds every folder here to.

| Script | Reviews | Called by |
|---|---|---|
| `code-review.ts <base> <head> [--slice <file>]` / `--since <tree>` / `--snapshot` | a git diff, with the blast-radius pack spliced in; with `--slice`, one piece of a too-large change: only the NUL-separated paths the file lists, over the set's one base and head (at most four pieces; `.agents/skills/implement-audit/SKILL.md` step-2); a framed result for the review receipt when asked | `/implement` Phase 4.7, `/implement-audit`, `validate.ts` |
| `spec-audit.ts <spec-or-folder> <brief> [pushback-file]` | a SPEC or spec folder | `/spec-audit` |
| `policy-review.ts <task-kind> <artifact> <brief>` | one file, under any policy row | `/spec-audit`, `/author` |
| `policy-chain.ts` | imported by the three above; walks the row | — |
| `blast-radius.ts` + `blast-radius-symbols.ts` | who imports, what imports, who calls | `code-review.ts` |
| `find-peers.ts <files>` / `--verify-sweep <regex> -- <pathspec>` | the siblings a fix left behind | `run-automated-checks.ts`, `/implement` § 3.1.5 |

## Where things are found

- **T3 execution lineage:** in T3 Code, run each live review command in a
  fresh delegated child (T3's `delegate_task`), with the exact command in its
  task, so the review belongs to the owning thread's lineage;
  `/spec-audit`'s fidelity check and round-1 review share one child
  (`.agents/skills/spec-audit/SKILL.md` § step-4). The child runs
  the existing program and returns stdout/stderr; it does not fix source or
  mark the owning audit complete. The parent owns fixes and the audit marker.
  Outside T3, run the command directly. Stub-only unit tests need no child. No
  second reviewer is launched alongside the command.
- **One audit across fresh review children:** the audit owner sets
  CODE_REVIEW_LOOP_ID to its actual T3 thread id (the parentThreadId returned
  by its required orchestrator_capabilities call) and preserves it on every
  snapshot, review round and QA review, including child commands. This keeps
  one owner's budget stable across fresh children without sharing another
  owner's counter. Missing owner input in T3 exits 2, including snapshots.
  Outside T3 the owner defaults to the close's own thread id
  (`.agents/skills/close/scripts/thread.ts`), which is what the close checks.
  A follow-up needs a snapshot issued for that owner AND repo. Never change the
  owner to evade a ceiling. The counters live in the owner's durable thread
  cache (`~/.cache/workbench/threads/<owner>/review-rounds[-qa]/`), in a build
  and a qa bucket (`CODE_REVIEW_BUCKET=qa`, which `validate.ts` sets for
  /qa's edits); nothing resets them — not a repeated full review, which
  spends a round, not a new executor child, not a content, scope or base
  change. A counter that is unreadable, or missing after the audit registered
  one, reads as spent (exit 5). The executing child's identity and the original
  writer's identity below serve different purposes; preserve all three.

- **The review receipt:** with `CODE_REVIEW_RESULT_FILE` set (`validate.ts`
  sets it, with `CODE_REVIEW_COVERAGE_FILE` naming the declared items), the
  reviewer answers in one frame — a `BEGIN_REVIEW_V1` line, a strict JSON
  object `{findings, coverage}`, an `END_REVIEW_V1` line — and `code-review.ts`
  validates it, hands only the findings field to the triage parser, keeps
  stdout to triage lines, and writes the parsed result there. The receipt,
  its content binding and its readers are
  `.agents/skills/implement-audit/scripts/audit-dedupe.ts`; without the variable the
  reply is plain triage lines and no receipt can come of it.

- **No independent vendor (exit 3):** a row whose declared `"fallback":
  "fresh-context"` found no eligible vendor — every one absent, failing, or an
  original author — or a chain that reached a `claude` slot. Most installs
  have one model CLI, and no review at all is worse than a weaker one said
  plainly: `validate.ts` leaves the review pending (`NEED_FALLBACK_REVIEW=1`),
  the implement-audit-reviewer agent reviews the same diff in a FRESH context,
  and `validate.ts --fallback-review <file>` records its reply against the
  receipt as `claude-fallback (fresh context, NOT independent)`. It is never
  reported as an independent review.

- **Original authors, for adversarial review:** set `POLICY_CHAIN_AUTHOR_VENDORS`
  to the comma-separated provider names `claude`, `codex`, `grok`, `gemini`, or
  `human`, as applicable. Verify them from the writing session or delegation
  trace; include every provider that wrote the artifact or its fixes. Pass this
  provenance in a child's brief and environment too: the child running a review
  is not necessarily the author. Standalone callers read the originating thread
  or report first. Missing or unknown provenance exits 2 before any vendor call.
  The existing chain excludes those providers and fails if no eligible reviewer
  can answer; its policy order otherwise stays intact. In T3, set
  `POLICY_CHAIN_AUTHOR_THREAD_ID` to the ORIGINAL writing thread from its T3
  context and preserve it in any child. It is mandatory in T3; the executor id
  and cwd are never inferred as the writing thread. Recorded writing-thread providers are normalized from
  their driver/account names; omitting one, including relabeling a model as human,
  exits 2. This conservatively excludes recorded participants; it does not attest
  which participant wrote each byte. Outside T3, the supplied author declaration
  remains the caller’s responsibility. Non-adversarial
  rows and `--snapshot` need no authorship input.
- **The executing task, for review counters and audit caching:** the existing
  close identity resolver must find one task. In a shared T3 worktree, pass
  `WORKBENCH_THREAD_ID` from the executing task’s T3 context, not a cwd lookup
  that can return its parent. Explicit child ids have their own safe keys.
  Ambiguous cwd identity never reads or writes another task’s audit marker;
  outside T3 the close's thread id is the owner, never an override of T3
  identity.
- **The repo under review** is the caller's: `code-review.ts` reads
  `CODEX_REVIEW_REPO`, else `git rev-parse --show-toplevel` from the cwd, and
  exits 2 with one line when neither names a repo. It never falls back to the
  checkout this script sits in — that reviews the wrong tree.
- **The other half of a cross-repo change** is named by
  `CODEX_REVIEW_COMPANIONS` (worktree paths, comma-separated): the prompt lists
  each with its branch and tells the reviewer to read that repo there, not from
  the landed checkout, which does not carry the change yet. A path that is not a
  git checkout exits 2. Without it, a reviewer spends rounds on findings about
  code the companion worktree has already changed.
- **The policy** is `policy.json` beside these scripts: rows `adversarial-review`,
  `judgment`, `panel` and `repo-investigation`, each an ordered list of vendor
  CLIs (`codex`, `grok`; a `claude` slot means "dispatch your own agent").
  `tracks` names an exact model for the CLI's `-m`; empty runs the CLI's own
  default. `POLICY_JSON` overrides the path; `POLICY_CHAIN_RESOLVER` overrides
  the model resolver. Only `adversarial-review` leaves the original authors
  out (above); the `panel` keeps every seat.
- **The parsers** `blast-radius-symbols.ts` uses — `web-tree-sitter`,
  `tree-sitter-bash`, `typescript` — are declared in `package.json` here and
  found in the workbench's own `node_modules`, then npm's global root
  (`npm i -g typescript@5 web-tree-sitter tree-sitter-bash`), then Node's own
  global `node_modules`. Without them the
  packer warns and falls back to a regex walk.

## Tests and the eval

The suites and fixtures stay in the Contextium repo; an install carries the
scripts only.

```bash
node --experimental-strip-types .agents/skills/review/run-tests.ts                        # every *.test.ts here
node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts --pack-only   # free half
node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts       # one vendor call; rerun when code-review.ts's prompt moves
```

The close's skills pass runs the same suites whenever a file here changes.
