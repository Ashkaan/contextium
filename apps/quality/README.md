---
name: Quality
description: >-
  The repo's own quality checks. Ships lean: the wired check is the commit gate
  (subject discipline + secret scan), with room to grow your own.
category: system
runtime: Manual
---

# apps/quality

Where the repo's own quality checks live. This ships lean: the one wired check is the commit gate.

## What's wired

`.claude/hooks/commit-gate.sh` runs at commit time (PreToolUse on `git commit`, configured in
`.claude/settings.json`). It does two things, both expressions of @rule:mechanisms-not-prose:

- **Subject discipline.** The commit subject must start with an action verb and stay under 100 chars,
  so the git log reads as memory rather than a pile of "wip" and "fix it". It also blocks AI
  co-author trailers, because the commit author is you.
- **Secret scan.** The staged diff is checked for obvious private keys and cloud credentials before
  the commit lands.

That hook is self-contained: no external dependencies, no platform wiring. Copy it and it works.

## Growing this

This is the place to add your own check scripts as your repo grows: a linter pass, a formatter, a
test-runner gate, a docs-drift check. Wire each one as a hook or a step inside a skill so it actually
fires, and keep the set lean. A check that only lives in a document does not run. See
@rule:mechanisms-not-prose and @rule:write-your-own-rules.
