# AGENTS.md

The working agreement for {{NAME}}'s workbench: the one repo that holds every project, its records
and the skills that work on them. Every AI tool this workbench supports reads this file at the root,
directly, so there is one copy and nothing to keep in sync. Read it first each session.

The sections between `<!-- contextium:… -->` and `<!-- /contextium -->` belong to Contextium and are
replaced whenever you re-run its installer. Everything outside them is yours and is never touched:
edit the preferences, fill in the stack, add your own sections and standards.

## Working preferences

- MUST respond concise, direct, practical; NEVER pad. Technical depth welcome.
- MUST name in plain English anything the reader has not seen this session (a project, a spec
  number, a tool, an acronym) the first time it appears; when something is unclear the fix is plainer
  words, NEVER more of them.
- MUST pick the shortest format that stays clear (prose, table, or list); NEVER add structure the
  answer does not need.
- MUST push back with better approaches when warranted; NEVER agree by default.
- MUST default to implementation over planning; NEVER expand a 30-minute task into a 3-hour plan.
- {{AUTONOMY}}
- MUST NOT declare a feature shipped while a known blocker remains.

## Stack

Document your runtime, orchestration, storage and credentials here. A fresh session reads this before
it reads any code, so it is the cheapest place to prevent a wrong assumption.

<!-- contextium:layout -->
## What lives where

| Path | Holds |
|---|---|
| `AGENTS.md` | this file — a link to `.agents/AGENTS.md` |
| `.agents/skills/` | the skills, each with its scripts and the templates it writes; `review/` is the reviewer chain |
| `.agents/agents/` | the agent prompts the skills dispatch in a fresh context |
| `.agents/checks/` | the checks `land.ts` runs before it commits: decision records, skills, integration manifests, script tests, standards citations, secrets |
| `.agents/hooks/` | the pre-tool guards: no host change without asking, no write into the shared checkout |
| `.agents/generators/` | the index generators for `apps/`, `integrations/`, `projects/` |
| `.agents/output-styles/` | Claude Code output styles `/author` writes, reached through `~/.claude/output-styles` |
| `.agents/harness` | `harness=` the tool you drive the workbench with (it decides where session worktrees go), `agent=` the model family that writes the code (the reviewer chain leaves it out), and `tools=` every tool the installer has wired here, which a re-run keeps wiring until `install.sh --drop-tool <name>` |
| `.agents/hooks/claude-hooks.json` | the guards in the shape Claude Code, Codex and Grok Build read, with yours added by the installer |
| `.agents/user-hooks.json` | your own hooks, on any event, in that same shape; the installer merges them in and never overwrites the file |
| `.agents/gemini-settings.json` | Gemini CLI's settings: `AGENTS.md` as its context file, and the guards; there while `tools=` names Gemini CLI |
| `.agents/user-gemini-settings.json` | your own Gemini CLI settings; the installer merges them in and never overwrites the file |
| `.agents/hooks.json` | the guards in Antigravity's shape; there while `tools=` names Antigravity |
| `apps/`, `integrations/`, `projects/`, `journal/`, `knowledge/`, `decisions/` | your work — the layer never overwrites these |

A re-run of the installer replaces each skill, agent, hook, check and generator Contextium ships,
and leaves alone anything you add beside them in those folders.

Codex, Cursor, VS Code with Copilot, Antigravity, Grok Build and Gemini CLI read `AGENTS.md` and
`.agents/skills/` in the workbench natively; Claude Code reads `AGENTS.md` (2.1.277 or later) and
reaches the skills through `~/.claude/skills`. Grok Build loads project files only in a trusted
folder. There is one guard manifest per format, and each wired tool's hook location links to it:
`~/.codex/hooks.json` (Codex, after a one-time hook trust) and `~/.grok/hooks/contextium.json`
(Grok Build) to `.agents/hooks/claude-hooks.json`, and `.gemini/settings.json` to
`.agents/gemini-settings.json` (Gemini CLI; its hooks follow its package source and have not been
run). Claude Code's `~/.claude/settings.json`, and a Codex hooks file of your own, get the
guards merged in instead; Antigravity reads `.agents/hooks.json` in place. Contextium wires no
guards for Cursor or VS Code.

`.agents/skills/review/policy.json` routes each kind of review — code, spec, the spirit check of a
spec against your words, a debate or investigation panel — to the models that answer it, in order.
A review leaves out the model named `agent=` in `.agents/harness`; with no other model installed it
falls back to a fresh context on the authoring model and says so.

A project lives in `projects/<domain>/<YYYY-MM-DD>_<slug>/`: `README.md` (status frontmatter, Goal,
Outcome — its `next:` derived from the roadmap, never typed), `ROADMAP.md` (the only list of what is
left), `specs/NNN-name/` (one spec folder per roadmap row) and `decisions/`. The templates live beside
the skill that writes each.
<!-- /contextium -->

<!-- contextium:records -->
## Records

A record is a file in this workbench, and a session writes it where it writes code: in its own
worktree, by relative path (`knowledge/...`, `journal/...`, `projects/...`), which `/close` then
lands. A write straight into the shared checkout is in no worktree, so no close commits it and the
report cannot mention it; `bash .agents/skills/close/scripts/write-root.sh .` prints this session's
worktree, and for another repo a session writes (a product) `write-root.sh /abs/path` hands back a
worktree of that repo. Before reading, editing or running a file in another repo (a sibling checkout,
a product worktree), first read the nearest `AGENTS.md` at or above that path, up to that repo's
root, once, and follow it alongside this file: no harness loads a rules file from a repo it did not
open. Your own facts (location, timezone, family) live in `knowledge/` — read them when a fact is
needed; never infer one.

A journal day is a FOLDER, not a file: `journal/<date>/` holds one file per session,
`HHMM-<slug>.md`, and a `0000-` name is the day's own record rather than a session. Read a day by
listing its folder; an absent folder means nobody worked that day. The entry's shape is defined once,
in `.agents/skills/close/references/journal-entry.md`.
<!-- /contextium -->

<!-- contextium:skills -->
## Skills

The skill folders live at `.agents/skills/` in this workbench; a session runs the copy in its
worktree (`node --experimental-strip-types .agents/skills/<name>/scripts/...`). The harnesses read
the landed checkout through home links — `~/.agents/skills` → `<workbench>/.agents/skills`, with
`~/.claude/skills` and `~/.gemini/config/skills` linked to it, and `~/.claude/agents` →
`<workbench>/.agents/agents` — which `.agents/checks/check-harness-config-links.ts` asserts. Three verbs, fresh context between
thinking and doing:

- `/project` → `/spec` — think. Writes a SPEC, audits it, closes itself.
- `/implement` — do. Builds, runs `/implement-audit`, closes itself.
- `/close` — verify, record, land every worktree this session owns. The producer verbs invoke it
  themselves; you do not type it to end one. Its last line is printed only by `land.ts`, after it has
  proved against `origin/<trunk>` that nothing was left behind.

Each artifact gets exactly one machine reviewer, fired by whatever produced it.
<!-- /contextium -->

<!-- contextium:skill-shape -->
## Skill shape

A skill is what the [Agent Skills specification](https://agentskills.io/specification) says it is,
and nothing more. The rules below are checked by `.agents/checks/check-skills.ts`; everything else
points here rather than restating them (one fact, one file).

**Frontmatter** is the specification's six keys — `name`, `description`, `license`, `compatibility`,
`metadata`, `allowed-tools` — and no other top-level key. The published validator, not this prose, is
the list: a key it does not allow fails the check, whatever this section says. `description` carries
both what the skill does and when to use it, at most 1,024 characters; there is no separate trigger
field. `allowed-tools` is one space-separated string. A YAML frontmatter uses block form only — the
validator rejects flow syntax such as `[a, b]` and `{k: v}`.

**`metadata.peers`** is the one custom key: a space-separated string of the paths the skill loads or
dispatches (its references, scripts, the skills and agents it calls), each relative to the workbench
root (`.agents/skills/<skill>/…`, `apps/…`, `knowledge/…`). No other `metadata` key is allowed, and
an empty string is a violation — name the peers or drop the key.

**Which skills the model may fire on its own is harness configuration, never a file field.** On
Claude Code it is `skillOverrides` in `~/.claude/settings.json`; other harnesses list every skill by
name and description or hide skills by path in their own settings. `disable-model-invocation`,
`when_to_use`, `argument-hint`, `steps`, `enforces`, `handoffs_to` and `handoffs_from` are not skill
fields, and the check refuses them.

**`assets/` is what a skill ships with; `state/` is what it has learned.** Data a skill accumulates
across sessions — a learned map, a track record — lives in `<skill>/state/`, written in the session's
worktree (`write-root.sh .`) like any other edit here. It is never loaded at activation: `SKILL.md`
must not name a `state/` path, and a `state/` folder must hold `_doc.md` describing what the folder
holds and naming, by path relative to the skill root, the script that writes and reads it.

**The body** has no length limit. Deterministic where possible — every lookup, transform, check or
computation is a script file in `scripts/` that the body invokes, never prose describing the steps —
and concise and effective. Judgment stays in the body; data comes from a script. References are one
level deep from `SKILL.md`.

**The check.** `node --experimental-strip-types .agents/checks/check-skills.ts --all` holds every
folder to the above; `land.ts` runs it with `--since` over the skill folders the session's worktree
changed before each commit, and `/author`'s verify step runs it on the skill it scaffolded. It uses the published validator
(`skills-ref`) when that is installed and a built-in reading of the same rules, in the validator's
wording, when it is not.
<!-- /contextium -->

<!-- contextium:standards -->
## Standards

The judgment rules a proposed change is measured against. A change that breaks one of these is not a
good change however well it works. Cite one as `AGENTS.md § Standards → <name>`, the name being its
bold words; `.agents/checks/check-standards-refs.ts` refuses a citation that names no bullet. Add your
own as bold-led bullets in a section of your own, outside this block — an upgrade replaces this block
whole.

- **Data is fetched, judgment is prompted.** When an authoritative deterministic source exists — a
  REST API, a stable HTML anchor, a computation, a lookup table, a repo file — use it. Never
  substitute a model call for data that already exists at a known URL, query or formula.
- **Read before asserting.** Any claim about repo state, platform contracts, API limits, versions,
  counts, dates or a causal mechanism needs a first-hand reading this session, named, and able to
  come back negative. A README, a function's name, a summary, an earlier write-up and a tool result
  are all claims, not readings. For a causal claim, name the competing explanation and the reading
  that rules it out.
- **A class fix is atomic.** When the flaw is a shared pattern, sweep for every instance and fix them
  all in the same session. Sweep the mechanism, not the file, and account for every match the sweep
  reports. Deferring a peer to a later phase, a project's future-work section, or an exemption list
  is not allowed; only the user can authorize one, and only for the specific peer in front of them.
- **No deferral.** Everything surfaced is either done now or explicitly blocked on something only the
  user can clear — money, an outbound message, host infrastructure, a vendor. "Follow-up", "next
  step", "out of scope", "too complex" and "want me to also…?" are not blockers. **Neither is a
  question.** Once the work is named and authorized, do it and report — "want me to…?", "shall I…?"
  and "X, or keep going?" are deferral in the interrogative, and the turn they cost rarely changes
  the answer.
- **Fix the cause.** A change that stops the symptom while the thing that caused it stays live is not
  a fix, unless it is restoring service during a live failure or the cause is outside this repo — and
  then it must name the cause it does not address.
- **Simplest mechanism that works.** Inline script before shared module before daemon. "Shared by
  other automations" means a shared function, not a deployed service. Where every caller is your own
  code, defense-in-depth is usually over-engineering.
- **Plan the four before building.** Downstream consumers, peer files doing the same thing, edge cases
  at 0 / 1 / empty / max / error, and which docs drift.
- **Tests and evals.** Every new function gets a test, error and boundary cases get tests, and a
  failing test is observed red before it is made green — INCLUDING when the code was written first,
  where the way to see red is to break the code or the fixture on purpose and check that the message
  names the thing the test claims. A test that has never failed is not evidence: it may be asserting
  against a field the code never reads, or against the arguments a function was called with rather
  than what it produced. Any app that calls a model carries an eval suite and re-runs it when its
  prompt moves. A script's test runs it as a program — `bash x.sh`, `node x.ts`, never `source` or
  `import` — so the test survives the script changing language, and
  `.agents/checks/check-scripts.ts` refuses a close that changes a script under `.agents/` without
  a paired test.
- **One fact, one file.** A rule, a step definition, a wire format or a schema lives in exactly one
  place and is referenced from everywhere else, never mirrored as prose.
- **A decision that would be expensive to reverse gets a record** in the narrowest `decisions/`
  folder containing everyone who could act contrary to it; the format and the placement rule are
  `decisions/README.md`.
- **Fix lint at the source.** Never add a file to an exclude list to silence it. Markdown is not code
  and gets no auto-formatting.
- **Prefer the API to SSH.** Research what a target exposes before choosing a transport and prefer
  HTTP/REST/S3 whenever one exists and it does not lengthen the path. SSH is for targets with no API
  or artifacts already on the runner. One carve-out: a repo path an automation WRITES must be read
  over SSH, because a read that 404s returns empty and an automation that reads-then-writes will
  commit that emptiness over real data.
- **Deploy is part of implementing.** Where the workbench deploys, let the merge deploy, verify it
  landed, and say so with the evidence — never hand back a command to run.
- **Anything a client could receive is drafted for the user to send, never sent.**
- **Don't build enforcement for a failure that has not happened yet**, and when a new pattern needs
  guarding, extend the mechanism that already exists.
- **A ship-claim needs a tool-call trace from this session.** "Deployed", "landed", "pushed", "it
  works", "verified" — each is a claim about the world, and the evidence is a command run in this
  session with its output read, named where the claim is made. A script's own proof counts and is
  preferred: the close's last line exists because a sentence about `origin/<trunk>` is worth only as
  much as the check behind it. Memory of having done it does not count, and neither does having
  written the code that would do it.
<!-- /contextium -->
