#!/usr/bin/env -S node --experimental-strip-types
// serve.ts — build + serve a repo for QA, in one of three states, and tear it
// down. A repo-agnostic, type-driven server (build → serve → health-poll) with
// OWNED-process teardown.
//
// Process ownership: the server is started in its own process group via a
// detached spawn (Node calls setsid() in the child, on Linux and macOS alike);
// teardown signals ONLY that recorded group + removes only the ephemeral
// worktree this run created. It MUST NOT global-`pkill workerd`/`wrangler` —
// that would kill unrelated servers from other repos/sessions on a shared host.
//
// peers:
//   .agents/skills/qa/scripts/detect-app.ts
//   .agents/skills/qa/scripts/lib.ts
//   .agents/skills/qa/scripts/tests/serve-guards.test.ts
//
// Usage:
//   serve.ts up   --repo <dir> --mode before|after|live|capture --run-id <id>
//                 [--port N] [--health-path /] [--live-url <url>]
//                 [--dist <prebuilt directory>]
//
// Port + listener ownership: with no --port, `up` scans UP from the default for
// a port with no listener, and never calls the server up until it has proven the
// listener belongs to the process group it spawned (or, when no listener pid can
// be read, that the port was free immediately before spawning; a pid in another
// group is refused either way). Answering on a port is not evidence of owning it.
//   serve.ts down --runfile <path> [--clean]
//   serve.ts status|restart --runfile <path>
//
// `up` output (stdout, KEY=VALUE, shellQuote'd for legacy readers; read as data):
//   QA_URL=<base url>          QA_PORT=<port>        QA_LABEL=<evidence label>
//   QA_RUNFILE=<runfile path>  QA_PID=<server pid or empty for --live>
//   QA_SRC=<the app directory served: inside QA_WORKTREE for --after, else --repo;
//           --before/--after only>
//   QA_PAGES=<%q-quoted space-separated routes discovered from the SERVED source;
//            empty when the source has no static routes — the SKILL then HALTs
//            unless an explicit `page` arg was passed>
//   QA_AUTH_JWT_FILE=<local Access token for a gated Worker, --before/--after only>
// Exit: 0 ok; 2 usage; 3 detect unknown; 4 build failed; 5 server never up;
//       6 no derivable live URL; 8 local database setup (migrations, qa:seed)
//       or local sign-in failed.
// `status` exits 1 for a stopped local server; --dist is before-only and never
// builds, seeds data or adds live bindings. --clean removes this run's captures.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import {
  qaAccessIssuer,
  qaD1Migrations,
  qaDeriveLiveUrlFromCf,
  qaDeriveLiveUrlFromWorkers,
  qaErr,
  qaLocalAccess,
  qaProbeActsAs,
  qaRepoSlug,
  qaWranglerDeclaresMain,
  qaWranglerVar,
} from "./lib.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const DEFAULT_PORT = 8813;
const SHOTS_ROOT = "/tmp/qa-shots";
const WORKTREE_ROOT = "/tmp/qa-worktrees";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * The node_modules a build in `from` resolves from: the nearest at or above it,
 * stopping short of $HOME and the root. An --after worktree under /tmp has none
 * beside it or above it, so its build finds no dependencies at all (`vite: not
 * found` on an app whose packages live beside its checkout).
 */
function nearestNodeModules(from: string): string | undefined {
  const home = process.env.HOME ?? "";
  for (let d = resolve(from); d !== dirname(d) && d !== home; d = dirname(d)) {
    if (isDir(join(d, "node_modules"))) return join(d, "node_modules");
  }
  return undefined;
}

/** A string bash reads back as itself: `printf %q`, as the runfile was always written. */
function shellQuote(s: string): string {
  if (s === "") return "''";
  let out = "";
  let i = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      const named: Record<number, string> = {
        7: "\\a",
        8: "\\b",
        9: "\\t",
        10: "\\n",
        11: "\\v",
        12: "\\f",
        13: "\\r",
      };
      out += `$'${named[code] ?? `\\${code.toString(8).padStart(3, "0")}`}'`;
    } else if (" \"$&'()*;<>?[\\]^`{|}!#".includes(ch)) {
      out += `\\${ch}`;
    } else if (ch === "~" && i === 0) {
      out += "\\~";
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}

/** Undo shellQuote: `''`, backslash escapes, and `$'…'` control-character runs, as bash reads them. */
function shellUnquote(v: string): string {
  if (v === "''") return "";
  const named: Record<string, string> = {
    a: "\x07",
    b: "\b",
    t: "\t",
    n: "\n",
    v: "\v",
    f: "\f",
    r: "\r",
  };
  let out = "";
  for (let i = 0; i < v.length; i++) {
    const ch = v[i] ?? "";
    if (ch === "\\" && i + 1 < v.length) {
      out += v[++i];
    } else if (ch === "$" && v[i + 1] === "'") {
      const end = v.indexOf("'", i + 2);
      const body = v.slice(i + 2, end === -1 ? v.length : end);
      out += body.replace(/\\([0-7]{3}|.)/g, (_m, e: string) =>
        /^[0-7]{3}$/.test(e) ? String.fromCharCode(Number.parseInt(e, 8)) : (named[e] ?? e),
      );
      i = end === -1 ? v.length : end;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * The value of `KEY=…` in a runfile this script wrote, unquoted as bash would
 * source it. A runfile written before every value went through shellQuote
 * double-quoted its paths (`QA_WORKTREE="…"`, `QA_PID=""`), and a down after an
 * upgrade still reads one. The two cannot be confused: shellQuote escapes every
 * `"`, so a value it wrote never opens with a bare one.
 */
function runfileValue(text: string, key: string): string {
  let v = "";
  for (const line of text.split("\n")) {
    if (line.startsWith(`${key}=`)) v = line.slice(key.length + 1);
  }
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\([\\"$`])/g, "$1");
  return shellUnquote(v);
}

// ── port ownership ───────────────────────────────────────────────────
// A health check that only proves "something answers on :PORT" is not a check —
// a stale server left behind by another repo answers 200 all day, and a /qa run
// that accepts it reviews the wrong application from end to end, while the
// label claims the right one. These helpers make a run prove it owns the
// listener.
//
// `ss` on Linux, `lsof` where there is no `ss` (macOS). With neither, no
// listener pid resolves, and a port is free only when it can be bound on the
// wildcard and loopback addresses (bindFree) — never merely because nothing
// could be asked. The run then accepts only a port it proved free the instant
// before spawning. A tool that exits nonzero with nothing on stdout answered
// nothing either, and bindFree decides for it too.

/** Whether `cmd` can be run at all. */
function hasCmd(cmd: string): boolean {
  return !spawnSync(cmd, ["--version"], { stdio: "ignore" }).error;
}

/** Stdout of a port query, "" when the tool is missing or says nothing. */
function query(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.error ? "" : (r.stdout ?? "");
}

/** The pids listening on `port`, sorted and unique. */
export function qaListenerPids(port: string | number): string[] {
  let pids: string[] = [];
  if (hasCmd("ss")) {
    pids = [...query("ss", ["-ltnpH", `sport = :${port}`]).matchAll(/pid=([0-9]+)/g)].map((m) => m[1] ?? "");
  } else if (hasCmd("lsof")) {
    pids = query("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).split("\n");
  }
  return [...new Set(pids.map((p) => p.trim()).filter((p) => p !== ""))].sort();
}

// A child node, so the check stays synchronous: it binds the port on each
// address in turn. It exits 1 on the first failure that is not a missing
// address family (EAFNOSUPPORT, or EADDRNOTAVAIL for an absent ::1) — a denied
// bind (EPERM, EACCES) says nothing about the port — and exits 1 too when no
// address could be bound at all.
const BIND_PROBE = `const net = require("node:net");
const port = Number(process.argv[1]);
(async () => {
  let bound = 0;
  for (const host of ["::", "0.0.0.0", "127.0.0.1", "::1"]) {
    const code = await new Promise((done) => {
      const s = net.createServer();
      s.once("error", (e) => done(e.code || "EUNKNOWN"));
      s.listen({ port, host, exclusive: true }, () => s.close(() => done("")));
    });
    if (code === "") bound++;
    else if (code !== "EAFNOSUPPORT" && code !== "EADDRNOTAVAIL") process.exit(1);
  }
  process.exit(bound > 0 ? 0 : 1);
})();`;

/**
 * True when `port` can be bound right now on the wildcard and loopback
 * addresses, IPv6 and IPv4 — what "free" means with no tool to list listeners.
 * An address family the host lacks is skipped, not counted as busy; any other
 * bind failure, or no address bound at all, is not free.
 */
function bindFree(port: string | number): boolean {
  const r = spawnSync(process.execPath, ["-e", BIND_PROBE, String(port)], {
    stdio: "ignore",
    timeout: 10_000,
  });
  return !r.error && r.status === 0;
}

/**
 * True when nothing is listening on `port`: ss or lsof says so with a clean
 * exit, or, when neither can answer, the port binds.
 */
export function qaPortFree(port: string | number): boolean {
  const ask = (cmd: string, args: string[]) =>
    spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const r = hasCmd("ss")
    ? ask("ss", ["-ltnH", `sport = :${port}`])
    : hasCmd("lsof")
      ? ask("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])
      : null;
  if (r === null) return bindFree(port);
  if ((r.stdout ?? "").trim() !== "") return false;
  if (r.error || r.status !== 0) return bindFree(port);
  return true;
}

/** The process group of `pid`, or "" when ps cannot see it. */
function pgidOf(pid: number | string): string {
  const r = spawnSync("ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return (r.stdout ?? "").replace(/ /g, "").replace(/\n+$/, "");
}

/**
 * Who holds the port: `ours` (a listener in our process group), `foreign` (a
 * listener whose pid resolves, in no group of ours), or `unknown` (no pid could
 * be read). Only `unknown` may lean on "the port was free before we spawned":
 * a resolved foreign pid is proof the other way, even when the port WAS free —
 * another session's server can take it between that check and our bind, and
 * a Vite server then moves to the next port while the probe grades theirs.
 */
export function qaPortOwner(port: string | number, pgid: string): "ours" | "foreign" | "unknown" {
  const pids = qaListenerPids(port);
  if (pids.length === 0) return "unknown";
  for (const p of pids) {
    const g = pgidOf(p);
    if (g !== "" && g === pgid) return "ours";
  }
  return "foreign";
}

/**
 * True when a listener on `port` belongs to process group `pgid` (the group
 * this run spawned detached); false otherwise, including when no pid is exposed
 * for the listener.
 */
export function qaPortOwnedBy(port: string | number, pgid: string): boolean {
  return qaPortOwner(port, pgid) === "ours";
}

/** Signal a whole process group (negative PID) we own, falling back to the pid itself. */
function signalGroup(pid: number, sig: NodeJS.Signals, fallback: boolean): void {
  try {
    process.kill(-pid, sig);
  } catch {
    if (!fallback) return;
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  }
}

/** A runfile is read as data, never sourced by the shell. */
function readRunfile(file: string): string {
  try {
    if (file !== "" && statSync(file).isFile()) return readFileSync(file, "utf8");
  } catch {
    // The caller gets one actionable usage error for missing or unreadable files.
  }
  qaErr(`serve: no runfile: ${file}`);
  exit(2);
}

/** Reject pid 0/1, negatives and malformed records before probing or signaling. */
function runfilePid(text: string): number | undefined {
  const value = runfileValue(text, "QA_PID");
  if (value === "") return undefined;
  const pid = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(pid) || pid < 2) {
    qaErr(`serve: invalid pid in runfile: ${value}`);
    exit(2);
  }
  return pid;
}

/** Process liveness without asking the agent to run shell `kill -0`. */
function processAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Where /proc exists (Linux) the identity and group checks read it; elsewhere (macOS) they ask ps. */
const HAS_PROC = isDir("/proc/self");

/** Stdout of ps, "" when it says nothing or fails. */
function ps(args: string[]): string {
  const r = spawnSync("ps", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return r.error || r.status !== 0 ? "" : (r.stdout ?? "");
}

/**
 * Linux start ticks plus the boot ID distinguish a reused PID from our server.
 * Without /proc, ps's start time plus the kernel's boot time do the same job.
 */
function processIdentity(pid: number): string {
  if (!HAS_PROC) {
    const stat = ps(["-o", "stat=", "-p", String(pid)]).trim();
    const started = ps(["-o", "lstart=", "-p", String(pid)]).trim();
    const boot = spawnSync("sysctl", ["-n", "kern.boottime"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const bootTime = /sec = (\d+)/.exec(boot.stdout ?? "")?.[1] ?? "";
    return stat !== "" && !stat.startsWith("Z") && started !== "" ? `${pid}:${bootTime}:${started}` : "";
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/);
    const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return fields[0] !== "Z" && fields[19] ? `${pid}:${boot}:${fields[19]}` : "";
  } catch {
    return "";
  }
}

/** Old records prove ownership through the group's exact recorded stdout log. */
function recordOwnsProcess(text: string, pid: number): boolean {
  const identity = runfileValue(text, "QA_PID_IDENTITY");
  if (identity !== "") return processIdentity(pid) === identity;
  const log = runfileValue(text, "QA_LOGFILE");
  try {
    return log !== "" && pgidOf(pid) === String(pid) && resolve(readlinkSync(`/proc/${pid}/fd/1`)) === resolve(log);
  } catch {
    return false;
  }
}

/** Children retain the run's marker even when npm or its launcher has exited. */
function ownedGroupAlive(text: string, pid: number): boolean {
  if (recordOwnsProcess(text, pid)) return true;
  const owner = runfileValue(text, "QA_SERVER_OWNER");
  const log = runfileValue(text, "QA_LOGFILE");
  if (!HAS_PROC) {
    // BSD ps: -E appends each process's environment to its command, which is
    // where the run's QA_SERVER_OWNER marker is read. With no marker recorded
    // there is no evidence to read, so nothing is claimed as ours.
    if (owner === "") return false;
    for (const row of ps(["-A", "-o", "pid=,pgid=,stat="]).split("\n")) {
      const [member = "", group = "", stat = ""] = row.trim().split(/\s+/);
      if (group !== String(pid) || stat.startsWith("Z")) continue;
      if (ps(["-E", "-ww", "-o", "command=", "-p", member]).includes(`QA_SERVER_OWNER=${owner}`)) return true;
    }
    return false;
  }
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/);
      if (fields[0] === "Z" || fields[2] !== String(pid)) continue;
      if (owner !== "") {
        if (readFileSync(`/proc/${entry}/environ`, "utf8").split("\0").includes(`QA_SERVER_OWNER=${owner}`))
          return true;
      } else if (log !== "" && resolve(readlinkSync(`/proc/${entry}/fd/1`)) === resolve(log)) return true;
    } catch {
      // A process may exit between listing the group and reading its evidence.
    }
  }
  return false;
}

/** Parse the shared lifecycle command's literal runfile path. */
function lifecycleRunfile(args: string[], cleanAllowed = false): { file: string; clean: boolean } {
  let file = "";
  let clean = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runfile" && args[i + 1]) file = args[++i] ?? "";
    else if (args[i] === "--clean" && cleanAllowed) clean = true;
    else {
      qaErr(`serve: unknown or incomplete flag: ${args[i]}`);
      exit(2);
    }
  }
  return { file, clean };
}

/** Return local process status; a live-site record owns no local process. */
function doStatus(args: string[]): void {
  const { file } = lifecycleRunfile(args);
  const text = readRunfile(file);
  const pid = runfilePid(text);
  const capture = runfileValue(text, "QA_KIND") === "capture";
  if (pid === undefined && runfileValue(text, "QA_URL") === "" && !capture) {
    qaErr("serve status: invalid runfile, no URL or local server");
    exit(2);
  }
  const present = processAlive(pid);
  const alive = pid !== undefined && ownedGroupAlive(text, pid);
  process.stdout.write(
    `QA_ALIVE=${alive ? "yes" : "no"}\nQA_STATUS=${capture ? "capture" : pid === undefined ? "live" : alive ? "running" : present ? "unverified" : "stopped"}\n`,
  );
  if (pid !== undefined && !alive) exit(1);
}

/** Restart exactly the recorded invocation, preserving evidence for its reviewer. */
async function doRestart(args: string[]): Promise<void> {
  const { file } = lifecycleRunfile(args);
  const text = readRunfile(file);
  if (runfileValue(text, "QA_KIND") === "capture") {
    qaErr("serve restart: capture-only runs have no server to restart");
    exit(2);
  }
  let start: unknown;
  try {
    start = JSON.parse(runfileValue(text, "QA_START_ARGS"));
  } catch {
    start = undefined;
  }
  if (!Array.isArray(start) || start.length === 0 || !start.every((arg) => typeof arg === "string")) {
    qaErr("serve restart: runfile has no valid start arguments; use up with the original target");
    exit(2);
  }
  await doDown(["--runfile", file]);
  await doUp(start);
}

// ── teardown (down) ──────────────────────────────────────────────────
async function doDown(args: string[]): Promise<void> {
  const { file: runfile, clean } = lifecycleRunfile(args, true);
  const text = readRunfile(runfile);
  const runDir = resolve(dirname(runfile));
  let captureRoot = SHOTS_ROOT;
  let captureDir = runDir;
  if (clean) {
    captureRoot = realpathSync(SHOTS_ROOT);
    captureDir = realpathSync(runDir);
  }
  const parts = relative(captureRoot, captureDir).split(sep);
  const recordedFile = runfileValue(text, "QA_RUNFILE");
  if (
    clean &&
    (parts.length !== 2 ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      basename(runfile) !== "server.run" ||
      (recordedFile !== "" && resolve(recordedFile) !== resolve(runfile)))
  ) {
    qaErr("serve down: --clean requires this run's server.run under the QA captures root");
    exit(2);
  }
  const pid = runfilePid(text);
  const worktree = runfileValue(text, "QA_WORKTREE");
  const sourceRepo = runfileValue(text, "QA_SOURCE_REPO");
  if (pid !== undefined) {
    const owned = ownedGroupAlive(text, pid);
    if (!owned && processAlive(pid) && processIdentity(pid) !== "") {
      qaErr("serve down: cannot prove process identity; refusing to signal this PID");
      exit(2);
    }
    if (owned) {
      // Signal only the verified group, including surviving server children.
      signalGroup(pid, "SIGTERM", recordOwnsProcess(text, pid));
      await sleep(1000);
      if (ownedGroupAlive(text, pid)) signalGroup(pid, "SIGKILL", false);
    }
  }
  if (worktree !== "" && isDir(worktree)) {
    const r = spawnSync("git", ["-C", sourceRepo || worktree, "worktree", "remove", "--force", worktree], {
      stdio: "ignore",
    });
    if (r.error || r.status !== 0) rmSync(worktree, { recursive: true, force: true });
  }
  if (clean) rmSync(runDir, { recursive: true, force: true });
  process.stdout.write(`qa: torn down (pid=${pid || "none"}, worktree=${worktree || "none"})\n`);
}

/**
 * Print `KEY=value` lines to stdout and write them to the runfile, as `tee` did.
 * Every value goes through shellQuote for compatibility with existing readers.
 * The workflow reads the fields as data and does not evaluate shell syntax.
 */
function emitRunfile(runfile: string, entries: [string, string | number][]): void {
  const text = entries.map(([k, v]) => `${k}=${shellQuote(String(v))}\n`).join("");
  writeFileSync(runfile, text);
  process.stdout.write(text);
}

// ── build + serve (up) ───────────────────────────────────────────────
async function doUp(args: string[]): Promise<void> {
  let REPO = "";
  let MODE = "";
  let RUN_ID = "";
  let PORT = "";
  let HEALTH_PATH = "/";
  let LIVE_URL = process.env.QA_LIVE_URL ?? "";
  let DIST = "";
  for (let i = 0; i < args.length; i += 2) {
    const v = args[i + 1] ?? "";
    if (v === "" || v.startsWith("--")) {
      qaErr(`serve up: missing value for ${args[i]}`);
      exit(2);
    }
    switch (args[i]) {
      case "--repo":
        REPO = v;
        break;
      case "--mode":
        MODE = v;
        break;
      case "--run-id":
        RUN_ID = v;
        break;
      case "--port":
        PORT = v;
        break;
      case "--health-path":
        HEALTH_PATH = v;
        break;
      case "--live-url":
        LIVE_URL = v;
        break;
      case "--dist":
        DIST = v;
        break;
      default:
        qaErr(`serve up: unknown flag: ${args[i]}`);
        exit(2);
    }
  }
  if (REPO === "" || !isDir(REPO)) {
    qaErr("serve up: --repo must be a directory");
    exit(2);
  }
  if (!["before", "after", "live", "capture"].includes(MODE)) {
    qaErr("serve up: --mode must be before|after|live|capture");
    exit(2);
  }
  if (RUN_ID === "") {
    qaErr("serve up: --run-id required");
    exit(2);
  }
  if (RUN_ID === "." || RUN_ID === ".." || RUN_ID.includes("/") || RUN_ID.includes("\\")) {
    qaErr("serve up: --run-id must be one directory name");
    exit(2);
  }
  if (DIST !== "" && (MODE !== "before" || !isDir(DIST))) {
    qaErr("serve up: --dist must name a directory and requires --mode before");
    exit(2);
  }
  if (PORT !== "" && (!/^\d+$/.test(PORT) || Number(PORT) < 1 || Number(PORT) > 65535)) {
    qaErr("serve up: --port must be an integer from 1 to 65535");
    exit(2);
  }
  REPO = resolve(REPO);

  const slug = qaRepoSlug(REPO);
  const runDir = `${SHOTS_ROOT}/${slug}/${RUN_ID}`;
  mkdirSync(runDir, { recursive: true });
  const RUNFILE = `${runDir}/server.run`;
  if (existsSync(RUNFILE)) {
    const previous = readRunfile(RUNFILE);
    const previousPid = runfilePid(previous);
    if (
      runfileValue(previous, "QA_KIND") === "capture" ||
      processAlive(previousPid) ||
      (previousPid !== undefined && ownedGroupAlive(previous, previousPid))
    ) {
      qaErr("serve up: this run is already running; use restart --runfile with its recorded path");
      exit(2);
    }
  }
  if (MODE === "capture") {
    emitRunfile(RUNFILE, [
      ["QA_KIND", "capture"],
      ["QA_RUNFILE", RUNFILE],
      ["QA_CAPTURE_DIR", runDir],
      ["QA_PID", ""],
    ]);
    return;
  }

  // ── resolve the SERVED SOURCE up front ──────────────────────────────
  // For --after, create the clean HEAD worktree NOW, BEFORE detection + route
  // discovery, so both read the committed revision being served — not the dirty
  // working tree. Otherwise an uncommitted page or qa:* script would select a
  // type/route that HEAD lacks and make after-commit QA lie (404s, wrong shots).
  // --before / --live detect + discover against the working tree.
  let src = REPO;
  let worktree = "";
  let label = DIST !== "" ? "prebuilt directory" : "working tree";
  if (MODE === "after") {
    mkdirSync(WORKTREE_ROOT, { recursive: true });
    worktree = `${WORKTREE_ROOT}/${slug}-${RUN_ID}`;
    rmSync(worktree, { recursive: true, force: true });
    const add = spawnSync("git", ["-C", REPO, "worktree", "add", "--quiet", "--detach", worktree, "HEAD"], {
      stdio: ["ignore", "inherit", "inherit"],
    });
    if (add.error || add.status !== 0) exit(add.status ?? 1);
    // The worktree is of the whole repository; an app below its git root (a
    // monorepo's apps/<x>) is served from the same place inside it, or
    // detection and the build would run on the repository root instead.
    const prefix = spawnSync("git", ["-C", REPO, "rev-parse", "--show-prefix"], { encoding: "utf8" });
    src = join(worktree, (prefix.stdout ?? "").trim()).replace(/\/+$/, "");
    label = "HEAD worktree";
    // node_modules is never committed, so the worktree builds against the
    // dependencies the checkout itself would; `worktree remove` unlinks the
    // link without following it.
    const deps = nearestNodeModules(REPO);
    if (deps !== undefined && isDir(src) && !isDir(join(src, "node_modules"))) {
      symlinkSync(deps, join(src, "node_modules"));
      qaErr(`serve up: HEAD worktree builds with ${deps}`);
    }
  }
  // Remove the --after worktree on any early exit below (fail-safe cleanup).
  const cleanupWorktree = () => {
    if (worktree !== "") spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", worktree], { stdio: "ignore" });
  };
  if (!isDir(src)) {
    qaErr(`serve up: ${src.slice(worktree.length + 1)}/ is not in HEAD — commit it, or use --before`);
    cleanupWorktree();
    exit(2);
  }

  // Detect type + any qa:* escape-hatch command against the served source.
  const detect =
    DIST !== ""
      ? { stdout: "TYPE=static\n", status: 0, error: undefined }
      : spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, "detect-app.ts"), src], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "inherit"],
        });
  const det = (detect.stdout ?? "").replace(/\n+$/, "");
  if (detect.error || detect.status !== 0) {
    process.stderr.write(`${det}\n`);
    cleanupWorktree();
    exit(3);
  }
  const field = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(det)?.[1] ?? "";
  const TYPE = DIST !== "" ? "static" : field("TYPE");
  const QA_SERVE = field("QA_SERVE");
  const SERVE_DIR = field("SERVE_DIR");

  if (TYPE === "cli" || TYPE === "render") {
    qaErr(`serve up: ${TYPE} target has no server — run it directly (see SKILL ${TYPE} path)`);
    cleanupWorktree();
    exit(2);
  }

  // Discover the routes to screenshot from the SAME source being served, so the
  // route list always matches the served bytes (for --after that is the HEAD
  // worktree, for --live the working tree — the closest local proxy for the
  // deployed site). Emitted as QA_PAGES; an explicit `page` arg overrides it in
  // the SKILL. Empty (no static routes) is passed through for the SKILL to HALT.
  const disc = spawnSync(
    process.execPath,
    ["--experimental-strip-types", join(SCRIPT_DIR, "discover-routes.ts"), src],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const pages = (disc.stdout ?? "").replace(/\n/g, " ");

  // ── --live: hit the deployed URL; never build, never infer the URL ──
  if (MODE === "live") {
    // An explicit --live-url (or QA_LIVE_URL) wins. Otherwise DERIVE the live
    // URL from the Cloudflare Pages API by matching this repo against each
    // project's source repo_name. This is a lookup in an authoritative registry,
    // NOT inference from the directory name — the two differ in practice (a repo
    // named site-web deploying to example.com), which is exactly why a name
    // heuristic would be wrong and the API is not.
    // A worktree's directory is often named after its branch or thread, not its
    // repo. Git identity survives that rename: origin names the provider's repo;
    // a local repo without origin falls back to its common checkout, never the
    // worktree's directory name.
    const origin = spawnSync("git", ["-C", REPO, "config", "--get", "remote.origin.url"], { encoding: "utf8" });
    const originName =
      origin.status === 0 ? /(?:^|[/:])([^/:]+?)(?:\.git)?\/?$/.exec(origin.stdout.trim())?.[1] : undefined;
    const common = originName
      ? undefined
      : spawnSync("git", ["-C", REPO, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" });
    const repoName = originName ?? (common?.status === 0 ? basename(dirname(common.stdout.trim())) : "");
    let liveUrl = LIVE_URL;
    if (liveUrl === "") {
      liveUrl = repoName ? ((await qaDeriveLiveUrlFromCf(repoName)) ?? "") : "";
      // A Worker is not in the Pages registry; ask the Workers custom-domain
      // registry for the Worker the repo's wrangler config names.
      if (liveUrl === "") liveUrl = (await qaDeriveLiveUrlFromWorkers(REPO)) ?? "";
      if (liveUrl !== "") qaErr(`serve up: live URL derived from the Cloudflare registry -> ${liveUrl}`);
    }
    if (liveUrl === "") {
      qaErr("serve up: --live needs a live URL — pass --live-url <url>, or set");
      qaErr("  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for a Cloudflare lookup");
      qaErr(`  (no Pages project matched repo '${repoName || "unresolved Git identity"}', and no Workers`);
      qaErr("  custom domain serves the Worker its wrangler config names). A local");
      qaErr("  build does not verify the requested production site; --before serves");
      qaErr("  the working tree when that is what you meant.");
      exit(6);
    }
    // A Cloudflare-Access-gated site needs a service token so a headless GET
    // returns 200, not a login redirect. Name its 1Password item in
    // QA_ACCESS_OP_ITEM and /qa attaches it on every --live run — harmless extra
    // headers on an ungated site, the difference between 200 and a login wall on
    // a gated one. We pass the 1Password item REF (not the secret) downstream;
    // screenshot.ts resolves it just-in-time into request headers, so no token
    // value hits stdout or the runfile. (QA_CF_ACCESS_ID / QA_CF_ACCESS_SECRET in
    // the environment work too, with no 1Password at all.)
    const probe = {
      id: process.env.QA_ACCESS_OP_ITEM ?? "",
      fields: {
        clientId: process.env.QA_ACCESS_ID_FIELD || "client_id",
        clientSecret: process.env.QA_ACCESS_SECRET_FIELD || "client_secret",
      },
    };
    const lines: [string, string][] = [
      ["QA_URL", liveUrl],
      ["QA_PORT", ""],
      ["QA_LABEL", `live URL ${liveUrl}`],
      ["QA_RUNFILE", RUNFILE],
      ["QA_SLUG", slug],
      ["QA_PID", ""],
      ["QA_CAPTURE_DIR", runDir],
      [
        "QA_START_ARGS",
        JSON.stringify(["--repo", REPO, "--mode", MODE, "--run-id", RUN_ID, ...(LIVE_URL !== "" ? ["--live-url", LIVE_URL] : [])]),
      ],
      ["QA_AUTH_OP_ITEM", probe.id],
      ["QA_AUTH_ID_FIELD", probe.fields.clientId],
      ["QA_AUTH_SECRET_FIELD", probe.fields.clientSecret],
    ];
    // An app that pairs the Access service token with a person (PROBE_ACTS_AS
    // in its wrangler config) answers every page with a machine's 403 unless
    // the act-as header names that person; emit it. Absent, nothing is sent.
    const actAs = qaProbeActsAs(REPO);
    if (actAs !== "") lines.push(["QA_AUTH_ACT_AS", actAs]);
    lines.push(["QA_PAGES", pages]);
    emitRunfile(RUNFILE, lines);
    return;
  }

  // Pick the port. An explicit --port is honoured as given; otherwise scan UP
  // from the default for one with NO listener, and record whether the chosen
  // port was verifiably free at start — that fact is half the ownership proof
  // below. Assuming the default is how a run lands on someone else's server.
  let port = "";
  let portWasFree = false;
  if (PORT !== "") {
    port = PORT;
    portWasFree = qaPortFree(port);
    if (!portWasFree) qaErr(`qa: --port ${port} already has a listener — ownership will be enforced`);
  } else {
    port = String(DEFAULT_PORT);
    for (let probe = DEFAULT_PORT; probe <= DEFAULT_PORT + 40; probe++) {
      if (qaPortFree(probe)) {
        port = String(probe);
        portWasFree = true;
        break;
      }
    }
    if (!portWasFree) qaErr(`qa: no free port in ${DEFAULT_PORT}-${DEFAULT_PORT + 40} — using :${port} anyway`);
    if (port !== String(DEFAULT_PORT)) qaErr(`qa: :${DEFAULT_PORT} is busy — serving on :${port} instead`);
  }

  // Served source resolved above (src): working tree for --before, HEAD
  // worktree for --after.
  const buildDir = src;
  const persist = `${buildDir}/.wrangler/qa-state`;
  const logfile = `${runDir}/server.log`;

  // ── build (guarded) ──
  let buildCmd = "";
  let serveCmd = "";
  let serveCwd = buildDir;
  switch (TYPE) {
    case "astro-cf":
      buildCmd = "npm run build";
      // A Cloudflare Astro repo is one of TWO shapes and they take different commands.
      // `main` in the wrangler config declares a WORKER entry -> `wrangler dev`. Without it
      // the project is Pages -> `wrangler pages dev dist`. Both shapes are common, and
      // detection cannot tell them apart from the astro+wrangler signals alone.
      //
      // Assuming Pages for both does not degrade — it HANGS. A Worker entry that exports a
      // Workflow or Durable Object is served through wrangler's pages-shim entrypoint, which
      // does not re-export it, so workerd refuses to boot with "Your Worker depends on the
      // following Workflows, which are not exported in your entrypoint file". The astro-dev
      // fallback below eventually catches it, but only after the pages attempt burns its full
      // health-check window, and the fallback has no CF bindings — so a whole QA pass runs
      // against a server with no data bindings, for a repo that would have served fine.
      if (qaWranglerDeclaresMain(buildDir)) {
        serveCmd = `npx wrangler dev --port ${port} --persist-to ${persist}`;
      } else {
        serveCmd = `npx wrangler pages dev dist --port ${port} --persist-to ${persist} --compatibility-date 2025-09-01`;
      }
      break;
    case "astro":
      buildCmd = "npm run build";
      // --ignore-lock keeps it in the foreground: Astro 7 sends `preview` (and
      // `dev`) to the background when it detects an agent running it, and a
      // backgrounded server is in no process group this run owns. Astro 5 accepts
      // the flag and ignores it (both checked).
      serveCmd = `npx astro preview --port ${port} --host --ignore-lock`;
      break;
    case "vite":
      buildCmd = "npm run build";
      serveCmd = `npx vite preview --port ${port}`;
      break;
    case "next":
      buildCmd = "npm run build";
      serveCmd = `npx next start --port ${port}`;
      break;
    case "static":
      serveCmd = `node --experimental-strip-types ${shellQuote(join(SCRIPT_DIR, "static-serve.ts"))} . ${port}`;
      serveCwd = DIST !== "" ? resolve(DIST) : `${buildDir}/${SERVE_DIR || "dist"}`;
      break;
    case "node-server":
      // The repo's qa:serve script binds $PORT; pass the port /qa health-polls.
      // `env` is required: the command is run under `exec` below, and `exec` with
      // a leading VAR=VALUE treats the assignment as the PROGRAM NAME, so the
      // bare `PORT=$port ...` form failed every single node-server run.
      serveCmd = `env PORT=${port} ${QA_SERVE}`;
      break;
    default:
      qaErr(`serve up: cannot serve type=${TYPE}`);
      exit(3);
  }

  if (buildCmd !== "") {
    process.stderr.write(`qa: building (${TYPE})…\n`);
    const buildLog = `${runDir}/build.log`;
    const fd = openSync(buildLog, "w");
    const b = spawnSync("bash", ["-c", buildCmd], {
      cwd: buildDir,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    if (b.error || b.status !== 0) {
      qaErr(`qa: build failed — tail of ${buildLog}:`);
      process.stderr.write(tail(buildLog, 20));
      cleanupWorktree();
      exit(4);
    }
  }

  // ── a fresh local database gets the app's schema, and no production rows ──
  // A Worker served by a Cloudflare runtime starts with EMPTY local D1
  // databases — no tables at all — so every query fails "no such table" and
  // the page is a 500, not the empty state it shows with no rows. /qa applies
  // the repo's own D1 migrations to each local database (`wrangler d1
  // migrations apply --local`, into the state dir the server is told to
  // persist to), then runs the app's `qa:seed` script when it has one: the
  // place for rows the app cannot work without locally, such as the role of
  // the person signed in below. No production data is read, so pages render
  // their empty states; for DATA-correctness QA use --live or read the store
  // directly. A binding marked `remote` is left alone and named — a local
  // server reaches production through it.
  if (TYPE === "astro-cf" || TYPE === "vite") {
    // The Cloudflare Vite plugin keeps its state in .wrangler/state; wrangler is told --persist-to.
    const statePath = TYPE === "vite" ? `${buildDir}/.wrangler/state` : persist;
    const toLocal = (what: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
      // Its output goes to stderr: stdout is the runfile block the SKILL evaluates.
      const r = spawnSync(cmd, args, { cwd: buildDir, env: { ...process.env, ...env }, stdio: ["ignore", 2, 2] });
      if (r.error || r.status !== 0) {
        qaErr(`qa: ${what} failed — a local server without its tables answers 500s, not empty states`);
        cleanupWorktree();
        exit(8);
      }
    };
    const seedScript = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(buildDir, "package.json"), "utf8"));
        return typeof pkg?.scripts?.["qa:seed"] === "string" ? pkg.scripts["qa:seed"] : "";
      } catch {
        return "";
      }
    })();
    let migrated = 0;
    for (const db of qaD1Migrations(buildDir)) {
      if (db.remote) {
        qaErr(`qa: ${db.binding} is remote — left alone; a local server reaches production through it`);
      } else if (!isDir(join(buildDir, db.dir))) {
        qaErr(
          seedScript !== ""
            ? `qa: ${db.binding} has no ${db.dir}/ — its tables are left to the app's qa:seed`
            : `qa: ${db.binding} has no ${db.dir}/ — its local database starts with no tables`,
        );
      } else {
        process.stderr.write(`qa: applying ${db.binding}'s migrations to its local database…\n`);
        toLocal(`applying ${db.binding}'s migrations`, "npx", [
          "wrangler",
          "d1",
          "migrations",
          "apply",
          db.binding,
          "--local",
          "--persist-to",
          statePath,
        ]);
        migrated++;
      }
    }
    if (seedScript !== "") {
      process.stderr.write("qa: running the app's qa:seed…\n");
      toLocal("the app's qa:seed", "npm", ["run", "qa:seed"], {
        QA_D1_PERSIST: statePath,
        QA_ACT_AS: qaProbeActsAs(buildDir),
      });
    }
    const from = [migrated > 0 ? "schema from migrations" : "", seedScript !== "" ? "then the app's qa:seed" : ""].filter(Boolean);
    if (from.length > 0) label = `${label}, local D1: ${from.join(", ")}, no production rows`;
  }

  // ── a local sign-in, for a Worker served by a Cloudflare runtime ──
  // An app whose wrangler config names PROBE_ACTS_AS and ACCESS_AUD verifies a
  // Cloudflare Access token on every request, so /qa stands in for Access: it
  // signs a token for that person (qaLocalAccess), serves the key set on
  // loopback beside the server, and hands the Worker its URL as
  // ACCESS_JWKS_URL, which such an app should honour only on a loopback
  // request. The token's issuer is the app's own `ACCESS_ISSUER` var when its
  // wrangler config declares one, so signing in needs no Cloudflare account;
  // otherwise it is read from the account's Access organization, which needs
  // wrangler's CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID. The token goes in
  // a file named by QA_AUTH_JWT_FILE, never on stdout.
  let envPrefix = "";
  let preamble = "";
  let jwtFile = "";
  if (TYPE === "astro-cf" || TYPE === "vite") {
    const person = qaProbeActsAs(buildDir);
    const aud = (qaWranglerVar(buildDir, "ACCESS_AUD").split(",")[0] ?? "").trim();
    if (person !== "" && aud !== "") {
      const issuer = qaWranglerVar(buildDir, "ACCESS_ISSUER").trim() || (await qaAccessIssuer());
      if (issuer === undefined) {
        qaErr("qa: could not read the account's Cloudflare Access team domain (GET access/organizations)");
        cleanupWorktree();
        exit(8);
      }
      const access = qaLocalAccess(person, aud, issuer);
      const jwks = `${runDir}/access-jwks.json`;
      jwtFile = `${runDir}/access.jwt`;
      writeFileSync(jwks, access.jwks);
      writeFileSync(jwtFile, access.jwt, { mode: 0o600 });
      // The kernel's pick of a free loopback port: nobody else looks for this one.
      const jwksPort = await new Promise<number>((done) => {
        const probe = createServer();
        probe.listen(0, "127.0.0.1", () => {
          const addr = probe.address();
          probe.close(() => done(typeof addr === "object" && addr !== null ? addr.port : 0));
        });
      });
      const server =
        'const [f, p] = process.argv.slice(1); require("node:http").createServer((q, s) => { s.setHeader("content-type", "application/json"); s.end(require("node:fs").readFileSync(f)); }).listen(Number(p), "127.0.0.1");';
      preamble = `${shellQuote(process.execPath)} -e ${shellQuote(server)} ${shellQuote(jwks)} ${jwksPort} & `;
      envPrefix = `env CLOUDFLARE_INCLUDE_PROCESS_ENV=true ACCESS_JWKS_URL=http://127.0.0.1:${jwksPort}/jwks.json `;
      label = `${label}, signed in locally as ${person}`;
    }
  }

  // ── start the server in its OWN process group, health-poll, and
  //    for astro-cf fall back to `astro dev` when workerd won't boot. ──
  // astro-cf primary is `wrangler pages dev` (real CF bindings); workerd fails to
  // start in some sandboxes, so `astro dev` (Vite, serves source, no build/CF
  // bindings) is queued as a second attempt. It loses local data — pages fall back
  // to code defaults; verify real DATA against the store directly, not this server.
  let pid = 0;
  let up: "no" | "yes" | "foreign" = "no";
  let usedFallback = false;
  const serveCmds = [serveCmd];
  // --ignore-lock: in the foreground, for the reason given at the astro case above.
  if (TYPE === "astro-cf") serveCmds.push(`npx astro dev --port ${port} --host --ignore-lock`);
  if (TYPE === "next") {
    // `next start` needs a production build and refuses on `output: export`;
    // `next dev` serves source and always works. Same shape as the astro-cf
    // workerd fallback: a second attempt, not a different code path.
    serveCmds.push(`npx next dev --port ${port}`);
  }
  let idx = 0;
  const serverOwner = randomUUID();
  for (const attempt of serveCmds) {
    idx++;
    process.stderr.write(`qa: starting ${TYPE} server on :${port} (${attempt})…\n`);
    // detached: the child calls setsid() (Linux and macOS alike, no setsid
    // binary needed), so it leads its own session and process group — the
    // group `down` signals, and nothing else.
    const logFd = openSync(logfile, "w");
    const child = spawn(
      "bash",
      ["-c", `cd ${shellQuote(serveCwd)} || exit 1; ${preamble}exec ${envPrefix}${attempt}`],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, QA_SERVER_OWNER: serverOwner },
      },
    );
    closeSync(logFd);
    let exited = child.pid === undefined;
    child.on("exit", () => {
      exited = true;
    });
    child.on("error", () => {
      exited = true;
    });
    child.unref();
    pid = child.pid ?? 0;
    // A setsid child is a session + process-group leader, so its PGID is its
    // own PID — read it back rather than assuming, and fall back to the pid if
    // it has already exited.
    const pgid = pgidOf(pid) || String(pid);
    up = "no";
    for (let n = 0; n < 40; n++) {
      const probe = spawnSync("curl", ["-s", "-o", "/dev/null", `http://localhost:${port}${HEALTH_PATH}`], {
        stdio: "ignore",
      });
      if (!probe.error && probe.status === 0) {
        // Something answers. Prove it is OURS before calling the server up:
        // either the listener is in the process group we just spawned, or the
        // port was verifiably free the moment before we spawned it.
        const owner = qaPortOwner(port, pgid);
        if (owner === "ours") {
          up = "yes";
        } else if (owner === "unknown" && portWasFree) {
          qaErr(`qa: listener pid on :${port} not resolvable — accepted (port was free at start)`);
          up = "yes";
        } else {
          qaErr(`qa: :${port} answers but the listener is NOT this run's process group`);
          qaErr("  — refusing it; that is how a QA pass grades a different repo's app.");
          up = "foreign";
        }
        break;
      }
      if (exited) break;
      await sleep(1000);
      if (exited) break;
    }
    if (up === "yes") {
      if (idx > 1) usedFallback = true;
      break;
    }
    if (up === "foreign") {
      qaErr(`qa: stop the process holding :${port}, or pass --port <free-port>.`);
    } else {
      qaErr(`qa: '${attempt}' did not come up on :${port} — tail of ${logfile}:`);
      process.stderr.write(tail(logfile, 5));
    }
    if (pid > 0) signalGroup(pid, "SIGTERM", true);
  }
  if (up !== "yes") {
    qaErr(`qa: server never came up on :${port} (all attempts failed)`);
    cleanupWorktree();
    exit(5);
  }
  if (usedFallback) {
    if (TYPE === "astro-cf") label = `${label} (astro dev fallback — no CF bindings)`;
    else if (TYPE === "next") label = `${label} (next dev fallback — dev server, not a production build)`;
    else label = `${label} (fallback server)`;
  }

  emitRunfile(RUNFILE, [
    ["QA_URL", `http://localhost:${port}`],
    ["QA_PORT", port],
    ["QA_LABEL", label],
    ["QA_RUNFILE", RUNFILE],
    ["QA_SLUG", slug],
    ["QA_PID", pid],
    ["QA_PID_IDENTITY", processIdentity(pid)],
    ["QA_SERVER_OWNER", serverOwner],
    ["QA_WORKTREE", worktree],
    ["QA_SRC", src],
    ["QA_SOURCE_REPO", REPO],
    ["QA_LOGFILE", logfile],
    ["QA_CAPTURE_DIR", runDir],
    [
      "QA_START_ARGS",
      JSON.stringify([
        "--repo",
        REPO,
        "--mode",
        MODE,
        "--run-id",
        RUN_ID,
        "--port",
        port,
        "--health-path",
        HEALTH_PATH,
        ...(DIST !== "" ? ["--dist", resolve(DIST)] : []),
      ]),
    ],
    ...(jwtFile !== "" ? ([["QA_AUTH_JWT_FILE", jwtFile]] as [string, string][]) : []),
    ["QA_PAGES", pages],
  ]);
}

/** The last `n` lines of a file, as `tail -n` prints them ("" when unreadable). */
function tail(file: string, n: number): string {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return "";
  }
  if (text === "") return "";
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return `${lines.slice(-n).join("\n")}${text.endsWith("\n") ? "\n" : ""}`;
}

async function main(): Promise<void> {
  const [sub = "", ...rest] = process.argv.slice(2);
  const flags = new Set<string>();
  for (const arg of rest) {
    if (!arg.startsWith("--")) continue;
    if (flags.has(arg)) {
      qaErr(`serve: duplicate flag: ${arg}`);
      exit(2);
    }
    flags.add(arg);
  }
  // flock owns a per-run lock until this invocation exits, including restart's
  // entire down/up sequence. Kernel locks disappear even if the runner crashes.
  // Where there is no flock (macOS), a mkdir lock below does the same.
  let record = rest[rest.indexOf("--runfile") + 1] ?? "";
  if (sub === "up") {
    const repoAt = rest.indexOf("--repo");
    const runAt = rest.indexOf("--run-id");
    record =
      repoAt >= 0 && runAt >= 0 && rest[repoAt + 1] && rest[runAt + 1]
        ? join(SHOTS_ROOT, qaRepoSlug(resolve(rest[repoAt + 1] ?? "")), rest[runAt + 1] ?? "", "server.run")
        : "";
  } else if (!rest.includes("--runfile")) record = "";
  if (record !== "" && ["up", "down", "status", "restart"].includes(sub)) {
    const lockDir = join(SHOTS_ROOT, ".locks");
    const lock = join(lockDir, createHash("sha256").update(resolve(record)).digest("hex"));
    if (process.env.QA_LIFECYCLE_LOCK !== lock && !hasCmd("flock")) {
      // No flock(1) (macOS): an atomic mkdir holds the lock, with this
      // process's pid inside, so a lock a crashed run left behind is taken
      // over rather than reported busy forever. This process keeps it until it
      // exits, restart's whole down/up sequence included.
      mkdirSync(lockDir, { recursive: true });
      const held = `${lock}.d`;
      const take = (): boolean => {
        try {
          mkdirSync(held);
          writeFileSync(join(held, "pid"), String(process.pid));
          return true;
        } catch {
          return false;
        }
      };
      let taken = take();
      if (!taken) {
        let holder = Number.NaN;
        let age = 0;
        try {
          age = Date.now() - statSync(held).mtimeMs;
          holder = Number(readFileSync(join(held, "pid"), "utf8"));
        } catch {
          // a holder still writing its pid reads as no pid yet
        }
        const stale = Number.isSafeInteger(holder) ? holder < 2 || !processAlive(holder) : age > 10_000;
        if (stale) {
          rmSync(held, { recursive: true, force: true });
          taken = take();
        }
      }
      if (!taken) {
        qaErr("serve: lifecycle is busy for this run; retry after the current command");
        exit(2);
      }
      process.env.QA_LIFECYCLE_LOCK = lock;
      process.on("exit", () => rmSync(held, { recursive: true, force: true }));
    }
    if (process.env.QA_LIFECYCLE_LOCK !== lock) {
      mkdirSync(lockDir, { recursive: true });
      const child = spawnSync(
        "flock",
        ["-n", "-E", "75", lock, process.execPath, "--experimental-strip-types", self, sub, ...rest],
        {
          stdio: "inherit",
          env: { ...process.env, QA_LIFECYCLE_LOCK: lock },
        },
      );
      if (child.status === 75) {
        qaErr("serve: lifecycle is busy for this run; retry after the current command");
        exit(2);
      }
      if (child.error) {
        qaErr(`serve: could not lock lifecycle: ${child.error.message}`);
        exit(2);
      }
      exit(child.status ?? 1);
    }
  }
  if (sub === "up") await doUp(rest);
  else if (sub === "down") await doDown(rest);
  else if (sub === "status") doStatus(rest);
  else if (sub === "restart") await doRestart(rest);
  else {
    qaErr("usage: serve.ts up|down|status|restart ...");
    exit(2);
  }
}

// Run as a program; imported (tests/serve-guards.test.ts reads the port helpers), do nothing.
const self = fileURLToPath(import.meta.url);
const invoked = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === self;
  } catch {
    return false;
  }
})();
if (invoked) await runToExit(main);
