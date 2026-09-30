#!/usr/bin/env -S node --experimental-strip-types
// roadmap-merge.ts — a git merge driver for ROADMAP.md: merge the table row by row.
//
// WHY. Two sessions building two rows of one project each flip their own row
// (planned → in-progress → done) and re-derive the README's `next:`. The rows are
// adjacent lines, and git's line merge calls adjacent edits a conflict, so the
// second of two parallel closes always stopped on NOT CLOSED with a conflict
// nobody had actually made. Keyed by row ID, the two edits never touch.
//
// THE RULES, per row ID across base (O), ours (A) and theirs (B):
//   - changed on one side only → that side's row (a `blocked: …` or
//     `absorbed by …` Status arrives exactly as the side that wrote it);
//   - added on one side → kept; added on both with the same text → kept once;
//   - deleted on one side and untouched on the other → deleted;
//   - changed on both → cell by cell: a cell only one side changed takes that
//     side's value; Status both changed takes the more advanced of
//     planned < in-progress < done; Sub-spec both changed takes the one that is
//     not `—`. Anything else — the same cell set to two different texts, a
//     `blocked:`/`absorbed by` both sides set differently, a row deleted on one
//     side and edited on the other — is a real conflict.
// Everything outside the table rows (the prose, the header) merges as whole
// blocks: identical, or changed on one side only. A real conflict anywhere
// falls back to git's own line merge, markers and all, and exits 1, so the
// close stops exactly as it did before.
//
// A PROJECT README (the path's last part is README.md) is merged by git's own
// line merge with one line set aside: its front-matter `next:`, which both
// sessions re-derive from their own copy of the table and so rewrite two ways.
// Ours is kept here, and land.ts re-derives it from the merged ROADMAP.md right
// after the merge, so the value that lands describes the merged table.
//
// The table is the one roadmap.ts reads: the first table under `# Roadmap`
// whose header names both ID and Status; Status and Sub-spec are found by
// header name. Cells split on unescaped `|`.
//
// Usage (git runs it; land.ts registers it before it merges):
//   roadmap-merge.ts <base> <ours> <theirs> [<path>]    result written to <ours>;
//   <path> ending in README.md selects the README rule above
// Exit: 0 merged cleanly · 1 conflict (markers written to <ours>) · 2 usage
//
// BYTES. The bash original ran its awk under LC_ALL=C, so it compared and wrote
// bytes. Files are read here as latin1 — one char per byte — and written back
// the same way, so a byte that is not valid UTF-8 survives a merge unchanged.
//
// peers:
//   .agents/skills/close/scripts/roadmap-merge.test.ts
//   .agents/skills/close/scripts/roadmap.ts   (the table's one reader and writer)
//   .agents/skills/close/scripts/land.ts      (registers the driver before merging)

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** awk's records of a file, one char per byte. */
function records(path: string): string[] {
  const text = readFileSync(path).toString("latin1");
  const lines = text === "" ? [] : text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
const writeBytes = (path: string, text: string): void => writeFileSync(path, Buffer.from(text, "latin1"));

/** `git merge-file -L … <current> <base> <other>`, output silenced; true when it merged cleanly. */
function gitMergeFile(name: string, current: string, base: string, other: string): boolean {
  const r = spawnSync(
    "git",
    ["merge-file", "-L", `${name} (ours)`, "-L", `${name} (base)`, "-L", `${name} (theirs)`, current, base, other],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

/** The file's lines with its front-matter `next:` line replaced by `want` (removed when that is empty). */
function nextAside(file: string, want: string): string {
  let fm = false;
  let done = false;
  let out = "";
  records(file).forEach((line, i) => {
    if (i === 0 && line === "---") {
      fm = true;
      out += `${line}\n`;
      return;
    }
    if (fm && line === "---") {
      fm = false;
      out += `${line}\n`;
      return;
    }
    if (fm && /^next:/.test(line) && !done) {
      done = true;
      if (want !== "") out += `${want}\n`;
      return;
    }
    out += `${line}\n`;
  });
  return out;
}

/** Ours' front-matter `next:` line, or "". */
function oursNext(file: string): string {
  const lines = records(file);
  if (lines[0] !== "---") return "";
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line === "---") return "";
    if (/^next:/.test(line)) return line;
  }
  return "";
}

// ── The table merge, the awk program of the bash original ─────────────────
//
// awk arrays are never cleared between calls, so a short row reads the cells a
// longer row left behind at the same index. The cell arrays below persist the
// same way, so every row this merges or refuses is merged or refused as before.

class Conflict {}
const conflict = (): never => {
  throw new Conflict();
};

const trim = (s: string): string => s.replace(/^[ \t]+/, "").replace(/[ \t]+$/, "");

/**
 * Split a table line into C[1..n] on unescaped pipes; returns n. C[1] is what
 * precedes the first pipe and C[n] what follows the last, so the cells are
 * C[2..n-1]. The trailing pipe is optional, as roadmap.ts reads it: a row
 * without one gets an empty C[n] after its last cell rather than losing it.
 */
function cells(line: string, C: string[]): number {
  let n = 0;
  let cur = "";
  let prev = "";
  for (const ch of line) {
    if (ch === "|" && prev !== "\\") {
      C[++n] = trim(cur);
      cur = "";
    } else cur += ch;
    prev = ch;
  }
  C[++n] = trim(cur);
  if (n > 1 && C[n] !== "") C[++n] = "";
  return n;
}

// tolower under LC_ALL=C folds ASCII only.
const lowerAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
function rank(s: string): number {
  const t = lowerAscii(s);
  return t === "planned" ? 0 : t === "in-progress" ? 1 : t === "done" ? 2 : -1;
}
const cell = (C: string[], i: number): string => C[i] ?? "";
// The em dash as the bytes the lines are held in (UTF-8 read as latin1).
const EM_DASH = Buffer.from("—", "utf8").toString("latin1");

/** The merged file, or a thrown Conflict. `files` are base, ours, theirs, in that order. */
function mergeTable(files: string[]): string {
  // { L[FILENAME, ++N[FILENAME]] = $0 }  FNR == 1 { F[++nf] = FILENAME }
  const L = new Map<string, string[]>();
  const F: string[] = [];
  for (const f of files) {
    const lines = records(f);
    if (lines.length > 0) F.push(f);
    const have = L.get(f) ?? [];
    have.push(...lines);
    L.set(f, have);
  }
  if (F.length !== 3) conflict();

  const C: string[] = [];
  const H: number[] = [];
  const idc: number[] = [];
  const R0: number[] = [];
  const R1: number[] = [];
  const pre: string[] = [];
  const post: string[] = [];
  const ids: number[] = [];
  const ROW = new Map<string, string>();
  const ORD = new Map<string, string>();
  const key = (k: number, id: string): string => `${k}\x1c${id}`;
  const lineOf = (f: string, i: number): string => L.get(f)?.[i - 1] ?? "";

  for (let k = 1; k <= 3; k++) {
    const f = F[k - 1] ?? "";
    const N = L.get(f)?.length ?? 0;
    H[k] = 0;
    let inr = false;
    for (let i = 1; i <= N; i++) {
      const l = lineOf(f, i);
      if (/^#[ \t]+Roadmap([ \t:]|$)/.test(l)) inr = true;
      if (inr && !H[k] && /^[ \t]*\|/.test(l)) {
        // Header names compared without case, as roadmap.ts compares them.
        const n = cells(l, C);
        idc[k] = 0;
        let hasst = false;
        for (let c = 2; c < n; c++) {
          if (lowerAscii(cell(C, c)) === "id") idc[k] = c;
          if (lowerAscii(cell(C, c)) === "status") hasst = true;
        }
        if (idc[k] && hasst) {
          H[k] = i;
          break;
        }
      }
    }
    const h = H[k] ?? 0;
    if (!h) conflict();
    // Rows run from the line after the separator to the first non-table line.
    const r0 = h + 2;
    let r1 = r0 - 1;
    for (let i = r0; i <= N && /^[ \t]*\|/.test(lineOf(f, i)); i++) r1 = i;
    R0[k] = r0;
    R1[k] = r1;
    let p = "";
    for (let i = 1; i <= h + 1; i++) p += `${lineOf(f, i)}\n`;
    pre[k] = p;
    let q = "";
    for (let i = r1 + 1; i <= N; i++) q += `${lineOf(f, i)}\n`;
    post[k] = q;
    ids[k] = 0;
    for (let i = r0; i <= r1; i++) {
      cells(lineOf(f, i), C);
      const id = cell(C, idc[k] ?? 0);
      if (id === "" || ROW.has(key(k, id))) conflict();
      ROW.set(key(k, id), lineOf(f, i));
      ids[k] = (ids[k] ?? 0) + 1;
      ORD.set(`${k}\x1c${ids[k]}`, id);
    }
  }

  // Column positions, by header name, from ours (the headers must agree).
  const HC: string[] = [];
  const nh = cells(lineOf(F[1] ?? "", H[2] ?? 0), HC);
  let stc = 0;
  let sbc = 0;
  for (let c = 2; c < nh; c++) {
    if (lowerAscii(cell(HC, c)) === "status") stc = c;
    if (lowerAscii(cell(HC, c)) === "sub-spec") sbc = c;
  }
  // Prose and header: identical, or changed on one side only.
  let P: string;
  if (pre[2] === pre[3] || pre[3] === pre[1]) P = pre[2] ?? "";
  else if (pre[2] === pre[1]) P = pre[3] ?? "";
  else return conflict();
  let Q: string;
  if (post[2] === post[3] || post[3] === post[1]) Q = post[2] ?? "";
  else if (post[2] === post[1]) Q = post[3] ?? "";
  else return conflict();

  let out = P;
  // Ours in its own order; each row only theirs has goes where theirs put it:
  // right after the row that precedes it in theirs, past any rows ours added
  // there (so two sides appending keep ours first). When that preceding row is
  // one ours deleted, there is no place to put it — a conflict, not a guess.
  const SEQ: string[] = []; // 1-based, as in awk
  let nout = 0;
  const INSEQ = new Set<string>();
  const ord = (k: number, j: number): string => ORD.get(`${k}\x1c${j}`) ?? "";
  for (let j = 1; j <= (ids[2] ?? 0); j++) {
    SEQ[++nout] = ord(2, j);
    INSEQ.add(ord(2, j));
  }
  for (let j = 1; j <= (ids[3] ?? 0); j++) {
    const id = ord(3, j);
    if (INSEQ.has(id)) continue;
    // In base but not in ours: ours deleted it. Deleted it stays, unless theirs
    // edited it — a delete against an edit is a conflict.
    if (ROW.has(key(1, id))) {
      if (ROW.get(key(3, id)) !== ROW.get(key(1, id))) conflict();
      continue;
    }
    let pos: number;
    if (j === 1) pos = 0;
    else {
      const prev = ord(3, j - 1);
      if (!INSEQ.has(prev)) conflict();
      for (pos = 1; pos <= nout && SEQ[pos] !== prev; pos++);
      while (pos < nout && !ROW.has(key(1, SEQ[pos + 1] ?? "")) && !ROW.has(key(3, SEQ[pos + 1] ?? ""))) pos++;
    }
    for (let q = nout; q > pos; q--) SEQ[q + 1] = SEQ[q] ?? "";
    SEQ[pos + 1] = id;
    nout++;
    INSEQ.add(id);
  }
  // A row in base only was deleted on both sides: it is in neither list.

  const CA: string[] = [];
  const CB: string[] = [];
  const CO: string[] = [];
  for (let j = 1; j <= nout; j++) {
    const id = SEQ[j] ?? "";
    const ino = ROW.has(key(1, id));
    const ina = ROW.has(key(2, id));
    const inb = ROW.has(key(3, id));
    const o = ROW.get(key(1, id)) ?? "";
    const a = ROW.get(key(2, id)) ?? "";
    const b = ROW.get(key(3, id)) ?? "";
    if (ina && inb) {
      if (a === b || b === o) {
        out += `${a}\n`;
        continue;
      }
      if (a === o) {
        out += `${b}\n`;
        continue;
      }
      // Both changed: cell by cell.
      const na = cells(a, CA);
      const nb = cells(b, CB);
      let no: number;
      if (ino) no = cells(o, CO);
      else {
        no = na;
        for (let c = 1; c <= no; c++) CO[c] = "\x01";
      }
      if (na !== nb || na !== no) conflict();
      let row = "";
      for (let c = 2; c < na; c++) {
        const x = cell(CA, c);
        const y = cell(CB, c);
        const z = cell(CO, c);
        let v: string;
        if (x === y || y === z) v = x;
        else if (x === z) v = y;
        else if (c === stc && rank(x) >= 0 && rank(y) >= 0) v = rank(x) >= rank(y) ? x : y;
        else if (c === sbc && (x === EM_DASH || x === "-" || x === "")) v = y;
        else if (c === sbc && (y === EM_DASH || y === "-" || y === "")) v = x;
        else return conflict();
        row += `| ${v} `;
      }
      out += `${row}|\n`;
    } else if (ina) {
      // Theirs lacks it: new in ours, or deleted in theirs.
      if (!ino) out += `${a}\n`;
      else if (a !== o) conflict();
    } else if (inb) {
      if (!ino) out += `${b}\n`;
      else if (b !== o) conflict();
    }
  }
  return out + Q;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length < 3) {
    process.stderr.write("usage: roadmap-merge.ts <base> <ours> <theirs> [<path>]\n");
    exit(2);
  }
  const BASE = argv[0] ?? "";
  const OURS = argv[1] ?? "";
  const THEIRS = argv[2] ?? "";
  const NAME = argv[3] || "ROADMAP.md";
  for (const f of [BASE, OURS, THEIRS]) {
    if (!isFile(f)) {
      process.stderr.write(`roadmap-merge: no such file: ${f}\n`);
      exit(2);
    }
  }

  const TMP = mkdtempSync(join(tmpdir(), "roadmap-merge-"));
  try {
    if (basename(NAME) === "README.md") {
      const want = oursNext(OURS);
      writeBytes(join(TMP, "o"), nextAside(BASE, want));
      writeBytes(join(TMP, "b"), nextAside(THEIRS, want));
      exit(gitMergeFile(NAME, OURS, join(TMP, "o"), join(TMP, "b")) ? 0 : 1);
    }

    let merged = "";
    try {
      merged = mergeTable([BASE, OURS, THEIRS]);
    } catch (e) {
      if (!(e instanceof Conflict)) throw e;
    }

    if (merged !== "") {
      // git reads the result out of <ours>: a write that failed is a failed merge,
      // never a clean one over whatever the file was left holding.
      try {
        writeBytes(OURS, merged);
      } catch {
        process.stderr.write(`roadmap-merge: could not write the merged table to ${OURS}\n`);
        exit(1);
      }
      exit(0);
    }

    // A real conflict, or a file this driver cannot read as a roadmap: git's own
    // line merge, markers and all. It exits with the number of conflicts, so a file
    // it merges cleanly (a roadmap whose table did not move) still merges.
    exit(gitMergeFile(NAME, OURS, BASE, THEIRS) ? 0 : 1);
  } finally {
    rmSync(TMP, { recursive: true, force: true });
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
