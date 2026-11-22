// land.helpers.test.ts — Case 28 of the close's suite: a close waits until every helper the thread started has reported back.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.helpers.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(28, 28);
