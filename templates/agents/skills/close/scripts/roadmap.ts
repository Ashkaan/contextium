#!/usr/bin/env -S node --experimental-strip-types
// roadmap.ts — THE one reader and writer of a project's ROADMAP.md table.
// detect-stage.ts, project-remaining-work.ts, next-implement-command.ts and
// setup-worktree.sh all call this instead of parsing the table themselves, for
// the reason two shard-table parsers taught: they disagreed (`reported`
// counted as done in one and as open in the other), and a table read two ways
// routes a project two ways.
//
// WHICH ROW IS READY, AND WHAT `next:` SAYS, IS NOT DEFINED HERE. The rule is
// written once, in the README template's derivation comment:
//   .agents/skills/project/references/templates/README.md  (the <!-- --> block)
// This script implements it; if the two ever disagree, the template is right and
// this file is the bug.
//
// Reading the table. The first table under `# Roadmap` whose header row names
// both an `ID` and a `Status` column. Columns are found BY HEADER NAME, so a
// reordered table reads the same. Cells are split on unescaped `|` (GFM's rule,
// which applies inside code spans too) and trimmed; spaces inside a cell are
// kept, so `blocked: vendor reply` survives whole.
//
// Sub-spec is printed as the NAME spec-state.ts gives that spec, so a caller can
// join the two outputs on it directly:
//   `specs/004-x/`                               → specs/004-x
//   `` `x.spec.md` → `x-report.md` `` (legacy)   → x   (the first backticked *.spec.md)
//   `—`, `-` or empty                            → —
//
// Usage:
//   roadmap.ts <project-folder>                 one TSV line per row:
//                                               ID  Status  ready(yes|no)  Sub-spec  Sub-feature
//   roadmap.ts <project-folder> --next          the derived `next:` value, or nothing
//   roadmap.ts <project-folder> --ready         the ready rows only, same TSV, in
//                                               next-order (in-progress, then planned)
//   roadmap.ts <project-folder> --check <ID>    exit 0 and print the row's Sub-spec when
//                                               the row may be built now: ready, a
//                                               Sub-spec named, that spec on disk and
//                                               still owed work. Otherwise exit 1 with one
//                                               `roadmap: <ID> not ready: <reason>` line per
//                                               reason (each unmet dependency by name)
//   roadmap.ts <project-folder> --set <ID> <status> [--sub-spec <path>]
//                                               rewrite that row's Status (and Sub-spec)
//                                               cells; every other byte is left alone
//   roadmap.ts <project-folder> --sync-next     rewrite README.md's `next:` line from --next
//
// --set and --sync-next take a per-project lock (`.roadmap.lock` beside the
// table), re-read the files under it, and replace them through a temp file and
// a rename, keeping the file's mode, so two sessions writing one checkout never
// lose each other's row. The lock is lock.sh's lock_take protocol, ported here
// so the two stay interoperable: a symlink whose target is the holder's pid, a
// dead holder's lock taken over under a `<lock>.takeover` mkdir guard.
// ROADMAP_LOCK_WAIT (seconds, default 30) bounds the wait.
//
// Warnings (exit 0) and errors (exit 1) go to stderr as `roadmap: <message>`.
// Exit: 0 ok · 1 no ROADMAP.md, malformed table, placeholder row, missing row,
// row not ready (--check), lock timeout, no README (--sync-next) · 2 usage.
//
// BYTES, NOT TEXT, ON THE WAY BACK OUT. The bash original was one gawk program
// under LC_ALL=C.UTF-8: it measured in characters (the 60-character cut) but
// wrote every line it did not change back byte for byte. So lines are held as
// latin1 strings — one char per byte, a lossless round trip — and decoded to
// UTF-8 only where a line is READ as text; the rewritten row and the `next:`
// line are the only bytes this program composes.
//
// peers:
//   .agents/skills/close/scripts/roadmap.test.ts
//   .agents/skills/close/scripts/spec-state.ts   (what each Sub-spec's state is)
//   .agents/skills/close/scripts/lock.sh         (the lock protocol this ports)
//   .agents/skills/project/references/templates/ROADMAP.md

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SPEC_STATE = join(dirname(fileURLToPath(import.meta.url)), "spec-state.ts");

const err = (msg: string): void => {
  process.stderr.write(`roadmap: ${msg}\n`);
};

function usage(): never {
  err(
    "usage: roadmap.ts <project-folder> [--next | --ready | --check <ID> | --set <ID> <status> [--sub-spec <path>] | --sync-next]",
  );
  return exit(2);
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
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

/** awk's records: split on \n, and a final newline ends the last record rather than starting an empty one. Latin1: one char per byte. */
function records(path: string): { lines: string[]; raw: Buffer } {
  const raw = readFileSync(path);
  const text = raw.toString("latin1");
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return { lines, raw };
}
const utf8 = (latin1: string): string => Buffer.from(latin1, "latin1").toString("utf8");
const bytes = (text: string): string => Buffer.from(text, "utf8").toString("latin1");

/** `$(tail -c1 f)` is non-empty: the file does not end in a newline. */
const lacksFinalNewline = (raw: Buffer): boolean => raw.length > 0 && raw[raw.length - 1] !== 0x0a;

/** A temp file beside `target`, as `mktemp "${target}.XXXXXX"` makes it (0600). */
function mktempBeside(target: string): string | null {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let attempt = 0; attempt < 100; attempt++) {
    let suffix = "";
    for (let i = 0; i < 6; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    const p = `${target}.${suffix}`;
    try {
      closeSync(openSync(p, "wx", 0o600));
      return p;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return null;
    }
  }
  return null;
}

/**
 * Write `out` (latin1) to the temp file, give it `target`'s mode, and rename it
 * over `target`: a reader sees the old file or the new one, never half of one,
 * and the mode survives (the temp file was made 0600).
 */
function replaceAtomic(target: string, tmp: string, out: string): boolean {
  try {
    const mode = statSync(target).mode & 0o7777;
    const fd = openSync(tmp, "w");
    writeSync(fd, Buffer.from(out, "latin1"));
    closeSync(fd);
    chmodSync(tmp, mode);
    renameSync(tmp, target);
    return true;
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    return false;
  }
}

// One writer at a time per project: lock.sh's lock_take/lock_release, in
// TypeScript. THE LOCK IS A SYMLINK whose target is the holder's pid —
// creating it is atomic and fails when it exists, and the pid is written in the
// same step. A DEAD HOLDER'S LOCK IS TAKEN OVER one taker at a time: take
// `<lock>.takeover` (mkdir), re-read the pid, remove the lock only if the dead
// pid still owns it. A bash writer sourcing lock.sh and this program exclude
// each other on the same path.
const readlinkOr = (p: string): string => {
  try {
    return readlinkSync(p);
  } catch {
    return "";
  }
};
/** `kill -0 <pid>`: true when the process exists (EPERM: exists, not ours). */
function alive(pid: string): boolean {
  if (!/^[0-9]+$/.test(pid)) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
const sleepMs = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};
let heldLock = "";
function lockRelease(lock: string): void {
  if (readlinkOr(lock) === String(process.pid)) {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}
/** Returns "" once held, or the holder's pid when the wait ran out. */
function lockTake(lock: string, waitS: number): string | null {
  let ticks = 0;
  for (;;) {
    try {
      symlinkSync(String(process.pid), lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") return readlinkOr(lock);
    }
    const holder = readlinkOr(lock);
    if (holder !== "" && !alive(holder)) {
      let guarded = false;
      try {
        mkdirSync(`${lock}.takeover`);
        guarded = true;
      } catch {
        guarded = false;
      }
      if (guarded) {
        if (readlinkOr(lock) === holder) {
          try {
            unlinkSync(lock);
          } catch {
            // taken by another already
          }
        }
        try {
          rmdirSync(`${lock}.takeover`);
        } catch {
          // gone
        }
        continue;
      }
    }
    if (ticks >= waitS * 5) return holder;
    sleepMs(200);
    ticks++;
  }
  heldLock = lock;
  process.on("exit", () => lockRelease(heldLock));
  return null;
}
function takeLock(projectDir: string): void {
  const lock = `${projectDir}/.roadmap.lock`;
  const w = Number.parseInt(process.env.ROADMAP_LOCK_WAIT ?? "", 10);
  const holder = lockTake(lock, Number.isFinite(w) && w >= 0 ? w : 30);
  if (holder === null) return;
  err(`another session is writing this project (lock ${lock} held by pid ${holder || "?"}); nothing was written`);
  exit(1);
}

// gawk string functions, in characters (UTF-8 locale), as the original measured.
const chars = (s: string): string[] => Array.from(s);
const len = (s: string): number => chars(s).length;
/** gawk 5.3 `substr(s, m, n)`: a start below 1 reads as 1 (measured: substr("abcdef",-2,4) is "abcd"), a length ≤ 0 is "". */
function substr(s: string, m: number, n?: number): string {
  const c = chars(s);
  const start = Math.max(m, 1);
  if (n === undefined) return c.slice(start - 1).join("");
  if (n <= 0) return "";
  return c.slice(start - 1, start - 1 + n).join("");
}
const trim = (s: string): string => s.replace(/^[ \t]+|[ \t]+$/g, "");

/** Split a table line into raw segments between unescaped pipes. seg[0] is whatever precedes the first pipe, the last whatever follows the last. */
function segs(line: string): string[] {
  const seg: string[] = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "\\" && line[i + 1] === "|") {
      cur += "\\|";
      i++;
      continue;
    }
    if (c === "|") {
      seg.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  seg.push(cur);
  return seg;
}

/** Cells of a row: the segments between the leading and trailing pipe. */
function cells(line: string): string[] {
  const seg = segs(line);
  const n = seg.length;
  const cell: string[] = [];
  for (let i = 1; i < n - 1; i++) cell.push(trim(seg[i] ?? ""));
  if (trim(seg[n - 1] ?? "") !== "") cell.push(trim(seg[n - 1] ?? "")); // row with no trailing pipe
  return cell;
}

function subspecName(s: string): string {
  const m = /`[^`]*\.(spec|plan)\.md`/.exec(s);
  if (m) {
    return m[0]
      .slice(1, -1)
      .replace(/.*\//, "")
      .replace(/\.(spec|plan)\.md$/, "");
  }
  let t = trim(s.replace(/`/g, ""));
  if (t === "" || t === "—" || t === "-") return "—";
  t = t.replace(/\/+$/, "");
  return t;
}

class ParseFail {}
function fail(msg: string): never {
  err(msg);
  throw new ParseFail();
}

interface SetArgs {
  id: string;
  status: string;
  subspec: string;
}

/**
 * The whole table model, in one function so list, --next and --set cannot
 * read the table differently from each other. Returns the exit status; writes
 * TSV rows (list), the next: value (next) or appends the rewritten file to
 * `setOut` (set).
 */
type ParseMode = "list" | "next" | "ready" | "check" | "set";

function parse(roadmap: string, mode: ParseMode, set: SetArgs, out: { text: string }): number {
  try {
    return parseOrThrow(roadmap, mode, set, out);
  } catch (e) {
    if (e instanceof ParseFail) return 1;
    throw e;
  }
}

function parseOrThrow(roadmap: string, mode: ParseMode, set: SetArgs, out: { text: string }): number {
  const { lines } = records(roadmap);
  let state = "seek-heading";
  let hdr: string[] = [];
  let nh = 0;
  let colId = 0;
  let colStatus = 0;
  let colSub = 0;
  let colFeat = 0;
  let colDep = 0;
  const seen = new Set<string>();
  const rid: string[] = [];
  const rline: number[] = [];
  const rstatus: string[] = [];
  const rfeat: string[] = [];
  const rsub: string[] = [];
  const rdep: string[] = [];
  const byid = new Map<string, number>();

  for (let idx = 0; idx < lines.length; idx++) {
    const NR = idx + 1;
    const line = utf8(lines[idx] ?? "");
    if (state === "seek-heading") {
      if (/^#[ \t]+Roadmap([ \t:]|$)/.test(line)) state = "seek-table";
      continue;
    }
    if (state === "seek-table" && /^[ \t]*\|/.test(line)) {
      hdr = cells(line);
      nh = hdr.length;
      colId = colStatus = colSub = colFeat = colDep = 0;
      for (let i = 1; i <= nh; i++) {
        const h = (hdr[i - 1] ?? "").toLowerCase();
        if (h === "id") colId = i;
        else if (h === "status") colStatus = i;
        else if (h === "sub-spec") colSub = i;
        else if (h === "sub-feature") colFeat = i;
        else if (h === "depends on") colDep = i;
      }
      state = colId && colStatus ? "sep" : "skip-table";
      continue;
    }
    if (state === "skip-table") {
      if (!/^[ \t]*\|/.test(line)) state = "seek-table";
      continue;
    }
    if (state === "sep") {
      state = "rows";
      if (/^[ \t]*\|[ \t:|-]*$/.test(line)) continue;
    }
    if (state === "rows") {
      if (!/^[ \t]*\|/.test(line)) {
        state = "done";
        continue;
      }
      const c = cells(line);
      const nc = c.length;
      if (nc !== nh) fail(`row at line ${NR} has ${nc} cells, the header has ${nh}`);
      const id = c[colId - 1] ?? "";
      if (id === "") fail(`row at line ${NR} has no ID`);
      if (seen.has(id.toUpperCase())) fail(`ID ${id} appears twice`);
      seen.add(id.toUpperCase());
      const feat = colFeat ? (c[colFeat - 1] ?? "") : "";
      if (/^<[^>]*>$/.test(feat)) fail(`placeholder row ${id} — the template was never filled in`);
      rid.push(id);
      rline.push(NR);
      rstatus.push(c[colStatus - 1] ?? "");
      rfeat.push(feat);
      rsub.push(colSub ? subspecName(c[colSub - 1] ?? "") : "—");
      rdep.push(colDep ? (c[colDep - 1] ?? "") : "");
      byid.set(id.toUpperCase(), rid.length - 1);
    }
  }

  if (state === "seek-heading") fail("no `# Roadmap` heading in ROADMAP.md");
  if (!colId || !colStatus || state === "seek-table" || state === "skip-table") {
    fail("no table under `# Roadmap` with ID and Status columns");
  }

  const nrow = rid.length;
  // Status → kind. The vocabulary is the template derivation rule.
  const kind: string[] = [];
  for (let r = 0; r < nrow; r++) {
    const s = (rstatus[r] ?? "").toLowerCase();
    if (s === "planned" || s === "in-progress" || s === "done") kind[r] = s;
    else if (/^blocked:/.test(s)) kind[r] = "blocked";
    else if (/^absorbed by /.test(s)) kind[r] = "absorbed";
    else {
      kind[r] = "unknown";
      err(`${rid[r]} has unknown status`);
    }
  }
  const ready: boolean[] = [];
  for (let r = 0; r < nrow; r++) {
    ready[r] = kind[r] === "planned" || kind[r] === "in-progress";
    const d = trim(rdep[r] ?? "");
    if (d === "" || d === "—" || d === "-") continue;
    for (const raw of d.split(",")) {
      const dep = trim(raw).replace(/`/g, "");
      if (dep === "") continue;
      const at = byid.get(dep.toUpperCase());
      if (at === undefined) {
        err(`${rid[r]} depends on unknown ${dep}`);
        ready[r] = false;
        continue;
      }
      const dk = kind[at];
      if (dk !== "done" && dk !== "absorbed") ready[r] = false;
    }
  }

  const rowTsv = (r: number): string =>
    `${rid[r]}\t${rstatus[r]}\t${ready[r] ? "yes" : "no"}\t${rsub[r]}\t${rfeat[r]}\n`;
  const noRow = (id: string): never => {
    const ids = rid.join(", ");
    return fail(`no row ${id} in ROADMAP.md (rows: ${ids === "" ? "none" : ids})`);
  };
  if (mode === "list") {
    for (let r = 0; r < nrow; r++) out.text += rowTsv(r);
    return 0;
  }
  if (mode === "ready") {
    for (let r = 0; r < nrow; r++) if (ready[r] && kind[r] === "in-progress") out.text += rowTsv(r);
    for (let r = 0; r < nrow; r++) if (ready[r] && kind[r] === "planned") out.text += rowTsv(r);
    return 0;
  }
  if (mode === "check") {
    const r = byid.get(set.id.toUpperCase());
    if (r === undefined) return noRow(set.id);
    let bad = false;
    if (kind[r] !== "planned" && kind[r] !== "in-progress") {
      err(`${rid[r]} not ready: its Status is \`${rstatus[r]}\``);
      bad = true;
    }
    const d = trim(rdep[r] ?? "");
    if (d !== "" && d !== "—" && d !== "-") {
      for (const raw of d.split(",")) {
        const dep = trim(raw).replace(/`/g, "");
        if (dep === "") continue;
        const q = byid.get(dep.toUpperCase());
        if (q === undefined) {
          err(`${rid[r]} not ready: depends on ${dep}, which is not a row`);
          bad = true;
          continue;
        }
        if (kind[q] !== "done" && kind[q] !== "absorbed") {
          err(`${rid[r]} not ready: depends on ${rid[q]}, which is \`${rstatus[q]}\``);
          bad = true;
        }
      }
    }
    if (rsub[r] === "—") {
      err(`${rid[r]} not ready: no spec yet (Sub-spec is —) — run /project`);
      bad = true;
    }
    if (bad) return 1;
    out.text += `${rsub[r]}\n`;
    return 0;
  }
  if (mode === "next") {
    let pick = -1;
    for (let r = 0; r < nrow && pick < 0; r++) if (ready[r] && kind[r] === "in-progress") pick = r;
    for (let r = 0; r < nrow && pick < 0; r++) if (ready[r] && kind[r] === "planned") pick = r;
    if (pick < 0) return 0;
    const feat = rfeat[pick] ?? "";
    let v = `${rid[pick]}: ${feat}`;
    if (len(v) > 60) {
      const head = `${rid[pick]}: `;
      const room = 60 - len(head) - 1; // 1 for the ellipsis
      let f = substr(feat, 1, room + 1);
      if (substr(f, room + 1, 1) !== " ") {
        f = substr(f, 1, room).replace(/[ \t]+[^ \t]*$/, "");
      } else {
        f = substr(f, 1, room);
      }
      f = f.replace(/[ \t,;:]+$/, "");
      v = `${head}${f}…`;
    }
    v = v.replace(/"/g, '\\"');
    out.text += `"${v}"\n`;
    return 0;
  }
  // mode === "set"
  const target = byid.get(set.id.toUpperCase());
  if (target === undefined) return noRow(set.id);
  if (set.subspec !== "" && !colSub) fail("no Sub-spec column to set");
  const ln = (rline[target] ?? 1) - 1;
  // Segments of the RAW line, so every byte of every other cell is kept.
  const seg = segs(lines[ln] ?? "");
  seg[colStatus] = ` ${bytes(set.status)} `;
  if (set.subspec !== "") seg[colSub] = ` \`${bytes(set.subspec)}\` `;
  lines[ln] = seg.join("|");
  for (const l of lines) out.text += `${l}\n`;
  return 0;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 1) usage();
  const projectDir = argv[0] ?? "";
  const rest = argv.slice(1);
  if (!isDir(projectDir)) {
    err(`not a directory: ${projectDir}`);
    exit(2);
  }
  const roadmap = `${projectDir}/ROADMAP.md`;

  let mode: "list" | "next" | "ready" | "check" | "set" | "sync" = "list";
  const set: SetArgs = { id: "", status: "", subspec: "" };
  switch (rest[0] ?? "") {
    case "":
      break;
    case "--next":
      mode = "next";
      if (rest.length !== 1) usage();
      break;
    case "--ready":
      mode = "ready";
      if (rest.length !== 1) usage();
      break;
    case "--check":
      mode = "check";
      if (!(rest.length === 2 && (rest[1] ?? "") !== "")) usage();
      set.id = rest[1] ?? "";
      break;
    case "--sync-next":
      mode = "sync";
      if (rest.length !== 1) usage();
      break;
    case "--set": {
      mode = "set";
      if (!(rest.length === 3 || (rest.length === 5 && rest[3] === "--sub-spec"))) usage();
      set.id = rest[1] ?? "";
      set.status = rest[2] ?? "";
      set.subspec = rest[4] ?? "";
      const s = set.status;
      const okStatus =
        s === "planned" ||
        s === "in-progress" ||
        s === "done" ||
        (s.startsWith("blocked: ") && s.length > "blocked: ".length) ||
        (s.startsWith("absorbed by ") && s.length > "absorbed by ".length);
      if (!okStatus) {
        err(`not a status: '${s}' (planned · in-progress · done · blocked: <what> · absorbed by <ID>)`);
        exit(2);
      }
      break;
    }
    default:
      usage();
  }

  if (!isFile(roadmap)) {
    err(`no ROADMAP.md in ${projectDir}`);
    exit(1);
  }

  if (mode === "list" || mode === "next" || mode === "ready") {
    const out = { text: "" };
    const rc = parse(roadmap, mode, set, out);
    process.stdout.write(out.text);
    exit(rc);
  }

  if (mode === "check") {
    const out = { text: "" };
    if (parse(roadmap, "check", set, out) !== 0) exit(1);
    const sub = out.text.replace(/\n+$/, "");
    // What spec-state.ts says of that spec: none/partial is owed work, complete
    // is finished, no line at all is a Sub-spec not on disk.
    const ss = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SPEC_STATE, projectDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const hit = (ss.stdout ?? "").split("\n").find((l) => l.split("\t")[0] === sub);
    const state = hit === undefined ? "" : (hit.split("\t")[1] ?? "");
    if (state === "none" || state === "partial") {
      process.stdout.write(`${sub}\n`);
      return;
    }
    if (state === "complete") {
      err(`${set.id} not ready: its spec ${sub} is already complete — /close flips the row to done`);
    } else {
      err(`${set.id} not ready: its Sub-spec ${sub} is not on disk — run /project`);
    }
    exit(1);
  }

  if (mode === "set") {
    takeLock(projectDir);
    const tmp = mktempBeside(roadmap);
    if (tmp === null) {
      err(`cannot write beside ${roadmap}`);
      exit(1);
    }
    const out = { text: "" };
    if (parse(roadmap, "set", set, out) !== 0) {
      unlinkSync(tmp);
      exit(1);
    }
    // Preserve a missing final newline: every line was written with one.
    let text = out.text;
    if (lacksFinalNewline(readFileSync(roadmap))) text = text.slice(0, -1);
    if (!replaceAtomic(roadmap, tmp, text)) {
      err(`cannot write ${roadmap}`);
      exit(1);
    }
    return;
  }

  // mode === "sync"
  const readme = `${projectDir}/README.md`;
  if (!isFile(readme)) {
    err(`no README.md in ${projectDir}`);
    exit(1);
  }
  takeLock(projectDir);
  const { lines, raw } = records(readme);
  if ((lines[0] ?? "") !== "---") {
    err("README.md has no frontmatter");
    exit(1);
  }
  const nextOut = { text: "" };
  if (parse(roadmap, "next", set, nextOut) !== 0) exit(1);
  const value = bytes(nextOut.text.replace(/\n+$/, ""));
  const tmp = mktempBeside(readme);
  if (tmp === null) {
    err(`cannot write beside ${readme}`);
    exit(1);
  }

  // Only frontmatter lines are touched. An existing `next:` is replaced where it
  // stands (and removed when no row is ready); a missing one goes after the
  // `description:` entry, or before the closing `---` when there is none.
  // Two passes over the file, as the gawk original read it twice.
  let fm = 0;
  let closeAt = 0;
  let hasNext = false;
  let descAt = 0;
  let descEnd = 0;
  lines.forEach((line, i) => {
    const FNR = i + 1;
    if (FNR === 1) {
      fm = 1;
      return;
    }
    if (fm === 1 && line === "---") {
      fm = 2;
      closeAt = FNR;
    }
    if (fm === 1 && /^next:/.test(line)) hasNext = true;
    if (fm === 1 && /^description:/.test(line)) descAt = FNR;
    if (fm === 1 && descAt && FNR > descAt && !descEnd && !/^[ \t]/.test(line)) descEnd = FNR - 1;
  });
  let out = "";
  let done = false;
  lines.forEach((line, i) => {
    const FNR = i + 1;
    if (FNR === 1 && descAt && !descEnd) descEnd = closeAt - 1;
    if (FNR < closeAt && /^next:/.test(line)) {
      if (value !== "" && !done) {
        out += `next: ${value}\n`;
        done = true;
      }
      return;
    }
    out += `${line}\n`;
    if (!hasNext && value !== "" && !done && descAt && FNR === descEnd) {
      out += `next: ${value}\n`;
      done = true;
    }
    if (!hasNext && value !== "" && !done && !descAt && FNR === closeAt - 1) {
      out += `next: ${value}\n`;
      done = true;
    }
  });
  if (lacksFinalNewline(raw)) out = out.slice(0, -1);
  if (!replaceAtomic(readme, tmp, out)) {
    err(`cannot write ${readme}`);
    exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
