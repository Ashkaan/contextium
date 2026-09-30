// land.rows.test.ts — Cases 15–20 of the close's suite: roadmap rows, a session outside T3, the script-tests gate, the lock, the final line and the kill points.
//
// The cases live in tests/land-cases.ts, split over three files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.rows.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(15, 99);
