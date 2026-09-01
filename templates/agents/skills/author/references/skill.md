# /author skill — branch flow

Scaffolds `.agents/skills/<name>/SKILL.md` from `references/templates/skill.template.md`,
then fills the placeholders. Skills are auto-discovered by directory presence —
there is no register step.

Governing rules: `@rule:skill-required-frontmatter`, `@rule:skill-step-graph`,
`@rule:skill-step-graph`, `@rule:skill-step-graph`,
`@rule:tiebreaker-skill-vs-agent`.

## Step 1 — resolve shape (ask the user)

Decide the two structure-determining questions before scaffolding:

| Question | Why it matters |
|---|---|
| Skill or agent? | A skill needs session history (orchestration, user-facing slash command, commit/push, editing on session state). If the work benefits from FRESH context (adversarial review, cold-reader analysis, isolated investigation), it is an agent — use `/author agent` instead (`@rule:tiebreaker-skill-vs-agent`). |
| Gated step graph, or single-body? | If the skill has gates (user questions, halt, shell checks, agent/skill dispatch), it MUST declare a `steps:` graph with each step's `id` + `kind` + (`action:` or `gate:` with `tool`+`on_fail`), and every step id MUST have a matching body section (`@rule:skill-step-graph` + `@rule:skill-step-graph` + `@rule:skill-step-graph`). Simple skills omit `steps:`. |
| Which steps are deterministic? | Enumerate every step. For each, apply the data-vs-judgment test (`@rule:deterministic-over-ai`): a lookup, computation, format/shape check, grep, fixed transform, or validation is DATA → it becomes a `scripts/<name>.sh`. Only classification, synthesis, design choice, or generation stays in the body as AI judgment. A skill that describes a deterministic step in prose instead of calling a script is the `@rule:mechanisms-not-prose` failure this skill exists to prevent. |

## Step 2 — scaffold

```bash
bash .agents/skills/author/scripts/scaffold.sh skill <name>
```

Writes `.agents/skills/<name>/SKILL.md` with `{{name}}` substituted. Refuses if the directory already exists (never overwrites). A non-kebab name is rejected with the `^[a-z][a-z0-9-]*$` convention; an empty name is the "no name" boundary — prompt for one.

## Step 2.5 — extract deterministic steps to scripts/ (hard checklist)

Before filling prose, act on the determinism inventory from Step 1. This is the step whose omission made past skills non-deterministic — do NOT skip it.

- For EACH step the inventory marked DATA, write `.agents/skills/<name>/scripts/<step>.sh` (or `.ts`) with `set -euo pipefail`, a one-line contract comment, and a paired `<step>.test.sh` with the 0/1/empty/max/error boundary rows (`@rule:boundary-inputs` + the convention that apps ship with tests for skill scripts). Mirror `.agents/skills/author/scripts/scaffold.sh` for shape.
- The SKILL.md body step then INVOKES the script (`bash scripts/<step>.sh ...`) — it MUST NOT re-describe the deterministic logic in prose. The script is the SSOT (`@rule:single-source-of-truth`).
- Add each script to `peers:`.
- Only steps that survive the data-vs-judgment test as genuine JUDGMENT stay as prose body sections. If the inventory found zero deterministic steps, say so explicitly — a single-body judgment-only skill is legitimate, but "I didn't look" is not.
- Carve-out: a script whose only caller is this skill AND that is session-safe (pure / read-mostly, no host or infra mutation) lives in `scripts/`; anything that mutates infrastructure or must outlive the session is an app, not a skill script (the convention that apps live in this repo).

## Step 3 — fill

Fill every `TODO` in the scaffold — this is the only AI-judgment step:

- `description:` is the **invocation trigger**, not a label — the model reads it to decide when to auto-fire the skill. Per Anthropic's Agent Skills guidance ([code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills)): write it in **third person** ("Scaffolds…", not "I scaffold…"); state WHAT it does AND WHEN to use it; keep `description` (+ optional `when_to_use`) **under 1,536 characters combined** — overflow collapses the skill to name-only in listings and kills discoverability.
- Set `disable-model-invocation` explicitly (`false` = user-slash-invocable; `true` = user-initiated-only, e.g. deploy/send).
- `argument-hint:` when the skill takes args (remove the field otherwise).
- `enforces:` lists every `@rule:<id>` the skill mechanizes (may stay `[]`). Each MUST resolve to a real rule (the requirement that every enforces: entry resolves).
- `peers:` lists co-located files the skill loads (references, scripts, dispatched agents/skills).
- If gated, write the `steps:` graph and a matching body section per step id.
- **Body ≤500 lines** (Anthropic adherence + token guidance). Past that, split detail into `references/<topic>.md` and link it — files you reference but don't inline cost ZERO context until read (progressive disclosure). Keep references **one level deep** from SKILL.md; nested reference→reference chains get partial `head` reads.
- **Low-context determinism — inline data, not fetch-instructions.** When the skill needs live repo state, prefer dynamic context injection (`` !`command` `` inline, or a `` ```! `` block) so the command's OUTPUT lands in the skill body, instead of writing prose telling the model to "run X to get context." Actual data beats an instruction to go get it — lower latency, deterministic, and it keeps the judgment step about the data, not about fetching it. This is the SKILL.md analogue of Step 2.5's script extraction.

## Step 4 — verify

```bash
bash .agents/skills/author/scripts/verify.sh skill .agents/skills/<name>/SKILL.md
```

Delegates to `check-skill-format.sh` — checks frontmatter fields, `enforces:` resolution, and (when present) step-graph + body-step parity. MUST exit 0 before the branch completes. Fix at source (`@rule:repo-hygiene-fix-at-source`).

## Step 5 — register

None. Skills are auto-discovered from `.agents/skills/<name>/SKILL.md`. Done after verify passes.
