#!/usr/bin/env -S node --experimental-strip-types
// roadmap.ts — THE one reader and writer of a project's ROADMAP.md table.
// detect-stage.ts, project-remaining-work.ts, next-implement-command.ts and
// setup-worktree.sh all call this instead of parsing the table themselves, for
// the reason two shard-table parsers taught: they disagreed (`reported`
// counted as done in one and as open in the other), and a table read two ways
// routes a project two ways.
//
// WHICH ROW IS READY, WHAT `next:` SAYS, AND WHAT `status:` IS, ARE NOT
// DEFINED HERE. The rules are written once, in the README template's derivation
// comment:
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
//   `specs/004-x/`, ticked or not                → specs/004-x
//   `—`                                          → —
//   `manual`, ticked or not (a step no spec is written for) → manual
// Any other cell is a malformed table (exit 1, naming the row and the cell), and
// `--set … --sub-spec` refuses anything but `specs/NNN-name/` or `manual` before
// it writes.
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
//   roadmap.ts <project-folder> --derive        the frontmatter --sync-next would write:
//                                               `status:`, then `next:`, `blocked-on:` or
//                                               `monitoring-until:` when the status has one
//   roadmap.ts <project-folder> --set <ID> <status> [--sub-spec <path>]
//                                               rewrite that row's Status (and Sub-spec)
//                                               cells; every other byte is left alone
//   roadmap.ts <project-folder> --sync-next     rewrite README.md's `status:`, `next:`,
//                                               `blocked-on:` and `monitoring-until:` lines
//                                               from --derive (the name predates status)
//   any of the above … --projects-root <dir>    the folder holding projects/, for a
//                                               table outside one (a scratch copy)
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
// row not ready (--check), open rows none of which is ready or blocked
// (--derive, --sync-next), lock timeout, no README (--sync-next) · 2 usage.
//
// BYTES, NOT TEXT, ON THE WAY BACK OUT. The bash original was one gawk program
// under LC_ALL=C.UTF-8: it measured in characters (the 60-character cut) but
// wrote every line it did not change back byte for byte. So lines are held as
// latin1 strings — one char per byte, a lossless round trip — and decoded to
// UTF-8 only where a line is READ as text; the rewritten row and the `next:`
// line are the only bytes this program composes.
//
// ANOTHER PROJECT'S ROW. A Depends on entry `<slug> <ID>`, or
// `<domain>/<slug> <ID>`, names a row of the project in
// `<root>/projects/<domain>/<YYYY-MM-DD>_<slug>/`, where <root> is
// `--projects-root` or the folder three above a table at
// `<root>/projects/<domain>/<folder>/`. That ROADMAP.md is read once per run
// through the same readTable(). An entry naming nothing that reads is an error
// naming the cell, and the row is never ready and never a wait.
//
// EXPORTS. calendarDay() and watchDate(), the watch-date rule --derive uses.
// check-roadmap-decisions.ts and check-journal-entry.ts import them rather than
// copy the pattern. releaseDate(), the day a `blocked: until <date>` wait ends,
// for /project triage, which lists such a row once the day has passed (nothing
// sets it back to `planned` on its own). listRows(), the list mode in-process,
// for rows-taken.ts, with each row's dependency results for
// check-roadmap-decisions.ts, project-status.ts and land.ts. dependsOnEntries()
// and matchProject(), the cell's grammar and the slug-to-folder match.
//
// peers:
//   .agents/skills/close/scripts/roadmap.test.ts
//   .agents/skills/close/scripts/spec-state.ts   (what each Sub-spec's state is)
//   .agents/skills/close/scripts/lock.sh         (the lock protocol this ports)
//   .agents/skills/close/scripts/check-roadmap-decisions.ts (watchDate, calendarDay)
//   .agents/skills/project/references/templates/ROADMAP.md

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SPEC_STATE = join(dirname(fileURLToPath(import.meta.url)), "spec-state.ts");

// listRows() collects the messages instead of printing them; the program prints.
let errSink: ((msg: string) => void) | null = null;
const err = (msg: string): void => {
  if (errSink !== null) errSink(msg);
  else process.stderr.write(`roadmap: ${msg}\n`);
};

function usage(): never {
  err(
    "usage: roadmap.ts <project-folder> [--next | --ready | --check <ID> | --derive | --set <ID> <status> [--sub-spec <path>] | --sync-next] [--projects-root <dir>]",
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

/** awk's records: split on \n, and a final newline ends the last record rather than starting an empty one. Latin1: one char per byte. `given` is the file's bytes when the caller already holds them. */
function records(path: string, given?: Buffer): { lines: string[]; raw: Buffer } {
  const raw = given ?? readFileSync(path);
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

/** Whether `token` is a `YYYY-MM-DD` naming a real calendar day: it survives a
 *  `Date.UTC` round trip, so `2099-99-99` and `2026-02-30` do not. */
export function calendarDay(token: string): boolean {
  const m = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(token);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === token;
}

/** The watch date of a `blocked:` status — its leading `YYYY-MM-DD`, when that
 *  is a calendar day and no digit follows it — or "". The template's watch
 *  rule: --derive reads `monitor` from it. */
export function watchDate(status: string): string {
  if (!/^blocked:/i.test(status)) return "";
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])/.exec(trim(status.replace(/^blocked:/i, "")));
  return m?.[1] !== undefined && calendarDay(m[1]) ? m[1] : "";
}

/** The day a `blocked: until YYYY-MM-DD …` wait ends — its date, when that is a
 *  calendar day and no digit follows it — or "". The template's release rule:
 *  until that day the row is a wait like any other, so the project derives
 *  `blocked`. Nothing sets it back to `planned` on its own: from that day
 *  `/project triage blocked` lists it as a date passed, and `unblock` there does. */
export function releaseDate(status: string): string {
  const m = /^blocked:[ \t]*until[ \t]+([0-9]{4}-[0-9]{2}-[0-9]{2})(?![0-9])/i.exec(trim(status));
  return m?.[1] !== undefined && calendarDay(m[1]) ? m[1] : "";
}

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

/** A spec folder as a Sub-spec names it: `specs/NNN-name/`, the slash included. */
const SPEC_FOLDER = /^specs\/[0-9]{3}-[^/`\s]+\/$/;

/** A Sub-spec cell's name — `—`, `manual`, or `specs/NNN-name` — or null when the cell is none of them. */
function subspecName(s: string): string | null {
  const t = trim(s);
  if (t === "—") return "—";
  const bare = /^`([^`]*)`$/.exec(t)?.[1] ?? t;
  if (bare === "manual") return "manual";
  return SPEC_FOLDER.test(bare) ? bare.replace(/\/$/, "") : null;
}

/**
 * `<head><text>`, at most 60 characters: past that, `text` is cut at the last
 * whole word that fits and `…` appended. Returned quoted, inner quotes escaped,
 * because every value it makes holds a colon that would break the YAML.
 */
function cut60(head: string, text: string): string {
  let v = `${head}${text}`;
  if (len(v) > 60) {
    const room = 60 - len(head) - 1; // 1 for the ellipsis
    let f = substr(text, 1, room + 1);
    if (substr(f, room + 1, 1) !== " ") {
      f = substr(f, 1, room).replace(/[ \t]+[^ \t]*$/, "");
    } else {
      f = substr(f, 1, room);
    }
    f = f.replace(/[ \t,;:]+$/, "");
    v = `${head}${f}…`;
  }
  return `"${v.replace(/"/g, '\\"')}"`;
}

/** The README frontmatter the table implies. Empty strings are fields the status does not carry. */
interface Derived {
  status: string;
  next: string;
  blockedOn: string;
  monitoringUntil: string;
}
const DERIVED_KEYS = ["status", "next", "blocked-on", "monitoring-until"] as const;
const derivedValue = (d: Derived, key: (typeof DERIVED_KEYS)[number]): string =>
  key === "status" ? d.status : key === "next" ? d.next : key === "blocked-on" ? d.blockedOn : d.monitoringUntil;

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
type ParseMode = "list" | "next" | "ready" | "check" | "derive" | "set";

function parse(
  roadmap: string,
  mode: ParseMode,
  set: SetArgs,
  out: { text: string; deps?: DepResult[][]; dependsOn?: string[] },
  given?: Buffer,
): number {
  try {
    return parseOrThrow(roadmap, mode, set, out, given);
  } catch (e) {
    if (e instanceof ParseFail) return 1;
    throw e;
  }
}

/** One table as read: rows in order, cells as found by header name. */
interface Table {
  lines: string[];
  colStatus: number;
  colSub: number;
  rid: string[];
  rline: number[];
  rstatus: string[];
  rfeat: string[];
  rsub: string[];
  rdep: string[];
  byid: Map<string, number>;
}

/** Status → kind, by the template derivation rule's vocabulary. */
function kindOf(status: string): string {
  const s = status.toLowerCase();
  if (s === "planned" || s === "in-progress" || s === "done") return s;
  if (/^blocked:/.test(s)) return "blocked";
  if (/^absorbed by /.test(s) || /^closed:/.test(s)) return "closed"; // finished without being done
  return "unknown";
}

/** The table under `# Roadmap`, or a ParseFail after err() names what is wrong. */
function readTable(lines: string[]): Table {
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
      const sub = colSub ? subspecName(c[colSub - 1] ?? "") : "—";
      if (sub === null) fail(`${id}: Sub-spec "${c[colSub - 1] ?? ""}" is not —, manual or specs/NNN-name/`);
      rsub.push(sub);
      rdep.push(colDep ? (c[colDep - 1] ?? "") : "");
      byid.set(id.toUpperCase(), rid.length - 1);
    }
  }

  if (state === "seek-heading") fail("no `# Roadmap` heading in ROADMAP.md");
  if (!colId || !colStatus || state === "seek-table" || state === "skip-table") {
    fail("no table under `# Roadmap` with ID and Status columns");
  }
  return { lines, colStatus, colSub, rid, rline, rstatus, rfeat, rsub, rdep, byid };
}

// ── Another project's row in Depends on ─────────────────────────────────────

/** A `Depends on` entry: a local row ID, or `<slug> <ID>` / `<domain>/<slug> <ID>`
 *  naming a row of another project. */
export type DepEntry = { text: string; project: string; domain: string; slug: string; id: string };

/** The entries of a `Depends on` cell — comma-separated, backticks stripped,
 *  `—`, `-` and blank meaning none. `project` is "" for a local ID. */
export function dependsOnEntries(cell: string): DepEntry[] {
  const d = trim(cell);
  if (d === "" || d === "—" || d === "-") return [];
  const entries: DepEntry[] = [];
  for (const raw of d.split(",")) {
    const text = trim(raw).replace(/`/g, "");
    if (text === "") continue;
    const m = /^(?:([^\s/]+)\/)?([^\s/]+)[ \t]+(\S+)$/.exec(text);
    if (m?.[2] && m[3]) {
      const domain = m[1] ?? "";
      entries.push({ text, project: domain ? `${domain}/${m[2]}` : m[2], domain, slug: m[2], id: m[3] });
    } else entries.push({ text, project: "", domain: "", slug: "", id: text });
  }
  return entries;
}

/** Which of `rels` (`projects/<domain>/<YYYY-MM-DD>_<slug>`) is the project
 *  `slug` names, in `domain` when given: an exact folder-name match, any date.
 *  Two matches are ambiguous, never the first one. */
export function matchProject(rels: string[], slug: string, domain = ""): { rel: string } | { error: string } {
  const hits = rels.filter((rel) => {
    const m = /^projects\/([^/]+)\/[0-9]{4}-[0-9]{2}-[0-9]{2}_(.+)$/.exec(rel);
    return m?.[2] === slug && (domain === "" || m[1] === domain);
  });
  if (hits.length === 1 && hits[0] !== undefined) return { rel: hits[0] };
  const named = domain ? `${domain}/${slug}` : slug;
  if (hits.length === 0) return { error: `no project ${named} under projects/` };
  return { error: `${named} names more than one project (${hits.sort().join(", ")}) — write <domain>/${slug}` };
}

/** `matchProject` over the project folders under `<root>/projects/` — those
 *  holding a ROADMAP.md, the only rows a Depends on entry can name; a stray
 *  folder of the same name is no candidate and makes nothing ambiguous. */
export function findProjectFolder(root: string, slug: string, domain = ""): { rel: string } | { error: string } {
  const rels: string[] = [];
  const top = `${root}/projects`;
  let domains: string[] = [];
  try {
    domains = readdirSync(top, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return { error: `no projects/ folder in ${root}` };
  }
  for (const d of domains) {
    if (domain !== "" && d !== domain) continue;
    for (const e of readdirSync(`${top}/${d}`, { withFileTypes: true }))
      if (e.isDirectory() && isFile(`${top}/${d}/${e.name}/ROADMAP.md`)) rels.push(`projects/${d}/${e.name}`);
  }
  return matchProject(rels, slug, domain);
}

/** The repo root above a table at `<root>/projects/<domain>/<folder>/ROADMAP.md`, or null. */
function rootAbove(roadmap: string): string | null {
  const folder = dirname(resolve(roadmap));
  const projects = dirname(dirname(folder));
  return basename(projects) === "projects" ? dirname(projects) : null;
}

/** A dependency as resolved: `open` until the row it names is done, closed or
 *  absorbed, then `satisfied`; `unresolved` when it names nothing that reads.
 *  `feature` is the named row's Sub-feature, for a foreign entry that resolved. */
export type DepResult = DepEntry & { state: "open" | "satisfied" | "unresolved"; feature: string };

/** `--projects-root`, or listRows' option: the folder holding `projects/`.
 *  undefined walks up from the table; null means there is none. */
let projectsRootOpt: string | null | undefined;

function parseOrThrow(
  roadmap: string,
  mode: ParseMode,
  set: SetArgs,
  out: { text: string; deps?: DepResult[][]; dependsOn?: string[] },
  given?: Buffer,
): number {
  const { lines, colStatus, colSub, rid, rline, rstatus, rfeat, rsub, rdep, byid } = readTable(
    records(roadmap, given).lines,
  );

  const nrow = rid.length;
  const kind: string[] = [];
  for (let r = 0; r < nrow; r++) {
    kind[r] = kindOf(rstatus[r] ?? "");
    if (kind[r] === "unknown") err(`${rid[r]} has unknown status`);
  }

  // Another project's table, read once per folder through readTable; its
  // messages are kept, not printed, and one of them explains a failed read.
  const root = projectsRootOpt === undefined ? rootAbove(roadmap) : projectsRootOpt;
  const foreign = new Map<string, { kinds: Map<string, { kind: string; feature: string }> } | { why: string }>();
  const readForeign = (rel: string) => {
    const hit = foreign.get(rel);
    if (hit) return hit;
    const saved = errSink;
    const said: string[] = [];
    errSink = (m) => said.push(m);
    let got: { kinds: Map<string, { kind: string; feature: string }> } | { why: string };
    try {
      const t = readTable(records(`${root}/${rel}/ROADMAP.md`).lines);
      const kinds = new Map<string, { kind: string; feature: string }>();
      t.rid.forEach((id, i) =>
        kinds.set(id.toUpperCase(), { kind: kindOf(t.rstatus[i] ?? ""), feature: t.rfeat[i] ?? "" }),
      );
      got = { kinds };
    } catch (e) {
      const why =
        e instanceof ParseFail
          ? (said[0] ?? "malformed")
          : (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "no ROADMAP.md"
            : String(e);
      got = { why };
    } finally {
      errSink = saved;
    }
    foreign.set(rel, got);
    return got;
  };

  // Every row's dependencies, resolved once: the ready column, the waits and
  // canBeReady all read these.
  const deps: DepResult[][] = [];
  const ready: boolean[] = [];
  for (let r = 0; r < nrow; r++) {
    ready[r] = kind[r] === "planned" || kind[r] === "in-progress";
    deps[r] = [];
    for (const e of dependsOnEntries(rdep[r] ?? "")) {
      let state: DepResult["state"] = "unresolved";
      let feature = "";
      if (e.project === "") {
        const at = byid.get(e.id.toUpperCase());
        if (at === undefined) err(`${rid[r]} depends on unknown ${e.text}`);
        else state = kind[at] === "done" || kind[at] === "closed" ? "satisfied" : "open";
      } else if (root === null) {
        err(
          `${rid[r]} depends on ${e.text}: no projects/ folder above this table to find ${e.project} in — pass --projects-root`,
        );
      } else {
        const found = findProjectFolder(root, e.slug, e.domain);
        if ("error" in found) err(`${rid[r]} depends on ${e.text}: ${found.error}`);
        else {
          const t = readForeign(found.rel);
          if ("why" in t) err(`${rid[r]} depends on ${e.text}: ${found.rel}/ROADMAP.md does not read (${t.why})`);
          else {
            const row = t.kinds.get(e.id.toUpperCase());
            if (row === undefined) err(`${rid[r]} depends on ${e.text}: ${e.project} has no row ${e.id}`);
            else if (row.kind === "unknown")
              err(`${rid[r]} depends on ${e.text}: ${e.project} ${e.id} has unknown status`);
            else {
              state = row.kind === "done" || row.kind === "closed" ? "satisfied" : "open";
              feature = row.feature;
            }
          }
        }
      }
      if (state !== "satisfied") ready[r] = false;
      deps[r]?.push({ ...e, state, feature });
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
    out.deps = deps;
    out.dependsOn = rdep;
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
    // Each dependency as resolved above: a local row by its Status, another
    // project's row (`<slug> <ID>`) by whether it is still open.
    for (const x of deps[r] ?? []) {
      if (x.state === "satisfied") continue;
      bad = true;
      const q = x.project === "" ? byid.get(x.id.toUpperCase()) : undefined;
      if (x.state === "unresolved") {
        err(`${rid[r]} not ready: depends on ${x.text}, which is not a row`);
      } else if (q !== undefined) {
        err(`${rid[r]} not ready: depends on ${rid[q]}, which is \`${rstatus[q]}\``);
      } else {
        err(`${rid[r]} not ready: depends on ${x.text}, which is still open`);
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
  if (mode === "next" || mode === "derive") {
    const d: Derived = { status: "", next: "", blockedOn: "", monitoringUntil: "" };
    let pick = -1;
    for (let r = 0; r < nrow && pick < 0; r++) if (ready[r] && kind[r] === "in-progress") pick = r;
    for (let r = 0; r < nrow && pick < 0; r++) if (ready[r] && kind[r] === "planned") pick = r;
    if (pick >= 0) d.next = cut60(`${rid[pick]}: `, rfeat[pick] ?? "");
    if (mode === "next") {
      if (d.next !== "") out.text += `${d.next}\n`;
      return 0;
    }
    // status, by the template's rule: a ready row → active; else a row blocked
    // on something that is not a date → blocked; else rows blocked on dates →
    // monitor, until the earliest; else nothing open (no rows at all included)
    // → completed.
    const what = (r: number): string => trim((rstatus[r] ?? "").replace(/^blocked:/i, ""));
    const dated = (r: number): string => watchDate(rstatus[r] ?? "");
    const open: number[] = [];
    for (let r = 0; r < nrow; r++) if (kind[r] !== "done" && kind[r] !== "closed") open.push(r);
    // blocked-on names the wait that ends first — the earliest `blocked: until`
    // date, the day the project reads active again — else the first wait in
    // table order.
    const released = (r: number): string => releaseDate(rstatus[r] ?? "");
    // A row that would be ready but for another project's open row is a wait
    // too — unless any of its entries is unresolved: a typo never reads as a
    // wait, so the table is refused below rather than blocked on nothing.
    const waitsOn = (r: number): DepResult[] => {
      if (kind[r] !== "planned" && kind[r] !== "in-progress") return [];
      const ds = deps[r] ?? [];
      if (ds.some((x) => x.state === "unresolved")) return [];
      return ds.filter((x) => x.project !== "" && x.state === "open");
    };
    const isWait = (r: number): boolean => (kind[r] === "blocked" && dated(r) === "") || waitsOn(r).length > 0;
    let waiting: number | undefined;
    for (const r of open) {
      if (!isWait(r)) continue;
      if (waiting === undefined) waiting = r;
      else if (released(r) !== "" && (released(waiting) === "" || released(r) < released(waiting))) waiting = r;
    }
    /** Ready once every blocked row it waits on clears: planned or in-progress, every dependency known and closed, blocked, another project's row, or itself able to be ready. A row met again on the way (`seen`) is a cycle. */
    const canBeReady = (r: number, seen: Set<number>): boolean => {
      if (kind[r] !== "planned" && kind[r] !== "in-progress") return false;
      if (seen.has(r)) return false;
      seen.add(r);
      const ok = (deps[r] ?? []).every((x) => {
        if (x.state === "unresolved") return false;
        if (x.project !== "" || x.state === "satisfied") return true;
        const at = byid.get(x.id.toUpperCase()) ?? -1;
        return kind[at] === "blocked" || canBeReady(at, seen);
      });
      seen.delete(r);
      return ok;
    };
    let watch = -1;
    for (const r of open) {
      if (kind[r] !== "blocked" || dated(r) === "") continue;
      if (watch < 0 || dated(r) < dated(watch)) watch = r;
    }
    if (pick >= 0) d.status = "active";
    else if (waiting !== undefined) {
      d.status = "blocked";
      const on = waitsOn(waiting);
      d.blockedOn = cut60(
        `${rid[waiting]}: `,
        kind[waiting] === "blocked" ? what(waiting) : `waits on ${on.map((x) => `${x.project} ${x.id}`).join(", ")}`,
      );
    } else if (watch >= 0) {
      // Monitor says every open row is a watch or waits on one. A row that can
      // never be ready — in a dependency cycle, of unknown status, or after an
      // unknown row — is neither, and is refused as the template's last clause
      // refuses it, rather than hidden behind the watch.
      const never = open.filter((r) => kind[r] !== "blocked" && !canBeReady(r, new Set()));
      if (never.length > 0) {
        fail(
          `cannot derive status: ${never.map((r) => rid[r]).join(", ")} open and never ready (a dependency cycle, an unknown status or an unknown Depends on) — give each a status or fix its Depends on`,
        );
      }
      d.status = "monitor";
      d.monitoringUntil = cut60(`${dated(watch)} — ${rid[watch]}: `, rfeat[watch] ?? "");
    } else if (open.length === 0) d.status = "completed";
    else {
      fail(
        `cannot derive status: ${open.map((r) => rid[r]).join(", ")} open, none ready or blocked — give each a status or fix its Depends on`,
      );
    }
    for (const key of DERIVED_KEYS) {
      const v = derivedValue(d, key);
      if (v !== "") out.text += `${key}: ${v}\n`;
    }
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
  if (set.subspec === "manual") seg[colSub] = " manual ";
  else if (set.subspec !== "") seg[colSub] = ` \`${bytes(set.subspec)}\` `;
  lines[ln] = seg.join("|");
  for (const l of lines) out.text += `${l}\n`;
  return 0;
}

/**
 * The list mode's rows in this process, one string[] of the five TSV fields per
 * row, with any message the parse would print returned in `messages` instead.
 * For rows-taken.ts, which reads one ROADMAP.md per open thread and cannot start
 * a program for each inside its one-second budget. `given` parses those bytes
 * instead of the file — a committed copy read with `git show` — and `roadmap`
 * then only names it in messages.
 *
 * Beside each row, index for index: `dependsOn`, its raw `Depends on` cell, and
 * `deps`, each entry resolved — another project's row included, read under
 * `opts.projectsRoot` (the folder holding `projects/`; null for none), else the
 * root above `roadmap`.
 */
export function listRows(
  roadmap: string,
  given?: Buffer,
  opts: { projectsRoot?: string | null } = {},
): { ok: boolean; rows: string[][]; deps: DepResult[][]; dependsOn: string[]; messages: string[] } {
  const messages: string[] = [];
  const out: { text: string; deps?: DepResult[][]; dependsOn?: string[] } = { text: "" };
  let rc = 1;
  errSink = (m) => messages.push(m);
  projectsRootOpt = opts.projectsRoot;
  try {
    rc = parse(roadmap, "list", { id: "", status: "", subspec: "" }, out, given);
  } catch (e) {
    messages.push(e instanceof Error ? e.message : String(e));
  } finally {
    errSink = null;
    projectsRootOpt = undefined;
  }
  if (rc !== 0) return { ok: false, rows: [], deps: [], dependsOn: [], messages };
  const rows = out.text
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));
  return { ok: true, rows, deps: out.deps ?? [], dependsOn: out.dependsOn ?? [], messages };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 1) usage();
  const projectDir = argv[0] ?? "";
  const rest = argv.slice(1);
  const at = rest.indexOf("--projects-root");
  if (at >= 0) {
    const dir = rest[at + 1] ?? "";
    if (!isDir(dir)) {
      err(`--projects-root '${dir}' is not a directory`);
      exit(2);
    }
    projectsRootOpt = resolve(dir);
    rest.splice(at, 2);
  }
  if (!isDir(projectDir)) {
    err(`not a directory: ${projectDir}`);
    exit(2);
  }
  const roadmap = `${projectDir}/ROADMAP.md`;

  let mode: "list" | "next" | "ready" | "check" | "derive" | "set" | "sync" = "list";
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
    case "--derive":
      mode = "derive";
      if (rest.length !== 1) usage();
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
      if (rest.length === 5 && set.subspec !== "manual" && !SPEC_FOLDER.test(set.subspec)) {
        err(`--sub-spec '${set.subspec}' is not specs/NNN-name/ or manual`);
        exit(2);
      }
      const s = set.status;
      const okStatus =
        s === "planned" ||
        s === "in-progress" ||
        s === "done" ||
        (s.startsWith("blocked: ") && s.length > "blocked: ".length) ||
        (s.startsWith("absorbed by ") && s.length > "absorbed by ".length) ||
        (s.startsWith("closed: ") && s.length > "closed: ".length);
      if (!okStatus) {
        err(`not a status: '${s}' (planned · in-progress · done · blocked: <what> · absorbed by <ID> · closed: <why>)`);
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

  if (mode === "list" || mode === "next" || mode === "ready" || mode === "derive") {
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
  const derivedOut = { text: "" };
  if (parse(roadmap, "derive", set, derivedOut) !== 0) exit(1);
  const want = new Map<string, string>();
  for (const line of derivedOut.text.split("\n")) {
    const at = line.indexOf(": ");
    if (at > 0) want.set(line.slice(0, at), bytes(line.slice(at + 2)));
  }
  const tmp = mktempBeside(readme);
  if (tmp === null) {
    err(`cannot write beside ${readme}`);
    exit(1);
  }

  // Only frontmatter lines are touched. Each derived key that exists is replaced
  // where it stands — with any indented continuation lines it carried — or
  // removed when the status does not carry it; a missing one goes after the
  // `description:` entry, or before the closing `---` when there is none, in
  // the order status, next, blocked-on, monitoring-until.
  let closeAt = 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") {
      closeAt = i + 1;
      break;
    }
  }
  if (closeAt === 0) {
    err("README.md frontmatter never closes");
    exit(1);
  }
  const keyOf = (line: string): string => DERIVED_KEYS.find((k) => line.startsWith(`${k}:`)) ?? "";
  let descEnd = 0; // FNR of the description entry's last line
  for (let FNR = 2; FNR < closeAt; FNR++) {
    if (/^description:/.test(lines[FNR - 1] ?? "")) {
      descEnd = FNR;
      while (descEnd + 1 < closeAt && /^[ \t]/.test(lines[descEnd] ?? "")) descEnd++;
    }
  }
  const present = new Set(
    lines
      .slice(1, closeAt - 1)
      .map(keyOf)
      .filter((k) => k !== ""),
  );
  const written = new Set<string>();
  let out = "";
  for (let FNR = 1; FNR <= lines.length; FNR++) {
    const line = lines[FNR - 1] ?? "";
    const key = FNR > 1 && FNR < closeAt ? keyOf(line) : "";
    if (key !== "") {
      while (FNR < closeAt - 1 && /^[ \t]/.test(lines[FNR] ?? "")) FNR++;
      const v = want.get(key) ?? "";
      if (v !== "" && !written.has(key)) out += `${key}: ${v}\n`;
      written.add(key);
    } else out += `${line}\n`;
    if (FNR === (descEnd || closeAt - 1)) {
      for (const k of DERIVED_KEYS) {
        const v = want.get(k) ?? "";
        if (!present.has(k) && v !== "") out += `${k}: ${v}\n`;
      }
    }
  }
  if (lacksFinalNewline(raw)) out = out.slice(0, -1);
  if (!replaceAtomic(readme, tmp, out)) {
    err(`cannot write ${readme}`);
    exit(1);
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
