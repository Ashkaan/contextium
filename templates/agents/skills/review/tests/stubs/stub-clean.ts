#!/usr/bin/env -S node --experimental-strip-types
// stub-clean.ts — CODEX_BIN stub: reviews successfully and finds nothing,
// emitting the NO_FINDINGS sentinel exactly as the prompt instructs.
//
// The paired opposite of stub-empty.ts. These two differ ONLY by the sentinel
// line, which is the whole point: that one line is what makes "clean" and
// "crashed" distinguishable, so the gate must exit 0 here and 1 there.
import { writeSync } from "node:fs";

writeSync(1, "NO_FINDINGS\n");
