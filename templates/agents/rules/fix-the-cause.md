---
paths: null
---

# Fix the Cause

Stopping a symptom is not a fix. Always loaded.

## fix-the-cause
A change that stops the symptom while the thing that caused it stays live MUST NOT be reported as a
fix. Find the mechanism that produced the failure and change that.

Two exceptions, and both MUST name the cause they leave in place: restoring service during a live
failure (then fix the cause in the same session, per @rule:no-deferral), and a cause outside this repo
(a vendor bug, a platform limit) — then say where it lives and what would remove it.

A patched symptom returns in the next sibling that shares the cause, and by then the first patch hides
where to look. When the cause is a shared pattern, @rule:class-fix-is-atomic sets the scope.
[2026-09-28]
