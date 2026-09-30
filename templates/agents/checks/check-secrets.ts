#!/usr/bin/env -S node --experimental-strip-types
// check-secrets.ts — scan a change for obvious secrets: a private key block, a
// cloud access key id, a hard-coded token. The single copy of the scan; land.ts
// runs it before it commits (AGENTS.md § Standards → Fix lint at the source
// holds for what it finds: remove the secret, never exclude the file).
//
// Usage:
//   check-secrets.ts                 the staged diff
//   check-secrets.ts --since <ref>   everything this branch changed since it
//                                    left <ref>, committed or not, plus
//                                    untracked files — what a close will commit
// Exit: 0 clean · 1 a likely secret · 2 caller error

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { exit, runToExit } from "../packages/cli-exit/cli-exit.ts";

function git(args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout ?? "" };
}

function fail(msg: string): never {
  process.stderr.write(`check-secrets: ${msg}\n`);
  exit(1);
}

// A diff git cannot produce is an error, never an empty (clean) change.
function unreadable(what: string): never {
  process.stderr.write(`check-secrets: could not read the change (${what}), so it was not scanned\n`);
  exit(2);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function main(): void {
  if (!git(["rev-parse", "--git-dir"]).ok) exit(0);
  const args = process.argv.slice(2);
  let diff: string;
  if (args[0] === "--since") {
    const ref = args[1];
    if (!ref) {
      process.stderr.write("check-secrets: --since needs a ref\n");
      exit(2);
    }
    const mb = git(["merge-base", "HEAD", ref]);
    if (!mb.ok) {
      process.stderr.write(`check-secrets: cannot find where HEAD left ${ref}\n`);
      exit(2);
    }
    const base = mb.out.trim();
    const d = git(["diff", base]);
    if (!d.ok) unreadable(`git diff ${base}`);
    diff = d.out;
    const u = git(["ls-files", "-z", "--others", "--exclude-standard"]);
    if (!u.ok) unreadable("git ls-files");
    for (const f of u.out.split("\0")) {
      if (!f || !isFile(f)) continue;
      let body: string;
      try {
        body = readFileSync(f, "utf8");
      } catch {
        unreadable(f);
      }
      diff += `\n${body.replace(/\n$/, "").split("\n").map((l) => `+${l}`).join("\n")}`;
    }
  } else {
    const d = git(["diff", "--cached"]);
    if (!d.ok) unreadable("git diff --cached");
    diff = d.out;
  }
  // Only the lines the change ADDS: a removed line is the fix for a leak, and a
  // context line was there before this change.
  const added = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !/^\+\+\+ (b\/|\/dev\/null)/.test(l))
    .join("\n");
  if (!added) exit(0);

  if (/-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----/.test(added)) {
    fail("the change contains a PRIVATE KEY. Remove it before committing.");
  }
  if (/\bAKIA[0-9A-Z]{16}\b/.test(added)) {
    fail("the change contains an AWS access key id. Remove it before committing.");
  }
  if (/(api[_-]?key|secret|token|password)["']?[ \t\v\f\r]*[:=][ \t\v\f\r]*["'][A-Za-z0-9/_+=-]{24,}["']/i.test(added)) {
    fail("the change looks like it contains a hard-coded secret. Use a secrets manager or env var.");
  }
  exit(0);
}

await runToExit(main);
