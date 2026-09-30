#!/usr/bin/env -S node --experimental-strip-types
// stub-fail.ts — CODEX_BIN stub: exits non-zero with a diagnostic, standing in
// for an unreachable / broken codex (container down, auth expired).
//
// Simulating the failure with a stub rather than stopping the real container
// keeps a failed test run from leaving the review path broken on what is a
// workstation someone may be mid-session on.
//
// Expected: code-review.ts exits 1 (review did NOT complete).
import { writeSync } from "node:fs";

writeSync(2, "stub-fail: simulated codex failure\n");
process.exit(3);
