# Where these templates come from

spec-kit ([github/spec-kit](https://github.com/github/spec-kit)) tag `v1.0.10`,
released 2026-09-22: commit `b5d97b41a3ad703800179eab0e711c1d7173422e` (annotated tag object
`6af89a4b2156966e8a1d62ee4d1dbad4ba15a200`). Every vendored file is spec-kit's
bytes at that commit, plus a first-line `<!-- source: … -->` comment and blocks
fenced `<!-- contextium: <name> -->` … `<!-- /contextium -->`. Nothing of ours
sits outside a block, so a re-vendor is a three-way diff against this commit.

| File | Upstream path | Tag | Commit | Contextium blocks |
|---|---|---|---|---|
| `spec.md` | `templates/spec-template.md` | v1.0.10 | `b5d97b41a3ad703800179eab0e711c1d7173422e` | `header` (Type, Complexity, Systems Affected, Roadmap; `## Clarifications`), `behavior`, `boundaries`, `acceptance` |
| `plan.md` | `templates/plan-template.md` | v1.0.10 | `b5d97b41a3ad703800179eab0e711c1d7173422e` | `simplest-shape`, `inputs-outputs` (with data sourcing), `constitution`, `patterns`, `failure-modes`, `validation` |
| `tasks.md` | `templates/tasks-template.md` | v1.0.10 | `b5d97b41a3ad703800179eab0e711c1d7173422e` | `tests-required` (top, and once per user story), `live-walk`, `task-lines` |
| `research.md` | `templates/commands/plan.md:114-135`, Phase 0; its entry format is lines 130-133 | v1.0.10 | `b5d97b41a3ad703800179eab0e711c1d7173422e` | `sources`, `decision-records`. Not a file upstream, so there is nothing to diff; the Phase 0 steps and the `Decision` / `Rationale` / `Alternatives considered` fields are spec-kit's words |

Not adopted: `constitution-template.md` (AGENTS.md and its Standards section
are the constitution) and `checklist-template.md`
(`/spec-audit` is the checklist).

The roadmap template is vendored beside `/project`, in
`.agents/skills/project/references/templates/`, whose `SOURCE.md` pins the same
commit.

## Checking the vendored bytes

Run from the repo root; needs the GitHub CLI (`gh`). Each file prints
`verbatim outside contextium blocks`, or the diff that says otherwise.

```bash
SHA=b5d97b41a3ad703800179eab0e711c1d7173422e; T=.agents/skills/spec/references/templates
for f in spec plan tasks; do
  diff <(gh api "repos/github/spec-kit/contents/templates/$f-template.md?ref=$SHA" --jq .content | base64 -d) \
       <(sed -e '1{/^<!-- source:/d;}' -e '/^<!-- contextium:/,/^<!-- \/contextium -->/d' "$T/$f.md") \
    && echo "$f: verbatim outside contextium blocks"
done
```
