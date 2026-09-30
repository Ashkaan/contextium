// Test harness for layer-2.ts — each package's tests, by convention.
// The subject is spawned as a program, with the file list on stdin, against
// fixture repos built under one temp root that is removed when the suite ends.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/layer-2.test.ts
//
// peers: layer-2.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "layer-2.ts");
const TMP = mkdtempSync(join(tmpdir(), "layer-2-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const mktemp = (): string => mkdtempSync(join(TMP, `d${++n}-`));

const has = (bin: string): boolean => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const noNpm = has("npm") ? false : "npm not installed";
const noMake = has("make") ? false : "make not installed";

const OK_TEST = 'import { test } from "node:test"; import { strict as assert } from "node:assert"; test("ok", () => assert.equal(1, 1));\n';
const BAD_TEST = 'import { test } from "node:test"; import { strict as assert } from "node:assert"; test("bad", () => assert.equal(1, 2));\n';

function makeRepo(): string {
  const d = mktemp();
  execFileSync("git", ["-C", d, "init", "-q"]);
  return d;
}

function write(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function run(stdin: string, opts: { repo?: string; cwd?: string }): { rc: number; out: string; all: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  // This suite runs under `node --test`, which marks its children as test
  // subprocesses; the subject's own `node --test` must not inherit that.
  delete env.NODE_TEST_CONTEXT;
  if (opts.repo) env.CLAUDE_PROJECT_DIR = opts.repo;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    input: stdin === "" ? "" : `${stdin}\n`,
    cwd: opts.cwd,
    env,
    timeout: 120000,
  });
  return { rc: r.status ?? -1, out: r.stdout, all: `${r.stdout}${r.stderr}` };
}

// ── Case 1: empty stdin → PASS (no tests in scope) ──
test("case1 empty-stdin", () => {
  const repo = makeRepo();
  const r = run("", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2 (no tests in scope)"), r.all);
});

// ── Case 2: a package with no test script and no test files → no tests in scope ──
test("case2 package-without-tests", () => {
  const repo = makeRepo();
  write(join(repo, "apps/foo/package.json"), '{"name":"foo"}\n');
  const r = run("apps/foo/src/x.ts", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2 apps/foo (no tests in scope)"), r.all);
});

// ── Case 3: the package's own test script wins, pass and fail ──
test("case3 own-test-script-pass-and-fail", { skip: noNpm }, () => {
  const repo = makeRepo();
  write(join(repo, "apps/foo/package.json"), '{"name":"foo","scripts":{"test":"true"}}\n');
  let r = run("apps/foo/x.ts", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2 apps/foo (npm test)"), r.all);
  write(join(repo, "apps/foo/package.json"), '{"name":"foo","scripts":{"test":"exit 1"}}\n');
  r = run("apps/foo/x.ts", { repo });
  assert.equal(r.rc, 1, `a red npm test passed: ${r.all}`);
  assert.ok(r.out.includes("FAIL: layer-2 apps/foo"), r.all);
});

// ── Case 4: a Makefile test target ──
test("case4 make-test-target", { skip: noMake }, () => {
  const repo = makeRepo();
  write(join(repo, "tools/gen/Makefile"), "test:\n\t@true\n");
  const r = run("tools/gen/main.go", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2 tools/gen (make test)"), r.all);
});

// ── Case 4b: a test target on a multi-target rule, or in an included file ──
test("case4b make-multi-target-and-included-test", { skip: noMake }, () => {
  const repo = makeRepo();
  write(join(repo, "tools/multi/Makefile"), "check test:\n\t@true\n");
  write(join(repo, "tools/inc/Makefile"), "include rules.mk\n");
  write(join(repo, "tools/inc/rules.mk"), "test:\n\t@false\n");
  const r = run("tools/multi/main.go\ntools/inc/main.go", { repo });
  assert.ok(r.out.includes("PASS: layer-2 tools/multi (make test)"), r.all);
  assert.ok(r.out.includes("FAIL: layer-2 tools/inc"), `an included test target was not run: ${r.all}`);
  assert.equal(r.rc, 1, r.all);
});

// ── Case 5: an integration with no package runs its *.test.ts in place ──
test("case5 in-place-tests-pass-and-fail", () => {
  const repo = makeRepo();
  write(join(repo, "integrations/bar/client.test.ts"), OK_TEST);
  let r = run("integrations/bar/client.ts", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2 integrations/bar (1 tests)"), r.all);
  write(join(repo, "integrations/bar/client.test.ts"), BAD_TEST);
  r = run("integrations/bar/client.ts", { repo });
  assert.equal(r.rc, 1, `a red in-place test passed: ${r.all}`);
  assert.ok(r.out.includes("FAIL: layer-2 integrations/bar"), r.all);
});

// ── Case 6: records and markdown select no tests ──
test("case6 records-run-nothing", () => {
  const repo = makeRepo();
  write(join(repo, "package.json"), '{"name":"root","scripts":{"test":"exit 1"}}\n');
  const r = run("README.md\njournal/2026-01-12/1200-x.md\nprojects/web/x/README.md", { repo });
  assert.equal(r.rc, 0, `records ran a suite: ${r.all}`);
  assert.ok(r.out.includes("no tests in scope"), r.all);
});

// ── Case 7: CLAUDE_PROJECT_DIR unset but cwd inside a git repo ──
test("case7 env-unset-in-repo-resolves-via-git", () => {
  const repo = makeRepo();
  const r = run("", { cwd: repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-2"), r.all);
});

// ── Case 8: CLAUDE_PROJECT_DIR unset AND outside a git repo → exit 1 ──
test("case8 env-unset-outside-repo-hard-errors", () => {
  const nongit = mktemp();
  const r = run("", { cwd: nongit });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.all.includes("not inside a git repo"), r.all);
});

// ── Case 9: JavaScript test files are found in place too ──
// Scope carries every file a package owns, JavaScript included, so the
// in-place fallback must run *.test.js / .mjs / .cjs as well as *.test.ts —
// otherwise a JS package's failing tests pass as "no tests in scope".
test("case9 js-tests-in-place", () => {
  const repo = makeRepo();
  write(
    join(repo, "integrations/js/a.test.cjs"),
    "const { test } = require('node:test'); const assert = require('node:assert'); test('bad', () => assert.equal(1, 2));\n",
  );
  write(join(repo, "integrations/js/b.test.mjs"), "import { test } from 'node:test'; test('ok', () => {});\n");
  write(join(repo, "integrations/js/c.test.js"), "const { test } = require('node:test'); test('ok', () => {});\n");
  let r = run("integrations/js/index.js", { repo });
  assert.equal(r.rc, 1, `a failing .cjs test was not run: ${r.all}`);
  assert.ok(r.out.includes("FAIL: layer-2 integrations/js"), r.all);
  rmSync(join(repo, "integrations/js/a.test.cjs"));
  r = run("integrations/js/index.js", { repo });
  assert.equal(r.rc, 0, `the .mjs and .js tests were not both run: ${r.all}`);
  assert.ok(r.out.includes("PASS: layer-2 integrations/js (2 tests)"), r.all);
});

// ── Case 10: node_modules is never searched for tests ──
test("case10 node-modules-tests-are-not-run", () => {
  const repo = makeRepo();
  write(join(repo, "packages/lib/index.test.ts"), OK_TEST);
  write(join(repo, "packages/lib/node_modules/dep/dep.test.ts"), BAD_TEST);
  const r = run("packages/lib/index.ts", { repo });
  assert.equal(r.rc, 0, `a dependency's test was run: ${r.all}`);
  assert.ok(r.out.includes("PASS: layer-2 packages/lib (1 tests)"), r.all);
});

// ── Case 11: build output and nested packages are not this package's tests ──
//
// dist/ and build/ hold emitted copies of the package's own tests (run twice,
// or stale); a nested folder with its own package.json or Makefile is a
// package of its own, tested by its own runner when it is in scope.
test("case11 build-output-and-nested-packages-are-not-searched", () => {
  const repo = makeRepo();
  write(join(repo, "packages/lib/index.test.ts"), OK_TEST);
  write(join(repo, "packages/lib/dist/index.test.js"), BAD_TEST);
  write(join(repo, "packages/lib/build/index.test.mjs"), BAD_TEST);
  write(join(repo, "packages/lib/sub/package.json"), '{"name":"sub"}\n');
  write(join(repo, "packages/lib/sub/sub.test.ts"), BAD_TEST);
  write(join(repo, "packages/lib/tool/Makefile"), "all:\n\t@true\n");
  write(join(repo, "packages/lib/tool/tool.test.ts"), BAD_TEST);
  const r = run("packages/lib/index.ts", { repo });
  assert.equal(r.rc, 0, `a build copy or a nested package's test was run: ${r.all}`);
  assert.ok(r.out.includes("PASS: layer-2 packages/lib (1 tests)"), r.all);
});
