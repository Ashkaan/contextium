#!/usr/bin/env -S node --experimental-strip-types
// qa-targets.ts — which web apps does this change put pixels in front of?
//
// `/implement` has to decide whether a UI was touched BEFORE it can require a
// full `/qa` pass, and "is this a UI change?" was a judgment the model made from
// the file paths. This makes it a lookup: walk up from each changed file to the
// nearest directory that owns a package.json, ask detect-app.ts what that
// directory IS, and keep the ones it calls web. Nothing here guesses, and
// nothing here reads a hand-maintained list of app names.
//
// Usage:
//   qa-targets.ts --repo <worktree> [--base <sha>] [--files-file PATH|-] [FILE...]
//
// Flags:
//   --repo <dir>       the worktree the changed files are relative to (required)
//   --base <sha>       the session's base commit. Without it the changed set is
//                      `git diff --name-only HEAD` plus untracked, which misses
//                      everything the session already COMMITTED — and
//                      /implement-audit reviews BASE_SHA..HEAD plus uncommitted,
//                      so a committed UI change is in the review and invisible
//                      here. That answered "skipped-not-web" for a change that
//                      was all pixels.
//   --files-file PATH  newline-separated repo-relative paths; `-` reads stdin.
//                      A relative PATH is read from inside --repo.
//
// Output (stdout): zero or more ABSOLUTE directory paths, one per line, sorted
// in byte order (LC_ALL=C) and deduped. Absolute because /qa takes a target
// directory, not a repo-relative path.
//
// Exit:
//   0  the list is complete (zero paths is a complete list)
//   2  caller error, OR the detector crashed / is missing
//
// A DETECTOR CRASH IS A HALT, NOT "NOT WEB". detect-app.ts exits 3 for a target
// it cannot classify, and that 3 legitimately means "not a web app". Any OTHER
// non-zero is the detector failing, and reading a failure as "no UI here" is how
// a UI ships with no QA and a green run — the one outcome this script exists to
// make impossible. So 3 is data and everything else is exit 2.
//
// WEB, is whatever detect-app.ts's TYPE says:
// astro-cf, astro, next, vite, static, node-server. cli / render / unknown are
// not targets — there are no pixels in a CLI's stdout, and a render target's
// PNGs are already its own deliverable.
//
// SHARED PACKAGES FAN OUT. A file in `packages/ui/` is not itself a web app, so
// the walk-up finds nothing and the naive answer is "no UI changed" — while two
// apps that import it just changed what they render. So for any changed file
// that resolved to no web target of its own, this finds the files that IMPORT
// it and walks up from THOSE. That is the same import matching
// blast-radius.ts documents, and it is why one edit to a shared component still
// sends both consumers through /qa.
//
// QA_DETECT_APP overrides the detector (the tests' seam): a `.ts` path runs
// under this Node, anything else is executed directly.
//
// peers:
//   .agents/skills/qa/scripts/detect-app.ts
//   .agents/skills/qa/scripts/import-map.ts
//   .agents/skills/qa/scripts/tests/qa-targets.test.ts
//   .agents/skills/implement/scripts/validate.ts
//   .agents/skills/review/blast-radius.ts
//
// Boundary inputs:
//   - 0 changed files:            no output, exit 0
//   - 1 file, not in any app:     no output, exit 0
//   - N files in one app:         that app once
//   - nested apps/<domain>/<app>: the APP dir, not the domain dir
//   - the worktree root is web:   the root is a target
//   - shared package, 2 consumers: both consumers
//   - deleted file:               kept; its app is still a target if it survives
//   - detect-app.ts missing:      exit 2
//   - detect-app.ts exit 2 / >3:  exit 2

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dropCodeExt, importEdges } from "./import-map.ts";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
  const DETECT = process.env.QA_DETECT_APP || join(SCRIPT_DIR, "detect-app.ts");

  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  function halt(...lines: string[]): never {
    for (const line of lines) err(line);
    exit(2);
  }

  const isFile = (p: string): boolean => existsSync(p) && statSync(p).isFile();
  const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();

  /** Byte order — `sort` under LC_ALL=C. */
  const sortC = (list: Iterable<string>): string[] =>
    [...list].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  let REPO = "";
  let BASE = "";
  let FILES_FILE = "";
  const ARG_FILES: string[] = [];

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (what: string): string => {
      if (i + 1 >= argv.length) halt(`qa-targets: ${a} needs ${what}`);
      return argv[++i];
    };
    if (a === "--repo") REPO = value("a directory");
    else if (a === "--base") BASE = value("a revision");
    else if (a === "--files-file") FILES_FILE = value("a path");
    else if (a === "-h" || a === "--help") {
      // The header comment above, from its Usage line to the exit codes.
      const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n");
      const from = header.findIndex((l) => l === "// Usage:");
      const to = header.findIndex((l) => l.startsWith("//   2  caller error"));
      process.stderr.write(`${header.slice(from, to + 1).join("\n")}\n`);
      exit(0);
    } else if (a.startsWith("--")) halt(`qa-targets: unknown flag: ${a}`);
    else ARG_FILES.push(a);
  }

  if (!REPO || !isDir(REPO)) halt(`qa-targets: --repo must name a directory (got '${REPO}')`);
  REPO = resolve(REPO);

  if (!isFile(DETECT)) {
    halt(
      `qa-targets: no detector at ${DETECT} — cannot tell a web app from a CLI.`,
      "This is a HALT, not 'no UI changed': a missing detector must never read",
      "as a clean skip of /qa.",
    );
  }

  // Every relative path below — git's reads, a relative --files-file — is the
  // worktree's.
  process.chdir(REPO);

  // ── The changed-file list ─────────────────────────────────────────────

  const git = (...args: string[]): SpawnSyncReturns<string> =>
    spawnSync("git", args, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const indent = (text: string): string[] =>
    text
      .replace(/\n$/, "")
      .split("\n")
      .filter((_, i, all) => all.length > 1 || all[0] !== "")
      .map((l) => `  ${l}`);

  // gitRead <what> <args...> — run a git read, and HALT (exit 2) when it fails. A
  // git read that fails prints nothing, and an empty changed set or an empty
  // importer list reads exactly like "no web app changed" — the one answer this
  // script must never give by accident. So a failure is never swallowed.
  function gitRead(what: string, ...args: string[]): string {
    const run = git(...args);
    if (run.status !== 0) {
      halt(
        `qa-targets: ${what} failed — refusing to report 'no UI changed' on a git error:`,
        ...indent(run.stderr ?? ""),
      );
    }
    return run.stdout;
  }

  let raw = "";
  if (FILES_FILE) {
    if (FILES_FILE === "-") raw = readFileSync(0, "utf8");
    else if (isFile(FILES_FILE)) raw = readFileSync(FILES_FILE, "utf8");
    else halt(`qa-targets: --files-file not found: ${FILES_FILE}`);
  } else if (ARG_FILES.length === 0) {
    // Exactly the population code-review.ts reviews: the committed range when a
    // base is given, the working-tree edits, and the untracked files git diff
    // cannot see.
    if (BASE) {
      const diff = git("diff", "--name-only", BASE);
      if (diff.status !== 0) {
        halt(
          `qa-targets: --base '${BASE}' does not resolve in this worktree.`,
          "Refusing to enumerate from a partial changed set — a UI change that",
          "is already committed would silently read as 'no UI changed'.",
        );
      }
      raw += diff.stdout;
    } else {
      // `rev-parse --verify -q HEAD` exits 1 for "no commit yet" and 128 for a
      // git error. Only the first is an unborn repo; reading the second as one
      // would scan the staged set alone and miss an unstaged UI edit.
      const head = git("rev-parse", "--verify", "-q", "HEAD");
      if (head.status === 0) {
        raw += gitRead("git diff --name-only HEAD", "diff", "--name-only", "HEAD");
      } else if (head.status === 1) {
        // Unborn: prove the repository itself reads, then take the staged set
        // (against the empty tree) and the unstaged edits on top of it; the
        // untracked files follow below.
        gitRead("git rev-parse --git-dir", "rev-parse", "--git-dir");
        raw += gitRead("git diff --cached --name-only", "diff", "--cached", "--name-only");
        raw += gitRead("git diff --name-only", "diff", "--name-only");
      } else {
        halt(
          `qa-targets: git rev-parse --verify HEAD failed (exit ${head.status ?? "?"}) — refusing to report 'no UI changed' on a git error:`,
          ...indent(head.stderr ?? ""),
        );
      }
    }
    raw += gitRead("git ls-files --others", "ls-files", "--others", "--exclude-standard");
  }
  if (ARG_FILES.length > 0) raw += `${ARG_FILES.join("\n")}\n`;

  // A DELETED path is kept. Removing a page, a component or a stylesheet changes
  // what the app renders as surely as editing one does, and the walk-up only needs
  // the file's DIRECTORY chain — which normally survives the deletion. Dropping
  // them meant a deletion-only UI change enumerated zero targets and skipped /qa
  // entirely. `webTargetFor` walks up from the path either way and simply finds
  // nothing when the whole tree is gone.
  const CHANGED = sortC(new Set(raw.split("\n").filter((l) => !/^\s*$/.test(l))));
  if (CHANGED.length === 0) exit(0);

  // ── Classification ────────────────────────────────────────────────────

  const WEB_TYPES = new Set(["astro-cf", "astro", "next", "vite", "static", "node-server"]);
  const TYPE_CACHE = new Map<string, boolean>();

  // isWeb <abs-dir> — true or false. Exits the SCRIPT with 2 on a detector
  // failure, which is the point: there is no third answer a caller could safely
  // ignore.
  function isWeb(dir: string): boolean {
    const cached = TYPE_CACHE.get(dir);
    if (cached !== undefined) return cached;
    const run = DETECT.endsWith(".ts")
      ? spawnSync(process.execPath, ["--experimental-strip-types", DETECT, dir], { encoding: "utf8" })
      : spawnSync(DETECT, [dir], { encoding: "utf8" });
    const rc = run.status ?? "?";
    if (rc === 3) {
      TYPE_CACHE.set(dir, false);
      return false;
    }
    if (rc !== 0) {
      halt(
        `qa-targets: the detector failed on ${dir} (exit ${rc}).`,
        "Refusing to report 'no UI changed' on a detector failure — re-run",
        "detect-app.ts on that directory and fix it before /implement closes.",
      );
    }
    const type = /^TYPE=(.*)$/m.exec(run.stdout)?.[1] ?? "";
    const web = WEB_TYPES.has(type);
    TYPE_CACHE.set(dir, web);
    return web;
  }

  // parentDir PATH — everything before the last `/`, or "." when there is none.
  const parentDir = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");

  // webTargetFor <repo-rel-file> — the nearest ancestor directory that owns a
  // package.json AND is web; an absolute path, or "" for none.
  //
  // Walking to the nearest package.json (rather than to apps/<first-segment>) is
  // what makes apps/<domain>/<app>/ resolve to the APP: the domain folder holds
  // shared config at most, and no manifest of its own.
  //
  // Answered once per DIRECTORY (TARGET_CACHE): the fan-out asks this for every
  // importer it reaches, hundreds of them for a shared module.
  const TARGET_CACHE = new Map<string, string>();
  function webTargetFor(file: string): string {
    const start = parentDir(file);
    const cached = TARGET_CACHE.get(start);
    if (cached !== undefined) return cached;
    let target = "";
    for (let dir = start; ; dir = parentDir(dir)) {
      if (dir === ".") {
        if (isFile(`${REPO}/package.json`) && isWeb(REPO)) target = REPO;
        break;
      }
      if (isFile(`${REPO}/${dir}/package.json`) && isWeb(`${REPO}/${dir}`)) {
        target = `${REPO}/${dir}`;
        break;
      }
    }
    TARGET_CACHE.set(start, target);
    return target;
  }

  const TARGETS: string[] = [];
  const ORPHANS: string[] = [];
  for (const f of CHANGED) {
    const t = webTargetFor(f);
    if (t) TARGETS.push(t);
    else ORPHANS.push(f);
  }

  // ── Shared-package fan-out ────────────────────────────────────────────
  //
  // Only for files that reached no web target of their own, and only for the
  // languages an import graph exists in. A changed README in packages/ has no
  // importers and produces nothing, which is correct.

  // The reverse-import map, built ONCE per run by import-map.ts, which carries
  // the resolution rules. An importer lookup that ran a repo-wide `git grep` per
  // file the walk reached, plus a `realpath` per import, took about 15 minutes on
  // a diff touching one widely imported library file.
  // Built only when a changed file needs the fan-out at all.
  let IMPORT_MAP: Map<string, string[]> | undefined;
  function importersOf(file: string): string[] {
    if (!IMPORT_MAP) {
      IMPORT_MAP = new Map();
      let edges: Array<[string, string]>;
      try {
        edges = importEdges(REPO);
      } catch (e) {
        halt(
          `import-map: ${e instanceof Error ? e.message : String(e)}`,
          `qa-targets: the import map could not be built on ${REPO}.`,
          "Refusing to report 'no UI changed' without the import graph.",
        );
      }
      for (const [target, importer] of edges) {
        if (!target || !importer) continue;
        const list = IMPORT_MAP.get(target) ?? [];
        list.push(importer);
        IMPORT_MAP.set(target, list);
      }
    }
    return IMPORT_MAP.get(dropCodeExt(file)) ?? [];
  }

  // ── The fan-out walk ──────────────────────────────────────────────────
  //
  // BFS, not one hop. `button.ts` is usually not imported by the app directly —
  // it goes through `packages/ui/index.ts`, and a single-hop walk stops at that
  // barrel, finds it is not web, and reports no target.
  //
  // NO DEPTH CAP, and that is the correction rather than the omission. The first
  // version stopped after six hops, which meant a seven-hop graph returned success
  // with unexplored importers still queued — a silent "no UI changed" for a change
  // that had one, which is the single outcome this script exists to prevent. A cap
  // can only ever turn a slow answer into a wrong one.
  //
  // Termination does not need it. VISITED admits each file at most once and the
  // repo is finite, so every iteration either shrinks the frontier or consumes a
  // file that can never be queued again; a circular import graph terminates for
  // the same reason. The bound is the number of source files, which is also the
  // bound on how wrong the answer could be without it.
  const VISITED = new Set<string>();
  let frontier: string[] = [];
  for (const f of ORPHANS) {
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|css|astro|svelte|vue)$/.test(f)) continue;
    frontier.push(f);
    VISITED.add(f);
  }

  while (frontier.length > 0) {
    const next: string[] = [];
    for (const f of frontier) {
      for (const importer of importersOf(f)) {
        if (!importer || VISITED.has(importer)) continue;
        VISITED.add(importer);
        const t = webTargetFor(importer);
        if (t) TARGETS.push(t);
        // Not in a web app itself — a barrel, or another shared module. Keep
        // walking through it.
        else next.push(importer);
      }
    }
    frontier = next;
  }

  if (TARGETS.length === 0) exit(0);
  process.stdout.write(`${sortC(new Set(TARGETS)).join("\n")}\n`);
}

await runToExit(main);
