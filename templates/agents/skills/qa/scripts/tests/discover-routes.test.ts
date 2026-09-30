#!/usr/bin/env -S node --experimental-strip-types
// discover-routes.test.ts — fixture-driven tests for discover-routes.ts covering
// the route-mapping rows: index→/, nested index, dynamic/private/error
// exclusions, no-src-pages (exit 3), no-static-routes (exit 4), and the
// no-fabricated-root case (real about.astro, no index → /about, never /).
// Fixtures are temp src/pages/ trees — no network, no real repo. The script is
// spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/discover-routes.test.ts
//
// peers: ../discover-routes.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "discover-routes.ts");
const TMP = mkdtempSync(join(tmpdir(), "discover-routes-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** A repo holding empty files at these repo-relative paths. */
function mkrepo(...files: string[]): string {
  const r = join(TMP, `r${n++}`);
  mkdirSync(r);
  for (const f of files) {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), "");
  }
  return r;
}
// A bare top-level pages/ only counts as a route tree in a Next repo.
function nextRepo(...files: string[]): string {
  const r = mkrepo(...files);
  writeFileSync(join(r, "package.json"), '{"dependencies":{"next":"16"}}');
  return r;
}

/** "RC|stdout|stderr", as the bash suite compared it (trailing newlines trimmed). */
function run(repo: string): string {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, repo], { encoding: "utf8" });
  return `${r.status}|${r.stdout.replace(/\n+$/, "")}|${r.stderr.replace(/\n+$/, "")}`;
}
/** Just the routes. */
function routes(repo: string): string {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, repo], { encoding: "utf8" });
  return r.stdout.replace(/\n+$/, "");
}

test("usage: no repo → exit 2", () => assert.match(run(""), /^2\|\|usage:/));

// index.astro only → exactly "/"
test("index → /", () => assert.ok(run(mkrepo("src/pages/index.astro")).startsWith("0|/|")));

// nested blog/index.astro + blog/post.astro → /blog and /blog/post, sorted+deduped
test("nested sorted", () =>
  assert.equal(routes(mkrepo("src/pages/blog/index.astro", "src/pages/blog/post.astro")), "/blog\n/blog/post"));

// dynamic [slug].astro → not emitted; stderr skipped-dynamic
test("dynamic skipped", () => {
  const got = run(mkrepo("src/pages/index.astro", "src/pages/[slug].astro"));
  assert.ok(got.startsWith("0|/|") && got.includes("skipped-dynamic: src/pages/[slug].astro"), got);
});

// private _partial.astro → not emitted; stderr skipped-private
test("private skipped", () => {
  const got = run(mkrepo("src/pages/index.astro", "src/pages/_partial.astro"));
  assert.ok(got.startsWith("0|/|") && got.includes("skipped-private: src/pages/_partial.astro"), got);
});

// 404.astro → not emitted; stderr skipped-error
test("error skipped", () => {
  const got = run(mkrepo("src/pages/index.astro", "src/pages/404.astro"));
  assert.ok(got.startsWith("0|/|") && got.includes("skipped-error: src/pages/404.astro"), got);
});

// no src/pages → exit 3, empty stdout, stderr no-src-pages
test("no-src-pages exit 3", () => {
  const got = run(mkrepo());
  assert.ok(got.startsWith("3||") && got.includes("no-src-pages"), got);
});

// src/pages with only [slug].astro → exit 4, empty stdout, stderr no-static-routes
test("no-static-routes exit 4", () => {
  const got = run(mkrepo("src/pages/[slug].astro"));
  assert.ok(got.startsWith("4||") && got.includes("no-static-routes"), got);
});

// no index but real about.astro → emits /about, does NOT emit /
test("about no-root", () => assert.equal(routes(mkrepo("src/pages/about.astro")), "/about"));

// ── Next App Router: app/ and src/app/, the DIRECTORY is the route ──

// app/page.tsx → /
test("app-router root", () => assert.equal(routes(mkrepo("app/page.tsx")), "/"));

// route groups are organisational: (marketing)/page.tsx → /, (onboarding)/order → /order
test("route groups stripped", () =>
  assert.equal(routes(mkrepo("app/(marketing)/page.tsx", "app/(onboarding)/order/page.tsx")), "/\n/order"));

// dynamic [id] → skipped, never emitted as a literal bracket path
test("app-router dynamic skipped", () => {
  const got = run(mkrepo("app/page.tsx", "app/post/[id]/page.tsx"));
  assert.ok(got.startsWith("0|/|") && got.includes("skipped-dynamic: app/post/[id]/page.tsx"), got);
});

// @slot parallel routes and _private folders are not standalone URLs
test("app-router @slot + _private skipped", () =>
  assert.equal(routes(mkrepo("app/page.tsx", "app/@modal/page.tsx", "app/_lib/page.tsx")), "/"));

// src/app/ is walked too
test("src/app walked", () => assert.equal(routes(mkrepo("src/app/about/page.tsx")), "/about"));

// ── Next Pages Router: pages/, only when the repo IS Next ───────────

test("pages-router (next repo)", () =>
  assert.equal(routes(nextRepo("pages/index.tsx", "pages/about.tsx")), "/\n/about"));

// a bare pages/ in a NON-Next repo is a directory, not a route tree → exit 3
test("bare pages/ in non-next ignored", () => {
  const got = run(mkrepo("pages/notes.md"));
  assert.ok(got.startsWith("3||") && got.includes("no-src-pages"), got);
});

// pages/api/* is an endpoint, not a page route
test("pages/api skipped", () => {
  const got = run(nextRepo("pages/index.tsx", "pages/api/hello.tsx"));
  assert.ok(got.startsWith("0|/|") && got.includes("skipped-api: pages/api/hello.tsx"), got);
});
