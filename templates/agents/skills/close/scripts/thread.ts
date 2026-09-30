#!/usr/bin/env -S node --experimental-strip-types
// thread.ts — which session (thread) is this shell in?
//
// A session is a thread: in T3 Code, a T3 thread; in any other harness, the
// harness's own session. Everything the close does — which worktrees this
// session owns, where its journal file goes, what the user actually typed —
// hangs off that thread id. T3 Code's id is read from T3's own record, never
// invented; outside T3 the harness's session id is used, and when the harness
// exports none, one is generated once and remembered for this tree.
//
// WHY NOT AN ENVIRONMENT VARIABLE. `CLAUDE_CODE_SESSION_ID` exists and would be
// one line, but it is Claude-only and the point of this close is that Codex,
// Grok Build and Antigravity run it unchanged. T3 itself exports no thread
// variable — the 0.0.40 bundle sets `T3CODE_HOME`, `T3_BOOT_SERVICE_UNIT` and
// `T3_SERVICE_LAUNCHER_CONTEXT`, and nothing else. What every harness DOES
// share is the directory it was started in, and T3's db maps that directory to
// the thread.
//
// THREE PLACES THE ANSWER CAN COME FROM, in order:
//
//   1. The T3 database, keyed on the toplevel of the current directory. This is
//      the normal case: the shell stands in the thread's own worktree.
//   2. The ledger, keyed the same way. Once a session has written to a SECOND
//      repo it has a satellite worktree, and a shell standing in that satellite
//      is in no T3 worktree at all — the db has never heard of the path. The
//      ledger that recorded the satellite knows which thread owns it.
//   3. Outside T3: the harness's session id (harness.sh — CONTEXTIUM_SESSION,
//      CLAUDE_CODE_SESSION_ID), else a generated `session-<date>-<random>` kept
//      in ~/.cache/workbench/sessions/ for the tree the shell stands in (the
//      main checkout, or the linked worktree the session started in) until a
//      close of it lands. Two id-less sessions in one checkout at once share
//      that id; in two worktrees of their own (T3 Code, `claude -w`, …) they
//      get two.
//      The thread's start is recorded the first time the id is seen.
//
// Exactly one ledger may claim a path. Two claiming it is a corrupted cache
// rather than a question to answer by picking one, so it exits 2.
//
// WHY THE FULL ID AND NOT A PREFIX. The worktrees write-root.sh makes for other
// repos are named by the whole uuid (T3's own `t3code-<8 hex>` folders are not
// derived from the id at all). An 8-character prefix reads better and two threads can share one; the
// collision would land one session's commits in another's ledger.
//
// Usage:
//   thread.ts                  — the thread id
//   thread.ts --id             — same
//   thread.ts --branch         — the branch T3 gave the thread's worktree
//   thread.ts --worktree       — the thread's own worktree path (T3's, or the
//                                linked worktree a harness started it in)
//   thread.ts --started        — thread creation time, ISO 8601 as stored
//   thread.ts --started --local      — the same instant as HHMM, local time
//   thread.ts --started --local-day  — the same instant as YYYY-MM-DD, local time
//                                (`--la` is accepted as the old name of --local)
//
// Env:
//   WORKBENCH_THREAD_ID — override. For a plain terminal and for the test
//                         suites; nothing in a real session sets it. With it
//                         set, `--id` answers from it alone, and the other
//                         modes still need the database row.
//   T3CODE_HOME         — T3's data root. Defaults to ~/.t3; T3 exports it to
//                         the providers it runs.
//   CONTEXTIUM_SESSION, CLAUDE_CODE_SESSION_ID — a non-T3 session's id
//                         (harness.sh reads them).
//
// peers:
//   .agents/skills/close/scripts/thread.test.ts
//   .agents/skills/close/scripts/write-root.sh   (the ledger's writer)
//   .agents/skills/close/scripts/harness.sh      (the harness's session id)
//
// Exit: 0 ok (answer on stdout) · 2 no thread, or an unreadable database

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

function fail(msg: string): never {
  process.stderr.write(`thread: ${msg}\n`);
  return exit(2);
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The child that reads the database. It is a separate `node` — the one on PATH,
// as the bash original ran it — rather than node:sqlite loaded in this process:
// Node 22 warns on stderr when node:sqlite loads, and callers capture this
// script's stderr with its answer (`$(node … thread.ts --id 2>&1)`). The child
// runs with `--disable-warning=ExperimentalWarning`, a flag that exists on every
// Node that has node:sqlite (22.5+); this process cannot turn its own warning
// off after it has started. And with `--experimental-sqlite`: Node 22.5–22.12
// load node:sqlite only behind it, and every later Node accepts it as a no-op.
const DB_CHILD = `
const { DatabaseSync } = require("node:sqlite");
const [dbPath, sql, ...params] = process.argv.slice(1);
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
} catch (e) {
  process.stderr.write(e.message + "\\n");
  process.exit(3);
}
const row = db.prepare(sql).get(...params);
if (!row) process.exit(4);
process.stdout.write(
  Object.values(row).map((v) => (v === null ? "" : String(v))).join("\\x1f"),
);
`;

// One query, one row, fields joined by \x1f — or status 4 for "no such row" so the
// caller can tell an empty result from a broken database (3). Read-only is not
// politeness: T3 is usually running and writing, and an accidental write lock
// here would stall the UI.
function dbRow(db: string, sql: string, ...params: string[]): { status: number; row: string } {
  const r = spawnSync("node", ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", "-e", DB_CHILD, db, sql, ...params], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // A command substitution drops trailing newlines; the row has none of its own.
  return { status: r.status ?? 1, row: (r.stdout ?? "").replace(/\n+$/, "") };
}

// The row's columns, split on the unit separator, empty ones kept: a null
// column is printed as an empty field, and collapsing a run of whitespace
// separators around it shifted every later column one to the left.
function fields(row: string): string[] {
  return row.split("\x1f");
}

const pad = (n: number): string => String(n).padStart(2, "0");

// An ISO 8601 instant in local time (the process's TZ): HHMM, or YYYY-MM-DD.
// A JS Date parse, not `date -d`: GNU and BSD date disagree on how to read an
// ISO string, and Node reads it the same on both.
function localFmt(iso: string, day: boolean): string | null {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return day
    ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`
    : `${pad(t.getHours())}${pad(t.getMinutes())}`;
}

function git(args: string[], cwd?: string): string {
  const r = spawnSync("git", args, { encoding: "utf8", cwd, stdio: ["ignore", "pipe", "ignore"] });
  return r.status === 0 ? (r.stdout ?? "").replace(/\n+$/, "") : "";
}

function readTrim(p: string): string {
  try {
    return readFileSync(p, "utf8").replace(/\n+$/, "");
  } catch {
    return "";
  }
}

// The harness's own session id, asked of harness.sh — the one place a harness's
// variables are named; setup-worktree.sh and write-root.sh source it too.
function harnessSessionId(): string {
  const lib = join(dirname(fileURLToPath(import.meta.url)), "harness.sh");
  const r = spawnSync("bash", ["-c", '. "$0"; harness_session_id', lib], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}

// ── Outside T3: the harness's session ──────────────────────────────────────
// The id is the harness's own (harness.sh), else one generated for this
// checkout and kept until a close of it lands. Its start is recorded the first
// time it is seen, and its own worktree is the linked worktree it started in —
// the harness made that one — recorded the same way.
function harnessSession(SESSIONS_HOME: string, LEDGER_HOME: string): string | null {
  let sid = harnessSessionId();
  if (sid !== "") return sid;
  // Keyed on the tree the shell stands in: the main checkout, or a linked
  // worktree the session started in. Two id-less sessions in two worktrees
  // are two sessions; keyed on the main checkout they shared one id, and the
  // second's close landed the first's tree as its own.
  const top = git(["rev-parse", "--show-toplevel"]);
  if (top === "") return null;
  let main: string;
  try {
    main = realpathSync(top);
  } catch {
    return null;
  }
  // POSIX cksum of the path, as the key has always been spelled, so a session
  // file an earlier install wrote is still found.
  const ck = spawnSync("cksum", [], { input: main, encoding: "utf8" });
  const key = (ck.stdout ?? "").split(" ")[0] ?? "";
  if (ck.status !== 0 || key === "") return null;
  const file = join(SESSIONS_HOME, key);
  sid = readTrim(file);
  if (sid === "" || existsSync(join(LEDGER_HOME, sid, "closed"))) {
    const n = new Date();
    const stamp = `${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}-${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
    sid = `session-${stamp}-${randomBytes(3).toString("hex")}`;
    mkdirSync(SESSIONS_HOME, { recursive: true });
    writeFileSync(file, `${sid}\n`);
  }
  return sid;
}

// The row for a non-T3 thread: id, branch, own worktree, start.
function harnessRow(LEDGER_HOME: string, tid: string, fresh: boolean): string {
  const state = join(LEDGER_HOME, tid);
  mkdirSync(state, { recursive: true });
  const startedFile = join(state, "started");
  if (!existsSync(startedFile)) writeFileSync(startedFile, `${new Date().toISOString().replace(/\.\d{3}Z$/, "Z")}\n`);
  let own = readTrim(join(state, "own"));
  if (own === "" && fresh) {
    const top = git(["rev-parse", "--show-toplevel"]);
    const common = git(["rev-parse", "--git-common-dir"]);
    if (top !== "" && common !== "") {
      try {
        const t = realpathSync(top);
        if (t !== realpathSync(join(resolve(common), ".."))) {
          own = t;
          writeFileSync(join(state, "own"), `${own}\n`);
        }
      } catch {
        // an unresolvable path is no own worktree
      }
    }
  }
  const branch = own === "" ? "" : git(["-C", own, "rev-parse", "--abbrev-ref", "HEAD"]);
  return [tid, branch, own, readTrim(startedFile)].join("\x1f");
}

async function main(): Promise<void> {
  const HOME = process.env.HOME ?? "";
  const T3_HOME = process.env.T3CODE_HOME || `${HOME}/.t3`;
  const DB = `${T3_HOME}/userdata/state.sqlite`;
  const LEDGER_HOME = `${HOME}/.cache/workbench/threads`;
  const SESSIONS_HOME = `${HOME}/.cache/workbench/sessions`;

  let MODE = "id";
  let LOCAL: "" | "time" | "day" = "";
  for (const arg of process.argv.slice(2)) {
    switch (arg) {
      case "--id":
        MODE = "id";
        break;
      case "--branch":
        MODE = "branch";
        break;
      case "--worktree":
        MODE = "worktree";
        break;
      case "--started":
        MODE = "started";
        break;
      case "--local":
      case "--la":
        LOCAL = "time";
        break;
      case "--local-day":
        LOCAL = "day";
        break;
      default:
        fail("usage: thread.ts [--id | --branch | --worktree | --started [--local | --local-day]]");
    }
  }

  const COLUMNS = "thread_id, branch, worktree_path, created_at";

  let row = "";
  const override = process.env.WORKBENCH_THREAD_ID ?? "";
  if (override !== "") {
    // The override names the thread. Everything except `--id` still needs the row,
    // and a missing database is reported rather than papered over — a caller that
    // asked for the branch must not be handed an empty string.
    if (MODE === "id") {
      process.stdout.write(`${override}\n`);
      exit(0);
    }
    if (isFile(DB)) {
      const r = dbRow(
        DB,
        `select ${COLUMNS} from projection_threads where thread_id = ? and deleted_at is null`,
        override,
      );
      if (r.status !== 0) {
        if (r.status === 3) fail(`cannot read ${DB}`);
        fail(`no thread ${override} in ${DB}`);
      }
      row = r.row;
    } else {
      // No T3 at all: the override names a harness session.
      row = harnessRow(LEDGER_HOME, override, true);
    }
  } else {
    // The toplevel, not the cwd: a shell three directories deep in the worktree is
    // still in the thread, and the db stores the worktree root.
    const g = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    let TOP = g.status === 0 ? (g.stdout ?? "").replace(/\n+$/, "") : "";
    if (TOP === "") fail(`not in a thread: ${process.cwd()} is not a git worktree`);
    TOP = realpathSync(TOP);

    if (isFile(DB)) {
      const r = dbRow(
        DB,
        `select ${COLUMNS} from projection_threads where worktree_path = ? and deleted_at is null`,
        TOP,
      );
      if (r.status !== 0) {
        if (r.status === 3) fail(`cannot read ${DB}`);
        row = "";
      } else {
        row = r.row;
      }
    }

    if (row === "") {
      // Not a T3 worktree. It may still be a satellite this session created, and
      // the ledger is the only record of that — `git worktree list` knows the
      // branch but not which thread the branch belongs to.
      const hits = new Set<string>();
      if (isDir(LEDGER_HOME)) {
        for (const name of readdirSync(LEDGER_HOME).sort()) {
          const file = `${LEDGER_HOME}/${name}/worktrees`;
          if (!existsSync(file)) continue;
          let text: string;
          try {
            text = readFileSync(file, "utf8");
          } catch {
            continue;
          }
          for (const line of text.split("\n")) {
            if (line.split("\t")[0] === TOP) hits.add(file);
          }
        }
      }
      const found = [...hits].sort();
      const count = found.length;
      if (count === 0) {
        // Not T3, and no ledger claims this tree: the harness's own session.
        const TID = harnessSession(SESSIONS_HOME, LEDGER_HOME);
        if (TID === null) fail(`cannot name a session for ${TOP}`);
        row = harnessRow(LEDGER_HOME, TID, true);
      } else {
        if (count > 1) fail(`ambiguous: ${TOP} is claimed by ${count} ledgers`);
        const TID = basename(dirname(found[0] ?? ""));
        if (MODE === "id") {
          process.stdout.write(`${TID}\n`);
          exit(0);
        }
        // A T3 thread's satellite reads T3's row; any other session's, its own.
        if (isFile(DB)) {
          const r = dbRow(DB, `select ${COLUMNS} from projection_threads where thread_id = ? and deleted_at is null`, TID);
          if (r.status === 0) row = r.row;
        }
        if (row === "") row = harnessRow(LEDGER_HOME, TID, false);
      }
    }
  }

  const [F_ID = "", F_BRANCH = "", F_WORKTREE = "", F_CREATED = ""] = fields(row);

  switch (MODE) {
    case "id":
      process.stdout.write(`${F_ID}\n`);
      break;
    case "branch":
      if (F_BRANCH === "") fail(`thread ${F_ID} has no branch recorded`);
      process.stdout.write(`${F_BRANCH}\n`);
      break;
    case "worktree":
      if (F_WORKTREE === "") fail(`thread ${F_ID} has no worktree recorded`);
      process.stdout.write(`${F_WORKTREE}\n`);
      break;
    case "started": {
      if (F_CREATED === "") fail(`thread ${F_ID} has no created_at`);
      if (LOCAL !== "") {
        // The journal files by the session's START, in local time, never by the
        // close time: a session that closes after midnight would otherwise file
        // under a day it did not happen on.
        const out = localFmt(F_CREATED, LOCAL === "day");
        if (out === null) fail(`cannot parse created_at: ${F_CREATED}`);
        process.stdout.write(`${out}\n`);
      } else {
        process.stdout.write(`${F_CREATED}\n`);
      }
      break;
    }
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
