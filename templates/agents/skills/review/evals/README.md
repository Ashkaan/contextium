# review evals

`code-review.ts verdict` is a declared `ai_judgment_feature`, so "an eval suite
for every app that calls a model" asks for an eval suite and for it to be re-run
whenever the prompt moves.

**This folder holds one file and it belongs to `../code-review.ts`.**
`caller-contract.eval.ts` grades that reviewer's verdict, so it lives with the
review chain in `.agents/skills/review/` and resolves the scripts it drives one
level up, in this folder's parent.

| Eval | Asks | Costs |
|---|---|---|
| `caller-contract.eval.ts` | Does the reviewer catch a caller the diff never shows it? | one vendor call |

```bash
node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts             # the rerun
node --experimental-strip-types .agents/skills/review/evals/caller-contract.eval.ts --pack-only # free half
```

These are deliberately **not** part of `run-tests.ts` or of anything that runs at
a close. A suite that spends a vendor call per run stops being run, and then it
is a file that looks like a gate rather than one. `code-review.test.ts` does run
the `--pack-only` half, which spends nothing.

Exit 2 is INCONCLUSIVE — the chain was exhausted or timed out, and the review
never happened. Reading that as a failing grade would let a vendor outage
present as a model regression, which is the misreading the whole
`code-review.ts` exit table exists to prevent.

`--pack-only` is not a substitute for the rerun. It proves the pack names the
caller; the rerun proves a reviewer given that pack acts on it. Two claims.
