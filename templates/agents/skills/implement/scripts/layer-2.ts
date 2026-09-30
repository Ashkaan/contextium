#!/usr/bin/env -S node --experimental-strip-types
// layer-2.ts — Layer 2 of /implement Phase 4 (unit + integration tests).
//
// Reads newline-separated file list from stdin. Groups the files by PACKAGE —
// the nearest folder above each one holding a package.json or a Makefile — and
// runs each package's tests, by convention, with no settings file:
//   the `test` npm script, else the `make test` target, else `node --test` over
//   the package's `*.test.{ts,js,mjs,cjs}` files where they sit.
// A file under `integrations/<name>/` or `packages/<name>/` with no package
// above it runs that folder's test files in place the same way.
//
// The in-place branch closes a hole, not a nicety: a layer that prints
// `WARN … skip` for a library with no test script reports PASS over test files
// it never executed.
//
// peers: layer-1.ts, layer-3.ts
//
// Output (stdout, TAP-ish):
//   PASS: layer-2 (no tests in scope)
//   PASS: layer-2 apps/foo (npm test)
//   PASS: layer-2 integrations/bar (N tests)
//   FAIL: layer-2 apps/foo — see stderr
//
// Exit:
//   0  all PASS
//   1  any FAIL

import { spawnSync } from "node:child_process";
import {
  closeSync,
  type Dirent,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
function out(msg: string): void {
  process.stdout.write(`${msg}\n`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `git rev-parse --show-toplevel`, or "" outside a repo. */
function gitToplevel(): string {
  const r = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.replace(/\n+$/, "") : "";
}

/** Every non-empty line of stdin. */
function stdinLines(): string[] {
  let text = "";
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
  return text.split("\n").filter((l) => l !== "");
}

const TEST_FILE = /\.test\.(ts|js|mjs|cjs)$/;

/**
 * Every `*.test.{ts,js,mjs,cjs}` regular file under a directory, never
 * following a symlink and never inside node_modules, sorted; nothing at all
 * when the directory is not there.
 */
function findTests(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.isFile() && TEST_FILE.test(e.name)) {
        found.push(p);
      }
    }
  };
  walk(dir);
  return found.sort();
}

/**
 * Run a command with stdout and stderr interleaved into one capture, in the
 * order they were written — `(cd dir && cmd 2>&1) > file 2>&1`. A file rather
 * than two pipes, because two pipes lose the interleaving.
 */
function runMerged(cmd: string, args: string[], cwd: string): { ok: boolean; out: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "layer-2-out-"));
  const file = join(dir, "out");
  const fd = openSync(file, "w");
  let ok = false;
  try {
    const r = spawnSync(cmd, args, { cwd, stdio: ["ignore", fd, fd] });
    ok = r.status === 0;
  } finally {
    closeSync(fd);
  }
  const captured = readFileSync(file);
  rmSync(dir, { recursive: true, force: true });
  return { ok, out: captured };
}

/** `head -c 10240 >&2`. */
function headToStderr(buf: Buffer): void {
  process.stderr.write(buf.subarray(0, 10240));
}

// The unit that owns a repo-relative path: its package, else its
// integrations/<name> or packages/<name> folder, else "". Markdown and the
// records folders own no tests.
function unitOf(file: string): string {
  if (file.endsWith(".md")) return "";
  if (/^(journal|projects|knowledge|decisions)\//.test(file)) return "";
  let d = posix.dirname(file);
  for (;;) {
    if (isFile(`${d}/package.json`) || isFile(`${d}/Makefile`)) return d;
    if (d === "." || d === "/") break;
    d = posix.dirname(d);
  }
  const m = /^((?:integrations|packages)\/[^/]+)\/./.exec(file);
  return m?.[1] ?? "";
}

// Does this package's OWN package.json declare the script? Read as JSON, not
// grepped: "test" appearing in a dependency name would match a grep.
function declaresScript(pkg: string, name: string): boolean {
  try {
    const p: unknown = JSON.parse(readFileSync(`${pkg}/package.json`, "utf8"));
    const scripts = (p as { scripts?: unknown }).scripts || {};
    return Boolean((scripts as Record<string, unknown>)[name]);
  } catch {
    return false;
  }
}

/** Does the package's Makefile declare `<name>:` at the start of a line? */
function hasTarget(pkg: string, name: string): boolean {
  let text = "";
  try {
    text = readFileSync(`${pkg}/Makefile`, "utf8");
  } catch {
    return false;
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}[ \\t]*:`, "m").test(text);
}

async function main(): Promise<void> {
  // CLAUDE_PROJECT_DIR is an optimization, not a hard dependency — fall back to
  // git when unset (some callers leave it unset). A failing rev-parse outside a
  // repo reads as "" so the guard below surfaces the documented exit code
  // rather than git's 128.
  const REPO_DIR = process.env.CLAUDE_PROJECT_DIR || gitToplevel();
  if (REPO_DIR === "") {
    err("CLAUDE_PROJECT_DIR unset and not inside a git repo");
    exit(1);
  }
  process.chdir(REPO_DIR);

  const files = stdinLines();
  const units = [...new Set(files.map(unitOf).filter((u) => u !== ""))].sort();
  if (units.length === 0) {
    out("PASS: layer-2 (no tests in scope)");
    exit(0);
  }

  let anyFail = false;

  // Run test files in place, with no bundle.
  //
  // --experimental-test-module-mocks is NOT optional: without it a file calling
  // mock.module() dies with "mock.module is not a function" and is reported as a
  // FAILING TEST, which reads as a regression.
  //
  // --preserve-symlinks{,-main} because the skills a harness reads are often a
  // symlink into the workbench, and a test reached through it must resolve its
  // repo imports relative to the link, not the target.
  //
  // Node is this same binary.
  const runTestsInPlace = (label: string, tests: string[]): void => {
    const r = runMerged(
      process.execPath,
      [
        "--test",
        "--experimental-strip-types",
        "--experimental-test-module-mocks",
        "--preserve-symlinks",
        "--preserve-symlinks-main",
        ...tests,
      ],
      process.cwd(),
    );
    if (r.ok) {
      out(`PASS: layer-2 ${label} (${tests.length} tests)`);
    } else {
      out(`FAIL: layer-2 ${label}`);
      headToStderr(r.out);
      anyFail = true;
    }
  };

  for (const unit of units) {
    const label = unit === "." ? "(root)" : unit.replace(/^\.\//, "");
    let cmd: string[] | null = null;
    if (declaresScript(unit, "test")) cmd = ["npm", "test", "--silent"];
    else if (hasTarget(unit, "test")) cmd = ["make", "--no-print-directory", "test"];
    if (cmd !== null) {
      // The package owns its own test script — its answer, not a guess.
      const [bin = "", ...args] = cmd;
      const r = runMerged(bin, args, unit);
      if (r.ok) {
        out(`PASS: layer-2 ${label} (${bin} test)`);
      } else {
        out(`FAIL: layer-2 ${label}`);
        headToStderr(r.out);
        anyFail = true;
      }
      continue;
    }
    const unitTests = findTests(unit);
    if (unitTests.length === 0) {
      out(`PASS: layer-2 ${label} (no tests in scope)`);
      continue;
    }
    runTestsInPlace(label, unitTests);
  }

  exit(anyFail ? 1 : 0);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
