#!/usr/bin/env -S node --experimental-strip-types
// blast-radius.ts — the whole-repo context a reviewer cannot see in a diff.
//
// A diff shows what a file now says. It does not show who CALLS the function
// whose signature just moved, and that is the finding class an isolated review
// structurally cannot produce. Hosted review apps sell exactly that answer over
// a persistent index. This computes it per review from the
// working tree instead — no vendor, no index to go stale while you edit, and it
// reads the tree the session actually changed rather than the last push.
//
// It is CONTEXT, never a verdict. It has no pass and no fail: code-review.ts
// pastes its stdout into the prompt and reviews the diff either way. A packer
// that could block a review would be a seventh gate for a question ("who calls
// this?") whose answer is never by itself a defect.
//
// Usage:
//   blast-radius.ts [--repo DIR] [--diff-file PATH|-] [--old-ref REV]
//                   [--files-file PATH] [FILE...]
//
// Flags:
//   --repo DIR         repo to read (default: git toplevel of cwd)
//   --diff-file PATH   unified diff scoping the pack to CHANGED symbols; `-`
//                      reads stdin. Without one, every export in every listed
//                      file is treated as changed.
//   --old-ref REV      revision the diff's `-` side came from (default HEAD).
//                      Only used to fetch old bytes for deleted-export lookup.
//   --files-file PATH  newline-separated file list, merged with FILE args
//
// Output (stdout): a `BLAST RADIUS` block, or nothing at all. Per listed
// .ts/.tsx/.sh file that still exists, three independent sections — who imports
// it, what it imports that this change does not touch, and the callers of each
// changed symbol.
//
// Exit:
//   0  pack written (an EMPTY pack is a success — see the boundary table)
//   2  caller error: unreadable repo, unreadable --files-file / --diff-file
//
// Boundary inputs:
//   - 0 files / empty --files-file:  no output, exit 0
//   - 1 file, no exports, no importers: no output for it, exit 0
//   - every listed file deleted:     no output, exit 0
//   - a deleted file among live ones: skipped, the rest are packed
//   - no .ts/.tsx/.sh in the list:   no output, exit 0
//   - comment-or-whitespace-only diff: import graph still printed, no symbols
//   - identifier under 4 chars:      never a symbol (greps to noise)
//   - over the caps:                 truncated-symbols / truncated-callers /
//                                    truncated-bytes lines, pack still printed
//   - parser package missing:        WARN on stderr, regex symbols, graph intact
//   - repo is not a git repo:        exit 2
//
// CAPS, AND WHY THEY ARE THIS SCRIPT'S OWN. MAX_BYTES is 32KiB and is never
// taken out of code-review.ts's 400,000-byte MAX_DIFF_BYTES: sharing that budget
// would mean a large pack silently shrinking the DIFF, and a review of a
// truncated diff reported as clean is the failure that script exists to prevent.
// The pack is the part that gets dropped, because it is the optional part.
//
// IMPORT MATCHING IS BOUNDED, AND DIFFERENTLY PER LANGUAGE.
//   TypeScript is RESOLVED: candidates come from a basename grep over
//   `from '...'`, `import('...')` and `export ... from '...'`, and each
//   candidate's specifier is then resolved against the importing file's own
//   directory and compared to the target. `.js` specifiers match `.ts` sources.
//   Not attempted: tsconfig `paths`, package.json `exports`, computed
//   specifiers — a wrong resolution would name a file that does not import this
//   one at all.
//   Shell is BASENAME-TAILED: `. path` / `source path` specifiers in this repo
//   are routinely `"$SCRIPT_DIR/x.sh"`, so there is no literal path to resolve.
//   Matching the basename tail is the honest bound; it over-matches two
//   same-named scripts in different directories and says so here rather than
//   pretending to resolve a variable.
//
// Search population: git-tracked plus untracked-not-ignored files, via
// `git grep --untracked` — the same set code-review.ts puts in front of the
// reviewer, so the pack cannot cite a file the diff never showed — minus the
// records (knowledge/, journal/, projects/, which live in the same tree): a
// journal entry that quotes a symbol is prose about it, not a caller.
//
// peers:
//   .agents/skills/review/blast-radius-symbols.ts
//   .agents/skills/review/blast-radius.test.ts
//   .agents/skills/review/code-review.ts
//   .agents/skills/review/find-peers.ts
//
// A sourced shell specifier resolves to its literal target, with a missing one
// shown under "sources missing:" — see importsOf.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../packages/cli-exit/cli-exit.ts";

const err = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SYMBOLS_TS = path.join(SCRIPT_DIR, "blast-radius-symbols.ts");

// Deterministic ordering everywhere, so the same tree packs the same bytes:
// every sort below is by code point (what LC_ALL=C gave the bash), and every
// child runs under LC_ALL=C as the bash's exported one did.
const CHILD_ENV: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C" };
const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** `sort -u` under LC_ALL=C. */
const sortUnique = (xs: string[]): string[] => [...new Set(xs)].sort(byCodePoint);

// Every repo-wide grep below takes these after its `--`.
const RECORD_EXCLUDES = [":!knowledge", ":!journal", ":!projects/**/*.md"];

// POSIX `[[:space:]]`, which a JS `\s` is wider than.
const SP = "[\\t\\n\\v\\f\\r ]";

interface Proc {
  status: number;
  stdout: string;
}

/** A git read with stderr dropped (the bash's `2>/dev/null`), stdout as `$(…)` returns it. */
function git(args: string[]): Proc {
  const r = spawnSync("git", args, {
    encoding: "utf8",
    env: CHILD_ENV,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 1024 * 1024 * 1024,
  });
  return { status: r.status ?? 128, stdout: (r.stdout ?? "").replace(/\n+$/, "") };
}

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A file's lines as grep reads them: none for an unreadable file, no phantom last line. */
function fileLines(p: string): string[] {
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return [];
  }
  if (text === "") return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

// stdin is read once: a second `-` (both --files-file and --diff-file) gets
// what `cat` at end of input got — nothing.
let stdinTaken = false;
function readStdin(): string {
  if (stdinTaken) return "";
  stdinTaken = true;
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

// ── The import graph helpers ──────────────────────────────────────────

// Drop a CODE extension, and only a code extension, from a path's last
// component. The bash's `${p%.*}` could not do this job: `./a` has its only dot
// in the `./` prefix, so the parameter expansion returned the empty string and
// the importer comparison below silently matched nothing — `src/caller.ts` was
// invisible to the first version of this script. Directories with dots in their
// names (`v1.2/`) fail the same way.
function dropCodeExt(p: string): string {
  const dir = path.posix.dirname(p);
  let base = path.posix.basename(p);
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|bash)$/.test(base)) base = base.slice(0, base.lastIndexOf("."));
  return dir === "." ? base : `${dir}/${base}`;
}

// `realpath -m`: every component that exists has its symlinks resolved, the
// rest is taken lexically — the target need not exist on disk (a `.js`
// specifier naming a `.ts` source never does).
function canonicalizeMissing(p: string): string {
  let cur = "/";
  for (const comp of p.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (comp === "..") {
      cur = path.posix.dirname(cur);
      continue;
    }
    const cand = path.posix.join(cur, comp);
    try {
      cur = realpathSync(cand);
    } catch {
      cur = cand;
    }
  }
  return cur;
}

/**
 * Normalize a specifier against the importing file's directory. Returns a
 * repo-relative path with any code extension dropped, or "" when the specifier
 * escapes the repo or is absolute.
 */
function resolveSpec(repo: string, fromFile: string, spec: string): string {
  const resolved = resolveLiteral(repo, fromFile, spec);
  return resolved === "" ? "" : dropCodeExt(resolved);
}

// The repo-relative path `spec` names from `fromFile`, extension kept — what a
// shell `source` reads. "" for an absolute path or one outside the repo.
function resolveLiteral(repo: string, fromFile: string, spec: string): string {
  let joined: string;
  if (spec.startsWith("./") || spec.startsWith("../")) joined = `${path.posix.dirname(fromFile)}/${spec}`;
  else if (spec.startsWith("/")) return "";
  else joined = spec;
  // `realpath --relative-to` prints `.` for the directory itself.
  const resolved = path.posix.relative(canonicalizeMissing(repo), canonicalizeMissing(`${repo}/${joined}`)) || ".";
  if (resolved.startsWith("../")) return "";
  return resolved;
}

// Every TS/JS import specifier a file states, one per entry.
function tsSpecifiers(repo: string, file: string): string[] {
  const re = new RegExp(`(from|import|require)${SP}*\\(?${SP}*['"]([^'"]+)['"]`, "g");
  const out: string[] = [];
  for (const line of fileLines(`${repo}/${file}`)) {
    for (const m of line.matchAll(re)) out.push(m[2] ?? "");
  }
  return out;
}

// Every `.`/`source` target a shell script states.
function shSpecifiers(repo: string, file: string): string[] {
  const re = new RegExp(`^${SP}*(\\.|source)${SP}+([^\\t\\n\\v\\f\\r #]+)`);
  const out: string[] = [];
  for (const line of fileLines(`${repo}/${file}`)) {
    const m = re.exec(line);
    if (m) out.push(m[2] ?? "");
  }
  return out;
}

// `git grep` exits 1 for "no match", a real answer; 2 and up is an error. The
// packer fails open by design, so an error does not stop it — but a pack built
// on a search that failed says so, or "no callers found" would read as a fact.
function grepFailed(code: number, what: string): void {
  err(`blast-radius: git grep failed (exit ${code}) looking for ${what} — the pack may be missing entries`);
}

// Files that import `target`. TypeScript is resolved; shell is basename-tailed.
function importersOf(repo: string, target: string): string[] {
  const targetNoext = dropCodeExt(target);
  const base = path.posix.basename(targetNoext);

  if (target.endsWith(".sh")) {
    const r = git([
      "grep",
      "-l",
      "--untracked",
      "-E",
      "-e",
      `(^|[[:space:];&|])(\\.|source)[[:space:]]+[^[:space:]]*/?${base}\\.sh`,
      "--",
      ".",
      ...RECORD_EXCLUDES,
    ]);
    if (r.status > 1) grepFailed(r.status, `the scripts sourcing ${target}`);
    return r.stdout.split("\n").filter((l) => l !== target && l !== "");
  }

  const r = git([
    "grep",
    "-l",
    "--untracked",
    "-E",
    "-e",
    `['"][^'"]*${base}(\\.(js|jsx|ts|tsx|mjs|cjs))?['"]`,
    "--",
    ".",
    ...RECORD_EXCLUDES,
  ]);
  if (r.status > 1) grepFailed(r.status, `the files importing ${target}`);

  // Candidates first (one grep), then resolution per candidate (no grep).
  const out: string[] = [];
  for (const hitfile of r.stdout.split("\n")) {
    if (hitfile === "" || hitfile === target) continue;
    if (!/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(hitfile)) continue;
    for (const spec of tsSpecifiers(repo, hitfile)) {
      if (spec === "") continue;
      if (path.posix.basename(dropCodeExt(spec)) !== base) continue;
      if (resolveSpec(repo, hitfile, spec) === targetNoext) {
        out.push(hitfile);
        break;
      }
    }
  }
  return out;
}

// Repo files `f` imports, minus (at the caller) the ones this change already
// shows the reviewer, and — for a shell script — the sourced targets that are
// not on disk.
//
// A SOURCED SHELL SPECIFIER RESOLVES TO EXACTLY WHAT BASH READS. `source x` /
// `. x` reads the file `x`: bash never completes an extensionless `x` to
// `x.sh` (the bash original did), nor substitutes `x.ts` for a missing `x.sh`.
// A literal target that is not a file is returned as missing, so the pack
// shows a broken source line instead of dropping it or naming a neighbour.
function importsOf(repo: string, f: string): { imports: string[]; missing: string[] } {
  const out: string[] = [];
  const missing: string[] = [];
  if (f.endsWith(".sh")) {
    for (const spec of shSpecifiers(repo, f)) {
      if (spec === "" || spec.includes("$")) continue;
      const resolved = resolveLiteral(repo, f, spec);
      if (resolved === "") continue;
      if (isFile(`${repo}/${resolved}`)) out.push(resolved);
      else missing.push(resolved);
    }
    return { imports: out, missing };
  }
  const exts = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx"];
  for (const spec of tsSpecifiers(repo, f)) {
    if (spec === "") continue;
    const resolved = resolveSpec(repo, f, spec);
    if (resolved === "") continue;
    for (const e of exts) {
      const cand = `${resolved}${e}`;
      if (isFile(`${repo}/${cand}`)) {
        out.push(cand);
        break;
      }
    }
  }
  return { imports: out, missing };
}

function callersOf(symbol: string, defining: string): string[] {
  // A word match as a fixed string: `\b` is not in every git's regex build
  // (macOS), and a `$` in a JavaScript identifier stays literal.
  const r = git(["grep", "-n", "--untracked", "-w", "-F", "-e", symbol, "--", ".", ...RECORD_EXCLUDES]);
  if (r.status > 1) grepFailed(r.status, `the callers of ${symbol}`);
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const fields = line.split(":");
    if (fields[0] === defining) continue;
    out.push(`${fields[0] ?? ""}:${fields[1] ?? ""}`);
  }
  return out;
}

// ── The diff, split per file ──────────────────────────────────────────
//
// Two facts per file: which NEW-side lines the diff added (so the parser can say
// which symbol encloses them), and the text of every line it removed (so a
// deleted export is still found on the old side). A `+`/`-` line that is blank
// or is nothing but a comment is neither — "boundary inputs"'s comment-only
// case, and the reason a typo fix in a docblock does not drag a symbol's whole
// caller list into the prompt.

interface FileDiff {
  newlines: number[];
  removed: string[];
}

// Content that is only whitespace, or only a line comment, is not a change
// to a symbol. `*` and `*/` cover the continuation lines of a TS block
// comment; `#` covers shell and the `#!` line.
function trivial(s: string): boolean {
  const t = s.replace(new RegExp(`^${SP}+`), "").replace(new RegExp(`${SP}+$`), "");
  return t === "" || t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("#");
}

const slugFor = (p: string): string => p.replace(/[^A-Za-z0-9._-]/g, "_");

/** Keyed by slug, as the bash's per-file temp names were. */
function parseDiff(diffText: string): Map<string, FileDiff> {
  const bySlug = new Map<string, FileDiff>();
  let filePath = "";
  let slug = "";
  let newline = 0;
  const entry = (): FileDiff => {
    let e = bySlug.get(slug);
    if (!e) {
      e = { newlines: [], removed: [] };
      bySlug.set(slug, e);
    }
    return e;
  };
  for (const line of diffText.split("\n")) {
    if (line.startsWith("diff --git ")) {
      filePath = "";
      newline = 0;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) {
      filePath = line.slice(4).replace(/^b\//, "");
      if (filePath === "/dev/null") {
        filePath = "";
        continue;
      }
      slug = slugFor(filePath);
      continue;
    }
    if (line.startsWith("@@ ")) {
      if (filePath === "") continue;
      // @@ -oldStart,oldCount +newStart,newCount @@
      const plus = (line.trim().split(/[ \t]+/)[2] ?? "").replace(/^\+/, "");
      newline = Number.parseInt(plus.split(",")[0] ?? "", 10) || 0;
      continue;
    }
    if (filePath === "") continue;
    const c = line.slice(0, 1);
    const body = line.slice(1);
    if (c === "+") {
      if (!trivial(body)) entry().newlines.push(newline);
      newline++;
    } else if (c === "-") {
      if (!trivial(body)) entry().removed.push(body);
    } else if (c === " " || c === "") {
      newline++;
    }
  }
  return bySlug;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const MAX_SYMBOLS = Number.parseInt(process.env.BLAST_RADIUS_MAX_SYMBOLS || "32", 10);
  const MAX_CALLERS = Number.parseInt(process.env.BLAST_RADIUS_MAX_CALLERS || "8", 10);
  const MAX_BYTES = Number.parseInt(process.env.BLAST_RADIUS_MAX_BYTES || "32768", 10);

  let REPO = "";
  let DIFF_FILE = "";
  let OLD_REF = "HEAD";
  let FILES_FILE = "";
  const ARG_FILES: string[] = [];

  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; ) {
    const a = argv[i] ?? "";
    const needsValue = (msg: string): string => {
      if (i + 1 >= argv.length) {
        err(msg);
        exit(2);
      }
      const v = argv[i + 1] ?? "";
      i += 2;
      return v;
    };
    if (a === "--repo") REPO = needsValue("blast-radius: --repo needs a directory");
    else if (a === "--diff-file") DIFF_FILE = needsValue("blast-radius: --diff-file needs a path");
    else if (a === "--old-ref") OLD_REF = needsValue("blast-radius: --old-ref needs a revision");
    else if (a === "--files-file") FILES_FILE = needsValue("blast-radius: --files-file needs a path");
    else if (a === "-h" || a === "--help") {
      // The header comment above, lines 2-40, is the help text.
      const lines = readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 40);
      process.stderr.write(`${lines.join("\n")}\n`);
      exit(0);
    } else if (a.startsWith("--")) {
      err(`blast-radius: unknown flag: ${a}`);
      exit(2);
    } else {
      ARG_FILES.push(a);
      i++;
    }
  }

  if (REPO === "") {
    const top = git(["rev-parse", "--show-toplevel"]);
    REPO = top.status === 0 ? top.stdout : "";
  }
  if (REPO === "" || git(["-C", REPO, "rev-parse", "--git-dir"]).status !== 0) {
    err(`blast-radius: not a git repo: ${REPO || "<cwd>"}`);
    exit(2);
  }
  REPO = path.resolve(REPO);
  process.chdir(REPO);

  // Caller errors are checked BEFORE any early exit. An unreadable --diff-file is
  // a bug in the caller whether or not the file list turned out to be empty, and
  // reporting 0 for it would hide a typo'd path behind an empty pack.
  if (DIFF_FILE !== "" && DIFF_FILE !== "-" && !isFile(DIFF_FILE)) {
    err(`blast-radius: --diff-file not found: ${DIFF_FILE}`);
    exit(2);
  }

  const TMP = mkdtempSync(path.join(os.tmpdir(), "blast-radius-"));
  try {
    await pack(REPO, DIFF_FILE, OLD_REF, FILES_FILE, ARG_FILES, TMP, MAX_SYMBOLS, MAX_CALLERS, MAX_BYTES);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

async function pack(
  REPO: string,
  DIFF_FILE: string,
  OLD_REF: string,
  FILES_FILE: string,
  ARG_FILES: string[],
  TMP: string,
  MAX_SYMBOLS: number,
  MAX_CALLERS: number,
  MAX_BYTES: number,
): Promise<void> {
  // ── The file list ─────────────────────────────────────────────────────

  let rawList = "";
  if (FILES_FILE !== "") {
    if (FILES_FILE === "-") {
      rawList += readStdin();
    } else if (isFile(FILES_FILE)) {
      rawList += readFileSync(FILES_FILE, "utf8");
    } else {
      err(`blast-radius: --files-file not found: ${FILES_FILE}`);
      exit(2);
    }
  }
  for (const a of ARG_FILES) rawList += `${a}\n`;

  // Only the three languages the symbol side can parse, only files that still
  // exist (a deleted file has no new side and nothing left to import), sorted and
  // deduped so two callers passing the same path do not pack it twice.
  const listed = rawList.split("\n");
  if (rawList.endsWith("\n")) listed.pop();
  const FILES = sortUnique(listed.filter((l) => !new RegExp(`^${SP}*$`).test(l))).filter(
    (f) => f !== "" && /\.(ts|tsx|sh)$/.test(f) && isFile(`${REPO}/${f}`),
  );

  if (FILES.length === 0) exit(0);

  const DIFF_TEXT = (DIFF_FILE === "" ? "" : DIFF_FILE === "-" ? readStdin() : readFileSync(DIFF_FILE, "utf8")).replace(
    /\n+$/,
    "",
  );
  const parsed = DIFF_TEXT !== "" ? parseDiff(DIFF_TEXT) : new Map<string, FileDiff>();

  // ── Ask the parser which symbols moved ────────────────────────────────

  const BYTES_DIR = path.join(TMP, "bytes");
  const PARSED_DIR = path.join(TMP, "diff");
  mkdirSync(BYTES_DIR, { recursive: true });
  mkdirSync(PARSED_DIR, { recursive: true });

  let request = "";
  FILES.forEach((f, i) => {
    const idx = i + 1;
    const slug = slugFor(f);
    const d = parsed.get(slug);
    const lang = f.endsWith(".sh") ? "sh" : "ts";
    request += `FILE ${f}\nLANG ${lang}\nNEWFILE ${REPO}/${f}\n`;
    if (DIFF_TEXT === "") {
      request += "NEWLINES all\n";
    } else if (d && d.newlines.length > 0) {
      request += `NEWLINES ${[...new Set(d.newlines)].sort((a, b) => a - b).join(",")}\n`;
    } else {
      request += "NEWLINES\n";
    }
    // The old side is fetched ONLY when the diff removed something from this
    // file — `git show` on every file would cost one process per file to learn
    // nothing in the common add-only case.
    if (d && d.removed.length > 0) {
      const show = spawnSync("git", ["show", `${OLD_REF}:${f}`], {
        env: CHILD_ENV,
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 1024 * 1024 * 1024,
      });
      const oldPath = path.join(BYTES_DIR, `old.${idx}`);
      writeFileSync(oldPath, show.stdout ?? "");
      if (show.status === 0) {
        const removedPath = path.join(PARSED_DIR, `${slug}.removed`);
        writeFileSync(removedPath, d.removed.map((l) => `${l}\n`).join(""));
        request += `OLDFILE ${oldPath}\nREMOVEDFILE ${removedPath}\n`;
      }
    }
    request += "\n";
  });

  let symbolsOut = "";
  if (existsSync(SYMBOLS_TS)) {
    // A parser crash must not take the review with it: the import graph below is
    // computed entirely in this program and still ships.
    const r = spawnSync(process.execPath, ["--experimental-strip-types", SYMBOLS_TS], {
      encoding: "utf8",
      input: request,
      env: { ...CHILD_ENV, BLAST_RADIUS_REPO_ROOT: REPO },
      maxBuffer: 1024 * 1024 * 1024,
    });
    if (r.status === 0) {
      symbolsOut = r.stdout;
    } else {
      err("blast-radius: the symbol parser failed; packing the import graph only");
      const stderr = r.stderr ?? "";
      if (stderr !== "") {
        const lines = stderr.split("\n");
        if (stderr.endsWith("\n")) lines.pop();
        for (const l of lines) err(`  ${l}`);
      }
    }
  } else {
    err(`blast-radius: ${SYMBOLS_TS} is missing; packing the import graph only`);
  }

  const symbolLines = symbolsOut.split("\n");
  for (const line of symbolLines) {
    if (line.startsWith("WARN ")) err(`blast-radius: ${line.slice(5)}`);
  }

  const symbolsFor = (f: string): string[] => {
    const out: string[] = [];
    for (const line of symbolLines) {
      const fields = line.trim().split(/[ \t]+/);
      if (fields[0] === "SYMBOL" && fields[1] === f) out.push(fields[2] ?? "");
    }
    return out;
  };

  // ── Emit ──────────────────────────────────────────────────────────────

  const changedSet = new Set(FILES);
  let body = "";
  let symbolBudget = MAX_SYMBOLS;
  let truncatedSymbols = 0;
  let truncatedCallers = 0;

  for (const f of FILES) {
    let section = "";

    const importedBy = sortUnique(importersOf(REPO, f));
    if (importedBy.length > 0) {
      section += "  imported-by:\n";
      for (const x of importedBy) section += `    ${x}\n`;
    }

    const graph = importsOf(REPO, f);
    const imports = sortUnique(graph.imports).filter((x) => !changedSet.has(x));
    if (imports.length > 0) {
      section += "  imports (not in this change):\n";
      for (const x of imports) section += `    ${x}\n`;
    }
    const missingSources = sortUnique(graph.missing);
    if (missingSources.length > 0) {
      section += "  sources missing:\n";
      for (const x of missingSources) section += `    ${x}\n`;
    }

    let symLines = "";
    for (const s of sortUnique(symbolsFor(f))) {
      if (s === "") continue;
      if (symbolBudget <= 0) {
        truncatedSymbols++;
        continue;
      }
      symbolBudget--;
      let calls = sortUnique(callersOf(s, f));
      if (calls.length === 0) {
        symLines += `    ${s} — no callers found\n`;
        continue;
      }
      if (calls.length > MAX_CALLERS) {
        truncatedCallers += calls.length - MAX_CALLERS;
        calls = calls.slice(0, MAX_CALLERS);
      }
      symLines += `    ${s} — callers:\n`;
      for (const c of calls) symLines += `      ${c}\n`;
    }
    if (symLines !== "") section += `  changed symbols:\n${symLines}`;

    // A file with nothing on any of the three axes contributes nothing — an
    // unchanged-looking heading per file is noise in a prompt that pays by byte.
    if (section !== "") body += `${f}\n${section}`;
  }

  if (body === "") exit(0);

  const HEADER = `BLAST RADIUS (computed from the working tree at review time)
Who calls the symbols this diff changed, and how these files connect. Context
for the review, not findings: nothing here is by itself a defect.`;

  let full = `${HEADER}\n\n${body}`;
  if (truncatedSymbols > 0) full += `truncated-symbols: ${truncatedSymbols}\n`;
  if (truncatedCallers > 0) full += `truncated-callers: ${truncatedCallers}\n`;

  const fullBytes = Buffer.from(full, "utf8");
  if (fullBytes.length > MAX_BYTES) {
    // Cut to the budget, then drop the partial last line so the pack never ends
    // mid-path — a half-written `apps/foo/ba` reads as a real file that is not
    // there. (As `head -c | sed '$d'` did: the last line goes even when the cut
    // lands on a newline.)
    const cut = fullBytes.subarray(0, MAX_BYTES);
    const withoutFinalNewline = cut.at(-1) === 0x0a ? cut.subarray(0, -1) : cut;
    const lastNewline = withoutFinalNewline.lastIndexOf(0x0a);
    process.stdout.write(lastNewline === -1 ? Buffer.alloc(0) : withoutFinalNewline.subarray(0, lastNewline + 1));
    process.stdout.write(`truncated-bytes: ${fullBytes.length - MAX_BYTES}\n`);
  } else {
    process.stdout.write(full);
  }

  exit(0);
}

if (process.argv[1] && realpathSync(path.resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
