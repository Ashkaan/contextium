// Test harness for layer-1.ts — lint then typecheck, per package, by convention.
// The subject is spawned as a program, with the file list on stdin, against
// fixture repos built under one temp root that is removed when the suite ends.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/layer-1.test.ts
//
// peers: layer-1.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "layer-1.ts");
const TMP = mkdtempSync(join(tmpdir(), "layer-1-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const mktemp = (): string => mkdtempSync(join(TMP, `d${++n}-`));

const has = (bin: string): boolean => spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
const noNpm = has("npm") ? false : "npm not installed";
const noMake = has("make") ? false : "make not installed";

/** A git repo; order.log records the order steps ran in. */
function makeRepo(): string {
  const d = mktemp();
  execFileSync("git", ["-C", d, "init", "-q"]);
  writeFileSync(join(d, "order.log"), "");
  return d;
}

/** A package.json at <repo>/<dir> declaring the given scripts ("" leaves one out). */
function pkg(repo: string, dir: string, lint: string, typecheck: string, check = ""): void {
  const scripts: Record<string, string> = {};
  if (lint) scripts.lint = lint;
  if (typecheck) scripts.typecheck = typecheck;
  if (check) scripts.check = check;
  mkdirSync(join(repo, dir), { recursive: true });
  writeFileSync(join(repo, dir, "package.json"), `${JSON.stringify({ name: "x", scripts })}\n`);
}

function run(stdin: string, opts: { repo?: string; cwd?: string }): { rc: number; out: string; all: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
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

const order = (repo: string): string => readFileSync(join(repo, "order.log"), "utf8").split("\n").join(" ");

// ── Case 1: 0 files on stdin → PASS: layer-1 (0 files) ──
test("case1 zero-files", () => {
  const repo = makeRepo();
  const r = run("", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-1 (0 files)"), r.all);
});

// ── Case 2: lint then typecheck, in that order, for every package ──
test("case2 lint-then-typecheck-and-check-counts", { skip: noNpm }, () => {
  const repo = makeRepo();
  const log = join(repo, "order.log");
  pkg(repo, "apps/a", `echo a-lint >> ${log}`, `echo a-type >> ${log}`);
  pkg(repo, "apps/b", `echo b-lint >> ${log}`, "", `echo b-check >> ${log}`);
  const r = run("apps/a/src/x.ts\napps/b/y.js", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.equal(order(repo), "a-lint b-lint a-type b-check ", `order: ${order(repo)}`);
  assert.ok(r.out.includes("PASS: layer-1 typecheck (apps/b)"), `npm check not taken as typecheck: ${r.all}`);
});

// ── Case 3: lint fails → FAIL early; typecheck not run ──
test("case3 lint-fails-early", { skip: noNpm }, () => {
  const repo = makeRepo();
  pkg(repo, "apps/a", "echo bad; exit 1", `echo a-type >> ${join(repo, "order.log")}`);
  const r = run("apps/a/x.ts", { repo });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: layer-1 lint (apps/a)"), r.all);
  assert.ok(r.all.includes("bad"), `the failing step's output is not on stderr: ${r.all}`);
  assert.equal(order(repo), "", "typecheck ran after a lint failure");
});

// ── Case 4: typecheck fails → FAIL ──
test("case4 typecheck-fails", { skip: noNpm }, () => {
  const repo = makeRepo();
  pkg(repo, "apps/a", "true", "exit 2");
  const r = run("apps/a/x.ts", { repo });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.out.includes("FAIL: layer-1 typecheck (apps/a)"), r.all);
});

// ── Case 5: a Makefile package, and a missing step is a WARN, not a FAIL ──
test("case5 make-target-and-missing-step-warns", { skip: noMake }, () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "tools/gen"), { recursive: true });
  writeFileSync(join(repo, "tools/gen/Makefile"), "lint:\n\t@true\n");
  const r = run("tools/gen/main.go", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-1 lint (tools/gen)"), `make lint not run: ${r.all}`);
  assert.ok(
    r.out.includes("WARN: layer-1 typecheck (tools/gen) — no typecheck/check script or make target; skipped"),
    `missing step not warned: ${r.all}`,
  );
});

// ── Case 5b: make's own view of the targets, not a line match ──
//
// A rule may name several targets (`lint typecheck:`) and an included file may
// hold them; a match on `^<name>:` saw neither, and a declared step was skipped
// as a WARN. A name that is only a prefix of a target, a variable and a pattern
// rule are still not targets.
test("case5b make-multi-target-and-included-targets", { skip: noMake }, () => {
  const repo = makeRepo();
  const log = join(repo, "order.log");
  mkdirSync(join(repo, "tools/multi"), { recursive: true });
  writeFileSync(join(repo, "tools/multi/Makefile"), `lint typecheck:\n\t@echo multi-$@ >> ${log}\n`);
  mkdirSync(join(repo, "tools/inc"), { recursive: true });
  writeFileSync(join(repo, "tools/inc/Makefile"), "include rules.mk\n");
  writeFileSync(
    join(repo, "tools/inc/rules.mk"),
    `lint:\n\t@echo inc-lint >> ${log}\ncheck:\n\t@echo inc-check >> ${log}\n`,
  );
  mkdirSync(join(repo, "tools/none"), { recursive: true });
  writeFileSync(join(repo, "tools/none/Makefile"), "lintx:\n\t@false\nLINT := lint\n%.o: %.c\n\t@false\n");
  const r = run("tools/multi/a.go\ntools/inc/a.go\ntools/none/a.go", { repo });
  assert.equal(r.rc, 0, r.all);
  for (const line of [
    "PASS: layer-1 lint (tools/multi)",
    "PASS: layer-1 typecheck (tools/multi)",
    "PASS: layer-1 lint (tools/inc)",
    "PASS: layer-1 typecheck (tools/inc)",
    "WARN: layer-1 lint (tools/none) — no lint script or make target; skipped",
  ]) {
    assert.ok(r.out.includes(line), `missing [${line}]: ${r.all}`);
  }
  assert.equal(order(repo), "inc-lint multi-lint inc-check multi-typecheck ");
});

// ── Case 5c: no make to ask — a declared target still runs, and FAILs ──
//
// Without make there is no database, so the Makefile's own lines answer; the
// step is then run and fails on the missing binary instead of passing as a
// skipped WARN. The run needs no binary but node, so an empty PATH stands in
// for a host without make.
test("case5c no-make-declared-target-fails-not-skips", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "tools/gen"), { recursive: true });
  writeFileSync(join(repo, "tools/gen/Makefile"), "lint typecheck:\n\t@true\n");
  const empty = mktemp();
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    input: "tools/gen/main.go\n",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, PATH: empty },
    timeout: 120000,
  });
  assert.equal(r.status, 1, `${r.stdout}${r.stderr}`);
  assert.ok(r.stdout.includes("FAIL: layer-1 lint (tools/gen)"), `${r.stdout}${r.stderr}`);
});

// ── Case 5d: a Makefile make cannot read FAILs, it is not "no such target" ──
//
// make still prints a database after a parse error — one holding none of the
// Makefile's targets — so a syntax error above the rules, or an include that
// is missing, read as a package that declares no lint and no typecheck, and
// the whole layer passed as two skipped WARNs. A Makefile with no `.DEFAULT`
// goal (every Makefile here) is the ordinary case and stays one.
test("case5d unparseable-makefile-fails-not-skips", { skip: noMake }, () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "tools/bad"), { recursive: true });
  writeFileSync(join(repo, "tools/bad/Makefile"), "oops this is not make\nlint typecheck:\n\t@true\n");
  mkdirSync(join(repo, "tools/noinc"), { recursive: true });
  writeFileSync(join(repo, "tools/noinc/Makefile"), "include missing.mk\n");
  const r = run("tools/bad/a.go\ntools/noinc/a.go", { repo });
  assert.equal(r.rc, 1, `an unparseable Makefile passed: ${r.all}`);
  assert.ok(r.out.includes("FAIL: layer-1 lint (tools/bad)"), `syntax error read as no target: ${r.all}`);
  assert.ok(r.out.includes("FAIL: layer-1 lint (tools/noinc)"), `missing include read as no target: ${r.all}`);
  assert.match(r.all, /missing separator/, "…and the failure quotes make's own error");
  assert.doesNotMatch(r.out, /WARN: layer-1 lint \(tools\/(bad|noinc)\)/, `…never a skipped WARN: ${r.all}`);
});

// ── Case 6: markdown and records select no package; a deleted file still does ──
test("case6 records-select-nothing-deleted-selects-its-package", { skip: noNpm }, () => {
  const repo = makeRepo();
  pkg(repo, ".", `echo root-lint >> ${join(repo, "order.log")}`, "");
  let r = run("README.md\njournal/2026-01-12/1200-x.md", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("no package in scope"), `records selected a package: ${r.all}`);
  r = run("src/deleted-file.ts", { repo });
  assert.ok(r.out.includes("PASS: layer-1 lint ((root))"), `a deleted path lost its package: ${r.all}`);
});

// ── Case 7: CLAUDE_PROJECT_DIR unset but cwd inside a git repo ──
test("case7 env-unset-in-repo-resolves-via-git", { skip: noNpm }, () => {
  const repo = makeRepo();
  pkg(repo, "apps/a", "true", "true");
  const r = run("apps/a/x.ts", { cwd: repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-1 lint (apps/a)"), r.all);
});

// ── Case 8: CLAUDE_PROJECT_DIR unset AND outside a git repo → exit 1 ──
test("case8 env-unset-outside-repo-hard-errors", () => {
  const nongit = mktemp();
  const r = run("x.ts", { cwd: nongit });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.all.includes("not inside a git repo"), r.all);
});

// ── Case 9: a code file no package owns is said, never passed over ──
//
// Nothing lints a file outside every package, and "no package in scope" read
// as a clean lint: a standalone script was certified linted with no checker
// run. It is a WARN naming the files; markdown and records stay silent.
test("case9 code-outside-every-package-warns", { skip: noNpm }, () => {
  const repo = makeRepo();
  let r = run("scripts/tool.sh\nbin/x.py\nREADME.md", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(
    r.out.includes("WARN: layer-1 lint (2 files in no package) — not linted or typechecked: bin/x.py scripts/tool.sh"),
    `unowned code not warned: ${r.all}`,
  );
  assert.equal(r.out.includes("PASS:"), false, `a pass was reported over nothing: ${r.all}`);
  pkg(repo, "apps/a", "true", "true");
  r = run("apps/a/x.ts\nscripts/tool.sh", { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("PASS: layer-1 lint (apps/a)"), r.all);
  assert.ok(
    r.out.includes("WARN: layer-1 lint (1 files in no package) — not linted or typechecked: scripts/tool.sh"),
    r.all,
  );
});
