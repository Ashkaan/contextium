# /author output-style — branch flow

The fourth type. An output style is a single Markdown file at
`.agents/output-styles/<name>.md` (only Claude Code reads styles; the installer
links `~/.claude/output-styles` to this folder) whose body is APPENDED TO THE SYSTEM PROMPT —
so it is in force on every turn of every session that selects it, and it is the
highest-leverage AI-layer artifact per character.

Authoritative field list read first-hand from `code.claude.com/docs/en/output-styles`.

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
  prompt. Only a `fork` inherits the parent's. So a style whose rules must bind
  a subagent needs a `SubagentStart` hook to carry them — a hook in
  `.agents/hooks/` (`/author hook`) whose allowlist fails closed.
- **It takes effect at session start.** Changes need `/clear` or a new session;
  editing the file does not change the turn you are in.

## Step 1 — cite-evidence

A real cited failure (journal path, commit SHA,
verbatim user correction). A style governs every reply, so "this reads better"
is not evidence. Halt if there is none.

## Step 2 — resolve-shape

Ask the user (a numbered list, recommendation first; in Claude Code, `AskUserQuestion`) for the two decisions the docs make load-bearing:

- **`keep-coding-instructions`** — true when the style changes HOW Claude
  communicates while still doing engineering work; false only when the sessions
  it governs are genuinely not software engineering.
- **Does it need to bind subagents?** If yes, the `register` step wires
  a `SubagentStart` hook; if no, say so explicitly, because the default silently
  does not.

## Step 3 — scaffold

```bash
bash .agents/skills/author/scripts/scaffold.sh output-style <name>
```

Writes `.agents/output-styles/<name>.md` from the template. Refuses on
collision; never overwrites.

## Step 4 — fill

Fill the body. Two shape constraints, both from what a system prompt is:

- **Standing instructions, not a procedure.** The body has no task in front of
  it; it is read before the request exists.
- **Lead with the sentence that decides what gets printed.** Everything after it
  is subordinate to that one, and a reader who stops after the first paragraph
  should already behave mostly right.

Keep project facts OUT — those go to AGENTS.md. A style that names a repo path
or a vendor is usually a rule wearing the wrong hat.

## Step 4.5 — design-review

`/author`'s design-review step, with one addition that matters MORE here: a
system-prompt edit is not sampled at a decision point, it is present in every
reply, so a dropped clause changes every turn rather than a rare one. Decompose
original vs. rewrite into clauses and hand `{original, rewrite, dropped_clauses}`
— and NOT your rationale — to the policy-assigned adversary via
`.agents/skills/review/policy-review.sh adversarial-review <file> <brief>`.
The brief lists every dropped clause and asks for one finding per clause in the
reviewer's own format: a `[must-fix]` naming the clause means it is load-bearing
(restore it and re-run); a `[nit]` or no finding means it was not. Converged =
a round with no `[must-fix]` on any dropped clause.

**Known limit, measured:** the reviewer re-scores the same clause
differently as the surviving pool changes (one clause flipped
from no finding to `[must-fix]` across two rounds on unchanged text). Treat a
single clean round as weaker evidence than it looks.

## Step 5 — verify + register

```bash
bash .agents/skills/author/scripts/verify.sh output-style .agents/output-styles/<name>.md
```

Checks frontmatter delimiters, rejects any key outside the documented four,
requires `description`, and requires `keep-coding-instructions` to be present
and explicitly `true` or `false`.

**Register** — unlike skills and agents, an output style is NOT auto-selected by
existing. Two wirings, neither automatic:

1. To make it the default, set `outputStyle: "<name>"` in
   `~/.claude/settings.json`.
2. To carry it into subagents, add the agent types to the allowlist of the
   `SubagentStart` hook in `.agents/hooks/`. Its allowlist fails closed — an
   unlisted agent type gets nothing.
