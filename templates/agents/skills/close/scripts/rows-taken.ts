#!/usr/bin/env -S node --experimental-strip-types
// rows-taken.ts — which rows of a project another open T3 thread is building.
//
// WHY. Two threads that run `/project <slug>` the same morning are both sent to
// the same next row by detect-stage.ts, and the second learns it only when its
// landing conflicts with the first's, hours later. `/implement` already marks
// the row it builds `in-progress`, but in its own thread's worktree, which no
// other thread reads. Claim files would be one more thing to keep in step, so
// this reads the open threads from T3's state database and each one's own copy
// of the project's ROADMAP.md instead. Nothing is stored. Outside T3 there is no
// such database, and no row is held.
//
// A ROW IS HELD ONLY BY A MARK THE WORKTREE ADDED. A row `in-progress` on
// origin/main is in every worktree cut from it, so it says nothing about who is
// building it: a project with ten manual rows committed `in-progress` would name
// every open thread as their builder.
// So a row counts when the worktree has it `in-progress` and the commit the
// worktree was cut from does not — its merge-base with origin/main, never
// origin/main's tip: main may since have moved an inherited row back to planned
// or done, which an old worktree still shows `in-progress` without having
// touched it. The thread's own flip is uncommitted until the close, or in a
// commit of its own branch, so it is never in that base; once the branch lands,
// the base is its head and nothing in it counts. A project the base does not
// hold yet has no inherited marks, so every mark in it counts. When that base
// cannot be read at all (no origin/main, a git error, a malformed copy) the
// worktree is skipped with a note, never read as holding everything.
//
// Only building holds a row (planning does not), and a thread the user forgot
// to settle holds its row until they settle it; every line names the thread so
// they can.
//
// Usage: rows-taken.ts <project-folder>
//   <project-folder> — relative or absolute, in any checkout; read as its
//   `projects/<domain>/<date>_<slug>` path, which is what is opened in each
//   other worktree.
//
// Output: one line per (row, holder), sorted by ID then thread id:
//   <ID>\t<thread title>\t<thread id>\t<worktree path>
// A title's tabs and newlines print as spaces; an empty title as `(untitled)`.
//
// Not a holder:
//   - this thread's own worktree — the checkout the shell stands in
//     (CONTEXT_WRITE_ROOT overrides it, as it does session-write-root.ts);
//   - a child task (t3-db.ts openThreads says how one is told apart);
//   - any checkout that is not a linked worktree (`.git` is not a file): the
//     shared checkout, where no thread owns edits and a stray flip would hold a
//     row for good;
//   - a worktree missing from disk, or without this project's ROADMAP.md;
//   - several threads on one worktree count once, as the earliest.
//
// NEVER FAILS ROUTING. This check only narrows a choice that is right without
// it, so anything it cannot read — no database, a locked or malformed one, one
// bad thread row, one malformed ROADMAP.md — is a `rows-taken:` note on stderr
// and "not held". Exit 0 always, except 2 for a usage error.
//
// Env: T3CODE_HOME (default ~/.t3), CONTEXT_WRITE_ROOT.
//
// Readers: .agents/skills/project/scripts/detect-stage.ts (next-row, `taken:` lines),
// .agents/skills/implement/scripts/setup-worktree.sh (an explicit `--shard`),
// .agents/skills/implement/SKILL.md Phase 1 (a T3 thread's gate),
// .agents/skills/close/scripts/next-implement-command.ts (the close's printed commands).
//
// peers:
//   .agents/skills/close/scripts/rows-taken.test.ts
//   .agents/skills/close/scripts/t3-db.ts     (openThreads)
//   .agents/skills/close/scripts/roadmap.ts   (listRows — the one table parser)

import { spawn } from "node:child_process";
import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";
import { listRows } from "./roadmap.ts";
import { loadSqlite, type OpenThread, openThreads, t3Database } from "./t3-db.ts";

const note = (msg: string): void => {
  process.stderr.write(`rows-taken: ${msg}\n`);
};

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** The checkout holding `dir`: the nearest ancestor with a `.git` entry, or null. */
function checkoutOf(dir: string): string | null {
  let d = real(dir);
  while (d !== null) {
    if (existsSync(join(d, ".git"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
  return null;
}

/** A linked git worktree: its `.git` is a file pointing into the main repository. */
function isLinkedWorktree(dir: string): boolean {
  try {
    return lstatSync(join(dir, ".git")).isFile();
  } catch {
    return false;
  }
}

/** IDs of the rows `in-progress` in a parsed table. */
const inProgress = (rows: string[][]): Set<string> =>
  new Set(rows.filter((r) => (r[1] ?? "").toLowerCase() === "in-progress").map((r) => r[0] ?? ""));

/** `git -C wt …` without blocking, so every worktree's reads run at once: a project marked in every worktree took 1.2 s read one after another. */
function git(wt: string, args: string[], input = ""): Promise<{ status: number | null; stdout: Buffer }> {
  return new Promise((done) => {
    const p = spawn("git", ["-C", wt, ...args], { stdio: ["pipe", "pipe", "ignore"] });
    const out: Buffer[] = [];
    p.stdout.on("data", (b: Buffer) => out.push(b));
    p.on("error", () => done({ status: null, stdout: Buffer.alloc(0) }));
    p.on("close", (status) => done({ status, stdout: Buffer.concat(out) }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

/**
 * The rows `in-progress` in `project` at the commit `wt` was cut from (its
 * merge-base with origin/main): marks the worktree inherited, not made. Empty
 * when that commit has no copy of the project; a string saying why when the
 * base cannot be read. `cat-file --batch` says `<name> missing` for a path the
 * commit lacks, so an absent file is never confused with a failed read.
 */
async function inherited(wt: string, project: string): Promise<Set<string> | string> {
  const base = await git(wt, ["merge-base", "HEAD", "refs/remotes/origin/main"]);
  const sha = base.stdout.toString().trim();
  if (base.status !== 0 || sha === "") return "no merge-base with origin/main";
  const path = `${sha}:${project}/ROADMAP.md`;
  const got = await git(wt, ["cat-file", "--batch"], `${path}\n`);
  const nl = got.stdout.indexOf(10);
  const header = nl < 0 ? "" : got.stdout.subarray(0, nl).toString();
  if (got.status !== 0 || nl < 0) return `git cat-file ${path} failed`;
  if (header === `${path} missing`) return new Set();
  const size = /^[0-9a-f]+ blob (\d+)$/.exec(header)?.[1];
  if (size === undefined) return `git cat-file ${path}: ${header}`;
  const parsed = listRows(path, got.stdout.subarray(nl + 1, nl + 1 + Number(size)));
  return parsed.ok ? inProgress(parsed.rows) : `${path} is malformed (${parsed.messages.at(-1) ?? "unreadable"})`;
}

/** The threads T3 has open, or [] with a note when its database cannot be read. */
async function readOpenThreads(): Promise<OpenThread[]> {
  const t3Home = process.env.T3CODE_HOME || join(process.env.HOME || homedir(), ".t3");
  const dbPath = t3Database(t3Home);
  if (!isFile(dbPath)) {
    note(`no T3 database at ${dbPath}; no row is held`);
    return [];
  }
  const sqlite = await loadSqlite(fileURLToPath(import.meta.url));
  try {
    const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    try {
      return openThreads(db, note);
    } finally {
      db.close();
    }
  } catch (e) {
    note(`cannot read ${dbPath} (${e instanceof Error ? e.message : String(e)}); no row is held`);
    return [];
  }
}

async function main(): Promise<void> {
  const arg = process.argv[2] ?? "";
  const m = /(?:^|\/)(projects\/[^/]+\/[^/]+?)\/*$/.exec(resolve(arg));
  if (process.argv.length !== 3 || arg === "" || m === null) {
    note("usage: rows-taken.ts <project-folder>   (a projects/<domain>/<date>_<slug> folder)");
    exit(2);
  }
  const project = m?.[1] ?? "";
  const own = real(process.env.CONTEXT_WRITE_ROOT || checkoutOf(process.cwd()) || process.cwd());

  const seen = new Set<string>();
  const candidates: { t: OpenThread; wt: string; marked: Set<string> }[] = [];
  for (const t of await readOpenThreads()) {
    const wt = real(t.worktreePath);
    if (wt === null || wt === own || seen.has(wt)) continue;
    seen.add(wt);
    if (!isLinkedWorktree(wt)) continue;
    const roadmap = join(wt, project, "ROADMAP.md");
    if (!isFile(roadmap)) continue;
    const r = listRows(roadmap);
    if (!r.ok) {
      note(`${roadmap} is malformed (${r.messages.at(-1) ?? "unreadable"}); skipped`);
      continue;
    }
    const marked = inProgress(r.rows);
    if (marked.size > 0) candidates.push({ t, wt, marked });
  }
  const bases = await Promise.all(candidates.map((c) => inherited(c.wt, project)));
  const lines: { id: string; thread: string; line: string }[] = [];
  for (const [i, { t, wt, marked }] of candidates.entries()) {
    const base = bases[i] ?? "not read";
    if (typeof base === "string") {
      note(`${wt}: ${base}; skipped`);
      continue;
    }
    const title = t.title.replace(/[\t\r\n]+/g, " ").trim() || "(untitled)";
    for (const id of marked) {
      if (id !== "" && !base.has(id)) {
        lines.push({ id, thread: t.id, line: `${id}\t${title}\t${t.id}\t${t.worktreePath}` });
      }
    }
  }
  const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });
  lines.sort((a, b) => byId(a.id, b.id) || (a.thread < b.thread ? -1 : a.thread > b.thread ? 1 : 0));
  process.stdout.write(lines.map((l) => `${l.line}\n`).join(""));
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
