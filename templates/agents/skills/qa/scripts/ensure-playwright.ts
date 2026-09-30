#!/usr/bin/env -S node --experimental-strip-types
// ensure-playwright.ts — find a Playwright with an installed Chromium, installing
// one on first use. Nothing installs Playwright ahead of time: a repo with no
// web app never pays for it.
//
// Usage:  ensure-playwright.ts [--app <dir>]
// Output: PLAYWRIGHT_MODULE=<absolute path of the playwright package>
// Exit:   0 ready · 4 unavailable — stderr carries one line,
//           `qa: skipped — Playwright unavailable (<reason>)`, which the caller
//           repeats to the user word for word · 2 usage error
//
// Order: the app's own `playwright` (resolved from --app, and only if it lives
// inside the app's repo), then the cache at $QA_PLAYWRIGHT_DIR (default
// ${XDG_CACHE_HOME:-~/.cache}/agents-qa/playwright). A module that resolves from
// outside those roots (a stray node_modules higher up the disk, NODE_PATH) is
// ignored: its version and browser are nobody's choice.
// A module without its browser gets `playwright install chromium` run through
// that same module's cli.js, because each Playwright version pins its own
// Chromium build. With neither, `npm install playwright` into the cache first.
// QA_NO_INSTALL=1 forbids every install (offline machines, CI).
//
// peers:
//   .agents/skills/qa/scripts/lib.ts (qaPlaywrightNodeModules falls back to this)
//   .agents/skills/qa/scripts/tests/ensure-playwright.test.ts

import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function skip(reason: string): never {
  process.stderr.write(`qa: skipped — Playwright unavailable (${reason})\n`);
  exit(4);
}

interface Probe {
  dir: string;
  ok: boolean;
}

/**
 * The playwright package that resolves from `from` to a path inside `root`, and
 * whether its Chromium is installed; undefined when none does. Each probe runs
 * in a fresh child, so a module installed a moment ago is read as it is now,
 * not as this process's require cache remembers it.
 */
function probe(from: string, root: string): Probe | undefined {
  const r = spawnSync(
    process.execPath,
    [
      "-e",
      `const path = require("path"), fs = require("fs");
let pj;
try { pj = fs.realpathSync(require.resolve("playwright/package.json", { paths: [process.argv[1]] })); }
catch { process.exit(0); }
const root = fs.realpathSync(process.argv[2]) + path.sep;
if (!pj.startsWith(root)) process.exit(0);
const dir = path.dirname(pj);
let exe = "";
try { exe = require(dir).chromium.executablePath(); } catch {}
process.stdout.write(dir + "\\t" + (exe && fs.existsSync(exe) ? "ok" : "nobrowser"));`,
      from,
      root,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const line = r.stdout ?? "";
  const tab = line.indexOf("\t");
  if (r.error || tab === -1) return undefined;
  return { dir: line.slice(0, tab), ok: line.slice(tab + 1) === "ok" };
}

/** The last line of a log, for a skip reason. */
function lastLine(file: string): string {
  try {
    const lines = readFileSync(file, "utf8").replace(/\n+$/, "").split("\n");
    return lines[lines.length - 1] ?? "";
  } catch {
    return "";
  }
}

/** Run a command with stdout and stderr in `log`; true when it exits 0. */
function logged(cmd: string, args: string[], log: string): boolean {
  const fd = openSync(log, "w");
  try {
    const r = spawnSync(cmd, args, { stdio: ["ignore", fd, fd] });
    return !r.error && r.status === 0;
  } finally {
    closeSync(fd);
  }
}

/** Print the module and stop when its browser is there; install the browser when only the module is. */
function ready(found: Probe | undefined, cache: string): void {
  if (found === undefined) return;
  if (!found.ok) {
    if (process.env.QA_NO_INSTALL === "1") skip("Chromium is not installed and QA_NO_INSTALL=1");
    process.stderr.write("qa: installing Chromium for Playwright (first use)…\n");
    mkdirSync(cache, { recursive: true });
    const log = join(cache, "install.log");
    if (!logged(process.execPath, [join(found.dir, "cli.js"), "install", "chromium"], log))
      skip(`playwright install chromium failed: ${lastLine(log)}`);
    if (!probe(dirname(dirname(found.dir)), found.dir)?.ok) skip("Chromium still missing after install");
  }
  process.stdout.write(`PLAYWRIGHT_MODULE=${found.dir}\n`);
  exit(0);
}

/** The repo root holding `app`, or `app` itself (real path) outside a repo. */
function appRoot(app: string): string {
  const r = spawnSync("git", ["-C", app, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const top = (r.stdout ?? "").replace(/\n+$/, "");
  return !r.error && r.status === 0 && top !== "" ? top : realpathSync(app);
}

/** Whether `npm` can be run at all. */
function hasNpm(): boolean {
  const r = spawnSync("npm", ["--version"], { stdio: "ignore" });
  return !r.error;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let app = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app") {
      if (i + 1 >= args.length) {
        process.stderr.write("ensure-playwright: --app needs a directory\n");
        exit(2);
      }
      app = args[++i] ?? "";
    } else {
      process.stderr.write(`ensure-playwright: unknown argument: ${args[i]}\n`);
      exit(2);
    }
  }
  const home = process.env.HOME || homedir();
  const cache =
    process.env.QA_PLAYWRIGHT_DIR || join(process.env.XDG_CACHE_HOME || join(home, ".cache"), "agents-qa", "playwright");

  if (app !== "" && isDir(app)) ready(probe(app, appRoot(app)), cache);
  if (isDir(cache)) ready(probe(cache, cache), cache);

  if (process.env.QA_NO_INSTALL === "1") skip("not installed and QA_NO_INSTALL=1");
  if (!hasNpm()) skip("npm is not installed");
  process.stderr.write(`qa: installing Playwright into ${cache} (first use)…\n`);
  mkdirSync(cache, { recursive: true });
  const log = join(cache, "install.log");
  if (!logged("npm", ["install", "--prefix", cache, "--no-audit", "--no-fund", "playwright"], log))
    skip(`npm install playwright failed: ${lastLine(log)}`);
  ready(probe(cache, cache), cache);
  skip(`npm install playwright left no module in ${cache}`);
}

await runToExit(main);
