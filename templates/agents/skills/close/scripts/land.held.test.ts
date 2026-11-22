// land.held.test.ts — Case 30 of the close's suite onward: a held close keeps every product worktree until its release.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.held.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(30, 99);
