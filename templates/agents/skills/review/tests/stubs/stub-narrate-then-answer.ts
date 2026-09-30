#!/usr/bin/env -S node --experimental-strip-types
// stub-narrate-then-answer.ts — CODEX_BIN/GROK_BIN stub: narrates on the first
// call, reviews properly on the second.
//
// Reproduces what a real vendor did, more than once in a row:
// exit 0 with only its own progress narration ("I'll review the full diff...")
// and no triage line. From the chain's side that slot SUCCEEDED, so the walk
// stops and the backup never runs — the review is spent without a review.
// code-review.ts re-asks the same slot once, which is what this stub's second
// call answers.
//
// Statefulness is the point and cannot be faked with a fixed-output stub: the
// two calls must differ. STUB_NARRATE_STATE names the marker file so the caller
// owns the lifetime and two cases in one suite cannot bleed into each other.
import { statSync, writeFileSync, writeSync } from "node:fs";

const STATE = process.env.STUB_NARRATE_STATE || `${process.env.TMPDIR || "/tmp"}/stub-narrate-state`;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

if (isFile(STATE)) {
  writeSync(1, "[must-fix] engine.ts:1: a real finding on the re-ask\n");
  process.exit(0);
}

try {
  writeFileSync(STATE, "");
} catch (e) {
  writeSync(2, `stub-narrate-then-answer.ts: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
}
writeSync(
  1,
  "I'll review the full diff and the changed files against the repo conventions.Reading the full changed implementations and their callers.\n",
);
