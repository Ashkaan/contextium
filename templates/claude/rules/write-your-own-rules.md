# Write Your Own Rules

A guide to growing this layer for your own work. Always loaded — it's the meta-rule that tells you how
to add the rest.

## write-your-own-rules
The rules in `.claude/rules/` are the starter set: voice, depth, boundaries, simplicity, no-deferral,
mechanisms, journal format. They encode a methodology, not your specifics. The system gets valuable as
you add rules that capture *your* corrections and *your* domain. Here is the discipline for doing that
well.

**Add a rule when there is evidence, not a hunch.** The right trigger is a real failure: the AI did
something wrong, you corrected it, and you want that correction to stick. Write the rule so the next
session won't repeat the mistake. A rule invented for a failure that has never happened is speculative
and usually becomes noise. (See @rule:mechanisms-not-prose on speculative enforcement.)

**Shape of a good rule:**
- A kebab-case id as a `## heading`, so other files can cite it (a reference of the
  form `@rule:` plus the id resolves to this heading).
- An imperative body: MUST / MUST NOT / SHOULD, with the boundary stated plainly.
- One line on *why* — the failure or principle behind it — so a future reader can tell whether it
  still applies.
- A backing mechanism if the rule is load-bearing (a hook, a check, a skill step). If you can't
  mechanize it, keep it short and accept it's advisory.

**Keep the set lean.** Every rule loaded into context costs attention. Prune rules that stopped
firing, fold duplicates together, and prefer extending an existing rule over adding a near-twin. A
growing rule count with no deletion gradient produces compliance theater, not better behavior.

**Path-scope what isn't universal.** A rule that only matters when editing one kind of file should
load only then, not on every prompt. The starter rules here are deliberately universal; your
domain-specific ones often shouldn't be.

When a correction recurs and you want it enforced, that is the signal to write it down — once, in one
file, with a mechanism if it matters. That loop, more than any single rule, is what makes the layer
yours.
