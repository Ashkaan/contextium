#!/usr/bin/env -S node --experimental-strip-types
// peer-sweep.ts — before changing a shared pattern, find every place that uses it.
//
// WHY BEFORE, NOT AFTER
//
// The expensive version of this mistake is fixing one call site, shipping, and
// leaving three siblings on the old behavior — two of which nobody notices until
// they misbehave in a way that looks unrelated. A reviewer catches some of those
// afterwards. Running the sweep BEFORE the edit turns "did I get them all?" into
// a list you work through.
//
// It prints the command it ran as well as the matches, so the sweep is evidence
// someone else can re-run and check, not a claim that one happened.
//
// USAGE
//   peer-sweep.ts --pattern <extended-regex> [--scope <pathspec>] [--exclude <pathspec>]
//
// OUTPUT (stdout)
//   # git grep -nE '<pattern>' -- <scope>
//   <file>:<line>:<content>
//   ...
//   MATCHES: N
//
// READ THE WHOLE OUTPUT. A sweep whose output you skimmed to the first few lines
// is a sweep that did not happen; the peer you missed is usually not near the top.
//
// EXIT: 0 on a valid search (including zero matches); 1 on a bad pattern, a scope
// matching no files, or not being in a git repo.
//
// peers: .agents/skills/implement/scripts/peer-sweep.test.ts

import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

/** `git rev-parse --show-toplevel`, or "" outside a repo. */
function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

/**
 * Whether the scope matches any path, as `compgen -G` answered it. fs.globSync
 * is still experimental on older Node 22 releases (the template's floor is
 * 22.6) and prints an ExperimentalWarning on stderr there; that one warning is
 * dropped so stderr carries only the sweep's own errors.
 */
function globMatches(pattern: string): boolean {
  const prior = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    if (w.name === "ExperimentalWarning" && w.message.includes("globSync")) return;
    for (const l of prior) l(w);
  });
  try {
    return globSync(pattern).some((m) => m !== "");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let PATTERN = "";
  let SCOPE = "";
  let EXCLUDE = "";

  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv[0] ?? "";
    if (a === "--pattern" || a === "--scope" || a === "--exclude") {
      const v = argv[1] ?? "";
      if (a === "--pattern") PATTERN = v;
      else if (a === "--scope") SCOPE = v;
      else EXCLUDE = v;
      argv.splice(0, 2);
    } else if (a === "-h" || a === "--help") {
      // The header comment above, lines 2-30, is the help text.
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 30);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else {
      err(`unknown flag: ${a}`);
      exit(1);
    }
  }

  if (PATTERN === "") {
    err("--pattern <extended-regex> required");
    exit(1);
  }

  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || gitToplevel();
  if (REPO_DIR === "") {
    err("not inside a git repo, and CLAUDE_PROJECT_DIR is unset");
    exit(1);
  }
  // `.git` is a DIRECTORY in a normal clone and a FILE (a gitdir pointer) in a
  // linked worktree, so a directory test would reject every worktree — including
  // one an implementation session may be running in.
  if (!existsSync(`${REPO_DIR}/.git`)) {
    err(`not a git repo: ${REPO_DIR}`);
    exit(1);
  }

  process.chdir(REPO_DIR);

  if (SCOPE !== "" && !globMatches(SCOPE)) {
    err(`scope matches no files: ${SCOPE}`);
    err("A scope that matches nothing produces an empty sweep that reads like a clean one.");
    exit(1);
  }

  // --untracked so a file this session just created is swept too. Without it
  // git grep sees only tracked files, and a brand-new peer reads as "no match".
  let cmdDisplay = `git grep -nE --untracked '${PATTERN}'`;
  const pathspec: string[] = [];
  if (SCOPE !== "") {
    pathspec.push(SCOPE);
    cmdDisplay += ` -- ${SCOPE}`;
  }
  if (EXCLUDE !== "") {
    pathspec.push(`:^${EXCLUDE}`);
    cmdDisplay += ` :^${EXCLUDE}`;
  }

  process.stdout.write(`# ${cmdDisplay}\n`);

  const args = ["grep", "-nE", "--untracked", PATTERN];
  if (pathspec.length > 0) args.push("--", ...pathspec);
  const r = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (r.error) {
    err(`git grep failed: ${r.error.message}`);
    exit(1);
  }
  const rc = r.status ?? 128;
  // stdout then stderr, as `$(… 2>&1)` captured them, trailing newlines cut.
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n+$/, "");

  // git grep exits 1 for "no matches" and 128+ for a malformed pattern. Only the
  // second is an error; a zero-match sweep is a real answer.
  if (rc >= 128) {
    err(`invalid pattern: ${PATTERN}`);
    err(out);
    exit(1);
  }

  let matchCount = 0;
  if (out !== "") {
    process.stdout.write(`${out}\n`);
    matchCount = out.split("\n").filter((l) => l !== "").length;
  }

  process.stdout.write(`MATCHES: ${matchCount}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
