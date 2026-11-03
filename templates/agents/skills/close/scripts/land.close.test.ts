// land.close.test.ts — Cases 24–26 of the close's suite: what the close does and requires itself — verify and the journal before anything lands, the review receipt, finished rows set done, audit lines quoted, the report saved.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.close.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(24, 26);
