#!/usr/bin/env -S node --experimental-strip-types
// {{name}}.ts — TODO one-line: a check. <what it validates>.
//
// Category (pick ONE, delete the rest):
//   (1) syntactic check  (2) peer-file co-commit  (3) progress-doc co-commit
//   (4) checklist gate    (5) journal frontmatter
//
// What fires it: a check that must block is a close gate in
// .agents/skills/close/scripts/land.ts; until one calls it, it runs by hand
// from the workbench root. Its test is {{name}}.test.ts beside it.
//
// Exit-code contract: takes `--since <ref>` (the files this branch changed
// since it left <ref>, plus untracked ones — what every land.ts gate passes)
// or file paths; exit 1 on violation, 2 on a caller error. Errors name the
// file + line + remediation.
//
// Run: node --experimental-strip-types .agents/checks/{{name}}.ts --since origin/main
//      node --experimental-strip-types .agents/checks/{{name}}.ts <file>...

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Actionable-error helper — name the file, the issue, and the fix. Returns the
// exit status, so `code = fail(…)` records a violation and keeps scanning.
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

/** The files to check: `--since <ref>` resolved through git, else the paths
 *  given. null after a caller error, with the reason on stderr. */
function filesFrom(argv: string[]): string[] | null {
  if (argv[0] !== "--since") return argv;
  const ref = argv[1];
  if (argv.length !== 2 || !ref) {
    fail("--since takes exactly one ref");
    return null;
  }
  const git = (...args: string[]) => spawnSync("git", args, { encoding: "utf8" });
  const mb = git("merge-base", "HEAD", ref);
  if (mb.status !== 0) {
    fail(`cannot find where HEAD left ${ref}`);
    return null;
  }
  const diff = git("diff", "-z", "--name-only", "--no-renames", mb.stdout.trim());
  const others = git("ls-files", "-z", "--others", "--exclude-standard");
  if (diff.status !== 0 || others.status !== 0) {
    fail("git could not list the change");
    return null;
  }
  return `${diff.stdout}${others.stdout}`.split("\0").filter(Boolean);
}

function main(): void {
  const files = filesFrom(process.argv.slice(2));
  if (files === null) {
    process.exitCode = 2;
    return;
  }
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
