# /author agent — branch flow + agent shape SSOT

Scaffolds `.agents/reviewers/<name>.md` from `references/templates/agent.template.md`,
then fills it. Agents are auto-discovered by file presence — no register step.

**This document is the single source of truth for the agent frontmatter + body
contract** (`@rule:single-source-of-truth`). No meta-rule for agent shape
exists; this doc owns it. `templates/agent.template.md` instantiates the field
list below and `verify.sh`'s agent branch checks it — both derive from here. The
five agents in `.agents/reviewers/` (`ai-layer-reviewer.md`,
`implement-audit-reviewer.md`, `research-agent.md`, `rule-efficacy-reviewer.md`,
`spirit-check.md`) are the EXAMPLES that informed this contract, not a parallel
authority; `verify.sh` does not read them at runtime.

Governing rules: `@rule:tiebreaker-skill-vs-agent`,
`@rule:single-source-of-truth`, `@rule:no-speculative-enforcement`.

## Frontmatter contract (the SSOT field list)

Every `.agents/reviewers/<name>.md` MUST declare these six frontmatter keys.
`verify.sh agent` checks exactly this list:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | kebab-case, matches the filename stem. |
| `description` | yes | one-line: the fresh-context job + who dispatches it. Used by the model to decide relevance. |
| `model` | yes | `inherit` (default — use the orchestrator's model) or a pinned model id. |
| `tools` | yes | YAML list of the tools the agent may call (e.g. `[Read, Grep, Glob, Bash]`). Scope to what the job needs. **The field is `tools`, NOT `allowed-tools`** — Anthropic ([sub-agents docs](https://code.claude.com/docs/en/sub-agents)) only recognizes `tools`; an `allowed-tools` key on an agent is silently ignored and the agent inherits ALL tools. (`allowed-tools` is the *skill* field, not the agent field.) |
| `peers` | yes (may be `[]`) | co-located files / dispatching skills the agent relates to. |
| `enforces` | yes (may be `[]`) | `@rule:<id>` list the agent mechanizes; each MUST resolve to a real rule. |

## Body contract

The body is the agent's system prompt. It MUST contain:

- An opening line establishing the agent has NO session history — it sees only the caller's brief.
- An **Input Contract** — exactly what the dispatching skill passes.
- **You MAY / You MUST NOT** guardrails — what the agent may touch; the hard limits (no inventing findings, every claim cites file:line, single-round, no dispatching other agents).
- An **Output Contract** — the exact structured shape the caller consumes (a fenced markdown block). Adversarial agents additionally emit triaged findings + a structured YAML section per `@rule:adversarial-triaged-output` + the machine-readable findings block.
- A **When to Refuse** clause — malformed brief, unbounded scope, or a tool-invocation-not-investigation request.

## Step 1 — resolve shape (ask the user)

Confirm this is actually an agent, not a skill. Place in an AGENT only if the work benefits from FRESH context (adversarial review, cold-reader analysis, isolated investigation, parallel offload to protect the main context window). If it needs session history (orchestration, user-facing slash command, commit/push) it is a SKILL — use `/author skill` (`@rule:tiebreaker-skill-vs-agent`). Agents are NOT slash-invocable; a verb-form name (`run-x`, `fix-y`) is the usual tell that a skill was meant — `scaffold.sh` prints a reminder on verb-form names.

## Step 2 — scaffold

```bash
bash .agents/skills/author/scripts/scaffold.sh agent <name>
```

Writes `.agents/reviewers/<name>.md` with `{{name}}` substituted and the six-field frontmatter. Refuses if the file exists.

## Step 3 — fill

Fill the frontmatter per the contract above (scope `tools` (NOT `allowed-tools`), resolve `enforces`), then write the body per the body contract — Input Contract, MAY/MUST NOT, Output Contract, When to Refuse.

## Step 4 — verify

```bash
bash .agents/skills/author/scripts/verify.sh agent .agents/reviewers/<name>.md
```

Gates (deterministic): the six required frontmatter fields present; `description` in **third person** (Anthropic — it drives delegation); `tools` a **non-empty scoped list** (an unscoped agent inherits every tool — higher permission + token surface). MUST exit 0 before the branch completes.

## Step 5 — register

None. Agents are auto-discovered from `.agents/reviewers/<name>.md`. The dispatching skill names the agent in the body step that dispatches it and in its `metadata.peers`.
