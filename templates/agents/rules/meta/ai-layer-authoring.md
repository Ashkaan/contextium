---
paths:
  - ".agents/**"
  - ".claude/**"
  - "templates/agents/**"
  - "templates/claude/**"
---

# Meta-AI-Layer Authoring

Path-scoped to the AI layer — `.agents/` (rules, skills, review scripts, templates) and `.claude/` (subagents, in-session hooks, output styles, settings), plus their `templates/` sources in the repo that authors the layer. Holds the "where does this new automation / guidance / mechanism belong?" tiebreakers. The rule that every behavioral rule needs a mechanism behind it lives once, in `../mechanisms-not-prose.md`.

## one-behavior-one-surface
When multiple surfaces constrain the same actor for the same action, MUST consolidate to the most powerful surface. MUST NOT add a rule documenting what a hook already enforces, and MUST NOT author a rule or hook for a behavior the harness already exposes as a `settings.json` key. Before retiring prose in favour of a mechanism, MUST verify the mechanism's coverage equals the prose's full scope. Surfaces may coexist when they constrain different actors (rule → the model, hook → git) or different moments (edit-time, commit-time). [2026-04-20] [2026-08-10]

## check-harness-surface-first
Before authoring ANY new rule, hook, or check, MUST first establish whether Claude Code already exposes the behavior natively — a `settings.json` key, a lifecycle hook event, or artifact frontmatter — and MUST use that surface when it exists. MUST NOT write governance prose or a bash gate as downstream cleanup for something a key prevents upstream. Training-data recall does not satisfy "reading"; the surface moves between versions. [2026-08-06]

## autonomous-guardrails-are-tool-scoped
When an agent runs work unsupervised, each of its hard limits MUST be enforced by withholding the tool that would breach it — scope the agent's `tools:` list — and MUST NOT rest on an instruction in its brief telling it not to. A brief is advisory; a missing tool is not. [2026-07-24]

## tiebreaker-skill-vs-agent
When splitting work between skill and agent, MUST place in a skill if the work needs session history (orchestration, user-facing slash commands, commit/push flows); MUST place in an agent if the work benefits from fresh context (adversarial review, cold-reader analysis, isolated investigation). MUST NOT expose work as user-slash-invocable via an agent — agents are not slash-command-exposed. Canonical pattern: skill orchestrates + dispatches agent for the sub-task. [2026-04-23]

## surface-visible-signal
Every automation MUST emit at least one signal channel (log output, stderr, notification); MUST NOT ship silent automation — silent automations cannot be debugged or trusted. [2026-04-18]

## tiebreaker-commit-hook-placement
Commit-time automation MUST be authored as a **native git hook** under `.githooks/` — a thin entrypoint delegating to a check script under `.githooks/checks/`, which is where the check's single copy lives. MUST NOT use a `.claude/` Bash hook as the enforcement for commit gating: a PreToolUse hook fires BEFORE the command runs, so it reads the staged diff before staging finishes and is blind to `git add && git commit`, `git commit -a`, and commits made inside scripts or by another tool. The native hook fires DURING the commit, after staging, for every commit regardless of who ran git.

A `.claude/` hook MAY still call the same check as a front end, so Claude gets the refusal as something it can act on rather than a failed commit it has to unpick — `commit-gate.sh` does exactly that. The check itself is not duplicated; both callers run the one copy under `.githooks/checks/`. [2026-04-18] [2026-05-23] [2026-06-09]

## rule-stable-id
A rule's id — its `## <slug>` — MUST be stable once shipped. Other files cite it as `@rule:<id>`, and
renaming it breaks every one of those references at once with nothing to tell you. MUST NOT rename a
shipped rule without updating every citation in the same commit. Pick the slug carefully the first
time. [2026-04-18]

## evidence-required-for-new-rules
Every new rule, hook, or check MUST cite a real failure that already happened — a journal entry, a
commit, an incident, a correction someone actually made — with the date. MUST NOT ship one citing a
hypothetical.

A rule written from a hunch is indistinguishable, at read time, from one written from a scar. Only
one of them is worth the attention it takes from the others. [2026-04-18]

## skill-required-frontmatter
Every skill's frontmatter MUST follow the [Agent Skills specification](https://agentskills.io/specification):
`name` (equal to the folder name) and `description` required; `license`, `compatibility`,
`allowed-tools` (one space-separated string) and `metadata` optional; no other key. `metadata` MUST
hold only `peers` — one space-separated string of the paths the skill loads or dispatches. Whether
the model may fire a skill on its own is harness configuration, never a file field.

The `description` is what the model routes on: it MUST say WHAT the skill does and WHEN to use it,
and the arguments it takes, in at most 1,024 characters. A harness ignores a key it does not know
without a word, so a skill carrying one looks configured and is not; `check-skill-format.sh` refuses
it at commit. [2026-04-18] [2026-09-24]

## skill-step-graph
When a skill has gates — a question it asks, a point it halts at, a check it runs, another skill it
dispatches — each step MUST be its own body section, `## <step-id>`, saying what it does and, for a
gate, what it checks and what happens when it fails. The frontmatter carries no step list: a graph
in a field no harness reads is a promise nobody checks. A step that is data (a lookup, a check, a
transform) calls a script rather than describing it (@rule:deterministic-over-ai). Simple skills are
one body. [2026-04-18] [2026-09-24]

## hook-errors-actionable
Every blocking hook MUST name the exact file, the line where applicable, and the concrete thing to do
next. MUST NOT say "fix the issue" without pointing at the issue. A refusal that cannot be acted on
gets worked around instead of obeyed. [2026-04-18]

## hook-blocking-exit-code
A PreToolUse hook that means to BLOCK MUST exit 2. Exit 1 prints and lets the call through — it is
the most common way a hook silently does nothing while looking installed. [2026-04-18]
