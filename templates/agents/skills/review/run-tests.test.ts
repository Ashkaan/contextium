// run-tests.test.ts — the folder runner aggregates: one planted red suite makes
// the run exit 1 and names it, a folder of green suites exits 0, and a missing
// folder is a caller error rather than a silent pass.
//
// Run: node --test --experimental-strip-types .agents/skills/review/run-tests.test.ts
//
// peers:
//   .agents/skills/review/run-tests.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "run-tests.ts");
const TMP = mkdtempSync(path.join(os.tmpdir(), "review-run-tests-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(dir: string): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", RUNNER, dir], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { rc: r.status, out: r.stdout + r.stderr };
}

const GREEN = "process.exit(0);\n";
mkdirSync(path.join(TMP, "green"));
mkdirSync(path.join(TMP, "mixed"));
mkdirSync(path.join(TMP, "empty"));
writeFileSync(path.join(TMP, "green", "a.test.ts"), GREEN);
writeFileSync(path.join(TMP, "green", "b.test.ts"), GREEN);
writeFileSync(path.join(TMP, "mixed", "a.test.ts"), GREEN);
writeFileSync(path.join(TMP, "mixed", "planted.test.ts"), 'console.error("planted");\nprocess.exit(1);\n');
writeFileSync(path.join(TMP, "mixed", "z.test.ts"), GREEN);

test("all green", () => {
  const r = run(path.join(TMP, "green"));
  assert.equal(r.rc, 0, "all green exits 0");
  assert.ok(r.out.includes("review: all 2 suites passed"), "and says so, with the count");
});

test("a folder with no suites", () => {
  const r = run(path.join(TMP, "empty"));
  assert.equal(r.rc, 1, "a folder with no suites is not a pass");
  assert.ok(r.out.includes("no *.test.ts in"), "and says what it found");
});

test("a planted failing suite", () => {
  const r = run(path.join(TMP, "mixed"));
  assert.equal(r.rc, 1, "a planted failing suite makes the run exit 1");
  assert.ok(r.out.includes("FAILED (1): planted.test.ts"), "naming the suite");
  assert.ok(r.out.includes("── z.test.ts"), "and the suites after it still ran");
});

test("a missing folder", () => {
  assert.equal(run(path.join(TMP, "nowhere")).rc, 2, "a missing folder is a caller error");
});

// The harnesses reach every skill script through a symlink (a home skills link
// into the workbench), and an entry guard comparing the invoked path with the
// resolved module path would skip main() there, exiting 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(path.join(TMP, "symlink-"));
  const link = path.join(dir, "run-tests.ts");
  symlinkSync(RUNNER, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...[path.join(dir, "missing")]], {
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /no such folder/);
});
