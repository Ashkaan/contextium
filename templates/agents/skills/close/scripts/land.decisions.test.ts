// land.decisions.test.ts — Case 12 of the close's suite: the decision-record gate and a failed git read.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.decisions.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(12, 12);
