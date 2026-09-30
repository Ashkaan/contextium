// land.gates.test.ts — Cases 8–14 of the close's suite: the auto-close gate, the report and the pre-commit gates (secrets and standards among them).
//
// The cases live in tests/land-cases.ts, split over three files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.gates.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(8, 14);
