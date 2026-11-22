// land.lock.test.ts — Case 29 of the close's suite: the repo lock is free while the gates and an owed deploy run.
//
// The cases live in tests/land-cases.ts, split over several files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why and how many.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.lock.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(29, 29);
