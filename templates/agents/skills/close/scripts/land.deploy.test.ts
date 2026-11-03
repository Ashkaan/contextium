// land.deploy.test.ts — Cases 6–7 of the close's suite: the push check and the journal entry gate.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.deploy.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(6, 7);
