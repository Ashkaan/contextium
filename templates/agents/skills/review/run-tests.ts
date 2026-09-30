#!/usr/bin/env -S node --experimental-strip-types
// run-tests.ts — every `*.test.ts` in this folder, for a hand run. The close's
// verify.ts collects the same suites on its own, as it does for every folder
// under .agents/skills/, so this is not the only runner — it is the one a person
// types.
//
// Every suite runs in full even when an earlier one fails: a run that stops at
// the first red tells you about one suite, and the question at close time is
// how many are broken.
//
// `*.test.ts`, not `*.test.sh`: every suite in this folder is a `*.test.ts`,
// so a runner globbing `*.test.sh` would find nothing here and exit 1.
// Each suite gets its own `node --test` so a red one is named by file, as the
// bash runner named it.
//
// Usage:
//   node --experimental-strip-types .agents/skills/review/run-tests.ts         # this folder
//   node --experimental-strip-types .agents/skills/review/run-tests.ts <dir>   # another folder (the test uses it)
//
// peers:
//   .agents/skills/review/run-tests.test.ts
//   .agents/skills/close/scripts/verify.ts
//
// Exit: 0 every suite passed · 1 one or more failed, or no suite found · 2 no such folder

import { spawnSync } from "node:child_process";
import { readdirSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const DIR = process.argv[2] || dirname(fileURLToPath(import.meta.url));
  let names: string[];
  try {
    if (!statSync(DIR).isDirectory()) throw new Error("not a directory");
    names = readdirSync(DIR);
  } catch {
    process.stderr.write(`run-tests: no such folder: ${DIR}\n`);
    exit(2);
  }

  const suites = names
    .filter((n) => n.endsWith(".test.ts") && !n.startsWith("."))
    .filter((n) => statSync(join(DIR, n)).isFile())
    .sort();

  // A runner started from inside another `node --test` (this file's own test,
  // or a close that collects suites that way) inherits NODE_TEST_CONTEXT, and a
  // `node --test` that sees it reports to the parent instead of exiting with
  // its own status — a red suite then exits 0. Each suite gets a clean one.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  const failed: string[] = [];
  let ran = 0;
  for (const suite of suites) {
    ran++;
    process.stdout.write(`── ${suite}\n`);
    const r = spawnSync(process.execPath, ["--test", "--experimental-strip-types", suite], {
      cwd: DIR,
      env,
      stdio: "inherit",
    });
    if (r.status !== 0) failed.push(suite);
  }

  // A folder with no suites is a runner pointed at the wrong place, never a pass.
  if (ran === 0) {
    process.stderr.write(`run-tests: no *.test.ts in ${DIR}\n`);
    exit(1);
  }
  if (failed.length > 0) {
    process.stderr.write(`\nFAILED (${failed.length}): ${failed.join(" ")}\n`);
    exit(1);
  }
  process.stdout.write(`\nreview: all ${ran} suites passed\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
