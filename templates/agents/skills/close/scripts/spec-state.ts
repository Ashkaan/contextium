#!/usr/bin/env -S node --experimental-strip-types
// spec-state.ts — for one project folder, say what state each spec is in.
// THE one place that answers "is this spec finished?"; next-implement-command.ts,
// project-remaining-work.ts and project/scripts/detect-stage.ts all call it
// instead of each re-deriving the rule from filenames.
//
// THE RULE. A spec is a folder `specs/NNN-name/` holding a `spec.md`, named by
// its path. Its state is its own `report.md`'s frontmatter `spec-status:` — a
// CLAIM somebody made, read narrowly: no report.md → none; a status opening with
// COMPLETE, SHIPPED or DONE → complete; anything else, or no `spec-status:` at
// all → partial. `CODE COMPLETE`, `BUILD COMPLETE`, `PARTIAL` and
// `NOT IMPLEMENTED` are all partial — this fails toward naming a loose end
// rather than hiding one. Three readers each asking "does `<name>-report.md`
// exist?" instead read a spec reported under a qualified name as pending
// forever, and /close would print an `/implement` for work already done.
//
// Loose `*.spec.md`, `*.plan.md` and `*-report.md` files are not read: the
// layout that used them was retired for ROADMAP.md rows and spec folders. A folder holding only a
// `report.md` (a report kept whose spec never existed) is not a spec.
//
// Usage: spec-state.ts <project-folder>
// Output: one line per spec, tab-separated —
//   specs/NNN-name	complete|partial|none	<evidence>
//
// ORDER. The bash original sorted its output by the locale; under the C locales
// (C, C.UTF-8, POSIX) that is code-point order, which is what `byCodePoint`
// sorts the folders by, so the output no longer depends on the machine's locale.
//
// peers:
//   .agents/skills/close/scripts/spec-state.test.ts

import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const err = (msg: string): void => {
  process.stderr.write(`Error: ${msg}\n`);
};

const byCodePoint = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The first `n` lines of a file, or "" when it cannot be read (`head -n N f 2>/dev/null`). */
function headLines(path: string, n: number): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, n);
}

// `sed -nE 's/^key:[[:space:]]*"?([^"]+)"?[[:space:]]*$/\1/p' | head -n1`
function frontmatterValue(lines: string[], key: string): string {
  const re = new RegExp(`^${key}:[ \\t\\r\\f\\v]*"?([^"]+)"?[ \\t\\r\\f\\v]*$`);
  for (const l of lines) {
    const m = re.exec(l);
    if (m) return m[1] ?? "";
  }
  return "";
}

/** Is this status string a completion claim? Deliberately narrow. */
function isCompleteClaim(s: string): boolean {
  const v = s.replace(/[a-z]/g, (c) => c.toUpperCase()).replace(/^[ \t\n\r\f\v]+/, "");
  return /^(COMPLETE|SHIPPED|DONE)($|[^A-Z])/.test(v);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) {
    err("usage: spec-state.ts <project-folder>");
    exit(2);
  }
  const projectDir = argv[0] ?? "";
  let isDir = false;
  try {
    isDir = statSync(projectDir).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    err(`not a directory: ${projectDir}`);
    exit(2);
  }

  // One folder per spec, `specs/NNN-name/`, holding its own `report.md`.
  const folderSpecs: string[] = [];
  let specDirs: string[] = [];
  try {
    specDirs = readdirSync(`${projectDir}/specs`)
      .filter((n) => !n.startsWith("."))
      .sort(byCodePoint);
  } catch {
    specDirs = [];
  }
  for (const d of specDirs) {
    if (exists(`${projectDir}/specs/${d}/spec.md`)) folderSpecs.push(`specs/${d}`);
  }
  if (folderSpecs.length === 0) exit(0);

  const STATE = new Map<string, string>();
  const EVID = new Map<string, string>();

  // A folder spec's state is its report.md's frontmatter `spec-status:`, read
  // through the same narrow completion test: no report.md → none, a report that
  // does not claim completion → partial.
  for (const fs of folderSpecs) {
    const rf = `${projectDir}/${fs}/report.md`;
    if (!isFile(rf)) {
      STATE.set(fs, "none");
      EVID.set(fs, "no report");
      continue;
    }
    let status = "";
    const head = headLines(rf, 20);
    if ((head[0] ?? "") === "---") status = frontmatterValue(head, "spec-status");
    if (status !== "" && isCompleteClaim(status)) {
      STATE.set(fs, "complete");
      EVID.set(fs, `frontmatter: ${fs}/report.md`);
    } else {
      STATE.set(fs, "partial");
      EVID.set(fs, status !== "" ? `frontmatter: ${fs}/report.md` : `no spec-status: ${fs}/report.md`);
    }
  }

  let out = "";
  for (const s of folderSpecs) out += `${s}\t${STATE.get(s) ?? ""}\t${EVID.get(s) ?? ""}\n`;
  process.stdout.write(out);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
