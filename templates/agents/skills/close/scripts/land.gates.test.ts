// land.gates.test.ts — Cases 8–12 of the close's suite: the auto-close gate, the report, the decision-record gate and a failed git read.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.gates.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(8, 12);
