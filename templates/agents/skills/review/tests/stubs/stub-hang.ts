#!/usr/bin/env -S node --experimental-strip-types
// stub-hang.ts — CODEX_BIN stub: sleeps well past any sane review timeout.
//
// Stands in for a review that hangs until killed. Run this with a short
// POLICY_CHAIN_SLOT_TIMEOUT_S so the assertion is fast.
//
// Expected: code-review.ts exits 124 (coreutils timeout convention).
setTimeout(() => process.exit(0), 600_000);
