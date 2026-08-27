# /author output-style — branch flow

The fifth type, added 2026-08-19. An output style is a single Markdown file at
`.claude/output-styles/<name>.md` whose body is APPENDED TO THE SYSTEM PROMPT —
so it is in force on every turn of every session that selects it, and it is the
highest-leverage artifact in `.claude/` per character.

Authoritative field list read first-hand from `code.claude.com/docs/en/output-styles`
(2026-08-19), per `@rule:check-harness-surface-first`.

Governing rules: the convention that rule edits go through /author (the same trailer gate
covers `.claude/output-styles/**`), `@rule:mechanisms-not-prose`,
`@rule:no-speculative-enforcement`, `@rule:single-source-of-truth`.

## Critical — three silent failures, all invisible without `verify`

1. **An unknown frontmatter key is IGNORED, not rejected.** Only `name`,
   `description`, `keep-coding-instructions` and `force-for-plugin` exist. A
   typo (`keep_coding_instructions`, `descripton`) leaves a file that parses,
   loads, and does the wrong thing with no error anywhere.
2. **`keep-coding-instructions` defaults to FALSE.** Omitting it STRIPS Claude
   Code's built-in software-engineering instructions — how to scope changes,
   write comments, verify work. In a coding repo that is almost never intended,
   and nothing surfaces it. Set it explicitly, either way, so the choice is on
   the record.
3. **`description` is what the `/config` picker shows.** Without it the style
   has no picker entry to select.

Two more facts that shape what a style may promise:

- **A style does NOT reach subagents.** Each subagent runs its own system
  prompt; only a fork inherits the parent's. So if you read a subagent's text
  directly, your style does not govern it. Two ways to close that: put the
  format requirements into the brief you hand the subagent, or add a
  `SubagentStart` hook that injects the style file for the agent types whose
  output you read. The brief is the simpler one and needs nothing new.
- **It takes effect at session start.** Changes need `/clear` or a new session;
  editing the file does not change the turn you are in.

## Step 1 — cite-evidence

Same bar as the rule branch: a real cited failure (journal path, commit SHA,
verbatim user correction). A style governs every reply, so "this reads better"
is not evidence. Halt if there is none.

## Step 2 — resolve-shape

`AskUserQuestion` for the two decisions the docs make load-bearing:

- **`keep-coding-instructions`** — true when the style changes HOW Claude
  communicates while still doing engineering work; false only when the sessions
  it governs are genuinely not software engineering.
- **Does it need to bind subagents?** If yes, the brief each subagent gets has
  to carry the format itself (or you add a `SubagentStart` hook). If no, say so
  explicitly — the default silently does not, and "I assumed it applied
  everywhere" is how a style ends up governing half the output.

## Step 3 — scaffold

```bash
bash .claude/skills/author/scripts/scaffold.sh output-style <name>
```

Writes `.claude/output-styles/<name>.md` from the template. Refuses on
collision; never overwrites.

## Step 4 — fill

Fill the body. Two shape constraints, both from what a system prompt is:

- **Standing instructions, not a procedure.** The body has no task in front of
  it; it is read before the request exists.
- **Lead with the sentence that decides what gets printed.** Everything after it
  is subordinate to that one, and a reader who stops after the first paragraph
  should already behave mostly right.

Keep project facts OUT — those go to CLAUDE.md. A style that names a repo path
or a vendor is usually a rule wearing the wrong hat.

## Step 4.5 — efficacy-gate (shared with the rule branch)

Runs identically, and matters MORE here: a system-prompt edit is not sampled at
a decision point, it is present in every reply, so a dropped clause changes
every turn rather than a rare one.

Decompose original vs. rewrite into clauses, hand
`{original, rewrite, dropped_clauses}` — and NOT your rationale — to the
policy-assigned adversary via
`.claude/hooks/checks/artifact-review.sh <file> <brief>`
(exit 3 → dispatch `rule-efficacy-reviewer` instead). Any `load-bearing` verdict
is restored and the gate re-runs. Converged = zero load-bearing drops.

**Known limit, measured 2026-08-18:** the reviewer re-scores the same clause
differently as the surviving pool changes (one rule flipped
`non-behavioral` → `load-bearing` across two rounds on unchanged text). Treat a
single clean round as weaker evidence than it looks.

## Step 5 — verify + register

```bash
bash .claude/skills/author/scripts/verify.sh output-style .claude/output-styles/<name>.md
```

Checks frontmatter delimiters, rejects any key outside the documented four,
requires `description`, and requires `keep-coding-instructions` to be present
and explicitly `true` or `false`.

**Register** — unlike skills and agents, an output style is NOT auto-selected by
existing. Two wirings, neither automatic:

1. To make it the repo default, set `outputStyle: "<name>"` in
   `.claude/settings.json`.
2. To carry it into subagents, put the format into their briefs, or add a
   `SubagentStart` hook that injects this file. Nothing does it for you.
