---
name: implement-audit
description: Review — adversarially check a freshly-built change before it lands.
---
Adversarially review the change you just built, with fresh eyes. The goal is to find what a self-satisfied author would miss.

1. Re-read the SPEC, then the diff. Where do they disagree?
2. Hunt for: missed edge cases (0 / 1 / empty / max / error), inconsistency with sibling code, downstream callers that now break, and silent failure modes.
3. Triage each finding as must-fix, should-fix, or a nit. Fix every must-fix and should-fix whose fix is ready before you commit — the label orders the work within this round, it does not schedule it to a later session. Clear the nits in one pass at the end.

In Claude Code this runs as a fresh-context review agent. In other tools, open a clean chat, load only the SPEC and the diff, and run this review there — a context that wrote the code is the wrong one to judge it.
