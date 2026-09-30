#!/usr/bin/env -S node --experimental-strip-types
// trunk.ts — what is THIS repo's trunk branch called?
//
// A close script that spells the answer `main` is correct for most repos and
// wrong for any that predates the rename: a repo whose trunk is `master` gets
// refused outright ("no origin/main"), a session that has to write there builds
// its worktree and pushes by hand, and nothing in the ledger records that it
// happened. A close cannot vouch for a repo it was never able to touch.
//
// So the name is ASKED FOR rather than assumed, per repo.
//
// Usage:
//   trunk.ts <repo-dir>        — the branch name, e.g. `main` or `master`
//   trunk.ts --ref <repo-dir>  — the remote-tracking ref, e.g. `origin/main`
//
// The two spellings exist because callers need both and deriving one from the
// other at 47 sites is how they drift: `git fetch origin <name>` takes the bare
// branch, every rev-parse and merge-base takes the `origin/<name>` ref.
//
// Resolution order, and the first one wins:
//   1. `refs/remotes/origin/HEAD` — what the REMOTE says its default is. Local,
//      deterministic, no network. Set on every
//      repo git cloned normally.
//   2. `git remote set-head origin --auto` — asks the remote once and WRITES
//      the answer into (1), so the next call is local again. Network; allowed
//      to fail, because an unreachable remote is not the same as no remote.
//   3. A probe of `origin/main` then `origin/master`, in that order. The floor
//      for a repo whose origin/HEAD was never set and whose remote is down.
//
// It NEVER falls back to a bare `main`. A guess that happens to be right on
// three repos out of four is what this file exists to delete: the failure it
// produces is silent, and it costs a close that thinks it landed everything.
//
// peers:
//   .agents/skills/close/scripts/trunk.test.ts
//   .agents/skills/close/scripts/land.ts        (per ledger repo)
//   .agents/skills/close/scripts/write-root.sh  (the base a worktree branches from)
//
// Exit: 0 ok (name or ref on stdout) · 2 not a git repo, or no trunk found

import { spawnSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** Run git in the repo, output discarded or captured; never throws. */
function git(repo: string, ...args: string[]): { ok: boolean; out: string } {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").replace(/\n+$/, "") };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  let MODE = "name";
  let REPO = "";
  const argv = process.argv.slice(2);
  while (argv.length > 0) {
    const a = argv.shift() ?? "";
    if (a === "--ref") MODE = "ref";
    else if (a === "--name") MODE = "name";
    else if (a.startsWith("-")) {
      process.stderr.write("trunk: usage: trunk.ts [--ref] <repo-dir>\n");
      exit(2);
    } else {
      if (REPO !== "") {
        process.stderr.write(`trunk: one repo at a time, got '${REPO}' and '${a}'\n`);
        exit(2);
      }
      REPO = a;
    }
  }

  if (REPO === "") {
    process.stderr.write("trunk: usage: trunk.ts [--ref] <repo-dir>\n");
    exit(2);
  }

  if (!isDir(REPO) || !git(REPO, "rev-parse", "--git-dir").ok) {
    process.stderr.write(`trunk: not a git repo: ${REPO}\n`);
    exit(2);
  }

  // `--short` on a symbolic ref to a remote-tracking branch prints `origin/main`,
  // so the `origin/` prefix is stripped rather than assumed away: a remote that is
  // not called `origin` would otherwise yield a branch name with a slash in it.
  const readHead = (): string => {
    const r = git(REPO, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
    if (!r.ok || r.out === "") return "";
    return r.out.startsWith("origin/") ? r.out.slice("origin/".length) : r.out;
  };

  let NAME = readHead();

  if (NAME === "") {
    // Asks the remote and caches the answer in refs/remotes/origin/HEAD. Silenced
    // and allowed to fail: offline is a normal state for a close and the probe
    // below still answers for the two names that cover every repo here.
    git(REPO, "remote", "set-head", "origin", "--auto");
    NAME = readHead();
  }

  if (NAME === "") {
    for (const candidate of ["main", "master"]) {
      if (git(REPO, "rev-parse", "--verify", "-q", `origin/${candidate}`).ok) {
        NAME = candidate;
        break;
      }
    }
  }

  if (NAME === "") {
    process.stderr.write(
      `trunk: no trunk branch in ${REPO} — origin/HEAD is unset and neither origin/main nor origin/master exists\n`,
    );
    exit(2);
  }

  process.stdout.write(MODE === "ref" ? `origin/${NAME}\n` : `${NAME}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
