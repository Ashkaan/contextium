#!/usr/bin/env -S node --experimental-strip-types
// {{name}}.ts — TODO one-line: a check. <what it validates>.
//
// Category (pick ONE, delete the rest):
//   (1) syntactic check  (2) peer-file co-commit  (3) progress-doc co-commit
//   (4) checklist gate    (5) journal frontmatter
//
// What fires it: nothing yet. Nothing dispatches the checks in .agents/checks/
// on its own; until something calls this one it runs by hand, from the
// workbench root, and its test is {{name}}.test.ts beside it.
//
// Exit-code contract: takes file paths as args; exit 1 on violation. Errors
// name the file + line + remediation.
//
// Run: node --experimental-strip-types .agents/checks/{{name}}.ts <file>...

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Actionable-error helper — name the file, the issue, and the fix. Returns the
// exit status, so `code = fail(…)` records a violation and keeps scanning.
// biome-ignore lint/correctness/noUnusedVariables: template stub: the author's filled-in body calls this
function fail(msg: string): number {
  process.stderr.write(`  {{name}}: ${msg}\n`);
  return 1;
}

/** The check itself: 0 clean, 1 on any violation. */
export function check(files: string[]): number {
  const code = 0;
  // TODO the check. Example (make `code` a `let`, import readFileSync):
  //   for (const file of files) {
  //     if (!existsSync(file)) continue;
  //     readFileSync(file, "utf8").split("\n").forEach((line, i) => {
  //       if (line.includes("FORBIDDEN")) code = fail(`${file}:${i + 1}: contains FORBIDDEN — remove it`);
  //     });
  //   }
  void files;
  return code;
}

function main(): void {
  const files = process.argv.slice(2);
  // exitCode, never process.exit: the process ends once stderr has drained, so
  // the error lines are never cut off.
  process.exitCode = check(files);
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
