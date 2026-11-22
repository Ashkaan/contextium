// land.deploy.test.ts — Case 6 of the close's suite: the deploy check.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.deploy.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(6, 6);
