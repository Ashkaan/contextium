---
name: implement-audit
description: Review — adversarially check a freshly-built change before it lands.
---
Adversarially review the change you just built, with fresh eyes. The goal is to find what a self-satisfied author would miss.

1. Re-read the SPEC, then the diff. Where do they disagree?
2. Hunt for: missed edge cases (0 / 1 / empty / max / error), inconsistency with sibling code, downstream callers that now break, and silent failure modes.
3. Triage findings into fix-now versus genuinely out-of-scope. Fix every fix-now finding before committing.

In Claude Code this runs as a fresh-context review agent. In other tools, open a clean chat, load only the SPEC and the diff, and run this review there — a context that wrote the code is the wrong one to judge it.
