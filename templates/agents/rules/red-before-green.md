---
paths: null
---

# Red Before Green

A test never seen failing is not evidence. Always loaded.

## red-before-green
Every new function gets a test, and its error and boundary cases get tests too (@rule:boundary-inputs).
Each test MUST be observed FAILING before it is accepted as passing — including when the code was
written first. Then the way to see red is to break the code or the fixture on purpose, run the test,
check the failure message names the thing the test claims, and restore.

A test that has only ever passed may be asserting against a field the code never reads, or against
the arguments a function was called with rather than what it produced; it would stay green with the
feature deleted. `/implement` records the red excerpt as its `test-failure-observed:` line in the
spec's `report.md`. [2026-09-24]
