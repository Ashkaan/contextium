---
name: spec-audit
description: Review — attack the SPEC before any code is written.
---
Review the SPEC you just wrote, adversarially, before it becomes code. A design flaw caught here costs a paragraph; the same flaw caught after the code exists costs the implementation.

1. Read the SPEC against what was actually asked. Does it describe that thing, or a fancier interpretation of it? A SPEC can be internally excellent and solve the wrong problem.
2. Attack the design: missing edge cases (0 / 1 / empty / max / error), downstream callers it doesn't mention, sibling code it leaves inconsistent, failure modes it never names, a shape heavier than the ask, and a "done" section that isn't an actual runnable command with an actual expected output.
3. For each finding, either fix the SPEC now or write down why the finding is wrong. Those are the only two options — "track it for later" is how a known flaw ships.

In Claude Code this runs on a different model from the one that wrote the SPEC, when one is installed. In other tools, open a clean chat — ideally in a different assistant — load only the ask and the SPEC, and run this review there. The author is the worst reviewer of their own design.
