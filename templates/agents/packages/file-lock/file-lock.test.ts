// file-lock.test.ts — peer of file-lock.ts: one exclusive flock(2) per call.
// Run: node --test --experimental-strip-types packages/file-lock/file-lock.test.ts
//
// Every case runs the package the way a script does: a child `node` that
// imports it and takes the lock, so two takers are two processes, as they are
// in use (a flock is per open file description; one process cannot contend
// with itself the way two do).

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "file-lock.ts");
const TMP = mkdtempSync(join(tmpdir(), "file-lock-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

// The taker: `taker.ts <lock> <mode> [waitSeconds] [holdMs]`. Its lines on
// stdout say what happened, in order, written synchronously so a SIGKILL
// cannot lose one already printed.
const TAKER = join(TMP, "taker.ts");
writeFileSync(
  TAKER,
  `import { writeSync } from "node:fs";
import { LockError, withLock } from ${JSON.stringify(pathToFileURL(PKG).href)};
const [path, mode, wait, hold] = process.argv.slice(2);
const say = (l: string): void => { writeSync(1, l + "\\n"); };
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const opts = {
  ...(wait ? { waitSeconds: Number(wait) } : {}),
  ...(mode.startsWith("shared-") ? { shared: true } : {}),
  ...(mode === "hooks"
    ? { onHeld: (fd: number) => say("held " + fd), onReleased: (fd: number) => say("released " + fd) }
    : {}),
};
const t0 = Date.now();
try {
  withLock(path, () => {
    say("RAN " + (Date.now() - t0));
    if (mode === "hold" || mode === "shared-hold") sleep(Number(hold));
    if (mode === "throw") throw new Error("boom");
    if (mode === "hooks") say("fn");
  }, opts);
  say("DONE");
} catch (e) {
  if (e instanceof LockError) say("LOCKERR " + e.status + " " + e.message);
  else say("THREW " + (e as Error).message);
  // Stay alive, so a release seen by another process is the code's, not the kernel's at exit.
  if (mode === "throw" && hold) sleep(Number(hold));
}
`,
);

interface R {
  out: string;
  rc: number | null;
}
function take(lock: string, mode: string, wait = "", hold = "", env: NodeJS.ProcessEnv = process.env): R {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", TAKER, lock, mode, wait, hold], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.trim(), rc: r.status };
}
/** Start a taker in the background and resolve once its output shows `marker` (default: it holds the lock). */
function holder(lock: string, holdMs: number, mode = "hold", marker = "RAN "): Promise<ChildProcess> {
  const c = spawn(process.execPath, ["--experimental-strip-types", TAKER, lock, mode, "", String(holdMs)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((ok, no) => {
    let buf = "";
    c.stdout?.on("data", (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(marker)) ok(c);
    });
    c.on("exit", () => no(new Error(`holder exited before holding: ${buf}`)));
  });
}
const exited = (c: ChildProcess): Promise<void> =>
  new Promise((ok) => {
    if (c.exitCode !== null || c.signalCode !== null) ok();
    else c.on("exit", () => ok());
  });
let n = 0;
const lockPath = (): string => {
  const d = join(TMP, `case-${++n}`);
  mkdirSync(d);
  return join(d, "x.lock");
};

test("a second process waits for a held lock and takes it once the first releases", async () => {
  const lock = lockPath();
  const h = await holder(lock, 1500);
  const r = take(lock, "run");
  await exited(h);
  assert.equal(r.rc, 0);
  const ran = r.out.match(/^RAN (\d+)$/m);
  assert.ok(ran, `the second taker ran: ${r.out}`);
  assert.ok(Number(ran[1]) >= 500, `it waited for the holder (${ran[1]} ms)`);
  assert.match(r.out, /DONE$/);
});

test("shared holders run together, and an exclusive taker waits for them", async () => {
  const lock = lockPath();
  const h = await holder(lock, 3000, "shared-hold");
  try {
    const shared = take(lock, "shared-run", "1");
    assert.match(shared.out, /^RAN \d+\nDONE$/, `a second shared taker runs while the first holds: ${shared.out}`);
    const exclusive = take(lock, "run", "1");
    assert.doesNotMatch(exclusive.out, /RAN/, "an exclusive taker must not run while a shared lock is held");
    assert.match(exclusive.out, /^LOCKERR 1 .*1s wait/);
  } finally {
    h.kill("SIGKILL");
    await exited(h);
  }
});

test("a shared taker waits for an exclusive holder", async () => {
  const lock = lockPath();
  const h = await holder(lock, 3000);
  try {
    const shared = take(lock, "shared-run", "1");
    assert.doesNotMatch(shared.out, /RAN/, "a shared taker must not run while an exclusive lock is held");
    assert.match(shared.out, /^LOCKERR 1 /);
  } finally {
    h.kill("SIGKILL");
    await exited(h);
  }
});

test("a bounded wait on a held lock fails with a LockError naming the lock, and fn never runs", async () => {
  const lock = lockPath();
  const h = await holder(lock, 5000);
  try {
    const r = take(lock, "run", "1");
    assert.doesNotMatch(r.out, /RAN/, "fn must not run without the lock");
    assert.match(r.out, /^LOCKERR 1 /);
    assert.ok(r.out.includes(lock), `the error names ${lock}: ${r.out}`);
    assert.match(r.out, /1s wait/);
  } finally {
    h.kill("SIGKILL");
    await exited(h);
  }
});

test("a throwing fn releases the lock and its error reaches the caller", async () => {
  const lock = lockPath();
  // The thrower stays alive after catching, so the kernel's release at exit cannot stand in for withLock's.
  const t = await holder(lock, 10_000, "throw", "THREW boom");
  try {
    const next = take(lock, "run", "1");
    assert.match(next.out, /^RAN \d+\nDONE$/, `another process gets it while the thrower is still alive: ${next.out}`);
  } finally {
    t.kill("SIGKILL");
    await exited(t);
  }
});

test("a holder killed with SIGKILL releases the lock", async () => {
  const lock = lockPath();
  const h = await holder(lock, 60_000);
  h.kill("SIGKILL");
  await exited(h);
  const r = take(lock, "run", "2");
  assert.match(r.out, /^RAN \d+\nDONE$/);
});

test("onHeld gets the open descriptor before fn, onReleased after", () => {
  const lock = lockPath();
  const r = take(lock, "hooks");
  const m = r.out.match(/^held (\d+)\nRAN \d+\nfn\nreleased (\d+)\nDONE$/);
  assert.ok(m, `hook order: ${r.out}`);
  assert.equal(m[1], m[2], "the same descriptor both times");
  assert.ok(Number(m[1]) > 2, "a real file descriptor, not stdio");
});

// Stock macOS has no flock(1): with none on PATH the lock is the directory
// <lock>.held, which a second process waits on, a bounded wait gives up on,
// and a SIGKILLed holder's dead pid gives up to the next taker.
test("with no flock on PATH, the directory lock excludes, times out, and is taken over from a dead holder", async () => {
  const empty = join(TMP, "empty-bin");
  mkdirSync(empty, { recursive: true });
  const env = { ...process.env, PATH: empty };
  const lock = lockPath();
  assert.match(take(lock, "run", "", "", env).out, /^RAN \d+\nDONE$/, "it runs without flock");
  assert.equal(existsSync(`${lock}.held`), false, "and leaves no lock behind");
  const h = spawn(process.execPath, ["--experimental-strip-types", TAKER, lock, "hold", "", "60000"], {
    stdio: ["ignore", "pipe", "inherit"],
    env,
  });
  await new Promise<void>((ok) => h.stdout?.on("data", (d: Buffer) => d.toString().includes("RAN ") && ok()));
  const busy = take(lock, "run", "1", "", env);
  assert.doesNotMatch(busy.out, /RAN/, "a held directory lock excludes");
  assert.match(busy.out, /^LOCKERR 1 .*past the 1s wait/);
  h.kill("SIGKILL");
  await exited(h);
  assert.match(take(lock, "run", "2", "", env).out, /^RAN \d+\nDONE$/, "a dead holder's lock is taken over");
});

/** A child process that tries the lock with no wait: "took" or "busy". */
function tryOnce(path: string): string {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      `import { withLock } from ${JSON.stringify(pathToFileURL(PKG).href)};
try { withLock(${JSON.stringify(path)}, () => {}, { waitSeconds: 0 }); console.log("took"); } catch { console.log("busy"); }`,
    ],
    { encoding: "utf8" },
  );
  return r.stdout.trim();
}

test("holdLock keeps the lock across async work until release(); another process is refused meanwhile and takes it after", async () => {
  const { holdLock } = (await import(pathToFileURL(PKG).href)) as typeof import("./file-lock.ts");
  const p = join(TMP, "hold.lock");
  const release = holdLock(p);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(tryOnce(p), "busy");
  release();
  release();
  assert.equal(tryOnce(p), "took");
});
