// cli-exit.test.ts — a program that exits through cli-exit keeps everything it
// printed, and still leaves with its status.
//
// `exit` is plain enough to test by import. Everything else ends the process
// that calls it, so each of those cases writes a tiny program into a temp dir,
// importing cli-exit by absolute path, and spawns it. The drain cases pipe the
// program into a reader that sleeps first, so the pipe is full when the program
// finishes — the condition under which process.exit() dropped the tail.
//
// Run: node --experimental-strip-types --test packages/cli-exit/cli-exit.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Exit, exit } from "./cli-exit.ts";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "cli-exit.ts");
const TMP = mkdtempSync(join(tmpdir(), "cli-exit-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
/** Write a program whose body follows the import, and return its path. */
function program(body: string): string {
  const path = join(TMP, `p${n++}.ts`);
  writeFileSync(path, `import { drainThenExit, exit, runToExit } from ${JSON.stringify(LIB)};\n${body}\n`);
  return path;
}
/** Run it with stdout (or stderr) into a reader that sleeps first; `rc=` lands on the other stream. */
function throughSlowPipe(path: string, stream: "stdout" | "stderr" = "stdout"): { out: string; rc: string } {
  const pipe = stream === "stdout" ? "" : "2>&1 >/dev/null";
  const r = spawnSync(
    "sh",
    [
      "-c",
      `{ "$0" --experimental-strip-types "$1" ${pipe}; echo "rc=$?" >&3; } 3>&2 | { sleep 1; cat; }`,
      process.execPath,
      path,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 },
  );
  return { out: r.stdout, rc: /rc=(\d+)/.exec(r.stderr)?.[1] ?? `none: ${r.stderr}` };
}
const LINES = 20_000; // about 300 KiB — several times a 64 KiB pipe buffer

test("exit throws an Exit carrying the status, and ends nothing itself", () => {
  assert.throws(
    () => exit(3),
    (e: unknown) => e instanceof Exit && e.code === 3,
  );
});

test("a long report and exit(1) through a slow pipe: every line, then the status", () => {
  const p = program(`await runToExit(() => {
  for (let i = 0; i < ${LINES}; i++) process.stdout.write(\`line \${i} of a long report\\n\`);
  process.stdout.write("VERDICT\\n");
  exit(1);
});`);
  const r = throughSlowPipe(p);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("line ")).length, LINES);
  assert.ok(r.out.endsWith("VERDICT\n"), "the last line written is the last line read");
  assert.equal(r.rc, "1");
});

test("stderr drains too", () => {
  const p = program(`await runToExit(() => {
  for (let i = 0; i < ${LINES}; i++) process.stderr.write(\`warning \${i}\\n\`);
  exit(2);
});`);
  const r = throughSlowPipe(p, "stderr");
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("warning ")).length, LINES);
  assert.equal(r.rc, "2");
});

test("a main that returns keeps the status it set, and ends despite a live timer", () => {
  const p = program(`setInterval(() => {}, 1000);
await runToExit(() => {
  process.stdout.write("done\\n");
  process.exitCode = 5;
});`);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", p], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.error, undefined, "the program ended on its own, before the timeout");
  assert.equal(r.stdout, "done\n");
  assert.equal(r.status, 5);
});

test("an error that is not an Exit still crashes, with its message", () => {
  const p = program(`await runToExit(() => {
  throw new Error("boom from main");
});`);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", p], { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boom from main/);
});

test("an event callback leaves through drainThenExit with its own status", () => {
  const p = program(`setTimeout(() => {
  for (let i = 0; i < ${LINES}; i++) process.stdout.write(\`from a callback \${i}\\n\`);
  process.exitCode = 4;
  drainThenExit();
}, 10);
await runToExit(() => new Promise(() => {}));`);
  const r = throughSlowPipe(p);
  assert.equal(r.out.split("\n").filter((l) => l.startsWith("from a callback ")).length, LINES);
  assert.equal(r.rc, "4");
});
