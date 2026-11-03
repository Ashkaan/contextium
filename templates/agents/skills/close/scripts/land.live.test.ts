// land.live.test.ts — Case 27 of the close's suite: live checks owed before the push, the forced hold, and the release that proves each on what is live.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.live.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(27, 99);
