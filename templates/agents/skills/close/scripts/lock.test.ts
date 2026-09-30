// lock.test.ts — peer of lock.sh: mutual exclusion under contention, a timeout
// that leaves a live holder alone, a dead holder's lock taken over, a release
// that only ever removes the caller's own lock, and lock_repo in both of its
// modes (flock where it exists, the portable lock where it does not).
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/lock.test.ts
//
// lock.sh stays bash (write-root.sh sources it), so every worker is a bash that
// sources the library — the same way write-root.sh and land.ts's lock holder
// take it.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "lock.sh");
const TMP = mkdtempSync(join(tmpdir(), "lock-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/** A bash that sources lock.sh and runs `body` with $1… set to `args`. */
function bash(body: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  return spawn("bash", ["-c", `source "$0"; ${body}`, LIB, ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
const done = (c: ChildProcess): Promise<number | null> => new Promise((ok) => c.on("close", (rc) => ok(rc)));
function bashSync(body: string, args: string[]): { rc: number | null; out: string } {
  const r = spawnSync("bash", ["-c", `source "$0"; ${body}`, LIB, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, "") };
}
/** A process that lives until killed, so its pid is a live holder. */
function sleeper(): ChildProcess {
  return spawn("sleep", ["30"], { stdio: "ignore" });
}
async function kill(c: ChildProcess): Promise<void> {
  c.kill();
  await done(c);
}

const LOCK = join(TMP, "lock");
const COUNTER = join(TMP, "counter");

// A worker: take the lock, read-modify-write a counter slowly, release.
test("15 contending writers lose no increment, and the lock is released after the last", async () => {
  writeFileSync(COUNTER, "0\n");
  const body = 'lock_take "$1" 30 || exit 1; n=$(cat "$2"); sleep 0.05; echo $((n + 1)) >"$2"';
  const rcs = await Promise.all(Array.from({ length: 15 }, () => done(bash(body, [LOCK, COUNTER]))));
  assert.deepEqual(rcs, Array(15).fill(0), "every writer took the lock");
  assert.equal(readFileSync(COUNTER, "utf8").trim(), "15", "15 contending writers lose no increment");
  assert.equal(isLink(LOCK), false, "the lock is released after the last one");
});

test("a live holder times the waiter out and keeps its lock; once dead, it is taken over", async () => {
  const live = sleeper();
  symlinkSync(String(live.pid), LOCK);
  assert.equal(bashSync('lock_take "$1" 1', [LOCK]).rc, 1, "a live holder times the waiter out");
  assert.equal(readlinkSync(LOCK), String(live.pid), "…and keeps its lock");
  await kill(live);

  const r = bashSync('lock_take "$1" 5 && readlink "$1"', [LOCK]);
  assert.equal(r.rc, 0, "a dead holder's lock is taken over");
  assert.ok(r.out !== "" && r.out !== String(live.pid), `…by the taker (read '${r.out}')`);
  assert.equal(existsSync(`${LOCK}.takeover`), false, "…and no takeover guard is left");
});

test("release never removes another holder's lock", async () => {
  const other = sleeper();
  rmSync(LOCK, { force: true });
  symlinkSync(String(other.pid), LOCK);
  bashSync('lock_release "$1"', [LOCK]);
  assert.equal(readlinkSync(LOCK), String(other.pid), "release never removes another holder's lock");
  await kill(other);
  rmSync(LOCK, { force: true });
});

// lock_repo: flock where it exists, the portable lock otherwise — and the
// second must also exclude a racing writer.
for (const mode of ["flock", "portable"] as const) {
  test(`lock_repo (${mode}): 10 writers lose no increment`, async () => {
    const c2 = join(TMP, `c2-${mode}`);
    writeFileSync(c2, "0\n");
    const env = mode === "portable" ? { LOCK_NO_FLOCK: "1" } : {};
    const body = 'lock_repo "$1" 30 || exit 1; n=$(cat "$2"); sleep 0.05; echo $((n + 1)) >"$2"; lock_repo_release "$1"';
    const rcs = await Promise.all(Array.from({ length: 10 }, () => done(bash(body, [join(TMP, "repo.lock"), c2], env))));
    assert.deepEqual(rcs, Array(10).fill(0), "every writer took the lock");
    assert.equal(readFileSync(c2, "utf8").trim(), "10", `lock_repo (${mode}): 10 writers lose no increment`);
  });
}

test("the portable repo lock is released", () => {
  assert.equal(isLink(join(TMP, "repo.lock.lnk")), false);
});
