#!/usr/bin/env -S node --experimental-strip-types
// layer-1.ts — Layer 1 of /implement Phase 4 (syntactic: lint, then typecheck).
//
// Reads newline-separated file list from stdin (output of resolve-scope.ts).
// Groups the files by PACKAGE — the nearest folder above each one that holds a
// package.json or a Makefile — and runs, by convention, with no settings file:
//   lint       the package's `lint` npm script, else its `make lint` target
//   typecheck  its `typecheck` or `check` npm script, else `make typecheck` /
//              `make check`
// A step a package does not declare is a WARN line and skipped, never a FAIL:
// a missing script is a gap in the package, not a defect this session made.
//
// Early-fail: if lint fails anywhere, do NOT typecheck — Layer 1 gates
// subsequent layers, and type errors mask runtime errors.
//
// Markdown and the records folders (journal/, projects/, knowledge/,
// decisions/) never select a package. A DELETED path still selects its package:
// deleting a file is exactly when you want its package checked. Any other file
// that no package owns is linted by nothing, and a WARN line names it — "no
// package in scope" is a clean result only when there was no code to lint.
//
// peers: resolve-scope.ts, layer-2.ts, layer-3.ts
//
// Output (stdout, TAP-ish):
//   PASS: layer-1 lint (apps/foo)
//   PASS: layer-1 typecheck (apps/foo)
//   WARN: layer-1 typecheck (tools/gen) — no typecheck/check script or make target; skipped
//   WARN: layer-1 lint (2 files in no package) — not linted or typechecked: bin/x.py tools/y.sh
//   FAIL: layer-1 lint (apps/foo)             (its output on stderr)
//   FAIL: layer-1 lint (tools/gen) — make cannot read the Makefile   (make's error on stderr)
//
// Exit:
//   0  all PASS (WARNs included)
//   1  any FAIL within layer

import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
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

/**
 * Run a command with stdout and stderr interleaved into one capture, in the
 * order they were written — `(cd dir && cmd 2>&1)`. A file rather than two
 * pipes, because two pipes lose the interleaving.
 */
function runMerged(cmd: string, args: string[], cwd: string): { ok: boolean; out: Buffer } {
  const dir = mkdtempSync(join(tmpdir(), "layer-1-out-"));
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

/** `printf '%s\n' "$out" | head -c 10240 >&2`: trailing newlines cut, plus one. */
function headToStderr(buf: Buffer): void {
  const text = buf.toString("utf8").replace(/\n+$/, "");
  process.stderr.write(Buffer.from(`${text}\n`, "utf8").subarray(0, 10240));
}

/** Markdown and the records: prose, which no package's lint reads. */
function isProse(file: string): boolean {
  return file.endsWith(".md") || /^(journal|projects|knowledge|decisions)\//.test(file);
}

/** The package that owns a repo-relative path, or "" for none. */
function pkgOf(file: string): string {
  if (isProse(file)) return "";
  let d = posix.dirname(file);
  for (;;) {
    if (isFile(`${d}/package.json`) || isFile(`${d}/Makefile`)) return d;
    if (d === "." || d === "/") return "";
    d = posix.dirname(d);
  }
}

// Does this package's OWN package.json declare the script? Read as JSON, not
// grepped: "lint" appearing in a dependency name would match a grep.
function declaresScript(pkg: string, name: string): boolean {
  try {
    const p: unknown = JSON.parse(readFileSync(`${pkg}/package.json`, "utf8"));
    const scripts = (p as { scripts?: unknown }).scripts || {};
    return Boolean((scripts as Record<string, unknown>)[name]);
  } catch {
    return false;
  }
}

/**
 * The targets the package's Makefile declares, as make itself reads them: its
 * own database (`make -pnqr .DEFAULT`), so a rule naming several targets
 * (`lint typecheck:`) and a target from an included file both count — a match
 * on `^<name>:` saw neither, and a declared step was skipped as a WARN. `-n`
 * and the goal `.DEFAULT` run no recipe; `-r` leaves the built-in rules out.
 * In the database's file section a target is a `name[ name…]:` line that is not
 * a target-specific variable (`name: VAR = x`) and not marked `# Not a target:`.
 * When make is not installed the Makefile's own lines are read instead, so a
 * declared step still runs — and FAILs loudly — rather than being skipped.
 *
 * A Makefile make cannot READ is not one that declares nothing. make prints a
 * database even after a parse error (a syntax error, a missing include, an
 * `$(error)`), holding none of the file's targets, so that database is never
 * used: `broken` carries make's own error lines and the step FAILs with them.
 * make's `*** ` lines are its errors; the one it always prints — no rule for
 * the `.DEFAULT` goal — is the ordinary case, and its warnings carry no `***`.
 */
interface MakeDb {
  targets: Set<string>;
  broken: string;
}
const targetsMemo = new Map<string, MakeDb>();
function makeTargets(pkg: string): MakeDb {
  const memo = targetsMemo.get(pkg);
  if (memo) return memo;
  const targets = new Set<string>();
  const addNames = (line: string): void => {
    const m = /^([^#\s:=%][^:=%]*?)\s*::?(?!=)(.*)$/.exec(line);
    if (!m || (m[2] ?? "").includes("=")) return;
    for (const t of (m[1] ?? "").split(/\s+/)) if (t !== "") targets.add(t);
  };
  const r = spawnSync("make", ["-pnqr", ".DEFAULT"], {
    cwd: pkg,
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const broken = r.error
    ? ""
    : (r.stderr ?? "")
        .split("\n")
        .filter((l) => l.includes("*** ") && !/No rule to make target [`']\.DEFAULT'/.test(l))
        .join("\n");
  if (broken !== "") {
    const db = { targets, broken };
    targetsMemo.set(pkg, db);
    return db;
  }
  const db = typeof r.stdout === "string" ? r.stdout.split("\n") : [];
  const start = db.indexOf("# Files");
  if (!r.error && start !== -1) {
    for (let i = start + 1; i < db.length && !(db[i] ?? "").startsWith("# files hash-table stats"); i++) {
      if (db[i - 1] !== "# Not a target:") addNames(db[i] ?? "");
    }
  } else {
    let text = "";
    try {
      text = readFileSync(`${pkg}/Makefile`, "utf8");
    } catch {
      text = "";
    }
    for (const line of text.split("\n")) addNames(line);
  }
  const found = { targets, broken: "" };
  targetsMemo.set(pkg, found);
  return found;
}

/** Does the package's Makefile declare the target? */
function hasTarget(pkg: string, name: string): boolean {
  return isFile(`${pkg}/Makefile`) && makeTargets(pkg).targets.has(name);
}

/** make's error when the package's Makefile does not parse; "" when it does, or there is none. */
function brokenMakefile(pkg: string): string {
  return isFile(`${pkg}/Makefile`) ? makeTargets(pkg).broken : "";
}

/** Run one step over every package; false when any FAILs. */
function runStep(pkgs: string[], step: string, candidates: string[]): boolean {
  let ok = true;
  for (const pkg of pkgs) {
    const label = pkg === "." ? "(root)" : pkg.replace(/^\.\//, "");
    let cmd: string[] | null = null;
    for (const cand of candidates) {
      if (declaresScript(pkg, cand)) {
        cmd = ["npm", "run", "--silent", cand];
        break;
      }
    }
    if (cmd === null && brokenMakefile(pkg) !== "") {
      out(`FAIL: layer-1 ${step} (${label}) — make cannot read the Makefile`);
      headToStderr(Buffer.from(brokenMakefile(pkg)));
      ok = false;
      continue;
    }
    if (cmd === null) {
      for (const cand of candidates) {
        if (hasTarget(pkg, cand)) {
          cmd = ["make", "--no-print-directory", cand];
          break;
        }
      }
    }
    if (cmd === null) {
      out(`WARN: layer-1 ${step} (${label}) — no ${candidates.join("/")} script or make target; skipped`);
      continue;
    }
    const [bin = "", ...args] = cmd;
    const r = runMerged(bin, args, pkg);
    if (r.ok) {
      out(`PASS: layer-1 ${step} (${label})`);
    } else {
      out(`FAIL: layer-1 ${step} (${label})`);
      headToStderr(r.out);
      ok = false;
    }
  }
  return ok;
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
  if (files.length === 0) {
    out("PASS: layer-1 (0 files)");
    exit(0);
  }

  const pkgs = [...new Set(files.map(pkgOf).filter((p) => p !== ""))].sort();
  const unowned = [...new Set(files.filter((f) => !isProse(f) && pkgOf(f) === ""))].sort();
  if (unowned.length > 0) {
    const shown = unowned.slice(0, 10).join(" ") + (unowned.length > 10 ? " …" : "");
    out(`WARN: layer-1 lint (${unowned.length} files in no package) — not linted or typechecked: ${shown}`);
  }
  if (pkgs.length === 0) {
    if (unowned.length === 0) out("PASS: layer-1 (no package in scope)");
    exit(0);
  }

  // ── lint, then typecheck ─────────────────────────────────────────────
  if (!runStep(pkgs, "lint", ["lint"])) exit(1); // early-fail: lint gates typecheck
  exit(runStep(pkgs, "typecheck", ["typecheck", "check"]) ? 0 : 1);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
