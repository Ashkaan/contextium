#!/usr/bin/env -S node --experimental-strip-types
// journal-file.ts — the path this session's journal entry goes to.
//
// A journal day is a FOLDER, `journal/<date>/`, and a session is one file in
// it: `<HHMM>-<slug>.md`. A day kept as one shared file every session appends
// to is merged by concurrent closes without a git conflict — which silently
// drops whole sessions from it.
//
// THE TIME IS THE SESSION'S START, not the close, in local time. A session that
// closes after midnight files under the day it happened on, which is the day
// its work is in.
//
// TWO PLACES A NAME CAN ALREADY BE TAKEN, and both are checked. The obvious one
// is this worktree. The other is the trunk: another thread that started in
// the same minute with the same slug allocated the name in ITS worktree, where
// this one cannot see it, and landed first. Checking only locally picks a name
// that collides at merge time — and a merge of two files with one path is
// exactly the shared-write failure the one-file-per-session shape removed.
// `land.ts` re-checks against a freshly fetched trunk at merge time,
// because the other thread may land in between; this is the first of the two.
//
// THE PATH IS PERSISTED, not remembered. `land.ts` verifies that this exact
// path reached the trunk, and a re-run after a failed Land resumes on the
// file already written rather than writing a second one.
//
// Usage:
//   journal-file.ts "<filename-stem>" — choose and print the path (creates the day
//                                folder; does NOT create the file)
//   journal-file.ts --existing — print the path already chosen for this thread,
//                                if the file is there. Exit 1 if not.
//   journal-file.ts --check    — validate that existing entry using the same
//                                gate as Land (check-journal-entry.ts: front
//                                matter and the body's sections), then print
//                                its path. No writes.
//
// Env:
//   WORKBENCH_THREAD_ID, T3CODE_HOME — read by thread.ts.
//
// WHERE. Under `journal/` of this thread's worktree of THIS repo — the one
// these scripts live in, the workbench, where the records sit beside the code.
// The repo is found by asking git for the toplevel of the script's own
// directory. That works from a worktree copy of the scripts and through the
// `~/.agents/skills` link into the landed checkout alike: write-root.sh
// canonicalises whatever it is handed to the shared checkout and answers with
// the thread's worktree of it — the harness's own when the thread is on the
// workbench, a satellite when the thread is on a product repo.
//
// peers:
//   .agents/skills/close/scripts/journal-file.test.ts
//   .agents/skills/close/references/journal-entry.md  (the file's shape)
//   .agents/skills/close/scripts/check-journal-entry.ts (the gate --check runs)
//   .agents/skills/close/scripts/land.ts              (re-checks at merge)
//
// Exit: 0 ok (path on stdout) · 1 no existing file · 2 usage/thread error
//       3 --check found an invalid entry

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const THREAD = join(SCRIPT_DIR, "thread.ts");
const WRITE_ROOT = join(SCRIPT_DIR, "write-root.sh");
const TRUNK_TS = join(SCRIPT_DIR, "trunk.ts");

function fail(msg: string): never {
  process.stderr.write(`journal-file: ${msg}\n`);
  return exit(2);
}

/** `$(…)`: the output with its trailing newlines removed. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

type Captured = { ok: boolean; out: string };

/** Run a command and capture its stdout; stderr is inherited, or discarded when `quiet`. */
function capture(cmd: string, args: string[], opts: { quiet?: boolean } = {}): Captured {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    stdio: ["inherit", "pipe", opts.quiet ? "ignore" : "inherit"],
  });
  return { ok: r.status === 0, out: chomp(r.stdout ?? "") };
}

function node(script: string, args: string[], opts: { quiet?: boolean } = {}): Captured {
  return capture(process.execPath, ["--experimental-strip-types", script, ...args], opts);
}

function git(args: string[]): boolean {
  return spawnSync("git", args, { stdio: "ignore" }).status === 0;
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length !== 1) fail('usage: journal-file.ts "<filename-stem>" | --existing | --check');
  const arg = argv[0] ?? "";

  // The repo the journal belongs to is the one this script is in.
  const top = capture("git", ["-C", SCRIPT_DIR, "rev-parse", "--show-toplevel"], { quiet: true });
  if (!top.ok) fail(`these scripts are not inside a git repo: ${SCRIPT_DIR}`);
  const SELF_REPO = top.out;

  // The id is stdout alone: a Node 22.x writes a type-stripping warning to
  // stderr on every run, and merged in it named a ledger no close reads. stderr
  // is read only for the refusal, by thread.ts's own `thread: ` line.
  const tid = spawnSync(process.execPath, ["--experimental-strip-types", THREAD, "--id"], {
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (tid.status !== 0) {
    const err = (tid.stderr ?? "").split("\n").filter((l) => l !== "");
    const why = err.filter((l) => l.startsWith("thread: ")).pop() ?? err.pop() ?? `thread.ts exited ${tid.status}`;
    fail(why.replace(/^thread: /, ""));
  }
  const TID = chomp(tid.stdout ?? "");
  const LEDGER_JOURNAL = join(process.env.HOME ?? homedir(), ".cache/workbench/threads", TID, "journal");

  if (arg === "--existing" || arg === "--check") {
    if (!isFile(LEDGER_JOURNAL)) exit(1);
    const CHOSEN = readFileSync(LEDGER_JOURNAL, "utf8").split("\n")[0] ?? "";
    if (CHOSEN === "") exit(1);
    // RECREATE BEFORE TESTING. `land.ts` merges the entry to the trunk and then
    // removes this thread's worktree of this repo when it is a satellite (a
    // thread T3 opened on a product repo), so the recorded path leaves disk
    // while the entry itself is safe on origin. Work continues in the same
    // session, and the next close must resume on that entry — but a `-f` test run
    // first reports it missing, and the allocator then files a second entry
    // beside the one already landed. write-root re-adds the worktree at the same deterministic path from
    // origin/<trunk>, so the landed entry comes back exactly where it was; a path
    // missing for any other reason is still a miss, and still exits 1 below.
    if (!isFile(CHOSEN)) {
      spawnSync("bash", [WRITE_ROOT, SELF_REPO], { stdio: ["inherit", "ignore", "inherit"] });
    }
    if (!isFile(CHOSEN)) exit(1);
    if (arg === "--check") {
      const r = spawnSync(
        process.execPath,
        ["--experimental-strip-types", join(SCRIPT_DIR, "check-journal-entry.ts"), CHOSEN],
        { stdio: "inherit" },
      );
      if (r.status !== 0) exit(3);
    }
    process.stdout.write(`${CHOSEN}\n`);
    exit(0);
  }

  const SLUG_IN = arg;

  // Kebab: lower-case, every run of anything else collapsed to one hyphen, ends
  // trimmed, 60 characters at most (`journal-entry.md` § One file per session).
  const SLUG = SLUG_IN.replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (SLUG === "") fail(`slug '${SLUG_IN}' has no usable characters`);

  const wr = capture("bash", [WRITE_ROOT, SELF_REPO]);
  if (!wr.ok) exit(2);
  const WT = wr.out;

  const started = node(THREAD, ["--started"]);
  if (!started.ok) fail(`no start time for thread ${TID}`);
  const STARTED = started.out;
  // The day and the minute in local time, both asked of thread.ts, so the two
  // are read the same way from the one start it recorded.
  const day = node(THREAD, ["--started", "--local-day"]);
  if (!day.ok) fail(`cannot parse the thread's start time: ${STARTED}`);
  const DATE = day.out;
  const hhmm = node(THREAD, ["--started", "--local"]);
  if (!hhmm.ok) fail("cannot format the start time");
  const HHMM = hhmm.out;

  const DAY_DIR = `${WT}/journal/${DATE}`;
  mkdirSync(DAY_DIR, { recursive: true });

  // The trunk ref is only as fresh as the last fetch, and a stale one is how two
  // threads agree on a name that is already taken. The trunk's NAME is asked of
  // trunk.ts rather than spelled `main`, the same as every other close script;
  // a repo it cannot name gets the local check only, which is the most this can
  // do without a ref to compare against.
  const jt = node(TRUNK_TS, [WT], { quiet: true });
  const JTRUNK = jt.ok ? jt.out : "";
  if (JTRUNK !== "") git(["-C", WT, "fetch", "-q", "origin", JTRUNK]);

  const taken = (name: string): boolean => {
    const rel = `journal/${DATE}/${name}`;
    if (existsSync(`${WT}/${rel}`)) return true;
    if (JTRUNK === "") return false;
    return git(["-C", WT, "cat-file", "-e", `origin/${JTRUNK}:${rel}`]);
  };

  let NAME = `${HHMM}-${SLUG}.md`;
  let N = 1;
  while (taken(NAME)) {
    N += 1;
    NAME = `${HHMM}-${SLUG}-${N}.md`;
  }

  const CHOSEN = `${DAY_DIR}/${NAME}`;
  mkdirSync(dirname(LEDGER_JOURNAL), { recursive: true });
  writeFileSync(LEDGER_JOURNAL, `${CHOSEN}\n`);
  process.stdout.write(`${CHOSEN}\n`);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
