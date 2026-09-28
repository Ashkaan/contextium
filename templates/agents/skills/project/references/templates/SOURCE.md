# Where these templates come from

| File | Upstream path | Tag | Commit | Contextium blocks |
|---|---|---|---|---|
| `ROADMAP.md` | `docs/concepts/spec-of-specs.md`, § The roadmap artifact — the fenced "minimal template" block (lines 57-69) | v1.0.10 | `b5d97b41a3ad703800179eab0e711c1d7173422e` (annotated tag object `6af89a4b2156966e8a1d62ee4d1dbad4ba15a200`) | `rules` |
| `README.md` | ours — no upstream | — | — | — |

spec-kit ([github/spec-kit](https://github.com/github/spec-kit)) publishes the
roadmap only as a block inside a docs page, so the vendored file is that
block's contents plus a first-line `<!-- source: … -->` comment and one block
fenced `<!-- contextium: rules -->` … `<!-- /contextium -->`. The spec, plan,
tasks and research templates are vendored beside `/spec`, in
`.agents/skills/spec/references/templates/`, whose `SOURCE.md` pins the same
commit.

## Checking the vendored bytes

Run from the repo root; needs the GitHub CLI (`gh`).

```bash
SHA=b5d97b41a3ad703800179eab0e711c1d7173422e; T=.agents/skills/project/references/templates
diff <(gh api "repos/github/spec-kit/contents/docs/concepts/spec-of-specs.md?ref=$SHA" --jq .content | base64 -d \
        | awk '/A minimal template:$/{f=1;next} f&&/^```markdown/{p=1;next} p&&/^```/{exit} p') \
     <(sed -e '1{/^<!-- source:/d;}' -e '/^<!-- contextium:/,/^<!-- \/contextium -->/d' "$T/ROADMAP.md") \
  && echo "roadmap: verbatim outside contextium blocks"
```
