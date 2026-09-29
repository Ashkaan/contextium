---
name: review
description: "The vendor review chain the loop skills run and never the model itself — code-review.sh over a git diff, spec-audit.sh over a SPEC or spec folder, policy-review.sh over any artifact — each walking a row of the policy table (policy.json here: Codex first, its declared backup next, never the vendor that wrote the code, and a fresh-context fallback labelled NOT independent only when no vendor answers), with blast-radius.sh packing the callers of what a diff changed and find-peers.sh sweeping a mechanism for the siblings a fix left behind. Invoked by /implement (Phase 4.7), /implement-audit, /spec-audit and /author through the paths in this folder; run by hand only to review a diff or SPEC outside those loops or to run the chain's own suites (run-tests.sh) and its eval (evals/)."
allowed-tools: "Bash(.agents/skills/review/*:*) Read"
metadata:
  peers: ".agents/skills/review/code-review.sh .agents/skills/review/spec-audit.sh .agents/skills/review/policy-review.sh .agents/skills/review/policy-chain.sh .agents/skills/review/policy.json .agents/skills/review/blast-radius.sh .agents/skills/review/blast-radius-symbols.mjs .agents/skills/review/find-peers.sh .agents/skills/review/run-tests.sh .agents/skills/review/evals/caller-contract.eval.sh"
---

# .agents/skills/review — the vendor review chain

A folder of scripts, not a workflow: the loop skills call these by path, and
this file exists so the folder is a skill in the shape `.agents/checks/check-skills.sh`
holds every folder here to.

| Script | Reviews | Called by |
|---|---|---|
| `code-review.sh <base> <head>` / `--since <tree>` / `--snapshot` | a git diff, with the blast-radius pack spliced in | `/implement` Phase 4.7, `/implement-audit`, `validate.sh` |
| `spec-audit.sh <spec-or-folder> <brief> [pushback-file]` | a SPEC or spec folder | `/spec-audit` |
| `policy-review.sh <task-kind> <artifact> <brief>` | one file, under any policy row | `/spec-audit`, `/author` |
| `policy-chain.sh` | sourced by the three above; walks the row | — |
| `blast-radius.sh` + `blast-radius-symbols.mjs` | who imports, what imports, who calls | `code-review.sh` |
| `find-peers.sh <files>` / `--verify-sweep <regex> -- <pathspec>` | the siblings a fix left behind | `run-automated-checks.sh`, `/implement` § 3.1.5 |

## Where things are found

- **The repo under review** is the caller's: `code-review.sh` reads
  `CODEX_REVIEW_REPO`, else `git rev-parse --show-toplevel` from the cwd, and
  exits 2 with one line when neither names a repo. It never falls back to the
  checkout this script sits in — that reviews the wrong tree.
- **The policy** is `policy.json` beside these scripts: rows `adversarial-review`,
  `judgment`, `panel` and `repo-investigation`, each an ordered list of vendor
  CLIs (`codex`, `grok`; a `claude` slot means "dispatch your own agent").
  `tracks` names an exact model for the CLI's `-m`; empty runs the CLI's own
  default. `POLICY_JSON` overrides the path; `POLICY_CHAIN_RESOLVER` overrides
  the model resolver.
- **The author is left out.** A review row skips the vendor recorded as
  `agent=` in `.agents/harness` (the model family that writes the code); the
  `panel` keeps every seat.
- **The parsers** `blast-radius-symbols.mjs` uses — `web-tree-sitter`,
  `tree-sitter-bash`, `typescript` — are declared in `package.json` here and
  found in the workbench's own `node_modules`, then Node's global one
  (`npm i -g typescript web-tree-sitter tree-sitter-bash`). Without them the
  packer warns and falls back to a regex walk.

## Tests and the eval

The suites and fixtures stay in the Contextium repo; an install carries the
scripts only.

```bash
bash .agents/skills/review/run-tests.sh                        # the *.test.sh here
bash .agents/skills/review/evals/caller-contract.eval.sh --pack-only   # free half
bash .agents/skills/review/evals/caller-contract.eval.sh       # one vendor call; rerun when code-review.sh's prompt moves
```

The close's skills pass runs the same suites whenever a file here changes.
