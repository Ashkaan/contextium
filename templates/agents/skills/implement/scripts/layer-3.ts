#!/usr/bin/env -S node --experimental-strip-types
// layer-3.ts — Layer 3 of /implement Phase 4 (quality-check dry-run).
//
// Runs the workbench's own checks against the change as a pre-commit dry-run,
// so Phase 4 surfaces the same violations land.ts would refuse the close on —
// before the close. Advisory: always exits 0.
//
// The checks are the ones in `.agents/checks/` that the close runs: decision
// records, skill manifests and secrets over what changed since HEAD, and
// standards citations over the tracked tree. Each present one prints a RAN
// line; when none is present, a NO-MATCH line.
//
// peers: layer-1.ts, layer-2.ts, resolve-scope.ts,
//        .agents/skills/close/scripts/land.ts (the same checks, blocking)
//
// Usage:
//   layer-3.ts --scope <arg>     (the scope is accepted for symmetry with the
//                                 other layers; the checks read the change)
//
// Output (stdout):
//   RAN: check-decision-records.ts → PASS
//   NO-MATCH: no quality check applies to this scope
//
// Exit:
//   0  always (advisory; land.ts is the blocking surface)
//   1  scope-arg invalid / repo missing

import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `git rev-parse --show-toplevel`, or "" outside a repo. */
function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

// Each check and the arguments the close's scan gives it: the change since
// HEAD, except the standards citations, which read the tracked tree.
const CHECKS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["check-decision-records.ts", ["--since", "HEAD"]],
  ["check-skills.ts", ["--since", "HEAD"]],
  ["check-secrets.ts", ["--since", "HEAD"]],
  ["check-standards-refs.ts", []],
];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    if (a === "--scope") {
      // Accepted, not used: the checks read the change themselves.
      argv.splice(0, 2);
    } else if (a === "-h" || a === "--help") {
      // The header comment above, after the shebang, is the help text.
      const all = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1);
      const end = all.findIndex((l) => !l.startsWith("//"));
      const lines = end === -1 ? all : all.slice(0, end);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else {
      err(`unknown flag: ${a}`);
      exit(1);
    }
  }

  // CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall back to
  // git when unset (some callers leave it unset). A failing rev-parse outside a
  // repo reads as "" so the guard below surfaces the documented exit code
  // rather than git's 128.
  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || gitToplevel();
  if (REPO_DIR === "") {
    err("CLAUDE_PROJECT_DIR unset and not inside a git repo");
    exit(1);
  }
  const CHECKS_REL = ".agents/checks";
  process.chdir(REPO_DIR);

  // Spawned on this same node binary with `--experimental-strip-types`, stdin
  // closed and output discarded: the verdict is the exit status.
  let ran = false;
  for (const [check, args] of CHECKS) {
    if (!isFile(`${CHECKS_REL}/${check}`)) continue;
    ran = true;
    const r = spawnSync(process.execPath, ["--experimental-strip-types", `${CHECKS_REL}/${check}`, ...args], {
      stdio: "ignore",
    });
    process.stdout.write(`RAN: ${check} → ${r.status === 0 ? "PASS" : "FAIL"}\n`);
  }
  if (!ran) process.stdout.write("NO-MATCH: no quality check applies to this scope\n");

  exit(0);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
