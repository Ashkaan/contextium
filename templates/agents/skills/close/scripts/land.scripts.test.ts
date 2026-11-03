// land.scripts.test.ts — Cases 17–23 of the close's suite: the script-tests gate, the lock, the final line, the kill points, the script roots, the harness links and the hold.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.scripts.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(17, 23);
