#!/usr/bin/env -S node --experimental-strip-types
// discover-routes.ts — enumerate a repo's static routes by walking its
// file-based routing directories, so /qa never carries a tracked page list (the
// user's point: "the number of pages will change, why track it?"). File-based
// routing IS the route SSOT for both frameworks /qa serves, so a filesystem walk
// is data, not judgment, and it can never drift the
// way a hand-maintained list does.
//
// Two routing dialects, both walked (a repo may have either or both):
//   pages-router  src/pages/ (Astro) and pages/ (Next Pages Router, only when the
//                 repo is Next — a bare pages/ of markdown in a non-Next repo is
//                 not a route tree). The FILE is the route.
//   app-router    app/ and src/app/ (Next App Router). The DIRECTORY containing a
//                 `page.*` file is the route; `(group)` segments are organisational
//                 and do NOT appear in the URL; `@slot` segments are parallel
//                 routes, not standalone URLs.
//
// This NEVER synthesizes a route: `/` is emitted only when a
// real root page file exists, and a repo with no static routes HALTs rather than
// inventing one. Dynamic segments (`[id]`, `[...slug]`) are skipped rather than
// emitted as a literal bracket path — there is no param value to pick.
//
// peers:
//   .agents/skills/qa/scripts/detect-app.ts
//   .agents/skills/qa/scripts/tests/discover-routes.test.ts
//
// Usage:   discover-routes.ts <repo-dir>
// Output:  one route per line on stdout, sorted + de-duplicated, no trailing
//          slash (`/`, `/blog`, `/blog/post`). Diagnostic `skipped-*:` lines on
//          stderr for files the framework's semantics exclude.
// Exit:    0 routes emitted; 2 usage; 3 no routing dir at all (no-src-pages on
//          stderr); 4 routing dir(s) present but zero static routes
//          (no-static-routes).

import { accessSync, constants, type Dirent, existsSync, opendirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

async function main(): Promise<void> {
  const REPO = process.argv[2] ?? "";
  const isDir = (p: string): boolean => existsSync(p) && statSync(p).isDirectory();
  if (!REPO || !isDir(REPO)) {
    process.stderr.write("usage: discover-routes.ts <repo-dir>\n");
    exit(2);
  }

  const routes: string[] = [];
  const rootsFound: string[] = [];
  const skipped = (kind: string, label: string, rel: string): void => {
    process.stderr.write(`skipped-${kind}: ${label}/${rel}\n`);
  };

  // isNextRepo — a bare top-level `pages/` is only a route tree in a Next repo;
  // elsewhere it is just a directory of files. next.config.* or a `next`
  // dependency is the evidence (same signal detect-app.ts uses).
  function isNextRepo(): boolean {
    if (readEntries(REPO).some((e) => e.name.startsWith("next.config."))) return true;
    try {
      const pkg: unknown = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
      if (typeof pkg !== "object" || pkg === null) return false;
      // devDependencies over dependencies, as `Object.assign` merged them.
      let next: unknown;
      for (const field of ["dependencies", "devDependencies"]) {
        const deps: unknown = Reflect.get(pkg, field);
        if (typeof deps === "object" && deps !== null && Object.hasOwn(deps, "next")) next = Reflect.get(deps, "next");
      }
      return Boolean(next);
    } catch {
      return false;
    }
  }

  /** A directory's entries in its own unsorted order, as `find` sees them. */
  function readEntries(dir: string): Dirent[] {
    const entries: Dirent[] = [];
    try {
      const handle = opendirSync(dir);
      for (let e = handle.readSync(); e !== null; e = handle.readSync()) entries.push(e);
      handle.closeSync();
    } catch (e) {
      process.stderr.write(`discover-routes: cannot read ${dir}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
    return entries;
  }

  /** Every regular file under `root` whose name passes `keep`, depth-first. */
  function findFiles(root: string, keep: (name: string) => boolean): string[] {
    const out: string[] = [];
    for (const entry of readEntries(root)) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) out.push(...findFiles(path, keep));
      else if (entry.isFile() && keep(entry.name)) out.push(path);
    }
    return out;
  }

  function readable(path: string): boolean {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  // walkPagesRouter ROOT LABEL — the file IS the route (Astro, Next Pages Router).
  function walkPagesRouter(root: string, label: string): void {
    for (const f of findFiles(root, (n) => /\.(astro|md|mdx|html|tsx|jsx)$/.test(n))) {
      const rel = relative(root, f);
      const base = basename(rel);
      const name = base.includes(".") ? base.slice(0, base.lastIndexOf(".")) : base; // strip the extension
      const dir = dirname(rel); // "." for a top-level file

      // ── exclusions (diagnosed on stderr, never emitted) ──
      // Private: any path segment starting with `_` (component/partial, and
      // Next's _app / _document).
      if (`/${rel}`.includes("/_")) {
        skipped("private", label, rel);
        continue;
      }
      // Dynamic: any `[param]` / `[...slug]` segment — no param value to pick.
      if (rel.includes("[")) {
        skipped("dynamic", label, rel);
        continue;
      }
      // API endpoints are not pages.
      if (rel.startsWith("api/")) {
        skipped("api", label, rel);
        continue;
      }
      // Error pages render only on a real 404/500, not as a shootable route.
      if (name === "404" || name === "500") {
        skipped("error", label, rel);
        continue;
      }
      // Unreadable file: skip loudly, keep walking.
      if (!readable(f)) {
        skipped("unreadable", label, rel);
        continue;
      }

      // ── route mapping ──
      // index.* maps to its parent route; top-level index.* IS the root `/`.
      if (name === "index") routes.push(dir === "." ? "/" : `/${dir}`);
      else routes.push(dir === "." ? `/${name}` : `/${dir}/${name}`);
    }
  }

  // walkAppRouter ROOT LABEL — the DIRECTORY holding a `page.*` file is the route
  // (Next App Router). `(group)` segments are stripped from the URL; `@slot`
  // (parallel route) and `_private` segments are not standalone URLs.
  function walkAppRouter(root: string, label: string): void {
    for (const f of findFiles(root, (n) => /^page\.(tsx|jsx|ts|js|mdx|md)$/.test(n))) {
      const rel = relative(root, f);
      const dir = dirname(rel);

      if (!readable(f)) {
        skipped("unreadable", label, rel);
        continue;
      }

      let url = "";
      let skip = "";
      if (dir !== ".") {
        for (const seg of dir.split("/").filter(Boolean)) {
          // Dynamic: no param value to pick — never emit a literal `[id]` path.
          if (seg.includes("[")) skip = "dynamic";
          // Parallel-route slot: rendered INTO another route, not its own URL.
          else if (seg.startsWith("@")) skip = "parallel";
          // Private folder: excluded from routing by Next.
          else if (seg.startsWith("_")) skip = "private";
          // Route group: organisational only, absent from the URL.
          else if (seg.startsWith("(") && seg.endsWith(")")) continue;
          else {
            url += `/${seg}`;
            continue;
          }
          break;
        }
      }

      if (skip) {
        skipped(skip, label, rel);
        continue;
      }
      routes.push(url || "/");
    }
  }

  // ── walk every routing dir this repo actually has ────────────────────
  if (isDir(join(REPO, "src/pages"))) {
    rootsFound.push("src/pages");
    walkPagesRouter(join(REPO, "src/pages"), "src/pages");
  }
  if (isDir(join(REPO, "pages")) && isNextRepo()) {
    rootsFound.push("pages");
    walkPagesRouter(join(REPO, "pages"), "pages");
  }
  if (isDir(join(REPO, "src/app"))) {
    rootsFound.push("src/app");
    walkAppRouter(join(REPO, "src/app"), "src/app");
  }
  if (isDir(join(REPO, "app"))) {
    rootsFound.push("app");
    walkAppRouter(join(REPO, "app"), "app");
  }

  // No routing directory at all — the repo has no file-based route tree /qa can read.
  if (rootsFound.length === 0) {
    process.stderr.write(`no-src-pages: ${REPO} (looked for src/pages, pages, src/app, app)\n`);
    exit(3);
  }

  // Routing dir(s) exist but yielded no static route (only dynamic/private/error/
  // non-page files) — a real HALT, never a fabricated `/` (no guessing).
  if (routes.length === 0) {
    process.stderr.write(`no-static-routes: ${REPO} (${rootsFound.join(" ")})\n`);
    exit(4);
  }

  // Byte order, which is `sort -u`'s order under the C.UTF-8 locale.
  const sorted = [...new Set(routes)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  process.stdout.write(`${sorted.join("\n")}\n`);
}

await runToExit(main);
