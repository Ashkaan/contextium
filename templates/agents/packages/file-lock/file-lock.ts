// packages/file-lock — hold an exclusive (or, asked, a shared) flock(2) on a file for the length of a
// synchronous function, from a Node program.
//
// THE MECHANISM. Node has no flock binding, so `withLock` opens the file itself
// (`>` semantics: create + truncate, as bash's `9>path` did) and hands that
// descriptor to `flock -x 3` as the child's fd 3. A flock lock belongs to the
// OPEN FILE DESCRIPTION, which the child shares with this process, so it
// outlives the child and is held until this process closes the file or exits.
// The kernel releases it when the holder dies, however it dies, so a lock is
// never left behind by a killed process (a create-exclusive pid file is; that
// is why this is the repo's lock and not one).
//
// The descriptor is opened close-on-exec, as every `fs.openSync` descriptor
// is, so a child spawned inside `fn` does not inherit the lock unless the
// caller passes it on (through `onHeld`, so a killed wrapper leaves the lock
// with the action still running).
//
// NO flock(1). Stock macOS ships no `flock`. Where it cannot be run (not on
// PATH), the lock is a directory beside the file, `<path>.held`, made with
// mkdir (atomic on every filesystem) and holding the holder's pid; it is
// removed on release and when the process exits, and a lock whose pid is no
// longer running is taken over, so a killed holder never leaves it behind for
// good. A shared lock is exclusive there: slower, never unsafe.
//
// FAILURE. A lock that cannot be taken — the bounded wait ran out, `flock`
// could not be run, `flock` failed — throws a `LockError` naming the lock file,
// before `fn` runs; the caller decides whether that ends the program. A file
// that cannot be opened (its folder missing) throws the open's own error:
// creating the folder is the caller's business.
//
// Consumers: .agents/skills/implement-audit/scripts/audit-dedupe.ts (the review
// record's per-repo write).
//
// Import:
//   import { LockError, withLock } from "../../packages/file-lock/file-lock.ts";

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { join } from "node:path";

export interface LockOptions {
  /** Give up after this many seconds (`flock -w`). Absent: wait as long as it takes. */
  waitSeconds?: number;
  /** Take a shared lock (`flock -s`), which any number of holders share and
   *  an exclusive one waits for. Absent: exclusive. */
  shared?: boolean;
  /** Called with the held descriptor after the lock is taken, before `fn`. */
  onHeld?(fd: number): void;
  /** Called with the descriptor after `fn`, before it is closed. */
  onReleased?(fd: number): void;
}

/** The lock was not taken; `fn` did not run. */
export class LockError extends Error {
  /** The lock file. */
  readonly path: string;
  /** The exit status bash would have reported for the `flock` child (127: could not run it). */
  readonly status: number;
  /** `flock`'s own stderr, as it wrote it. */
  readonly stderr: string;
  /** Why `flock` could not be started, when it could not. */
  readonly spawnError: string | null;
  constructor(path: string, reason: string, status: number, stderr: string, spawnError: string | null) {
    super(`cannot lock ${path}: ${reason}`);
    this.name = "LockError";
    this.path = path;
    this.status = status;
    this.stderr = stderr;
    this.spawnError = spawnError;
  }
}

export function withLock<T>(path: string, fn: () => T, opts: LockOptions = {}): T {
  const { fd, release } = take(path, opts);
  opts.onHeld?.(fd);
  try {
    return fn();
  } finally {
    opts.onReleased?.(fd);
    release();
    closeSync(fd);
  }
}

/**
 * Take the lock and keep it until the returned `release()`, or until this
 * process exits however it exits — for a holder whose work is asynchronous,
 * which withLock's synchronous `fn` cannot cover. Fails as withLock does.
 */
export function holdLock(path: string, opts: Pick<LockOptions, "waitSeconds"> = {}): () => void {
  const { fd, release } = take(path, opts);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    release();
    closeSync(fd);
  };
}

/** Open the lock file and take flock on it (or, with no flock to run, the
 *  directory lock); the open descriptor and what else releasing needs, or LockError. */
function take(path: string, opts: Pick<LockOptions, "waitSeconds" | "shared">): { fd: number; release: () => void } {
  const fd = openSync(path, "w");
  const wait = opts.waitSeconds;
  const r = spawnSync("flock", [...(wait === undefined ? [] : ["-w", String(wait)]), opts.shared ? "-s" : "-x", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf8",
  });
  const stderr = typeof r.stderr === "string" ? r.stderr : "";
  let failure: LockError | null = null;
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") {
    const held = takeDir(path, wait);
    if (held instanceof LockError) {
      closeSync(fd);
      throw held;
    }
    return { fd, release: held };
  }
  if (r.error) {
    failure = new LockError(path, `flock could not be run (${r.error.message})`, 127, stderr, r.error.message);
  } else if (r.status !== 0) {
    const status = r.status !== null ? r.status : r.signal ? 128 + (osConstants.signals[r.signal] ?? 0) : 1;
    const reason =
      wait !== undefined && r.status === 1 && stderr.trim() === ""
        ? `another process held it past the ${wait}s wait`
        : `flock exited ${status}${stderr.trim() ? `: ${stderr.trim()}` : ""}`;
    failure = new LockError(path, reason, status, stderr, null);
  }
  if (failure) {
    closeSync(fd);
    throw failure;
  }
  return { fd, release: () => {} };
}

/** Whether a process with this pid is running (EPERM: running, someone else's). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The directory lock for a host with no flock(1): its release, or LockError. */
function takeDir(path: string, wait: number | undefined): (() => void) | LockError {
  const dir = `${path}.held`;
  const deadline = wait === undefined ? Number.POSITIVE_INFINITY : Date.now() + wait * 1000;
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      let held = true;
      const release = (): void => {
        if (!held) return;
        held = false;
        process.removeListener("exit", release);
        rmSync(dir, { recursive: true, force: true });
      };
      process.on("exit", release);
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST")
        return new LockError(path, `cannot make ${dir}: ${(e as Error).message}`, 1, "", null);
    }
    // A pid not yet written (the holder is between its mkdir and its write)
    // reads as held; a pid no longer running is a dead holder's, taken over.
    let pid = Number.NaN;
    try {
      pid = Number(readFileSync(join(dir, "pid"), "utf8"));
    } catch {
      // not written yet
    }
    if (Number.isInteger(pid) && pid > 0 && !alive(pid)) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() >= deadline) return new LockError(path, `another process held it past the ${wait}s wait`, 1, "", null);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
}
