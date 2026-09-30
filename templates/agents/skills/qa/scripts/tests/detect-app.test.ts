#!/usr/bin/env -S node --experimental-strip-types
// detect-app.test.ts — fixture-driven tests for detect-app.ts covering the
// detection table + the boundary rows (unknown type, Node/CLI
// without a qa:* script → exit 3, package.json qa:* script wins over convention).
// The script is spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/detect-app.test.ts
//
// peers: ../detect-app.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "detect-app.ts");
const TMP = mkdtempSync(join(tmpdir(), "detect-app-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function mkrepo(pkg?: string, files: string[] = [], dirs: string[] = []): string {
  const r = join(TMP, `r${n++}`);
  mkdirSync(r);
  if (pkg !== undefined) writeFileSync(join(r, "package.json"), pkg);
  for (const f of files) writeFileSync(join(r, f), "");
  for (const d of dirs) mkdirSync(join(r, d));
  return r;
}

/** "TYPE|RC", as the bash suite compared it. */
function run(repo: string): string {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, repo], { encoding: "utf8" });
  const type = /^TYPE=(.*)$/m.exec(r.stdout)?.[1] ?? "";
  return `${type}|${r.status}`;
}

test("astro-cf via dep", () =>
  assert.equal(run(mkrepo('{"dependencies":{"astro":"5","wrangler":"3"}}')), "astro-cf|0"));
test("astro-cf via wrangler.toml", () =>
  assert.equal(run(mkrepo('{"dependencies":{"astro":"5"}}', ["wrangler.toml"])), "astro-cf|0"));
test("astro plain", () => assert.equal(run(mkrepo('{"dependencies":{"astro":"5"}}')), "astro|0"));
test("vite", () => assert.equal(run(mkrepo('{"devDependencies":{"vite":"5"}}')), "vite|0"));
test("static dist", () => assert.equal(run(mkrepo(undefined, [], ["dist"])), "static|0"));
test("unknown empty", () => assert.equal(run(mkrepo()), "unknown|3"));
// CLI (bin field) without a qa:* script → exit 3 (no guessed command)
test("cli no-script exit3", () => assert.equal(run(mkrepo('{"bin":{"foo":"cli.js"}}')), "unknown|3"));
test("qa:cmd → cli", () =>
  assert.equal(run(mkrepo('{"bin":{"foo":"cli.js"},"scripts":{"qa:cmd":"node cli.js --help"}}')), "cli|0"));
test("qa:serve → node-server", () =>
  assert.equal(run(mkrepo('{"scripts":{"start":"node server.js","qa:serve":"node server.js"}}')), "node-server|0"));
// qa:render wins over astro detection
test("qa:render → render", () =>
  assert.equal(run(mkrepo('{"dependencies":{"astro":"5"},"scripts":{"qa:render":"make qa-png"}}')), "render|0"));
test("next via dep", () => assert.equal(run(mkrepo('{"dependencies":{"next":"16"}}')), "next|0"));
// Next via next.config.* on disk, with a public/ dir that would otherwise have
// fallen through to `static` and served prebuilt bytes instead of the app
test("next.config beats static fallback", () =>
  assert.equal(run(mkrepo(undefined, ["next.config.ts"], ["public"])), "next|0"));
// `next-auth` is not `next` — the dep match must be word-exact
test("next-auth is not next", () =>
  assert.equal(run(mkrepo('{"dependencies":{"next-auth":"5"}}', [], ["dist"])), "static|0"));
test("qa:serve beats next", () =>
  assert.equal(run(mkrepo('{"dependencies":{"next":"16"},"scripts":{"qa:serve":"next dev"}}')), "node-server|0"));

// The rest of the output contract serve.ts and qa-targets.ts read.
test("every KEY line is emitted, with the npm command for a declared qa:* script", () => {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SCRIPT, mkrepo('{"scripts":{"qa:serve":"node s.js"}}')],
    { encoding: "utf8" },
  );
  assert.equal(
    r.stdout,
    "TYPE=node-server\nQA_SERVE=npm run qa:serve\nQA_CMD=\nQA_RENDER=\nSERVE_DIR=\nSIGNALS=package.json:qa:serve\n",
  );
});
test("static names its dir and the signals", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, mkrepo(undefined, [], ["public"])], {
    encoding: "utf8",
  });
  assert.match(r.stdout, /^SERVE_DIR=public$/m);
  assert.match(r.stdout, /^SIGNALS=astro=no,next=no,vite=no,wrangler=no,bin=no,static=public$/m);
});
test("unknown says why on stderr", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, mkrepo()], { encoding: "utf8" });
  assert.match(r.stderr, /detect-app: unknown app type \(astro=no/);
});
test("no argument → 2 with usage", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage: detect-app\.ts <repo-dir>/);
});
test("not a directory → 2", () => {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, join(TMP, "nope")], {
    encoding: "utf8",
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a directory/);
});
