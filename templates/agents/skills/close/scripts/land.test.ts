// land.test.ts — Cases 1–5 of the close's suite: the close itself — landing, conflicts and journal names.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(1, 5);
