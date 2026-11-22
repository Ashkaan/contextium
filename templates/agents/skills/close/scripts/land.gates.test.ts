// land.gates.test.ts — Cases 8–11 of the close's suite: the auto-close gate and the report.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.gates.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(8, 11);
