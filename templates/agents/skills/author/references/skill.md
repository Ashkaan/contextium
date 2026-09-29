# /author skill — branch flow

Scaffolds `.agents/skills/<name>/SKILL.md` from `references/templates/skill.template.md`,
then fills the placeholders. Skills are auto-discovered by directory presence —
there is no register step.

Governing shape: `AGENTS.md § Skill shape`; the skill-vs-agent
tiebreaker is session history (skill) versus fresh context (agent).

## Step 1 — resolve shape (ask the user: a numbered list, recommendation first; in Claude Code, `AskUserQuestion`)

Decide the two structure-determining questions before scaffolding:

| Question | Why it matters |
|---|---|
| Skill or agent? | A skill needs session history (orchestration, user-facing slash command, commit/push, editing on session state). If the work benefits from FRESH context (adversarial review, cold-reader analysis, isolated investigation), it is an agent — use `/author agent` instead. |
| Gated, or single-body? | If the skill has gates (a question, a halt, a shell check, an agent/skill dispatch), each gate is a named body section stating its check and what happens on failure; the body IS the step graph (the frontmatter carries none). Simple skills are one body. |
| Which steps are deterministic? | Enumerate every step. For each, apply the data-vs-judgment test: a lookup, computation, format/shape check, grep, fixed transform, or validation is DATA → it becomes a `scripts/<name>.sh`. Only classification, synthesis, design choice, or generation stays in the body as AI judgment. A skill that describes a deterministic step in prose instead of calling a script is the failure this skill exists to prevent. |

## Step 2 — scaffold

```bash
bash .agents/skills/author/scripts/scaffold.sh skill <name>
```

Writes `.agents/skills/<name>/SKILL.md` with `{{name}}` substituted. Refuses if the directory already exists (never overwrites). A non-kebab name is rejected with the `^[a-z][a-z0-9-]*$` convention; an empty name is the "no name" boundary — prompt for one.

## Step 2.5 — extract deterministic steps to scripts/ (hard checklist)

Before filling prose, act on the determinism inventory from Step 1. This is the step whose omission made past skills non-deterministic — do NOT skip it.

- For EACH step the inventory marked DATA, write `.agents/skills/<name>/scripts/<step>.sh` (or `.ts`) with `set -euo pipefail`, a one-line contract comment, and a paired `<step>.test.sh` with the 0/1/empty/max/error boundary rows. Mirror `.agents/skills/author/scripts/scaffold.sh` for shape.
- The SKILL.md body step then INVOKES the script (`bash scripts/<step>.sh ...`) — it MUST NOT re-describe the deterministic logic in prose. The script is the SSOT.
- Add each script to `metadata.peers`.
- Only steps that survive the data-vs-judgment test as genuine JUDGMENT stay as prose body sections. If the inventory found zero deterministic steps, say so explicitly — a single-body judgment-only skill is legitimate, but "I didn't look" is not.
- Carve-out: a script whose only caller is this skill AND that is session-safe (pure / read-mostly, no host or infra mutation) lives in `scripts/`; anything that mutates infrastructure or must outlive the session is an app, not a skill script.

## Step 3 — fill

Fill every `TODO` in the scaffold — this is the only AI-judgment step:

- The frontmatter is the Agent Skills specification's six keys and nothing else; `AGENTS.md § Skill shape` is the one statement of the shape, the `metadata.peers` key, the `state/` convention and the body standard — read it, do not restate it here.
- `description:` is the **invocation trigger**, not a label — the model reads it to decide when to fire the skill. Write it in **third person** ("Scaffolds…", not "I scaffold…"); state WHAT it does AND WHEN to use it, trigger phrases included, in as many sentences as that takes and at most **1,024 characters** — the spec's cap, and `check-skills.sh` fails past it. There is no separate trigger field.
- Whether only the user may fire the skill is not a file field: set `skillOverrides` in `~/.claude/settings.json` (`"user-invocable-only"`) — the activation-fields step in SKILL.md is the SSOT for when.
- `allowed-tools:` (one space-separated string) when the skill's own commands would otherwise prompt every run; remove the field otherwise.
- `metadata:` → `peers:` lists, as one space-separated string, the co-located files the skill loads (references, scripts, dispatched agents/skills).
- **Low-context determinism — inline data, not fetch-instructions.** When the skill needs live repo state, prefer dynamic context injection (`` !`command` `` inline, or a `` ```! `` block) so the command's OUTPUT lands in the skill body, instead of writing prose telling Claude to "run X to get context." Actual data beats an instruction to go get it — lower latency, deterministic, and it keeps the judgment step about the data, not about fetching it. This is the SKILL.md analogue of Step 2.5's script extraction.
- The body has no length limit; the standard is deterministic where possible (scripts in `scripts/`), concise and effective. Detail that loads only on demand goes in `references/<topic>.md`, one level deep from SKILL.md.

## Step 4 — verify

```bash
bash .agents/skills/author/scripts/verify.sh skill .agents/skills/<name>/SKILL.md
```

Delegates to `.agents/checks/check-skills.sh` — the published Agent Skills validator plus the local rules `AGENTS.md § Skill shape` states — then checks the description for first person and the references for depth. MUST exit 0 before the branch completes. Fix at source.

## Step 5 — register

None. Skills are auto-discovered from `.agents/skills/<name>/SKILL.md` (every harness reaches it through its home link). Done after verify passes.
