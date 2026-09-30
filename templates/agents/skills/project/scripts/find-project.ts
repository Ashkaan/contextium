#!/usr/bin/env -S node --experimental-strip-types
// find-project.ts
//
// Resolve a project slug to its folder path. Walks `projects/<domain>/<date>_<slug>/`
// and emits the matching path, or "NOT_FOUND" with the nearest matches.
//
// Deterministic — single filesystem scan.
//
// Usage:
//   find-project.ts <slug>
//   find-project.ts <domain>/<slug>   # fully-qualified form bypasses slug-only scan
//
// Output (one or more lines to stdout):
//   PATH:projects/<domain>/<date>_<slug>     → success
//   NOT_FOUND                                → no match
//   NOT_FOUND:nearest: <slug1>, <slug2>, ... → no exact match; suggestions
//
// Exit code: 0 always — caller parses stdout. An unknown domain or a missing
// projects/ folder is NOT_FOUND, not a failure. 1 when no slug is given or the
// write root cannot be resolved.

import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * THE WRITE ROOT. This script reads projects and journals with repo-relative
 * paths, so it runs FROM the root the session resolves — the thread's worktree,
 * else the checkout it lives in — never from whichever cwd invoked it, because a
 * wrong cwd here reports "no projects" rather than failing. The resolver's
 * stderr reaches ours; its failure is ours (exit 1).
 */
function enterWriteRoot(): void {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "../../implement/scripts/session-write-root.ts"), "--no-create"],
    { encoding: "utf8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (r.status !== 0) exit(1);
  const root = (r.stdout ?? "").replace(/\n+$/, "");
  // `cd ""` is a no-op in bash; only a named root that is not there fails.
  if (root === "") return;
  try {
    process.chdir(root);
  } catch {
    process.stderr.write(`find-project: cd: ${root}: No such file or directory\n`);
    exit(1);
  }
}

/** Directories directly inside `dir`, as `dir/<name>`. Nothing when `dir` is
 *  missing or unreadable. */
function subdirs(dir: string): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => `${dir}/${e.name}`);
}

/**
 * Every project folder: `projects/<domain>/<name>`, depth two only. The root and
 * the domain folders are not candidates — the bash original's `find projects
 * -maxdepth 2` (and `find projects/<domain> -maxdepth 1`) listed them too, so a
 * domain whose own name ended in `_<slug>` matched as the project.
 */
function projectsTree(): string[] {
  return subdirs("projects").flatMap((d) => subdirs(d));
}

/** `-name "*_<slug>"`, a glob on the last path component. The slug is the
 *  user's; `*`, `?` and `[` in it stay glob characters as they were for find. */
function globMatch(name: string, pattern: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) re += "\\[";
      else {
        let body = pattern.slice(i + 1, end);
        if (body.startsWith("!")) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`, "s").test(name);
  } catch {
    return false;
  }
}

const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

async function main(): Promise<void> {
  enterWriteRoot();

  const INPUT = process.argv[2] ?? "";
  if (INPUT === "") {
    process.stderr.write(`${process.argv[1]}: 1: slug required\n`);
    exit(1);
  }

  // Fully-qualified form: <domain>/<slug>
  if (INPUT.includes("/")) {
    const DOMAIN = INPUT.slice(0, INPUT.indexOf("/"));
    const SLUG = INPUT.slice(INPUT.lastIndexOf("/") + 1);
    // The domain folder itself is never a candidate, existing or not.
    const MATCH = subdirs(`projects/${DOMAIN}`).find((d) => globMatch(base(d), `*_${SLUG}`));
    process.stdout.write(MATCH ? `PATH:${MATCH}\n` : "NOT_FOUND\n");
    return;
  }

  // Bare slug: scan all domains
  const tree = projectsTree();
  const MATCH = tree.find((d) => globMatch(base(d), `*_${INPUT}`));
  if (MATCH) {
    process.stdout.write(`PATH:${MATCH}\n`);
    return;
  }

  // Suggest nearest matches by substring: `grep -iE "_.*<input>.*$"`, then
  // `sed 's|.*_||'` (what follows the LAST underscore), `sort -u`, first five.
  let near: RegExp | null;
  try {
    near = new RegExp(`_.*${INPUT}.*$`, "i");
  } catch {
    near = null;
  }
  const NEAREST = near
    ? [...new Set(tree.filter((d) => near.test(d)).map((d) => d.slice(d.lastIndexOf("_") + 1)))]
        .sort()
        .slice(0, 5)
        .join(",")
    : "";

  process.stdout.write(NEAREST ? `NOT_FOUND:nearest: ${NEAREST}\n` : "NOT_FOUND\n");
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
