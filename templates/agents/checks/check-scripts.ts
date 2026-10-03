#!/usr/bin/env -S node --experimental-strip-types
// check-scripts.ts — hold every script under .agents/ (the skills, checks,
// generators and hooks) to "carries a test, and the test RUNS it", before a
// close commits it.
//
// WHY. A script with no test is changed blind, and a test that imports or
// sources its subject instead of running it breaks the day the program changes
// language, while a test that spawns it survives with the interpreter line
// changed. AGENTS.md § Standards "Tests and evals" states that rule, and
// AGENTS.md § Standards "Scripts are TypeScript" states which language a
// script under .agents/ is written in; this program owns whether a given tree
// obeys both.
//
// WHAT IT CHECKS — each violation carries the letter of the part it breaks:
//   (a)  every script has a paired test: `<stem>.test.ts` (or a legacy
//        `.test.sh`) beside it, or `tests/<stem>.test.*` in its folder or its
//        parent. Whether the suite asserts anything is the runner's and the
//        reviewer's business, not this check's — an empty test file passes.
//   (b)  when the script is a PROGRAM, its paired test does not import or
//        source the script's own path — it runs it as a subprocess. A LIBRARY
//        is exempt from (b) only: it is a file at least one non-test file
//        under the roots imports or sources, so there is no program to run and
//        the import IS how it is used. Library status is re-derived on every run, so
//        deleting a library's last importer turns its import test into a (b)
//        violation on the next scan, incremental included.
//   (c)  the language, over EVERY file under ROOTS — tracked, or untracked
//        and not ignored, anywhere but under a `node_modules/` segment — in
//        every mode: no `.js`, `.mjs`, `.cjs` or `.py` at all, and a `.sh`
//        only in the tier AGENTS.md § Standards "Scripts are TypeScript"
//        names. Files outside ROOTS are the workbench owner's own work, in
//        whatever language they chose, and are never judged. The tier is
//        derived on each run from what the files of the WHOLE worktree do (a
//        hook config or a sourcing file may sit outside ROOTS), never from a
//        list of names. A `.sh` is in it when it is
//          - named by a hook `command` in any JSON hook config of the repo
//            (`.claude/settings.json`, `.agents/hooks.json`, …) — the harness
//            fires it on every tool call;
//          - a maker of the tree TypeScript runs from: a command line (not a
//            comment, not inside a string) running `git … worktree add` or
//            `git … clone`, or `git -C <other tree> … reset --hard`;
//          - the deploy poller land.ts runs by name,
//            `.agents/deploy/await-deploy-run.sh`;
//          - the script a `curl … | bash` line in the repo's README installs;
//          - a provisioner of a stock host: `apt-get install` in a file that
//            runs `ssh`;
//          - SOURCED by a file in the tier, transitively — bash cannot source
//            TypeScript. A `source`/`.` path built from a variable is resolved
//            through that variable's assignments in the same file. A file a
//            tier script merely executes is not in the tier.
//        A tier file whose `source` names a `.ts`, or whose `source` line
//        cannot be resolved to a file, is a violation too, and so is a `.ts`
//        whose shebang passes flags without `env -S` (Linux hands the whole
//        rest of the line to env as ONE argument).
//
// WHAT IS A SCRIPT, for (a) and (b). Under ROOTS below: every `*.sh`; every
// `.ts`, `.mjs`, `.js` or `.py` whose first line starts `#!` or whose parent
// folder is one of SCRIPT_DIRS. Never a `*.test.*`, a `*.template.*`, or
// anything under a `references/`, `tests/`, `templates/` or `node_modules/`
// segment. Nothing else re-derives the definition. The bash scripts (the
// hooks, lock.sh, …) pair the same way as the TypeScript:
// `hooks/lib/paths.sh` is covered by `hooks/lib/paths.test.ts` beside it.
// Part (c) has no definition of a script: it reads extensions.
//
// WHAT CONTEXTIUM SHIPPED. A script the installer put here and that still
// matches the checksum it recorded (`.agents/<folder>/.contextium-manifest`)
// passes (a): its tests run in the Contextium repo, and the installer copies
// no tests. Once edited it no longer matches and is yours, test included —
// the same rule the installer uses to decide what it may remove.
//
// WHAT COUNTS AS AN IMPORT. A TypeScript/JS `from "<specifier>"` whose
// specifier, resolved against the importer's directory, is the subject's own
// path; or a shell `source <path>` / `. <path>` line whose path resolves the
// same way. A shell path built at run time (`"$(dirname "$0")/x.sh"`,
// `"$SCRIPT_DIR/x.sh"`, `"$HERE/../x.sh"`) cannot be resolved, so it counts
// when the importer sits in the subject's directory, or one folder below it.
// A comment that mentions the file matches neither shape.
//
// WHAT IT SCANS. With no arguments: part (a) over the scripts changed in this
// worktree since HEAD, staged or not, plus untracked ones — land.ts calls it
// BEFORE its `git add -A`; a changed or deleted `*.test.*` selects its paired
// subject (removing a script's only test is refused); a subject no longer on
// disk is skipped. Part (b) over EVERY test in the universe whose text
// imports or sources its own subject, changed or not. Part (c) over every file
// under ROOTS, changed or not, because a file leaves the tier when ANOTHER file
// changes (a hook entry deleted, a `source` line removed). With `--since <ref>`
// the same, measured from where this branch left <ref>: a script the session
// already COMMITTED differs from nothing at HEAD. `--all` runs (a) and (b) over every
// script under ROOTS; explicit paths run them over exactly those files, or
// every script beneath a directory argument. Part (c) is the same in all four.
//
// Usage:
//   check-scripts.ts                  scripts changed since HEAD
//   check-scripts.ts --since <ref>    …since this branch left <ref>
//   check-scripts.ts --all            every script under the roots
//   check-scripts.ts <path>...        those files / directories
//
// Output (stdout): exactly one line — `OK — N script(s) checked`, or
//   `FAIL — N script(s) checked, M violation(s)`. N is the number of scripts
//   part (a) was run over; a (b) or (c) violation found by a whole-universe or
//   whole-roots pass does not add to it.
// Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
//
// peers:
//   AGENTS.md § Standards "Tests and evals"         (the rule (a) and (b) enforce)
//   AGENTS.md § Standards "Scripts are TypeScript"  (the rule (c) enforces)
//   .agents/skills/close/scripts/land.ts     (the gate that calls it)
//   .agents/checks/check-scripts.test.ts
//   .agents/skills/close/scripts/verify.ts   (runs the suites this pairs)
//
// Exit: 0 clean · 1 one or more violations · 2 caller error

import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  statSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── The universe ─────────────────────────────────────────────────────────
const ROOTS = [".agents"];
const SCRIPT_DIRS = ["scripts", "checks", "deploy", "generators", "hooks"];
/** The deploy poller land.ts runs on a landing, by this name (`AWAIT_REL` there). */
const DEPLOY_POLLER = ".agents/deploy/await-deploy-run.sh";
const EXCLUDE_SEGMENTS = ["references", "tests", "templates", "node_modules"];
const SCRIPT_EXTS = ["sh", "ts", "mjs", "js", "py"];
const TEST_EXTS = ["sh", "ts"];

/** Thrown to end the run with a code from deep inside a scan. */
class Exit extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`exit ${code}`);
    this.code = code;
  }
}

function err(msg: string): void {
  process.stderr.write(`${msg}\n`);
}

function die(msg: string): never {
  err(msg);
  throw new Exit(2);
}

function scriptRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/** `[[ -f p ]]`: a regular file, symlinks followed. */
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `[[ -d p ]]`: a directory, symlinks followed. */
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function inRoots(p: string): boolean {
  return ROOTS.some((r) => p.startsWith(`${r}/`));
}

function excludedSegment(p: string): boolean {
  return EXCLUDE_SEGMENTS.some((s) => `/${p}/`.includes(`/${s}/`));
}

function inScriptDir(p: string): boolean {
  return SCRIPT_DIRS.includes(basename(dirname(p)));
}

/** The first two bytes, or what precedes the first newline within them —
 *  `read -n 2` stops at the delimiter. Empty when the file cannot be read. */
function firstTwo(p: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(2);
    const n = readSync(fd, buf, 0, 2, 0);
    const s = buf.subarray(0, n).toString("latin1");
    const nl = s.indexOf("\n");
    return nl === -1 ? s : s.slice(0, nl);
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The definition in the header. Reads the first line for the shebang, so the
 *  file has to be on disk. */
function isScript(p: string): boolean {
  const b = basename(p);
  if (!inRoots(p)) return false;
  if (excludedSegment(p)) return false;
  if (b.includes(".test.") || b.includes(".template.")) return false;
  if (b.endsWith(".sh")) return true;
  if (b.endsWith(".ts") || b.endsWith(".mjs") || b.endsWith(".js") || b.endsWith(".py")) {
    if (!isFile(p)) return false;
    if (firstTwo(p) === "#!") return true;
    return inScriptDir(p);
  }
  return false;
}

/** C-locale byte order, which is what `sort` gives under C.UTF-8. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Every script under ROOTS, sorted. `find` rather than `git ls-files` so a
 *  script that appeared since the last commit counts. A `find` that fails is a
 *  caller error, not an empty universe. */
function everyScript(): string[] {
  const prune: string[] = [];
  for (const s of EXCLUDE_SEGMENTS) prune.push("-o", "-name", s);
  const listing: string[] = [];
  for (const r of ROOTS) {
    if (!isDir(r)) continue;
    const res = spawnSync(
      "find",
      [
        r,
        "(",
        "-type",
        "d",
        "(",
        "-false",
        ...prune,
        ")",
        "-prune",
        ")",
        "-o",
        "-type",
        "f",
        "(",
        "-name",
        "*.sh",
        "-o",
        "-name",
        "*.ts",
        "-o",
        "-name",
        "*.mjs",
        "-o",
        "-name",
        "*.js",
        "-o",
        "-name",
        "*.py",
        ")",
        "-print",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 256 * 1024 * 1024 },
    );
    if (res.status !== 0) die(`check-scripts: find failed under ${r}`);
    for (const line of res.stdout.split("\n")) if (line !== "") listing.push(line);
  }
  listing.sort(byteCompare);
  return listing.filter(isScript);
}

let universeCache: string[] | undefined;
function universe(): string[] {
  if (universeCache === undefined) universeCache = everyScript();
  return universeCache;
}

/** `${b%.*}` */
function stemOf(p: string): string {
  const b = basename(p);
  const i = b.lastIndexOf(".");
  return i === -1 ? b : b.slice(0, i);
}

/** Every paired test's path, in the three shapes. Part (a) needs one; part (b)
 *  reads them all, because a program with a clean `.test.sh` beside an
 *  importing `.test.ts` is still imported. */
function findTests(p: string): string[] {
  const d = dirname(p);
  const stem = stemOf(p);
  const found: string[] = [];
  for (const c of [`${d}/${stem}`, `${d}/tests/${stem}`, `${dirname(d)}/tests/${stem}`]) {
    for (const e of TEST_EXTS) {
      if (isFile(`${c}.test.${e}`)) found.push(`${c.startsWith("./") ? c.slice(2) : c}.test.${e}`);
    }
  }
  return found;
}

/** The subdirectories `"$parent"/*\/` expands to: not hidden, glob-sorted,
 *  symlinks to folders included. */
function subdirs(parent: string): string[] {
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  return names
    .filter((n) => !n.startsWith(".") && isDir(`${parent}/${n}`))
    .sort(byteCompare)
    .map((n) => `${parent}/${n}`);
}

/** The scripts this test pairs with (usually one), so a changed or deleted
 *  test selects its subject. */
function subjectsOfTest(t: string): string[] {
  const d = dirname(t);
  const b = basename(t);
  const stem = b.slice(0, b.indexOf(".test."));
  // findTests' three shapes, inverted: a test beside its script; in the
  // script's tests/ (script in the parent); in the tests/ beside the script's
  // folder (script in any sibling folder of this tests/).
  const dirs = [d];
  if (basename(d) === "tests") {
    const parent = dirname(d);
    dirs.push(parent);
    for (const sib of subdirs(parent)) if (sib !== d) dirs.push(sib);
  }
  const subjects: string[] = [];
  for (const c of dirs) {
    for (const e of SCRIPT_EXTS) {
      const cand = `${c}/${stem}.${e}`;
      if (isFile(cand) && isScript(cand)) subjects.push(cand);
    }
  }
  return subjects;
}

// ── Imports ──────────────────────────────────────────────────────────────

/** `realpath -m`: symlinks resolved component by component, `..` applied
 *  after, missing components allowed. */
const realCache = new Map<string, string>();
function realpathM(p: string): string {
  const abs = isAbsolute(p) ? p : `${process.cwd()}/${p}`;
  const hit = realCache.get(abs);
  if (hit !== undefined) return hit;
  const queue = abs.split("/");
  let out = "";
  let links = 0;
  while (queue.length > 0) {
    const c = queue.shift() ?? "";
    if (c === "" || c === ".") continue;
    if (c === "..") {
      out = out.slice(0, Math.max(0, out.lastIndexOf("/")));
      continue;
    }
    const next = `${out}/${c}`;
    let link: string | undefined;
    try {
      if (lstatSync(next).isSymbolicLink() && links < 40) link = readlinkSync(next);
    } catch {
      link = undefined;
    }
    if (link === undefined) {
      out = next;
      continue;
    }
    links += 1;
    if (link.startsWith("/")) out = "";
    queue.unshift(...link.split("/"));
  }
  const real = out === "" ? "/" : out;
  realCache.set(abs, real);
  return real;
}

/** The literal text after the last run-time part of a shell path. Each `$(…)`
 *  and `${…}` is skipped whole, and inside one, quotes and further
 *  substitutions are skipped with their own scope, so a `)` in `tr -d ")"` or
 *  in a folder's own name never ends anything early. `$NAME` and backtick spans
 *  are run-time too. Quotes outside every substitution are dropped. */
function literalTail(s: string): string {
  const n = s.length;
  let pos = 0;
  const at = (i: number): string => s.charAt(i);
  const opensSubst = (i: number): boolean => at(i) === "$" && (at(i + 1) === "(" || at(i + 1) === "{");
  const backtick = (): void => {
    pos += 1;
    while (pos < n && at(pos) !== "`") pos += 1;
    pos += 1;
  };
  const dquote = (): void => {
    while (pos < n) {
      const c = at(pos);
      if (c === "\\") {
        pos += 2;
      } else if (c === '"') {
        pos += 1;
        return;
      } else if (opensSubst(pos)) {
        pos += 2;
        subst(at(pos - 1));
      } else if (c === "`") {
        backtick();
      } else {
        pos += 1;
      }
    }
  };
  const subst = (open: string): void => {
    const close = open === "{" ? "}" : ")";
    let depth = 1;
    while (pos < n) {
      const c = at(pos);
      if (c === "'") {
        pos += 1;
        while (pos < n && at(pos) !== "'") pos += 1;
        pos += 1;
      } else if (c === '"') {
        pos += 1;
        dquote();
      } else if (c === "\\") {
        pos += 2;
      } else if (opensSubst(pos)) {
        pos += 2;
        subst(at(pos - 1));
      } else if (c === "`") {
        backtick();
      } else if (c === open) {
        depth += 1;
        pos += 1;
      } else if (c === close) {
        depth -= 1;
        pos += 1;
        if (depth === 0) return;
      } else {
        pos += 1;
      }
    }
  };
  let tail = "";
  while (pos < n) {
    const c = at(pos);
    if (opensSubst(pos)) {
      pos += 2;
      subst(at(pos - 1));
      tail = "";
    } else if (c === "$") {
      pos += 1;
      while (pos < n && /[A-Za-z0-9_]/.test(at(pos))) pos += 1;
      tail = "";
    } else if (c === "`") {
      backtick();
      tail = "";
    } else {
      if (c !== '"' && c !== "'") tail += c;
      pos += 1;
    }
  }
  return tail;
}

/** Does this specifier, read from <importer>, name the subject (given as its
 *  `realpath -m`)? Run-time-built shell paths (anything holding `$` or a
 *  backtick) resolve by proximity: the importer sits in the subject's folder
 *  or one below it. */
function resolvesTo(importer: string, spec: string, subject: string): boolean {
  const idir = dirname(importer);
  const sdir = dirname(subject);
  if (spec.includes("$") || spec.includes("`")) {
    const ireal = realpathM(idir);
    // The literal tail after the last run-time part (`/../scripts/x.sh` of
    // `$HERE/../scripts/x.sh`). A tail with folders in it names where it
    // points, read from the importer's folder; only a bare `/x.sh` is left to
    // proximity.
    let tail = literalTail(spec);
    if (tail.startsWith("/")) tail = tail.slice(1);
    if (tail.includes("/")) return realpathM(`${ireal}/${tail}`) === subject;
    if (ireal === sdir) return true;
    if (dirname(ireal) === sdir && basename(ireal) === "tests") return true;
    // the tests/ beside the subject's folder (`$HERE/../scripts/x.sh`)
    if (basename(ireal) === "tests" && dirname(ireal) === dirname(sdir)) return true;
    return false;
  }
  if (spec.startsWith("/")) return realpathM(spec) === subject;
  return realpathM(`${idir}/${spec}`) === subject;
}

const textCache = new Map<string, string | null>();
/** A file's text, or null when it cannot be read (grep's `2>/dev/null`). */
function readText(p: string): string | null {
  let t = textCache.get(p);
  if (t === undefined) {
    try {
      t = readFileSync(p, "utf8");
    } catch {
      t = null;
    }
    textCache.set(p, t);
  }
  return t;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// [[:space:]] within one line.
const SP = "[ \\t\\v\\f\\r]";
// `s`: bash's `.` also matches a carriage return, which JS's does not by default.
const SOURCE_LINE = new RegExp(`^${SP}*(source|\\.)${SP}+(.*)$`, "s");
const COMMENT_LINE = new RegExp(`^${SP}*(//|/\\*|\\*)`);

function sourcePattern(stem: string): RegExp {
  return new RegExp(`^${SP}*(source|\\.)${SP}+.*${escapeRe(stem)}\\.sh`, "s");
}
function fromPattern(stem: string, flags = ""): RegExp {
  return new RegExp(`from${SP}+["'][^"']*${escapeRe(stem)}\\.(ts|mjs|js)["']`, flags);
}

/** Does <file> import or source <subject>? Only `from "…"` and a leading
 *  `source`/`.` count; a comment naming the file matches neither. */
function importsSubject(file: string, subject: string): boolean {
  // A file that cannot be read cannot be cleared: stop, never read it as clean.
  try {
    accessSync(file, constants.R_OK);
  } catch {
    die(`check-scripts: cannot read ${file}`);
  }
  const stem = stemOf(subject);
  const sreal = realpathM(subject);
  const text = readText(file);
  if (text === null) return false;
  if (subject.endsWith(".sh")) {
    if (!text.includes(`${stem}.sh`)) return false;
    const grep = sourcePattern(stem);
    for (const line of text.split("\n")) {
      if (!grep.test(line)) continue;
      const m = SOURCE_LINE.exec(line);
      if (m === null) continue;
      // The path is everything up to the first `;`, `&&` or `||`; quotes
      // come off after, so a `$(dirname "$0")/x.sh` keeps its inner quotes.
      let spec = m[2] ?? "";
      for (const cut of [";", "&&", "||"]) {
        const i = spec.indexOf(cut);
        if (i !== -1) spec = spec.slice(0, i);
      }
      spec = spec.replace(/[ \t\n\v\f\r]+$/, "");
      if (spec.endsWith('"')) spec = spec.slice(0, -1);
      if (spec.startsWith('"')) spec = spec.slice(1);
      if (spec.endsWith("'")) spec = spec.slice(0, -1);
      if (spec.startsWith("'")) spec = spec.slice(1);
      if (!spec.includes(`${stem}.sh`)) continue;
      if (resolvesTo(file, spec, sreal)) return true;
    }
    return false;
  }
  // Comment lines (`//`, `/*`, ` *`) are dropped before the match: a test
  // that says it "used to `import … from "./x.ts"`" is not importing.
  if (!text.includes(stem)) return false;
  const from = fromPattern(stem, "g");
  const head = new RegExp(`^from${SP}+["']`);
  for (const line of text.split("\n")) {
    if (COMMENT_LINE.test(line)) continue;
    for (const m of line.matchAll(from)) {
      const spec = m[0].replace(head, "").replace(/["']$/, "");
      if (resolvesTo(file, spec, sreal)) return true;
    }
  }
  return false;
}

/** Every file `grep -r --exclude='*.test.*' --exclude-dir=node_modules` reads
 *  under the roots: symlinks below a root are not followed. */
let libraryPoolCache: string[] | undefined;
function libraryPool(): string[] {
  if (libraryPoolCache !== undefined) return libraryPoolCache;
  const pool: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(p);
      } else if (e.isFile() && !e.name.includes(".test.")) {
        pool.push(p);
      }
    }
  };
  for (const r of ROOTS) if (isDir(r)) walk(r);
  libraryPoolCache = pool;
  return pool;
}

/** Does a non-test file under the roots import or source <subject>? One scan
 *  of the roots for the stem, then each candidate resolved. */
function isLibrary(subject: string): boolean {
  const stem = stemOf(subject);
  const isSh = subject.endsWith(".sh");
  const needle = isSh ? `${stem}.sh` : stem;
  const pat = isSh ? sourcePattern(stem) : fromPattern(stem);
  for (const cand of libraryPool()) {
    if (cand === subject) continue;
    const text = readText(cand);
    if (text === null || !text.includes(needle)) continue;
    if (!text.split("\n").some((line) => pat.test(line))) continue;
    if (importsSubject(cand, subject)) return true;
  }
  return false;
}

// ── Parts ────────────────────────────────────────────────────────────────

let violations = 0;
function violation(p: string, part: string, what: string): void {
  violations += 1;
  err(`${p}: (${part}) ${what}`);
}

/** POSIX `cksum` of a file as `<CRC> <byte count>`, the form the installer
 *  records. Computed here rather than spawned, so it reads the same on macOS. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i << 24;
    for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function cksum(buf: Buffer): string {
  let crc = 0;
  const step = (b: number): void => {
    crc = ((crc << 8) ^ (CRC_TABLE[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0;
  };
  for (const b of buf) step(b);
  for (let len = buf.length; len > 0; len = Math.floor(len / 256)) step(len & 0xff);
  return `${(~crc) >>> 0} ${buf.length}`;
}

/** Contextium installed it and it is unchanged since: its folder's manifest
 *  lists it with the checksum it still has. */
function shipped(p: string): boolean {
  const item = p.replace(/^\.agents\//, "").split("/")[0] ?? "";
  const manifest = `.agents/${item}/.contextium-manifest`;
  if (!isFile(manifest)) return false;
  const text = readText(manifest);
  if (text === null) return false;
  let want = "";
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab !== -1 && line.slice(0, tab) === p) {
      want = line.slice(tab + 1).split("\t")[0] ?? "";
      break;
    }
  }
  if (want === "") return false;
  try {
    return cksum(readFileSync(p)) === want;
  } catch {
    return false;
  }
}

function partA(p: string): boolean {
  if (findTests(p).length > 0) return true;
  if (shipped(p)) return true;
  const stem = stemOf(p);
  violation(p, "a", `no test — expected ${stem}.test.ts beside it, or tests/${stem}.test.ts in its folder or parent`);
  return false;
}

function partB(p: string): void {
  let library: boolean | undefined;
  for (const t of findTests(p)) {
    if (!importsSubject(t, p)) continue;
    if (library === undefined) library = isLibrary(p);
    if (library) return;
    violation(t, "b", `imports its subject ${p} — run it as a subprocess`);
  }
}

// ── Part (c): the language, and the bash tier ────────────────────────────

/** Every file of the worktree a commit could carry: tracked, plus untracked and
 *  not ignored (land.ts runs this before its `git add -A`), still on disk,
 *  outside `node_modules/`. A listing that fails is a caller error. */
function worktreeFiles(): string[] {
  const r = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], false);
  if (!r.ok) die("check-scripts: git ls-files failed");
  const files = new Set<string>();
  for (const p of r.out.split("\0")) {
    if (p === "" || `/${p}/`.includes("/node_modules/")) continue;
    if (isFile(p)) files.add(p);
  }
  return [...files].sort(byteCompare);
}

/** Two copies of a shell file's text, each the same length as the text so an
 *  offset in one is the same place in the other. In `code`, comments and
 *  heredoc bodies are blanked and the inside of every quoted string is masked
 *  with `_` — except a `$( … )` inside double quotes, which is a command and is
 *  kept. In `bare`, only comments are blanked. A backslash-newline is a space
 *  in both, so a continued command reads as one line. */
function shellText(text: string): { code: string; bare: string } {
  const n = text.length;
  const code = text.split("");
  const bare = text.split("");
  let i = 0;
  const heredocs: { delim: string; strip: boolean }[] = [];
  const mask = (from: number, to: number, ch: string, both: boolean): void => {
    for (let k = from; k < to && k < n; k++) {
      if (code[k] === "\n") continue;
      code[k] = ch;
      if (both) bare[k] = ch;
    }
  };
  const wordStart = (k: number): boolean => k === 0 || /[\s;&|()<>]/.test(text.charAt(k - 1));
  const backtick = (): void => {
    while (i < n && text.charAt(i) !== "`") i += text.charAt(i) === "\\" ? 2 : 1;
    i += 1;
  };
  // At the newline that ends a line holding `<<DELIM`, the body runs to the
  // line that is the delimiter. It is data: blanked in `code`, kept in `bare`
  // (a provisioner's `ssh host bash <<EOF` body is where its apt-get is).
  const bodies = (): void => {
    for (const { delim, strip } of heredocs.splice(0)) {
      while (i < n) {
        const e = text.indexOf("\n", i);
        const end = e === -1 ? n : e;
        const line = text.slice(i, end);
        mask(i, end, " ", false);
        i = end + 1;
        if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
      }
    }
  };
  const dquote = (): void => {
    let run = i;
    while (i < n) {
      const c = text.charAt(i);
      if (c === "\\") {
        i += 2;
      } else if (c === '"') {
        mask(run, i, "_", false);
        i += 1;
        return;
      } else if (c === "$" && text.charAt(i + 1) === "(") {
        mask(run, i, "_", false);
        i += 2;
        normal(true);
        run = i;
      } else if (c === "`") {
        mask(run, i, "_", false);
        i += 1;
        backtick();
        run = i;
      } else {
        i += 1;
      }
    }
    mask(run, i, "_", false);
  };
  // Code until the end of the text, or — inside a `$(` — the `)` closing it.
  const normal = (inSubst: boolean): void => {
    let depth = 0;
    while (i < n) {
      const c = text.charAt(i);
      if (c === "\n") {
        i += 1;
        if (heredocs.length > 0) bodies();
      } else if (c === "\\") {
        if (text.charAt(i + 1) === "\n") {
          code[i] = " ";
          bare[i] = " ";
          code[i + 1] = " ";
          bare[i + 1] = " ";
        }
        i += 2;
      } else if (c === "#" && wordStart(i)) {
        const e = text.indexOf("\n", i);
        const end = e === -1 ? n : e;
        mask(i, end, " ", true);
        i = end;
      } else if (c === "'" || (c === "$" && text.charAt(i + 1) === "'")) {
        const ansi = c === "$";
        i += ansi ? 2 : 1;
        const start = i;
        while (i < n && text.charAt(i) !== "'") i += ansi && text.charAt(i) === "\\" ? 2 : 1;
        mask(start, i, "_", false);
        i += 1;
      } else if (c === '"') {
        i += 1;
        dquote();
      } else if (c === "`") {
        i += 1;
        backtick();
      } else if (c === "<" && text.charAt(i + 1) === "<" && text.charAt(i + 2) !== "<") {
        const m = /^<<(-?)[ \t]*(['"]?)\\?([A-Za-z_][A-Za-z0-9_]*)\2/.exec(text.slice(i, i + 80));
        if (m !== null) {
          heredocs.push({ delim: m[3] ?? "", strip: m[1] === "-" });
          i += m[0].length;
        } else {
          i += 2;
        }
      } else if (c === "(") {
        depth += 1;
        i += 1;
      } else if (c === ")") {
        i += 1;
        if (inSubst && depth === 0) return;
        depth = Math.max(0, depth - 1);
      } else {
        i += 1;
      }
    }
  };
  normal(false);
  return { code: code.join(""), bare: bare.join("") };
}

/** One shell word from offset <i>: up to unquoted whitespace or an operator,
 *  quotes and `$( … )` / `${ … }` taken whole. */
function shellWord(s: string, i: number): string {
  const n = s.length;
  const skipDquote = (j: number): number => {
    while (j < n) {
      const c = s.charAt(j);
      if (c === "\\") j += 2;
      else if (c === '"') return j + 1;
      else if (c === "$" && (s.charAt(j + 1) === "(" || s.charAt(j + 1) === "{")) j = skipGroup(j + 1);
      else j += 1;
    }
    return j;
  };
  const skipGroup = (j: number): number => {
    const open = s.charAt(j);
    const close = open === "{" ? "}" : ")";
    let depth = 0;
    while (j < n) {
      const c = s.charAt(j);
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "'") {
        j = s.indexOf("'", j + 1);
        j = j === -1 ? n : j + 1;
        continue;
      }
      if (c === '"') {
        j = skipDquote(j + 1);
        continue;
      }
      if (c === open) depth += 1;
      if (c === close) {
        depth -= 1;
        if (depth === 0) return j + 1;
      }
      j += 1;
    }
    return j;
  };
  let j = i;
  while (j < n) {
    const c = s.charAt(j);
    if (/[ \t\n;&|<>)]/.test(c)) break;
    if (c === "\\") j += 2;
    else if (c === "'") {
      const e = s.indexOf("'", j + 1);
      j = e === -1 ? n : e + 1;
    } else if (c === '"') j = skipDquote(j + 1);
    else if (c === "$" && (s.charAt(j + 1) === "(" || s.charAt(j + 1) === "{")) j = skipGroup(j + 1);
    else j += 1;
  }
  return s.slice(i, j);
}

/** `"x"` → `x`, `'x'` → `x`: one layer of quotes around a whole word. */
function unquote(w: string): string {
  if (w.length >= 2 && (w[0] === '"' || w[0] === "'") && w.at(-1) === w[0]) return w.slice(1, -1);
  return w;
}

const LINE_START = "(?:^|[;&|({!`]|\\bthen|\\bdo|\\belse)[ \\t]*";
// `git`, its global options (`-C <dir>`, `-c k=v`, `--no-pager`…), then the verb.
const GIT_HEAD = "(?:^|[\\s;&|(`])git((?:[ \\t]+(?:-[Cc][ \\t]+\\S+|--?[A-Za-z][\\w-]*(?:=\\S+)?))*)[ \\t]+";
const MAKES_TREE = new RegExp(`${GIT_HEAD}(?:worktree[ \\t]+add|clone)(?=[ \\t;&|)]|$)`, "m");
const RESETS = new RegExp(`${GIT_HEAD}reset\\b([^\\n;&|]*)`, "gm");
const APT_INSTALL = /(?:^|[\s;&|(`'"])(?:sudo[ \t]+)?apt(?:-get)?[ \t]+(?:-\S+[ \t]+)*install\b/m;
const RUNS_SSH = /(?:^|[\s;&|(`])ssh(?=[ \t]|$)/m;
const SOURCE_AT = new RegExp(`${LINE_START}(?:source|\\.)[ \\t]+`, "gm");
// An assignment at a command position — a line start, or after `;`, `&&`,
// `then`… — so `LIB=b.sh; . "$LIB"` sees the assignment before it on its line.
const ASSIGN_AT = new RegExp(
  `${LINE_START}(?:(?:export|local|readonly|declare(?:[ \\t]+-[A-Za-z]+)*)[ \\t]+)?([A-Za-z_][A-Za-z0-9_]*)=`,
  "gm",
);

interface ShellFacts {
  /** a bootstrap shape: makes a worktree or a clone, resets another tree, provisions a host */
  bootstrap: boolean;
  /** each `source`/`.` line: its offset, 1-based line number and raw path word */
  sources: { at: number; line: number; word: string }[];
  /** each same-file assignment: name → [offset, value] in file order */
  assigns: Map<string, { at: number; value: string }[]>;
}

const factsCache = new Map<string, ShellFacts>();
function shellFacts(p: string): ShellFacts {
  const hit = factsCache.get(p);
  if (hit !== undefined) return hit;
  const { code, bare } = shellText(readText(p) ?? "");
  const lineAt = (off: number): number => {
    let line = 1;
    for (let k = code.indexOf("\n"); k !== -1 && k < off; k = code.indexOf("\n", k + 1)) line += 1;
    return line;
  };
  let resets = false;
  for (const m of code.matchAll(RESETS)) {
    if (/(?:^|[ \t])-C[ \t]/.test(m[1] ?? "") && /(?:^|[ \t])--hard\b/.test(m[2] ?? "")) resets = true;
  }
  const bootstrap = MAKES_TREE.test(code) || resets || (APT_INSTALL.test(bare) && RUNS_SSH.test(code));
  const sources: ShellFacts["sources"] = [];
  for (const m of code.matchAll(SOURCE_AT)) {
    const at = (m.index ?? 0) + m[0].length;
    const word = shellWord(bare, at);
    if (word !== "") sources.push({ at, line: lineAt(at), word });
  }
  const assigns: ShellFacts["assigns"] = new Map();
  for (const m of bare.matchAll(ASSIGN_AT)) {
    const name = m[1] ?? "";
    const at = (m.index ?? 0) + m[0].length;
    // An assignment inside a heredoc body or a string is data, not this file's.
    if (code.slice(at - name.length - 1, at) !== `${name}=`) continue;
    const list = assigns.get(name) ?? [];
    list.push({ at, value: unquote(shellWord(bare, at)) });
    assigns.set(name, list);
  }
  const facts = { bootstrap, sources, assigns };
  factsCache.set(p, facts);
  return facts;
}

const VAR_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** <word> with each `$NAME` / `${NAME}` replaced by NAME's assignment in the
 *  same file — the last one before offset <at>, else the first anywhere —
 *  whose own value is expanded the same way at THAT assignment's offset, as
 *  the shell expanded it when the assignment ran, so a variable built from
 *  another resolves and a later reassignment of the inner one does not move
 *  it. Eight levels deep at most, so a name assigned from itself ends. A name
 *  with no assignment stays, and `unassigned` says so. */
function expandVars(
  word: string,
  at: number,
  assigns: ShellFacts["assigns"],
): { expanded: string; unassigned: boolean } {
  const expand = (w: string, off: number, depth: number): string =>
    depth >= 8
      ? w
      : w.replace(VAR_REF, (whole, a: string | undefined, b: string | undefined) => {
          const list = assigns.get(a ?? b ?? "");
          if (list === undefined) return whole;
          const hit = list.filter((x) => x.at < off).at(-1) ?? list[0];
          return hit === undefined ? whole : expand(hit.value, hit.at, depth + 1);
        });
  const out = expand(word, at, 0);
  // `$0` and `${BASH_SOURCE[0]}` are the file's own path and never assigned;
  // any other name still here has no value this file gives it.
  return { expanded: out, unassigned: [...out.matchAll(VAR_REF)].length > 0 };
}

type SourceTarget = { kind: "file"; path: string } | { kind: "ts"; path: string } | { kind: "unresolvable" };

/** Where a tier file's `source <word>` at offset <at> points. A path holding a
 *  variable the file never assigns is unresolvable, whatever its tail names.
 *  Otherwise a run-time prefix (`$(dirname "$0")`, a `HOOK_DIR` built from it)
 *  is the file's own folder in every form the repo uses, so the literal tail
 *  after it is read from that folder, then from the repo root. A literal
 *  relative path is read the way the shell reads it — from the working
 *  directory, the repo root when the harness runs a hook — and only then from
 *  the file's folder. */
function sourceTarget(file: string, word: string, at: number): SourceTarget {
  const { expanded, unassigned } = expandVars(word, at, shellFacts(file).assigns);
  if (unassigned) return { kind: "unresolvable" };
  const runtime = /[$`]/.test(expanded);
  const tail = runtime ? literalTail(expanded) : unquote(expanded).replace(/["']/g, "");
  if (tail === "" || tail.endsWith("/")) return { kind: "unresolvable" };
  if (tail.endsWith(".ts")) return { kind: "ts", path: tail };
  const cands: string[] = [];
  if (!runtime && tail.startsWith("/")) {
    cands.push(tail);
  } else if (!runtime) {
    cands.push(normalize(tail), normalize(join(dirname(file), tail)));
  } else {
    const rel = tail.replace(/^\/+/, "");
    cands.push(normalize(join(dirname(file), rel)), normalize(rel));
  }
  for (const c of cands) if (isFile(c)) return { kind: "file", path: c };
  return { kind: "unresolvable" };
}

/** The index of the `)` closing the `(` at <open>, quotes, escapes, nested
 *  substitutions and backticks respected; the text's length when unclosed. */
function closeParen(s: string, open: number): number {
  let depth = 1;
  let q = "";
  for (let k = open + 1; k < s.length; k++) {
    const c = s.charAt(k);
    if (q === "'") {
      if (c === "'") q = "";
    } else if (c === "\\") {
      k += 1;
    } else if (q === '"') {
      if (c === '"') q = "";
      else if (c === "$" && s.charAt(k + 1) === "(") k = closeParen(s, k + 1);
      else if (c === "`") k = closeBacktick(s, k + 1);
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (c === "`") {
      k = closeBacktick(s, k + 1);
    } else if (c === "(") {
      depth += 1;
    } else if (c === ")") {
      depth -= 1;
      if (depth === 0) return k;
    }
  }
  return s.length;
}

/** The index of the backtick closing one opened just before <from>. */
function closeBacktick(s: string, from: number): number {
  for (let k = from; k < s.length; k++) {
    if (s.charAt(k) === "\\") k += 1;
    else if (s.charAt(k) === "`") return k;
  }
  return s.length;
}

/** One pass over a shell command: where its top-level `;`, `&`, `|` and
 *  newlines are, and the body of each top-level `$( … )` or backtick
 *  substitution — outside single quotes and not escaped, inside double quotes
 *  included, because there it still runs. */
function scanShell(s: string): { seps: number[]; subs: { at: number; body: string }[] } {
  const seps: number[] = [];
  const subs: { at: number; body: string }[] = [];
  let q = "";
  for (let k = 0; k < s.length; k++) {
    const c = s.charAt(k);
    if (q === "'") {
      if (c === "'") q = "";
    } else if (c === "\\") {
      k += 1;
    } else if (c === '"') {
      q = q === '"' ? "" : '"';
    } else if (c === "'" && q === "") {
      q = "'";
    } else if (c === "`") {
      const e = closeBacktick(s, k + 1);
      subs.push({ at: k, body: s.slice(k + 1, e) });
      k = e;
    } else if (c === "$" && s.charAt(k + 1) === "(") {
      const e = closeParen(s, k + 1);
      subs.push({ at: k, body: s.slice(k + 2, e) });
      k = e;
    } else if (q === "" && /[;&|\n]/.test(c)) {
      seps.push(k);
    }
  }
  return { seps, subs };
}

/** <s> with each comment blanked to spaces, offsets kept: a `#` that starts a
 *  word outside quotes runs to the end of its line. Substitutions are stepped
 *  over whole. */
function blankComments(s: string): string {
  const out = s.split("");
  let q = "";
  for (let k = 0; k < s.length; k++) {
    const c = s.charAt(k);
    if (q === "'") {
      if (c === "'") q = "";
    } else if (c === "\\") {
      k += 1;
    } else if (c === '"') {
      q = q === '"' ? "" : '"';
    } else if (q === '"') {
      if (c === "$" && s.charAt(k + 1) === "(") k = closeParen(s, k + 1);
      else if (c === "`") k = closeBacktick(s, k + 1);
    } else if (c === "'") {
      q = "'";
    } else if (c === "`") {
      k = closeBacktick(s, k + 1);
    } else if (c === "$" && s.charAt(k + 1) === "(") {
      k = closeParen(s, k + 1);
    } else if (c === "#" && (k === 0 || /[\s;&|(]/.test(s.charAt(k - 1)))) {
      while (k < s.length && s.charAt(k) !== "\n") out[k++] = " ";
      k -= 1;
    }
  }
  return out.join("");
}

/** What in a shell command runs. Comments go first. Each top-level command is
 *  kept unless it only prints (`echo`, `printf`, `:`, after any `then`, `do`,
 *  `!`… in front of it); of a printing command only its substitutions run.
 *  Either way every substitution's body is read the same way, so an echo
 *  inside `x=$( … )` prints and runs nothing. */
function runnableText(raw: string): string {
  const cmd = blankComments(raw);
  const { seps, subs } = scanShell(cmd);
  const out: string[] = [];
  let from = 0;
  for (const to of [...seps, cmd.length]) {
    const seg = cmd.slice(from, to);
    const lead = seg.length - seg.trimStart().length;
    const bare = seg.trimStart().replace(/^(?:(?:then|do|else|elif|if|while|until|!|\{|\()[ \t]+)+/, "");
    const inside = subs.filter((sub) => sub.at >= from + lead && sub.at < to);
    if (/^(?:echo|printf|:)(?:[ \t]|$)/.test(bare)) {
      for (const sub of inside) out.push(runnableText(sub.body));
    } else {
      // The segment's own words, with each substitution swapped for what in it runs.
      let text = "";
      let at = from;
      for (const sub of inside) {
        text += `${cmd.slice(at, sub.at)}\n${runnableText(sub.body)}\n`;
        at = sub.at + (cmd.charAt(sub.at) === "`" ? sub.body.length + 2 : sub.body.length + 3);
      }
      out.push(text + cmd.slice(at, to));
    }
    from = to + 1;
  }
  return out.join("\n");
}

/** Every `command` string under a `hooks` key, at any depth. */
function hookCommands(node: unknown, underHooks: boolean, out: string[]): string[] {
  if (Array.isArray(node)) {
    for (const v of node) hookCommands(v, underHooks, out);
  } else if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (k === "command" && typeof v === "string" && underHooks) out.push(v);
      else hookCommands(v, underHooks || k === "hooks", out);
    }
  }
  return out;
}

/** The `.sh` files a JSON hook config names. A path in a command is read from
 *  the repo root, then from the config's folder (`bash ../.agents/hooks/x.sh`
 *  in `.agents/hooks.json`); a path that names neither — an installed layout
 *  such as `$d/.agents/hooks/x.sh` in a template repo — matches the bash file
 *  whose last two path parts it ends with. */
function hookFiles(files: string[], bash: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const cfg of files) {
    if (!cfg.endsWith(".json")) continue;
    const text = readText(cfg);
    if (text === null || !text.includes('"hooks"') || !text.includes('"command"')) continue;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      continue; // not a config any harness could load
    }
    for (const cmd of hookCommands(json, false, [])) {
      // `$d/h.sh` is the path `/h.sh` under a run-time folder, not `d/h.sh`;
      // and a path only printed (`echo "old.sh moved"`) is not a hook.
      const literal = runnableText(cmd).replace(/\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/g, " ");
      for (const m of literal.matchAll(/[A-Za-z0-9_./-]*[A-Za-z0-9_-]\.sh(?![A-Za-z0-9_])/g)) {
        const tok = m[0].replace(/^\/+/, "");
        const direct = [normalize(tok), normalize(join(dirname(cfg), tok))].find((c) => bash.has(c));
        if (direct !== undefined) {
          found.add(direct);
          continue;
        }
        const parts = tok.split("/");
        if (parts.length < 2) continue;
        const suffix = parts.slice(-2).join("/");
        for (const b of bash) if (b === suffix || b.endsWith(`/${suffix}`)) found.add(b);
      }
    }
  }
  return found;
}

/** The script a `curl … | bash` line in the repo's README installs: the bash
 *  file named by the URL's last segment (with or without `.sh`) whose path the
 *  URL ends with, else the one at the repo root (`contextium.ai/install`). */
function installerFiles(files: string[], bash: Set<string>): Set<string> {
  const found = new Set<string>();
  for (const readme of files) {
    if (!/^README(\.md)?$/i.test(readme)) continue;
    for (const line of (readText(readme) ?? "").split("\n")) {
      const m = /\bcurl\b([^|\n]*)\|[ \t]*(?:sudo[ \t]+)?(?:ba|z)?sh\b/.exec(line);
      if (m === null) continue;
      const url = (m[1] ?? "")
        .trim()
        .split(/[ \t]+/)
        .filter((t) => !t.startsWith("-") && /[./]/.test(t))
        .at(-1);
      if (url === undefined) continue;
      const segs = url
        .replace(/["'`]/g, "")
        .replace(/^[a-z]+:\/\//i, "")
        .split(/[?#]/)[0]
        ?.split("/")
        .filter(Boolean)
        .slice(1);
      const last = segs?.at(-1);
      if (segs === undefined || last === undefined) continue;
      const named = [...bash].filter((b) => basename(b) === last || basename(b) === `${last}.sh`);
      const urlPath = segs.join("/");
      const bySuffix = named.filter((b) => urlPath === b || urlPath.endsWith(`/${b}`));
      for (const b of bySuffix.length > 0 ? bySuffix : named.filter((b) => !b.includes("/"))) found.add(b);
    }
  }
  return found;
}

/** The first line of a file, up to 256 bytes. */
function firstLine(p: string): string {
  let fd: number | undefined;
  try {
    fd = openSync(p, "r");
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, 256, 0);
    return buf.subarray(0, n).toString("utf8").split("\n")[0] ?? "";
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** `#!/usr/bin/env node --experimental-strip-types` hands env ONE argument,
 *  `node --experimental-strip-types`, which names no program. A direct
 *  interpreter gets the rest of the line as one argument too, so
 *  `#!/usr/bin/node --experimental-strip-types` works and a second flag does not. */
function shebangNeedsS(p: string): boolean {
  const line = firstLine(p);
  if (!line.startsWith("#!")) return false;
  const words = line
    .slice(2)
    .trim()
    .split(/[ \t]+/);
  if (basename(words[0] ?? "") !== "env") return words.length > 2;
  if ((words[1] ?? "").startsWith("-S")) return false;
  return words.length > 2;
}

/** Part (c): the files under ROOTS in a language other than TypeScript or the
 *  bash tier, and every tier file under ROOTS whose `source` line breaks. */
function partC(): void {
  const files = worktreeFiles();
  const bash = new Set(files.filter((p) => p.endsWith(".sh")));
  const found: [string, string][] = [];
  const tier = new Set<string>([...hookFiles(files, bash), ...installerFiles(files, bash)]);
  // land.ts runs the opt-in deploy poller by this one name, `.sh` included.
  if (bash.has(DEPLOY_POLLER)) tier.add(DEPLOY_POLLER);
  for (const p of bash) if (shellFacts(p).bootstrap) tier.add(p);
  // The closure, over SOURCE edges only.
  const queue = [...tier];
  for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
    for (const { at, line, word } of shellFacts(p).sources) {
      const t = sourceTarget(p, word, at);
      if (t.kind === "ts") {
        if (inRoots(p)) found.push([p, `tier-1 bash sources a TypeScript file — line ${line}: ${word}`]);
      } else if (t.kind === "unresolvable") {
        if (inRoots(p)) found.push([p, `unresolvable source line — line ${line}: ${word}`]);
      } else if (bash.has(t.path) && !tier.has(t.path)) {
        tier.add(t.path);
        queue.push(t.path);
      }
    }
  }
  // Only files under ROOTS are judged; the rest of the worktree is read above
  // for the tier alone.
  for (const p of files.filter(inRoots)) {
    if (p.endsWith(".sh")) {
      if (!tier.has(p))
        found.push([p, "bash outside the hook/bootstrap tier — AGENTS.md § Standards → Scripts are TypeScript"]);
    } else if (/\.[mc]?js$/.test(p)) {
      found.push([p, "JavaScript — TypeScript everywhere"]);
    } else if (p.endsWith(".py")) {
      found.push([p, "Python — TypeScript everywhere"]);
    } else if (p.endsWith(".ts") && shebangNeedsS(p)) {
      found.push([p, "shebang needs env -S — `#!/usr/bin/env -S node --experimental-strip-types`"]);
    }
  }
  found.sort((a, b) => byteCompare(a[0], b[0]));
  for (const [p, what] of found) violation(p, "c", what);
}

// ── Modes ────────────────────────────────────────────────────────────────

function git(args: string[], quietErr: boolean): { ok: boolean; out: string } {
  const res = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", quietErr ? "ignore" : "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  });
  return { ok: res.status === 0, out: res.stdout ?? "" };
}

function toplevel(quietErr: boolean): string | undefined {
  const r = git(["rev-parse", "--show-toplevel"], quietErr);
  return r.ok ? r.out.replace(/\n$/, "") : undefined;
}

function chdirOrExit(dir: string): void {
  try {
    process.chdir(dir);
  } catch {
    throw new Exit(2);
  }
}

function run(argv: string[], targets: string[]): number {
  const seen = new Set<string>();
  const addTarget = (p: string): void => {
    if (seen.has(p)) return;
    seen.add(p);
    targets.push(p);
  };

  let mode: "changed" | "all" | "paths" = "changed";
  let since = "";
  const first = argv[0] ?? "";
  if (first === "--all") {
    if (argv.length !== 1) die("check-scripts: --all takes no paths");
    mode = "all";
  } else if (first === "--since") {
    if (!argv[1]) die("check-scripts: --since needs a ref");
    since = argv[1];
    if (argv.length !== 2) die("check-scripts: --since takes no paths");
  } else if (first.startsWith("-")) {
    die(`check-scripts: unknown option ${first}`);
  } else if (first !== "") {
    mode = "paths";
  }

  if (mode === "paths") {
    const repoRoot = toplevel(true) ?? scriptRoot();
    chdirOrExit(repoRoot);
    for (let arg of argv) {
      if (arg.startsWith(`${repoRoot}/`)) arg = arg.slice(repoRoot.length + 1);
      if (arg.startsWith("./")) arg = arg.slice(2);
      if (isDir(arg)) {
        for (const p of universe()) if (p.startsWith(`${arg}/`) || p === arg) addTarget(p);
      } else if (isFile(arg)) {
        if (isScript(arg)) addTarget(arg);
      } else {
        die(`check-scripts: no such file or directory: ${arg}`);
      }
    }
    for (const p of targets) if (partA(p)) partB(p);
  } else if (mode === "all") {
    chdirOrExit(toplevel(true) ?? scriptRoot());
    for (const p of universe()) addTarget(p);
    for (const p of targets) if (partA(p)) partB(p);
  } else {
    const repoRoot = toplevel(false);
    if (repoRoot === undefined) die("check-scripts: not inside a git work tree");
    chdirOrExit(repoRoot);
    let base = "HEAD";
    if (since !== "") {
      const mb = git(["merge-base", "HEAD", since], false);
      if (!mb.ok) die(`check-scripts: cannot find where HEAD left ${since}`);
      base = mb.out.replace(/\n$/, "");
    }
    // Tracked changes against the base plus untracked files, one per file.
    // `--no-renames` lists a move as its two halves; the half no longer on disk
    // is skipped as a subject, but as a TEST it still selects what it paired —
    // and a test under `tests/` is read BEFORE the excluded-segment rule, which
    // is about scripts, or deleting a script's only test there would pass.
    // Either listing failing is a caller error, never an empty change set.
    const diff = git(["diff", "-z", "--name-only", "--no-renames", base], false);
    if (!diff.ok) die(`check-scripts: git diff against ${base} failed`);
    const others = git(["ls-files", "-z", "--others", "--exclude-standard"], false);
    if (!others.ok) die("check-scripts: git ls-files failed");
    for (const path of `${diff.out}${others.out}`.split("\0")) {
      if (path === "" || !inRoots(path)) continue;
      if (basename(path).includes(".test.")) {
        for (const p of subjectsOfTest(path)) addTarget(p);
      } else {
        if (excludedSegment(path)) continue;
        if (!isFile(path)) continue;
        if (isScript(path)) addTarget(path);
      }
    }
    for (const p of targets) partA(p);
    // Part (b) over the whole universe: library status depends on files that
    // did not change, so the changed set cannot scope it.
    for (const p of universe()) partB(p);
  }

  // Part (c) in every mode: a file's tier can move when another file changes.
  partC();

  if (violations > 0) {
    process.stdout.write(`FAIL — ${targets.length} script(s) checked, ${violations} violation(s)\n`);
    return 1;
  }
  process.stdout.write(`OK — ${targets.length} script(s) checked\n`);
  return 0;
}

function main(): void {
  const targets: string[] = [];
  let code = 0;
  try {
    code = run(process.argv.slice(2), targets);
  } catch (e) {
    if (!(e instanceof Exit)) throw e;
    code = e.code;
  }
  process.exitCode = code;
}

if (
  process.argv[1] !== undefined &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main();
}
