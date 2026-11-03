// land.manifests.test.ts — Cases 13–14 of the close's suite: the integration-manifest, skill-manifest, workbench roadmap, merged-tree app check, secrets and standards gates.
//
// The cases live in tests/land-cases.ts, split over eight files so that no
// one suite outruns verify.ts's per-suite timeout; that file says why.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/land.manifests.test.ts
import { runCases } from "./tests/land-cases.ts";

runCases(13, 14);
