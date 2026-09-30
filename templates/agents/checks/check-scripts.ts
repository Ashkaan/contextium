#!/usr/bin/env -S node --experimental-strip-types
// check-scripts.ts — hold every script under .agents/ (the skills, checks,
// generators and hooks) to "carries a test, and the test RUNS it", before a
// close commits it.
//
// WHY. A script with no test is changed blind, and a test that imports or
// sources its subject instead of running it breaks the day the program changes
// language, while a test that spawns it survives with the interpreter line
// changed. AGENTS.md § Standards "Tests and evals" states the rule; this
// program owns whether a given tree obeys it.
//
// WHAT IT CHECKS — each violation carries the letter of the part it breaks:
//   (a)  every script has a paired test: `<stem>.test.sh` or `<stem>.test.ts`
//        beside it, or `tests/<stem>.test.{sh,ts}` in its folder or its parent.
//        Any test extension pairs with any script extension. Whether the suite
//        asserts anything is the runner's and the reviewer's business, not
//        this check's — an empty test file passes.
//   (b)  when the script is a PROGRAM, its paired test does not import or
//        source the script's own path — it runs it as a subprocess. A LIBRARY
//        is exempt from (b) only: it is a file at least one non-test file
//        under the roots imports or sources, so there is no program to run and
//        the import IS how it is used. Library status is re-derived on every run, so
//        deleting a library's last importer turns its import test into a (b)
//        violation on the next scan, incremental included.
//
// WHAT IS A SCRIPT. Under ROOTS below: every `*.sh`; every `.ts`, `.mjs`, `.js`
// or `.py` whose first line starts `#!` or whose parent folder is one of
// SCRIPT_DIRS. Never a `*.test.*`, a `*.template.*`, or anything under a
// `references/`, `tests/`, `templates/` or `node_modules/` segment. Nothing
// else re-derives the definition. The bash scripts (the hooks, lock.sh, …)
// pair the same way as the TypeScript: `hooks/lib/paths.sh` is covered by
// `hooks/lib/paths.test.ts` beside it.
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
// disk is skipped. And part (b) over EVERY test in the universe whose text
// imports or sources its own subject, changed or not. With `--since <ref>` the
// same, measured from where this branch left <ref>: a script the session
// already COMMITTED differs from nothing at HEAD. `--all` runs both parts over
// every script under ROOTS; explicit paths run both parts over exactly those
// files, or every script beneath a directory argument.
//
// Usage:
//   check-scripts.ts                  scripts changed since HEAD
//   check-scripts.ts --since <ref>    …since this branch left <ref>
//   check-scripts.ts --all            every script under the roots
//   check-scripts.ts <path>...        those files / directories
//
// Output (stdout): exactly one line — `OK — N script(s) checked`, or
//   `FAIL — N script(s) checked, M violation(s)`. N is the number of scripts
//   part (a) was run over; a (b) violation found by the universe-wide pass in
//   an incremental scan does not add to it.
// Output (stderr): one line per violation, `<path>: (<part>) <what is wrong>`.
//
// peers:
//   AGENTS.md § Standards "Tests and evals"         (the rule this enforces)
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
import { basename, dirname, isAbsolute, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── The universe ─────────────────────────────────────────────────────────
const ROOTS = [".agents"];
const SCRIPT_DIRS = ["scripts", "checks", "deploy", "generators", "hooks"];
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
  violation(
    p,
    "a",
    `no test — expected ${stem}.test.sh or ${stem}.test.ts beside it, or tests/${stem}.test.* in its folder or parent`,
  );
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
