# /author rule — branch flow

Absorbed from the retired `/propose-rule` skill (2026-06-08). A rule is the one
type that scaffolds nothing: it is an inline `## <slug>` section appended to an
existing `.agents/rules/*.md` file, not a standalone file. So `scaffold.sh rule
<slug>` writes no file — it validates the slug, checks collision against every
existing rule ID (`@rule:rule-stable-id`), and prints insertion guidance. The
5 steps below are the rule branch's `scaffold`/`fill`/`verify` shape.

Governing rules: `@rule:evidence-required-for-new-rules`, `@rule:rule-stable-id`,
`@rule:evidence-required-for-new-rules`, `@rule:mechanisms-not-prose`,
`@rule:class-fix-is-atomic`, the question of where guidance belongs,
`@rule:no-speculative-enforcement`.

## Critical

- Evidence is required THIS session. A rule without a cited failure (journal path, commit SHA, user-correction quote, monitoring alert) does not ship per `@rule:evidence-required-for-new-rules` + `@rule:no-speculative-enforcement`. No "I think this would be useful."
- Peer-sweep is mandatory. Always run `scripts/grep-rule-peers.sh` against the target file and review every sibling for overlap. ≥2 overlapping siblings = redesign, not append.
- Rule IDs are immutable once shipped. `@rule:<id>` references resolve by grep across the repo (`.githooks/checks/check-rule-refs.sh`); renaming a shipped rule breaks every reference. Pick the slug carefully — `scaffold.sh rule <slug>` rejects a slug that collides with an existing rule.

## Step 1 — cite-evidence

Write a one-sentence evidence citation naming the originating failure. Accept any of:

- Journal entry path: `journal/2026-04-20.md § <session-id>`
- Commit SHA: `abc12345` with subject line
- Direct user correction: quote the user's message + session id
- Monitoring alert: alert name + date
- Weekly aggregator: report date + section

Reject intuition, "this seems useful", hypothetical future failures. Per `@rule:no-speculative-enforcement` and `@rule:evidence-required-for-new-rules`, a rule without a cited failure does not ship. Halt here if there is no evidence.

## Step 2 — pick-surface (declare the deterministic trigger)

Ask the user to pick where the rule lives AND its deterministic trigger. Per the preference for a deterministic trigger + the rule against leaving loading to the model, a new rule DEFAULTS to a deterministic trigger; always-loaded placement is the justified exception, never the default:

- **hook / linter** (commit/edit/tool-time mechanism) → `.agents/rules/{topic}.md`, body trims to a pointer (`@rule:one-behavior-one-surface`)
- **path-scoped** (`paths:` glob — only matters editing certain files) → `.agents/rules/{topic}.md` with `paths:` frontmatter
- **judgment-core always-loaded** (`paths: null`) → ONLY when the rule applies every session AND cannot be checked or path-scoped. The section should carry a `<!-- judgment-core: <reason> -->` marker saying why neither a check nor a path scope can do the job.
- Persistent fact about a person → that person's file under `knowledge/`; domain-specific → that domain's README; multi-step named operation → `.agents/skills/{name}/SKILL.md`

User-level preferences live inlined in `.agents/AGENTS.md § Working preferences`, the working agreement every tool reads. Halt if the user cannot name a deterministic trigger AND the rule isn't genuinely judgment-core — an un-triggered, non-judgment-core rule is not yet well-scoped (the rule against leaving loading to the model bans "load it when relevant").

**Minimal-context body (the keep-the-body-minimal convention):** whichever surface, the rule body is imperative + `[YYYY-MM-DD]` + ≤1-line why + an evidence pointer. The failure story, verbatim quotes, how-to-apply, and amendment narrative are quoted in the session journal (structured bullets) + git history, not inline and NOT in a `knowledge/ai` appendix (retired 2026-07-16; `knowledge/` is user-facing). For always-loaded sections this is enforced (400-char inline-evidence cap).

## Step 3 — scaffold (validate slug, no file write)

Run the collision + kebab check; the rule type prints guidance instead of writing:

```bash
bash .agents/skills/author/scripts/scaffold.sh rule <slug>
```

A collision exits non-zero citing `@rule:rule-stable-id` (IDs are immutable — pick a more specific slug). A clean slug prints the insertion guidance. Then emit the draft in v8 format per `@rule:evidence-required-for-new-rules` + `@rule:rule-stable-id`:

```
## <stable-id-kebab-case>
[When X,] MUST <action>[; MUST NOT <anti>][; <failure class name>]. [YYYY-MM-DD]
Except: <optional exception clause>.
```

Prefer concrete nouns over verbs (`rule-convention-vs-vendor-detail`, not `classify-rule-strings`).

## Step 4 — peer-sweep

Before inserting the drafted rule, list the sibling `## <slug>` sections in the chosen file:

```bash
bash .agents/skills/author/scripts/grep-rule-peers.sh <path-to-rule-file>
```

The script discovers the headings; reviewing each sibling for overlap is the judgment work. Per `@rule:class-fix-is-atomic`, the same loophole in adjacent rules MUST be closed in the same commit. If the new rule subsumes a sibling, delete the sibling outright (remove the `## <slug>` section) and update any `@rule:<slug>` references across the repo. Halt if ≥2 overlapping siblings exist; redesign before continuing.

## Step 5 — verify + register (co-commit)

1. Insert the rule in topic order within the chosen file.
2. Run the rule linters via `verify.sh` (SSOT for the linter set):
   ```bash
   bash .agents/skills/author/scripts/verify.sh rule .agents/rules/<file>.md
   ```
   It short-circuits on the first failing linter. Fix at the source (`@rule:repo-hygiene-fix-at-source`); do not override.
3. Update any skill `enforces:` lists that should reference the new rule (the requirement that every enforces: entry resolves).
4. Commit with `rule(<topic>): <short>` and the evidence citation in the body.

## Step 4.5 — efficacy-gate (compression safety)

Runs for every rule draft; does real work only when clauses were dropped (always,
in the compress flow). It is the numberless answer to "as compact as possible
without losing efficacy": you cut freely, and a blind fresh-context reviewer
forces back only what proves load-bearing.

1. Decompose original vs. rewrite into clauses (method.md § Output contract:
   `directives_original` / `directives_kept`). `dropped_clauses` = original minus
   kept.
2. Dispatch `.agents/reviewers/rule-efficacy-reviewer.md` with `{original,
   compressed, dropped_clauses}` — and NOT your per-clause rationale (blind
   review; the value-test principle in `value-test/RESULTS.md`).
3. Reviewer returns `verdicts: [{clause, verdict, reasoning}]`. Any
   `load-bearing` → restore into the rewrite, re-dispatch. Converged = zero
   load-bearing drops. Then and only then edit the rule text.

`class-fix-is-atomic` is the worked safety case: its exceptions ARE the rule, so
removing one changes a decision → reviewer returns `load-bearing` → kept.
Compression sheds narrative, never normative scope.

## Compress flow (`/author rule --compress <path|slug>`)

Compacts EXISTING rules instead of authoring new ones. Skips Step 1 (evidence
citation) and Step 3 scaffold (no new slug). Per rule:

1. **Decompose** into clauses (method.md Test 1 — clause necessity: "if this
   clause were deleted, what would someone do differently?").
2. **Draft the rewrite** — imperative + `[date]` + ≤1-line why + pointer. Route
   each cut clause by method.md waste category (failure narrative, justification,
   mechanism citation, amendment history, sibling restatement).
3. **Relocate evidence** — for cuts that are failure narrative or justification,
   move the prose to the journal the `[date]` names:
   ```bash
   bash .agents/skills/author/scripts/relocate-evidence.sh <slug> <date> <evidence-file>
   ```
   (idempotent; creates a back-dated stub if that journal is absent). The `[date]`
   IS the link id — no new scheme.
4. **efficacy-gate** (Step 4.5) — restore any load-bearing drop.
5. **Replace in place** and run `verify.sh rule <file>`.

Whole-file batch (e.g. `.agents/rules/feedback.md`): enumerate `## <slug>`
sections via `scripts/grep-rule-peers.sh`, run each through 1–5, commit the file's
rules together (`@rule:class-fix-is-atomic` — compress the file atomically, don't
drip). Always-loaded files first; path-scoped files carry zero budget so they are
lower priority. `chars_before`/`chars_after` are recorded as observations, never
targets.

## Amendment vs. new rule

If `peer-sweep` finds an existing rule with the same intent, this is an AMENDMENT, not a new rule: edit the existing rule's body in place with a `[Amended YYYY-MM-DD: ...]` clause + journal citation, and do NOT add a second `## <slug>`.
