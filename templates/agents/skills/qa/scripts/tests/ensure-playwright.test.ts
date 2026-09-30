#!/usr/bin/env -S node --experimental-strip-types
// ensure-playwright.test.ts — peer of ensure-playwright.ts. Offline: every
// Playwright here is a fake module, and npm is a stub on PATH.
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/ensure-playwright.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "..", "ensure-playwright.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "ensure-pw-test-")));
after(() => rmSync(tmp, { recursive: true, force: true }));

/** A playwright whose chromium lives at <nm>/.browser, and whose cli.js "installs" it by touching that file. */
function fakePw(nm: string): void {
  mkdirSync(join(nm, "playwright"), { recursive: true });
  writeFileSync(join(nm, "playwright/package.json"), '{"name":"playwright","version":"0.0.0","main":"index.js"}\n');
  writeFileSync(
    join(nm, "playwright/index.js"),
    'module.exports={chromium:{executablePath:()=>require("path").join(__dirname,"..",".browser")}};\n',
  );
  writeFileSync(
    join(nm, "playwright/cli.js"),
    'require("fs").appendFileSync(__dirname+"/../cli-calls",process.argv.slice(2).join(" ")+"\\n");require("fs").writeFileSync(__dirname+"/../.browser","");\n',
  );
}

// A PATH holding only a stub npm (the script runs node as process.execPath).
const BIN = join(tmp, "bin");
mkdirSync(BIN);
function stubNpm(body: string): void {
  writeFileSync(join(BIN, "npm"), `#!/bin/sh\n${body}\n`);
  chmodSync(join(BIN, "npm"), 0o755);
}
function run(args: string[], env: NodeJS.ProcessEnv = {}): { rc: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: { HOME: join(tmp, "home"), PATH: BIN, ...env },
  });
  return { rc: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

test("the app's own Playwright is used", () => {
  fakePw(join(tmp, "app1/node_modules"));
  writeFileSync(join(tmp, "app1/node_modules/.browser"), "");
  const r = run(["--app", join(tmp, "app1")], { QA_PLAYWRIGHT_DIR: join(tmp, "cache1") });
  assert.equal(r.out, `PLAYWRIGHT_MODULE=${join(tmp, "app1/node_modules/playwright")}\n`, r.err);
  assert.equal(r.rc, 0);
});

test("a missing browser is installed by the same module", () => {
  fakePw(join(tmp, "app2/node_modules"));
  const r = run(["--app", join(tmp, "app2")], { QA_PLAYWRIGHT_DIR: join(tmp, "cache2") });
  assert.equal(r.out, `PLAYWRIGHT_MODULE=${join(tmp, "app2/node_modules/playwright")}\n`, r.err);
  assert.equal(r.rc, 0);
  assert.equal(readFileSync(join(tmp, "app2/node_modules/cli-calls"), "utf8"), "install chromium\n");
});

test("nothing anywhere and QA_NO_INSTALL=1: exit 4, said plainly", () => {
  mkdirSync(join(tmp, "app3"), { recursive: true });
  const r = run(["--app", join(tmp, "app3")], { QA_NO_INSTALL: "1", QA_PLAYWRIGHT_DIR: join(tmp, "cache3") });
  assert.equal(r.rc, 4);
  assert.match(r.err, /^qa: skipped — Playwright unavailable \(/m);
});

test("a module without its browser and QA_NO_INSTALL=1: exit 4, nothing installed", () => {
  fakePw(join(tmp, "app3b/node_modules"));
  const r = run(["--app", join(tmp, "app3b")], { QA_NO_INSTALL: "1", QA_PLAYWRIGHT_DIR: join(tmp, "cache3") });
  assert.equal(r.rc, 4);
  assert.match(r.err, /Chromium is not installed and QA_NO_INSTALL=1/);
});

test("a Playwright above the app's root is somebody else's and is ignored", () => {
  fakePw(join(tmp, "outer/node_modules"));
  writeFileSync(join(tmp, "outer/node_modules/.browser"), "");
  mkdirSync(join(tmp, "outer/app/.git"), { recursive: true });
  const r = run(["--app", join(tmp, "outer/app")], { QA_NO_INSTALL: "1", QA_PLAYWRIGHT_DIR: join(tmp, "cache3") });
  assert.equal(r.rc, 4, r.out);
});

test("nothing anywhere and npm fails (offline): exit 4 with npm's reason", () => {
  stubNpm('[ "$1" = --version ] && exit 0; echo "npm ERR! network unreachable" >&2; exit 1');
  const r = run(["--app", join(tmp, "app3")], { QA_PLAYWRIGHT_DIR: join(tmp, "cache4") });
  assert.equal(r.rc, 4);
  assert.match(r.err, /^qa: skipped — Playwright unavailable \(.*network unreachable/m);
});

test("first use installs into the cache, and the second use finds it without npm", () => {
  // The stub npm makes <prefix>/node_modules/playwright (a fake), as npm install would.
  stubNpm(`[ "$1" = --version ] && exit 0
prefix=""; while [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix="$2"; shift; done
/bin/mkdir -p "$prefix/node_modules" && /bin/cp -R "${join(tmp, "app2/node_modules/playwright")}" "$prefix/node_modules/"`);
  const cache = join(tmp, "cache5");
  const first = run(["--app", join(tmp, "app3")], { QA_PLAYWRIGHT_DIR: cache });
  assert.equal(first.out, `PLAYWRIGHT_MODULE=${join(cache, "node_modules/playwright")}\n`, first.err);
  assert.equal(first.rc, 0);
  stubNpm("exit 1");
  const second = run(["--app", join(tmp, "app3")], { QA_PLAYWRIGHT_DIR: cache });
  assert.equal(second.out, `PLAYWRIGHT_MODULE=${join(cache, "node_modules/playwright")}\n`, second.err);
  assert.equal(second.rc, 0);
});

test("no npm at all: exit 4", () => {
  rmSync(join(BIN, "npm"), { force: true });
  const r = run(["--app", join(tmp, "app3")], { QA_PLAYWRIGHT_DIR: join(tmp, "cache6") });
  assert.equal(r.rc, 4);
  assert.match(r.err, /npm is not installed/);
});

test("an unknown flag is exit 2", () => assert.equal(run(["--wat"]).rc, 2));
test("--app with no directory is exit 2", () => assert.equal(run(["--app"]).rc, 2));
