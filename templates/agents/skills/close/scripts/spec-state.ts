#!/usr/bin/env -S node --experimental-strip-types
// spec-state.ts — for one project folder, say what state each SPEC is in.
// THE one place that answers "is this SPEC finished?"; next-implement-command.ts,
// project-remaining-work.ts and project/scripts/detect-stage.ts all call it
// instead of each re-deriving the rule from filenames.
//
// THE BUG THIS REPLACES. Three readers each asking the filesystem "does
// `<name>-report.md` exist?" read a SPEC reported under slice names
// (`phase-2-sync-freshness-report.md`) as pending forever, and /close would
// print an `/implement` for work already done. Widening the glob alone would be
// worse: a SPEC with one partial report would read as finished and drop out of
// the queue silently. So the widened match resolves to `partial`, never
// `complete`.
//
// WHERE THE ANSWER COMES FROM, most trusted first. Completeness is a CLAIM
// somebody made, not a fact about which files exist, so a declaration always
// beats the filename:
//   1. report frontmatter — `spec: <name>` + `spec-status: complete|partial`
//   2. report prose       — `**SPEC**: ...<name>.spec.md` + `**Status**: ...`
//      (the header /implement's report has always written)
//   3. the filename       — exact `<name>-report.md` is complete by the old
//      convention; a qualified `<name>-<rest>-report.md` is PARTIAL
//
// A status counts as complete only when it opens with COMPLETE, SHIPPED or DONE.
// `CODE COMPLETE`, `BUILD COMPLETE`, `PARTIAL` and `NOT IMPLEMENTED` are all
// partial — the tail of that vocabulary is a judgment call per report, so this
// fails toward naming a loose end rather than hiding one.
//
// Usage: spec-state.ts <project-folder>
// Output: one line per SPEC, tab-separated —
//   <name>	complete|partial|none	<evidence>
// where <name> is a legacy stem (`alpha`) or a spec folder (`specs/001-alpha`).
//
// ORDER. The bash original took its reports in glob order and its output
// through `sort -u`, both collating by the locale; under the C locales (C,
// C.UTF-8, POSIX) that is code-point order, which is what `byCodePoint` sorts
// by, so the output no longer depends on the machine's locale.
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

/** Entries of `dir` a shell glob `*<suffix>` matches: no dotfiles, sorted. */
function glob(dir: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter((n) => !n.startsWith(".") && n.endsWith(suffix)).sort(byCodePoint);
}

/** coreutils `basename`: trailing slashes dropped, then the last component. */
function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  if (t === "") return p === "" ? "" : "/";
  return t.slice(t.lastIndexOf("/") + 1);
}
const stripSuffix = (s: string, suffix: string): string => (s.endsWith(suffix) ? s.slice(0, -suffix.length) : s);

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

/**
 * Which SPEC does this report belong to, and what does it claim?
 * Returns "<spec-name>|<claim>|<evidence>"; empty when it belongs to none.
 */
function classify(rf: string, specs: string[]): string {
  const head = headLines(rf, 20);
  let specName = "";
  let claim = "";
  let evidence = "";

  // 1. frontmatter
  if ((head[0] ?? "") === "---") {
    const decl = frontmatterValue(head, "spec");
    const status = frontmatterValue(head, "spec-status");
    if (decl !== "") {
      specName = stripSuffix(stripSuffix(basename(decl), ".spec.md"), ".plan.md");
      if (status !== "") {
        claim = isCompleteClaim(status) ? "complete" : "partial";
        evidence = "frontmatter";
      }
    }
  }

  // 2. prose
  if (specName === "" || claim === "") {
    const specLine = head.find((l) => /^\*\*SPEC\*\*:/i.test(l));
    const decl = specLine === undefined ? "" : (/[A-Za-z0-9._-]+\.(spec|plan)\.md/.exec(specLine)?.[0] ?? "");
    // Anywhere on the line: older reports put SPEC and Status on one line.
    const statusLine = head.find((l) => /\*\*Status\*\*:/i.test(l));
    const status =
      statusLine === undefined ? "" : statusLine.replace(/^.*\*\*Status\*\*:[ \t\n\r\f\v]*/i, "");
    if (specName === "" && decl !== "") {
      specName = stripSuffix(stripSuffix(decl, ".spec.md"), ".plan.md");
    }
    if (claim === "" && status !== "") {
      claim = isCompleteClaim(status) ? "complete" : "partial";
      evidence = "declared-status";
    }
  }

  // 3. filename — longest SPEC name that the report stem starts with wins, so a
  // sibling `alpha-2.spec.md` keeps `alpha-2-report.md` away from `alpha`.
  const stem = stripSuffix(basename(rf), "-report.md");
  if (specName === "") {
    let best = "";
    for (const s of specs) {
      if (stem === s || stem.startsWith(`${s}-`)) {
        if (s.length > best.length) best = s;
      }
    }
    specName = best;
    if (specName === "") return "";
    if (claim === "") {
      if (stem === specName) {
        claim = "complete";
        evidence = "exact-filename";
      } else {
        claim = "partial";
        evidence = "qualified-filename";
      }
    }
  }
  if (specName === "") return "";
  if (claim === "") {
    claim = "partial";
    evidence = evidence || "report-present";
  }
  return `${specName}|${claim}|${evidence}`;
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

  // Every SPEC in the folder. `*.plan.md` is the legacy spelling, still recognised.
  const specs: string[] = [];
  for (const b of [...glob(projectDir, ".spec.md"), ...glob(projectDir, ".plan.md")]) {
    specs.push(stripSuffix(stripSuffix(b, ".spec.md"), ".plan.md"));
  }
  const reports = glob(projectDir, "-report.md").map((b) => `${projectDir}/${b}`);
  // The spec-kit layout: one folder per spec, `specs/NNN-name/`,
  // holding its own `report.md`. A folder spec is NAMED BY ITS PATH, so it can
  // never collide with a legacy stem (`001-x.spec.md` stays `001-x`), and its
  // report is that folder's `report.md` alone — the top-level `*-report.md` glob
  // above never reaches it, and no filename is matched.
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
  if (specs.length === 0 && folderSpecs.length === 0) exit(0);

  const STATE = new Map<string, string>();
  const EVID = new Map<string, string>();
  for (const s of specs) {
    STATE.set(s, "none");
    EVID.set(s, "no report");
  }
  for (const rf of reports) {
    const line = classify(rf, specs);
    if (line === "") continue;
    const name = line.slice(0, line.indexOf("|"));
    const rest = line.slice(line.indexOf("|") + 1);
    const claim = rest.includes("|") ? rest.slice(0, rest.indexOf("|")) : rest;
    const ev = rest.slice(rest.lastIndexOf("|") + 1);
    if (!STATE.has(name)) continue; // declares a SPEC not in this folder
    if (claim === "complete") {
      STATE.set(name, "complete");
      EVID.set(name, `${ev}: ${basename(rf)}`);
    } else if (STATE.get(name) !== "complete") {
      STATE.set(name, "partial");
      EVID.set(name, `${ev}: ${basename(rf)}`);
    }
  }

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

  // `for s in $(printf '%s\n' … | sort -u)` — unique, sorted, and split on
  // whitespace as the unquoted substitution split it.
  const names = [...new Set([...specs, ...folderSpecs])]
    .sort(byCodePoint)
    .join("\n")
    .split(/[ \t\n]+/)
    .filter((s) => s !== "");
  let out = "";
  for (const s of names) out += `${s}\t${STATE.get(s) ?? ""}\t${EVID.get(s) ?? ""}\n`;
  process.stdout.write(out);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
