// land.journal.test.ts — Case 7 of the close's suite: the journal entry gate.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.journal.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(7, 7);
