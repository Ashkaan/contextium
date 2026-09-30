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
//   serve.ts up   --repo <dir> --mode before|after|live --run-id <id>
//                 [--port N] [--health-path /] [--live-url <url>]
//
// Port + listener ownership: with no --port, `up` scans UP from the default for
// a port with no listener, and never calls the server up until it has proven the
// listener belongs to the process group it spawned (or that the port was free
// immediately before spawning). Answering on a port is not evidence of owning it.
//   serve.ts down --runfile <path>
//
// `up` output (stdout, KEY=VALUE, every value shellQuote'd — the SKILL `eval`s it):
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

import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

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
  const named: Record<string, string> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r" };
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

/** The value of `KEY=…` in a runfile this script wrote, unquoted as bash would source it. */
function runfileValue(text: string, key: string): string {
  let v = "";
  for (const line of text.split("\n")) {
    if (line.startsWith(`${key}=`)) v = line.slice(key.length + 1);
  }
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
// before spawning.

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
// address in turn and exits 1 on the first one something already holds.
const BIND_PROBE = `const net = require("node:net");
const port = Number(process.argv[1]);
(async () => {
  for (const host of ["::", "0.0.0.0", "127.0.0.1", "::1"]) {
    const code = await new Promise((done) => {
      const s = net.createServer();
      s.once("error", (e) => done(e.code));
      s.listen({ port, host, exclusive: true }, () => s.close(() => done("")));
    });
    if (code === "EADDRINUSE" || code === "EACCES") process.exit(1);
  }
  process.exit(0);
})();`;

/**
 * True when `port` can be bound right now on the wildcard and loopback
 * addresses, IPv6 and IPv4 — what "free" means with no tool to list listeners.
 * An address family the host lacks is skipped, not counted as busy.
 */
function bindFree(port: string | number): boolean {
  const r = spawnSync(process.execPath, ["-e", BIND_PROBE, String(port)], { stdio: "ignore", timeout: 10_000 });
  return !r.error && r.status === 0;
}

/** True when nothing is listening on `port`. */
export function qaPortFree(port: string | number): boolean {
  if (hasCmd("ss")) return query("ss", ["-ltnH", `sport = :${port}`]) === "";
  if (hasCmd("lsof")) return query("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]).trim() === "";
  return bindFree(port);
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
 * True when a listener on `port` belongs to process group `pgid` (the group
 * this run spawned detached); false otherwise, including when no pid is exposed
 * for the listener.
 */
export function qaPortOwnedBy(port: string | number, pgid: string): boolean {
  const pids = qaListenerPids(port);
  if (pids.length === 0) return false;
  for (const p of pids) {
    const g = pgidOf(p);
    if (g !== "" && g === pgid) return true;
  }
  return false;
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

// ── teardown (down) ──────────────────────────────────────────────────
async function doDown(args: string[]): Promise<void> {
  let runfile = "";
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--runfile") runfile = args[i + 1] ?? "";
    else {
      qaErr(`serve down: unknown flag: ${args[i]}`);
      exit(2);
    }
  }
  let text = "";
  try {
    if (runfile !== "" && statSync(runfile).isFile()) text = readFileSync(runfile, "utf8");
    else throw new Error("no runfile");
  } catch {
    qaErr(`serve down: no runfile: ${runfile}`);
    exit(2);
  }
  const pid = runfileValue(text, "QA_PID");
  const worktree = runfileValue(text, "QA_WORKTREE");
  const sourceRepo = runfileValue(text, "QA_SOURCE_REPO");
  if (pid !== "") {
    // Signal the whole process group (negative PID) we own — never a global pkill.
    signalGroup(Number(pid), "SIGTERM", true);
    await sleep(1000);
    signalGroup(Number(pid), "SIGKILL", false);
  }
  if (worktree !== "" && isDir(worktree)) {
    const r = spawnSync("git", ["-C", sourceRepo || worktree, "worktree", "remove", "--force", worktree], {
      stdio: "ignore",
    });
    if (r.error || r.status !== 0) rmSync(worktree, { recursive: true, force: true });
  }
  process.stdout.write(`qa: torn down (pid=${pid || "none"}, worktree=${worktree || "none"})\n`);
}

/**
 * Print `KEY=value` lines to stdout and write them to the runfile, as `tee` did.
 * Every value goes through shellQuote: the SKILL `eval`s this block, so a value
 * with a space, `&`, `$` or a quote in it must come back as itself, never as
 * shell syntax.
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
  for (let i = 0; i < args.length; i += 2) {
    const v = args[i + 1] ?? "";
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
      default:
        qaErr(`serve up: unknown flag: ${args[i]}`);
        exit(2);
    }
  }
  if (REPO === "" || !isDir(REPO)) {
    qaErr("serve up: --repo must be a directory");
    exit(2);
  }
  if (!["before", "after", "live"].includes(MODE)) {
    qaErr("serve up: --mode must be before|after|live");
    exit(2);
  }
  if (RUN_ID === "") {
    qaErr("serve up: --run-id required");
    exit(2);
  }
  REPO = resolve(REPO);

  const slug = qaRepoSlug(REPO);
  const runDir = `${SHOTS_ROOT}/${slug}/${RUN_ID}`;
  mkdirSync(runDir, { recursive: true });
  const RUNFILE = `${runDir}/server.run`;

  // ── resolve the SERVED SOURCE up front ──────────────────────────────
  // For --after, create the clean HEAD worktree NOW, BEFORE detection + route
  // discovery, so both read the committed revision being served — not the dirty
  // working tree. Otherwise an uncommitted page or qa:* script would select a
  // type/route that HEAD lacks and make after-commit QA lie (404s, wrong shots).
  // --before / --live detect + discover against the working tree.
  let src = REPO;
  let worktree = "";
  let label = "working tree";
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
  const detect = spawnSync(process.execPath, ["--experimental-strip-types", join(SCRIPT_DIR, "detect-app.ts"), src], {
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
  const TYPE = field("TYPE");
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
    let liveUrl = LIVE_URL;
    if (liveUrl === "") {
      liveUrl = (await qaDeriveLiveUrlFromCf(basename(REPO))) ?? "";
      // A Worker is not in the Pages registry; ask the Workers custom-domain
      // registry for the Worker the repo's wrangler config names.
      if (liveUrl === "") liveUrl = (await qaDeriveLiveUrlFromWorkers(REPO)) ?? "";
      if (liveUrl !== "") qaErr(`serve up: live URL derived from the Cloudflare registry -> ${liveUrl}`);
    }
    if (liveUrl === "") {
      qaErr("serve up: --live needs a live URL — pass --live-url <url>, or set");
      qaErr("  CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID for a Cloudflare lookup");
      qaErr(`  (no Pages project matched repo '${basename(REPO)}', and no Workers`);
      qaErr("  custom domain serves the Worker its wrangler config names). Or use");
      qaErr("  --before to build and serve the working tree instead.");
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
      serveCmd = `npx astro preview --port ${port} --host`;
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
      serveCmd = `python3 -m http.server ${port}`;
      serveCwd = `${buildDir}/${SERVE_DIR || "dist"}`;
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
    const b = spawnSync("bash", ["-c", buildCmd], { cwd: buildDir, stdio: ["ignore", fd, fd] });
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
    let migrated = 0;
    for (const db of qaD1Migrations(buildDir)) {
      if (db.remote) {
        qaErr(`qa: ${db.binding} is remote — left alone; a local server reaches production through it`);
      } else if (!isDir(join(buildDir, db.dir))) {
        qaErr(`qa: ${db.binding} has no ${db.dir}/ — its local database starts with no tables`);
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
    const seedScript = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(buildDir, "package.json"), "utf8"));
        return typeof pkg?.scripts?.["qa:seed"] === "string" ? pkg.scripts["qa:seed"] : "";
      } catch {
        return "";
      }
    })();
    if (seedScript !== "") {
      process.stderr.write("qa: running the app's qa:seed…\n");
      toLocal("the app's qa:seed", "npm", ["run", "qa:seed"], {
        QA_D1_PERSIST: statePath,
        QA_ACT_AS: qaProbeActsAs(buildDir),
      });
    }
    if (migrated > 0) label = `${label}, local D1: schema from migrations, no production rows`;
  }

  // ── a local sign-in, for a Worker served by a Cloudflare runtime ──
  // An app whose wrangler config names PROBE_ACTS_AS and ACCESS_AUD verifies a
  // Cloudflare Access token on every request, so /qa stands in for Access: it
  // signs a token for that person (qaLocalAccess), serves the key set on
  // loopback beside the server, and hands the Worker its URL as
  // ACCESS_JWKS_URL, which such an app should honour only on a loopback
  // request. The issuer is read from the account's Access organization, so
  // this needs wrangler's CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID. The
  // token goes in a file named by QA_AUTH_JWT_FILE, never on stdout.
  let envPrefix = "";
  let preamble = "";
  let jwtFile = "";
  if (TYPE === "astro-cf" || TYPE === "vite") {
    const person = qaProbeActsAs(buildDir);
    const aud = (qaWranglerVar(buildDir, "ACCESS_AUD").split(",")[0] ?? "").trim();
    if (person !== "" && aud !== "") {
      const issuer = await qaAccessIssuer();
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
  if (TYPE === "astro-cf") serveCmds.push(`npx astro dev --port ${port} --host`);
  if (TYPE === "next") {
    // `next start` needs a production build and refuses on `output: export`;
    // `next dev` serves source and always works. Same shape as the astro-cf
    // workerd fallback: a second attempt, not a different code path.
    serveCmds.push(`npx next dev --port ${port}`);
  }
  let idx = 0;
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
        if (qaPortOwnedBy(port, pgid)) {
          up = "yes";
        } else if (portWasFree) {
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
    ["QA_WORKTREE", worktree],
    ["QA_SRC", src],
    ["QA_SOURCE_REPO", REPO],
    ["QA_LOGFILE", logfile],
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
  if (sub === "up") await doUp(rest);
  else if (sub === "down") await doDown(rest);
  else {
    qaErr("usage: serve.ts up|down ...");
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
