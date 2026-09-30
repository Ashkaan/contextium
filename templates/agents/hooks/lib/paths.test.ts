// Rows for lib/paths.sh: canon_missing gives GNU `realpath --canonicalize-missing`'s
// answer (symlinks in the existing part followed, a missing tail kept, `.` and
// `..` folded) without GNU; run_bounded stops a command at its limit and says
// so with 124. Where GNU realpath is present the rows are also checked against it.
//
// paths.sh stays bash (the hook sources it), so each row spawns bash, sources
// the library and calls the function the way the hook does.
//
// Run: node --test --experimental-strip-types .agents/hooks/lib/paths.test.ts

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const LIB = join(import.meta.dirname, "paths.sh");
const T = realpathSync(mkdtempSync(join(tmpdir(), "paths-test-")));
after(() => rmSync(T, { recursive: true, force: true }));

/** Source paths.sh in a fresh bash and run `script`; args reach it as $1…. */
function sh(script: string, args: string[] = [], cwd?: string): { rc: number | null; out: string } {
  const r = spawnSync("bash", ["-c", `set -uo pipefail; . "$LIB"; ${script}`, "paths-test", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, LIB },
  });
  return { rc: r.status, out: r.stdout.replace(/\n$/, "") };
}
const canon = (p: string, cwd?: string): string => sh('canon_missing "$1"', [p], cwd).out;

mkdirSync(join(T, "real/sub"), { recursive: true });
mkdirSync(join(T, "links"));
writeFileSync(join(T, "real/sub/file"), "x\n");
symlinkSync(join(T, "real"), join(T, "links/dirlink"));
symlinkSync("../real/sub/file", join(T, "links/filelink"));
symlinkSync(join(T, "nowhere/else"), join(T, "links/dangling"));
symlinkSync("../real/sub", join(T, "links/rel"));

const rows: [string, string, string][] = [
  ["an existing path", `${T}/real/sub/file`, `${T}/real/sub/file`],
  ["a missing tail is kept", `${T}/real/sub/new/deeper.md`, `${T}/real/sub/new/deeper.md`],
  ["a symlinked directory in the path is followed", `${T}/links/dirlink/sub/new.md`, `${T}/real/sub/new.md`],
  ["a symlinked leaf is followed", `${T}/links/filelink`, `${T}/real/sub/file`],
  ["a dangling link resolves to its missing target", `${T}/links/dangling`, `${T}/nowhere/else`],
  ["dot and dot-dot fold", `${T}/real/./sub/../sub/x/../y`, `${T}/real/sub/y`],
  ["the root", "/", "/"],
  [".. after a symlinked directory is taken from its target", `${T}/links/dirlink/../elsewhere.md`, `${T}/elsewhere.md`],
  ["…through a relative link too", `${T}/links/rel/../x`, `${T}/real/x`],
];

for (const [name, input, want] of rows) {
  test(`canon_missing: ${name}`, () => {
    assert.equal(canon(input), want);
  });
}

test("canon_missing: a relative path is taken from PWD", () => {
  assert.equal(canon("sub/z", join(T, "real")), `${T}/real/sub/z`);
});

const gnu = spawnSync("realpath", ["--canonicalize-missing", "/"], { encoding: "utf8" }).status === 0;
test("canon_missing agrees with GNU realpath", { skip: gnu ? false : "no GNU realpath here" }, () => {
  for (const p of [
    `${T}/real/sub/file`,
    `${T}/links/dirlink/sub/new.md`,
    `${T}/links/filelink`,
    `${T}/links/dangling`,
    `${T}/real/./sub/../sub/x/../y`,
    `${T}/links/dirlink/../elsewhere.md`,
    `${T}/links/rel/../x`,
  ]) {
    const r = spawnSync("realpath", ["--canonicalize-missing", "--", p], { encoding: "utf8" });
    assert.equal(canon(p), r.stdout.replace(/\n$/, ""), `agrees with GNU realpath: ${p}`);
  }
});

test("run_bounded: a command past its limit returns 124, stopped near the limit", () => {
  const start = Date.now();
  const r = sh('rc=0; run_bounded 1 sleep 5 || rc=$?; echo "$rc"');
  assert.equal(r.out, "124", "a command past its limit returns 124");
  assert.ok(Date.now() - start < 4000, "…and is stopped near the limit");
});

test("run_bounded: a stopped command's own children do not hold its output open", () => {
  const start = Date.now();
  const r = sh(`out="$(run_bounded 1 sh -c 'sleep 5; echo late' 2>/dev/null)"; printf '%s' "$out"`);
  assert.equal(`${Date.now() - start < 4000}:${r.out}`, "true:");
});

test("run_bounded: a command within its limit keeps its own exit code and output", () => {
  assert.equal(sh(`rc=0; run_bounded 5 sh -c 'exit 3' || rc=$?; echo "$rc"`).out, "3");
  assert.equal(sh("run_bounded 5 echo hi").out, "hi");
});
