#!/usr/bin/env -S node --experimental-strip-types
// check-standards-refs.ts — every citation of a standard names one that exists.
//
// The standards are the bold-led bullets of AGENTS.md (`- **<Name>.** …`, or
// `- **<Name>** …` where the bold runs into the sentence), Contextium's under
// § Standards and any a user adds in a section of their own. A file cites one
// as `AGENTS.md § Standards → <Name>`. A citation naming no bullet is invisible
// until someone follows it and finds nothing, so land.ts runs this before each
// commit and it names the file and line.
//
// WHAT IT CHECKS
//   - each `§ Standards → <Name>` in a tracked file names a bullet: the text
//     after the arrow begins with a bullet's name, compared without case, and
//     the name ends at a word boundary. `<name>` placeholders are not
//     citations.
//   - no `@rule:<id>` remains: that form cited the retired .agents/rules/ files.
//   - no two bullets share a name.
//   journal/ and projects/ are records of what was true then: a stale citation
//   there is counted and reported, never refused.
//
// WHERE AGENTS.md IS: .agents/AGENTS.md in a repo that installed the layer,
// templates/agents/AGENTS.md in the repo that authors it; both when both exist.
//
// Usage:
//   check-standards-refs.ts              tracked files, as in the working tree
//   check-standards-refs.ts --cached     the staged copies
//   check-standards-refs.ts [--cached] <path>...   only those paths
//
// Output: `OK — N citation(s) checked` on stdout, or one line per violation on
// stderr and `FAIL — …` on stdout.
// Exit: 0 clean · 1 a violation · 2 caller error

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exit, runToExit } from "../packages/cli-exit/cli-exit.ts";

const ARROW = "→";
const KEY = `Standards ${ARROW} `;

function git(args: string[], cwd?: string): { rc: number; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
  return { rc: r.status ?? 128, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** The lower-cased names of an AGENTS.md's bold-led bullets, in order. */
function bulletNames(text: string): string[] {
  const names: string[] = [];
  for (const line of text.split("\n")) {
    if (!/^- \*\*[^*]+\*\*/.test(line)) continue;
    let name = line.slice(4);
    name = name.slice(0, name.indexOf("**"));
    names.push(name.replace(/[.:]$/, "").toLowerCase());
  }
  return names;
}

function main(): void {
  const args = process.argv.slice(2);
  let cached = false;
  if (args[0] === "--cached") {
    cached = true;
    args.shift();
  }
  if (args[0]?.startsWith("-")) {
    err(`check-standards-refs: unknown option ${args[0]}`);
    exit(2);
  }

  const top = git(["rev-parse", "--show-toplevel"]);
  if (top.rc !== 0) {
    err("check-standards-refs: not inside a git work tree");
    exit(2);
  }
  const root = top.out.trim();

  // Both modes read the index (git grep searches tracked files; --cached reads
  // the staged copies). One git cannot read must fail the check, not look like a
  // repo with nothing in it.
  const idx = git(["ls-files"], root);
  if (idx.rc !== 0) {
    err(`check-standards-refs: git cannot read the index: ${idx.err.trim()}`);
    exit(2);
  }

  const known = new Set<string>();
  let found = false;
  let violations = 0;
  for (const src of [".agents/AGENTS.md", "templates/agents/AGENTS.md"]) {
    let text: string;
    if (cached) {
      if (git(["cat-file", "-e", `:${src}`], root).rc !== 0) continue;
      text = git(["show", `:${src}`], root).out;
    } else {
      if (!isFile(join(root, src))) continue;
      try {
        text = readFileSync(join(root, src), "utf8");
      } catch {
        text = "";
      }
    }
    found = true;
    const these = bulletNames(text);
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const n of these) {
      if (seen.has(n)) dups.add(n);
      seen.add(n);
    }
    for (const dup of [...dups].sort()) {
      err(`${src}: two bullets named '${dup}' — a citation could mean either`);
      violations++;
    }
    for (const n of these) known.add(n);
  }

  if (!found) {
    process.stdout.write("OK — no AGENTS.md standards here, nothing to check\n");
    exit(0);
  }

  // git grep exits 1 for "no match", which is a clean answer; anything above 1 is
  // a grep that did not happen.
  const grepArgs = ["grep", ...(cached ? ["--cached"] : []), "-n", "-I", "-F", "-e", KEY, "-e", "@rule:", "--", ...args];
  const g = git(grepArgs, root);
  if (g.rc > 1) {
    err(`check-standards-refs: git grep failed: ${g.err.trim()}`);
    exit(2);
  }

  // The text after the arrow names a standard when it begins with one, the
  // name ending at a word boundary: a name may hold commas and still be cited.
  const resolves = (text: string): boolean => {
    const t = text.toLowerCase();
    for (const n of known) {
      if (!t.startsWith(n)) continue;
      const nx = t.charAt(n.length);
      if (nx === "" || !/[a-z0-9]/.test(nx)) return true;
    }
    return false;
  };
  const hist = (f: string): boolean => /^(journal|projects)\//.test(f);

  let checked = 0;
  let historical = 0;
  const report = (f: string, l: string, msg: string): void => {
    checked++;
    if (hist(f)) {
      historical++;
      return;
    }
    err(`${f}:${l}: ${msg}`);
    violations++;
  };

  for (const hit of g.out.split("\n")) {
    if (!hit) continue;
    const p1 = hit.indexOf(":");
    const f = hit.slice(0, p1);
    const rest = hit.slice(p1 + 1);
    const p2 = rest.indexOf(":");
    const l = rest.slice(0, p2);
    const line = rest.slice(p2 + 1);

    let s = line;
    let p: number;
    while ((p = s.indexOf(KEY)) >= 0) {
      s = s.slice(p + KEY.length);
      if (s === "" || s.startsWith("<")) continue;
      if (resolves(s)) {
        checked++;
        continue;
      }
      let shown = s;
      const m = /[`)]/.exec(shown);
      if (m) shown = shown.slice(0, m.index);
      if (shown.length > 60) shown = `${shown.slice(0, 60)}…`;
      shown = shown.replace(/[ .,;:]+$/, "");
      report(f, l, `cites '${shown}', which is no bullet in AGENTS.md § Standards`);
    }
    for (const r of line.matchAll(/@rule:[a-z][a-z0-9-]*/g)) {
      report(f, l, `${r[0]} is retired — cite AGENTS.md § Standards ${ARROW} <name> instead`);
    }
  }

  if (historical > 0) {
    err(`ℹ ${historical} stale citation(s) in journal/ and projects/ — records of what was true then, not refused`);
  }
  if (violations > 0) {
    process.stdout.write(`FAIL — ${checked} citation(s) checked, ${violations} violation(s)\n`);
    exit(1);
  }
  process.stdout.write(`OK — ${checked} citation(s) checked\n`);
  exit(0);
}

await runToExit(main);
