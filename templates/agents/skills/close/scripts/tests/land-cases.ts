// land-cases.ts — the cases close.spec.md § 6 names as the hard gate, and every
// one the close has grown since. Not a suite itself: land.test.ts,
// land.gates.test.ts and land.rows.test.ts each run one range of these cases.
//
// WHY THREE FILES. The cases run strictly one after another, and every one
// spawns land.ts and its helpers as Node processes. In bash that cost a few
// milliseconds a child; in TypeScript it is a Node start each, and the whole
// suite takes about 200 s — past the 180 s verify.ts gives one suite. Three
// files are three processes that `node --test` runs side by side and verify.ts
// times one at a time, while every case and expected string stays in this one
// file.
//
// Run all three:
//   node --test --experimental-strip-types .agents/skills/close/scripts/land*.test.ts
//
// Each scenario builds its own throwaway world: two real repos with real bare
// origins, real git worktrees, a fixture state.sqlite with real thread rows,
// and a throwaway HOME for the ledger. The repos are named with this process's
// pid so the /tmp per-repo lock land.ts takes cannot collide with another run.
//
// The CODE repo stands in for the workbench and holds the records too:
// `journal/` and `projects/` live inside it, beside a copy of these scripts at
// `.agents/skills/close/scripts/`, so `journal-file.ts` run out of a thread's
// worktree files the entry in that same worktree. The PROD repo is a product
// repo — the satellite shape a thread still opens for a repo other than its
// own. The copy carries what the scripts import from outside their folder too
// (`.agents/packages/cli-exit/`, and whatever else a relative import names), at
// the same relative path under `.agents/`, so the copy runs.
//
// Nothing is stubbed except what is not this script's job: the deploy-run
// poller (`.agents/deploy/await-deploy-run.sh` owns its own behavior — what is
// tested here is that its VERDICT is honoured, that a repo that has not opted
// in is not polled at all, and that one that opted in without a poller is
// refused), and the pre-commit checkers, whose rules their own suites own.
//
// Ported from land.test.sh case for case, with each expected string verbatim
// except where it names a file that changed extension (`check-skills.sh`,
// `roadmap-merge.sh`, `check-journal-entry.sh`, the `.agents/checks/` checkers
// → `.ts`). Cases run in order, one after another; each assertion is one test,
// so the count matches the bash suite's ok/FAIL lines. Cases 18 and 19 are new
// with the port: the repo lock and the fetch behind the final line had no case
// of their own.

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(HERE, "../../..");
const LAND = join(HERE, "land.ts");
const WRITE_ROOT = join(HERE, "write-root.sh");
const PID = process.pid;

const ROOT = mkdtempSync(join(tmpdir(), "land-test-"));

// How the suite starts every Node child. Node 22.x prints an ExperimentalWarning
// (type stripping) and a MODULE_TYPELESS_PACKAGE_JSON warning on stderr; the
// merged-output assertions read that stream, so both are switched off — as
// land.ts switches them off for its own children.
const NODE_TS = [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
];

// Local time is the journal's clock; the fixtures' times are written for this zone.
process.env.TZ = "America/Los_Angeles";
// The harness's own session env must not reach the scripts under test.
for (const v of ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CONTEXTIUM_SESSION", "CONTEXTIUM_HARNESS"])
  delete process.env[v];

after(() => {
  for (const s of readdirSync(ROOT)) {
    for (const d of readdirSync(join(ROOT, s))) {
      if (/^land-.*-(code|prod|legacy|third)$/.test(d))
        spawnSync("git", ["-C", join(ROOT, s, d), "worktree", "prune"], { stdio: "ignore" });
    }
  }
  rmSync(ROOT, { recursive: true, force: true });
  for (const f of readdirSync("/tmp")) {
    if (f.startsWith(`land-${PID}-`) && (f.endsWith("-git.lock") || f.endsWith("-git.lock.lnk")))
      rmSync(join("/tmp", f), { force: true });
  }
});

// ── Assertions: each one a test, named as the bash suite named it ─────────

function is(name: string, got: string | number, want: string | number): void {
  const g = String(got);
  const w = String(want);
  it(name, () => assert.equal(g, w));
}
function has(name: string, hay: string, needle: string): void {
  it(name, () => assert.ok(hay.includes(needle), `'${hay}' lacks '${needle}'`));
}
function hasnt(name: string, hay: string, needle: string): void {
  it(name, () => assert.ok(!hay.includes(needle), `'${hay}' should not contain '${needle}'`));
}
function isnt(name: string, got: string | number, notWant: string | number): void {
  const g = String(got);
  const n = String(notWant);
  it(name, () => assert.notEqual(g, n));
}
function ok(name: string, cond: boolean, failure: string): void {
  it(name, () => assert.ok(cond, failure));
}

// Cases are collected here and registered by runCases, which a suite file calls
// with the range it runs. Within a range they run strictly one after another:
// each describe body waits for the one before it, and registers its assertions
// as it goes.
type Case = { name: string; body: () => Promise<void> | void };
const CASES: Case[] = [];
function kase(name: string, body: () => Promise<void> | void): void {
  CASES.push({ name, body });
}

/** The number in a case's name: "Case 12x: …" → 12. */
function caseNumber(name: string): number {
  const m = /^Case (\d+)/.exec(name);
  if (!m?.[1]) throw new Error(`land-cases: a case name with no number: ${name}`);
  return Number(m[1]);
}

/** Register every case numbered from..to (inclusive), in file order. */
export function runCases(from: number, to: number): void {
  let chain: Promise<void> = Promise.resolve();
  for (const c of CASES) {
    const n = caseNumber(c.name);
    if (n < from || n > to) continue;
    const prev = chain;
    let release: () => void = () => {};
    chain = new Promise((r) => {
      release = r;
    });
    describe(c.name, async () => {
      try {
        await prev;
        await c.body();
      } finally {
        release();
      }
    });
  }
}

// ── Process helpers ───────────────────────────────────────────────────────

/** What `$(…)` keeps: everything but trailing newlines. */
function chomp(s: string): string {
  return s.replace(/\n+$/, "");
}

type Res = { rc: number; out: string };

/**
 * Run a command. `merge` is `$(… 2>&1)`: stdout and stderr through one file,
 * in the order written. Otherwise only stdout is kept, as `$(…)` keeps it.
 */
function sh(cmd: string, args: string[], opt: { cwd?: string; env?: NodeJS.ProcessEnv; merge?: boolean } = {}): Res {
  const env = opt.env ?? process.env;
  if (opt.merge) {
    const dir = mkdtempSync(join(tmpdir(), "land-out-"));
    const file = join(dir, "out");
    const fd = openSync(file, "w+");
    try {
      const r = spawnSync(cmd, args, { cwd: opt.cwd, env, stdio: ["ignore", fd, fd], timeout: 300_000 });
      return { rc: r.status ?? 1, out: chomp(readFileSync(file, "utf8")) };
    } finally {
      closeSync(fd);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const r = spawnSync(cmd, args, {
    cwd: opt.cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  return { rc: r.status ?? 1, out: chomp(r.stdout ?? "") };
}

/** git, for fixture work: its stdout, `$(…)`-trimmed, whether or not it failed. */
function g(dir: string, ...args: string[]): string {
  return sh("git", ["-C", dir, ...args]).out;
}
/** git, for a yes/no question: did it exit 0? */
function gOk(dir: string, ...args: string[]): boolean {
  return spawnSync("git", ["-C", dir, ...args], { stdio: "ignore" }).status === 0;
}
/** git, for a fixture step that must succeed. */
function gDo(dir: string, ...args: string[]): void {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`git -C ${dir} ${args.join(" ")}: ${r.stderr}`);
}
function gInit(dir: string, branch: string, bare = false): void {
  const r = spawnSync("git", ["init", "-q", ...(bare ? ["--bare"] : []), "-b", branch, dir], { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`git init ${dir}`);
}

function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
function cat(...paths: string[]): string {
  return chomp(paths.map((p) => readFileSync(p, "utf8")).join(""));
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
/** `grep -c` over a file: the count of matching lines, or "" when it is absent. */
function countLines(p: string, pred: (l: string) => boolean): string {
  if (!isFile(p)) return "";
  const text = readFileSync(p, "utf8");
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return String(lines.filter((l) => text !== "" && pred(l)).length);
}
function lastLine(s: string): string {
  const l = s.split("\n");
  return l[l.length - 1] ?? "";
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Copying the scripts into a fixture repo ───────────────────────────────

/** Every relative import a TypeScript file names, resolved against it. */
function relativeImports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
    const spec = m[1];
    if (spec) out.push(resolve(dirname(file), spec));
  }
  return out;
}

/**
 * Copy <file> from this template to the path it installs at under <destRoot>
 * (`templates/agents/<rel>` → `.agents/<rel>`), and what it imports.
 */
function copyWithImports(file: string, destRoot: string, seen: Set<string>): void {
  if (seen.has(file)) return;
  seen.add(file);
  const rel = relative(REPO, file);
  if (rel.startsWith("..") || !isFile(file)) return;
  const dest = join(destRoot, ".agents", rel);
  if (!existsSync(dest)) {
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(file, dest);
  }
  if (file.endsWith(".ts")) for (const dep of relativeImports(file)) copyWithImports(dep, destRoot, seen);
}

/** The close's scripts (not their tests) at their real path under <destRoot>. */
function copyScripts(destRoot: string): void {
  mkdirSync(join(destRoot, ".agents/skills/close/scripts"), { recursive: true });
  const seen = new Set<string>();
  for (const f of readdirSync(HERE)) {
    if (!/\.(sh|ts)$/.test(f) || f.includes(".test.")) continue;
    copyWithImports(join(HERE, f), destRoot, seen);
  }
}

// ── Fixture ───────────────────────────────────────────────────────────────

const TID1 = "aaaa1111-0000-0000-0000-000000000001";
const TID2 = "bbbb2222-0000-0000-0000-000000000002";

type Fx = {
  S: string;
  CODE: string;
  PROD: string;
  WT1: string;
  WT2: string;
  HOME_DIR: string;
  env1: Record<string, string>;
  env2: Record<string, string>;
};
let F: Fx;

// fixture <scenario> [created_at_1] [created_at_2]
function fixture(
  name: string,
  at1 = "2026-09-14T03:15:00.000Z",
  at2 = "2026-09-14T04:20:00.000Z",
  scStub = true,
): void {
  const S = join(ROOT, name);
  for (const d of ["origins", "home", "t3home/userdata", "t3"]) mkdirSync(join(S, d), { recursive: true });

  for (const repo of ["code", "prod"]) {
    // The lock land.ts takes is keyed on the checkout's basename, so the
    // basename has to be unique per run — but the variable has to stay short.
    const bare = join(S, "origins", `land-${PID}-${name}-${repo}.git`);
    const dir = join(S, repo);
    gInit(bare, "main", true);
    gInit(dir, "main");
    gDo(dir, "config", "user.email", "t@example.com");
    gDo(dir, "config", "user.name", "tester");
    write(join(dir, "seed.txt"), "seed\n");
    gDo(dir, "add", "seed.txt");
    if (repo === "code") {
      // The scripts at their real path, so `journal-file.ts` run out of a
      // worktree of this repo finds THIS repo as its own and files the journal
      // there. Tests are left out; nothing here runs them.
      copyScripts(dir);
      gDo(dir, "add", "-A");
      // The script-tests checker, as a stub that passes everything, seeded ON
      // THE TRUNK: the copies above and the checker stubs the cases commit are
      // scripts under .agents/, and without a resolvable checker land.ts
      // refuses any close that changes one. Case 17 overwrites it with a
      // strict stub; `scStub = false` leaves it out for the rows that need no
      // checker in any worktree.
      if (scStub) {
        write(join(dir, ".agents/checks/check-scripts.ts"), 'console.log("OK — stub");\n');
        gDo(dir, "add", ".agents");
      }
    }
    gDo(dir, "commit", "-q", "-m", "seed");
    gDo(dir, "remote", "add", "origin", bare);
    gDo(dir, "push", "-q", "-u", "origin", "main");
  }

  // The basename land.ts locks on. Renaming the directory after init is
  // simpler than threading the name through every git call above.
  const CODE = join(S, `land-${PID}-${name}-code`);
  const PROD = join(S, `land-${PID}-${name}-prod`);
  renameSync(join(S, "code"), CODE);
  renameSync(join(S, "prod"), PROD);

  // Two T3 threads, each with a linked worktree of the code repo on a branch
  // named the way T3 names them — never `t3/`.
  const WT1 = join(S, "t3/one");
  const WT2 = join(S, "t3/two");
  gDo(CODE, "worktree", "add", "-q", "-b", "t3code/one", WT1, "main");
  gDo(CODE, "worktree", "add", "-q", "-b", "t3code/two", WT2, "main");

  // node:sqlite loads only behind --experimental-sqlite on Node 22.5–22.12;
  // later Nodes accept the flag as a no-op.
  const db = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "-e",
      `
const { DatabaseSync } = require("node:sqlite");
const [dbPath, t1, w1, a1, t2, w2, a2] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(\`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)\`);
const ins = db.prepare("insert into projection_threads values (?,?,?,?,?,?,?,?)");
ins.run(t1, "p", "one", "t3code/one", w1, a1, "x", null);
ins.run(t2, "p", "two", "t3code/two", w2, a2, "x", null);
`,
      join(S, "t3home/userdata/state.sqlite"),
      TID1,
      WT1,
      at1,
      TID2,
      WT2,
      at2,
    ],
    { stdio: "ignore" },
  );
  if (db.status !== 0) throw new Error("fixture: state.sqlite");

  const env1 = { HOME: join(S, "home"), T3CODE_HOME: join(S, "t3home"), LAND_PUSH_SLEEP: "0" };
  F = { S, CODE, PROD, WT1, WT2, HOME_DIR: join(S, "home"), env1, env2: { ...env1 } };
}

function envOf(n: 1 | 2, cwd: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...(n === 1 ? F.env1 : F.env2), ...extra, PWD: cwd };
}

// Run land.ts as thread N, from that thread's own T3 worktree. `merge` is the
// bash suite's `2>&1`.
function land(
  n: 1 | 2,
  args: string[],
  opt: { merge?: boolean; extra?: Record<string, string>; script?: string } = {},
): Res {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  return sh(process.execPath, [...NODE_TS, opt.script ?? LAND, ...args], {
    cwd,
    env: envOf(n, cwd, opt.extra),
    merge: opt.merge ?? false,
  });
}
function writeRoot(n: 1 | 2, target: string, merge = false): Res {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  return sh("bash", [WRITE_ROOT, target], { cwd, env: envOf(n, cwd), merge });
}

// Allocate a journal path as thread N — through the copy of journal-file.ts in
// THAT thread's worktree, which is how a session runs it. The real copy under
// HERE would name the real workbench as its repo, and nothing in this suite
// may touch a real checkout.
function jf(n: 1 | 2, ...args: string[]): string {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  return sh(
    process.execPath,
    [...NODE_TS, join(cwd, ".agents/skills/close/scripts/journal-file.ts"), ...args],
    {
      cwd,
      env: envOf(n, cwd),
    },
  ).out;
}

// The files one commit touched, by its subject.
function filesInCommit(repo: string, subject: string): string {
  const sha = g(repo, "log", "origin/main", "--format=%H", `--grep=^${subject}$`).split("\n")[0] ?? "";
  if (!sha) return "NO-SUCH-COMMIT";
  return g(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", sha)
    .split("\n")
    .filter(Boolean)
    .sort()
    .map((f) => `${f} `)
    .join("");
}

function onMain(repo: string, path: string): string {
  gOk(repo, "fetch", "-q", "origin", "main");
  return gOk(repo, "cat-file", "-e", `origin/main:${path}`) ? "yes" : "no";
}

function threadFile(tid: string, f: string): string {
  return join(F.HOME_DIR, ".cache/workbench/threads", tid, f);
}

function entry(path: string, slug: string, body: string): void {
  write(
    path,
    `---\ndate: 2026-09-13\ntime: 20:15\nslug: ${slug}\ntags: []\n---\n\n### ${slug}\n**Action:** shipped\n\n${body}\n`,
  );
}

function lines(...ls: string[]): string {
  return `${ls.join("\n")}\n`;
}

// ── Case 1 ────────────────────────────────────────────────────────────────

kase("Case 1: two threads, two repos, same minute", () => {
  fixture("c1");
  const SAT1 = writeRoot(1, F.PROD).out;
  const SAT2 = writeRoot(2, F.PROD).out;

  write(join(F.WT1, "one.txt"), "one\n");
  write(join(SAT1, "one-prod.md"), "one\n");
  write(join(F.WT2, "two.txt"), "two\n");
  write(join(SAT2, "two-prod.md"), "two\n");

  const r1 = land(1, ["thread one"]);
  const r2 = land(2, ["thread two"]);

  is("thread one lands", r1.rc, "0");
  is("thread two lands", r2.rc, "0");
  has("thread one prints the safe-to-close line", r1.out, "— closing this tab loses nothing.");
  has("thread two prints it too", r2.out, "— closing this tab loses nothing.");

  is("thread one's commit touches only thread one's file", filesInCommit(F.CODE, "thread one"), "one.txt ");
  is("thread two's commit touches only thread two's file", filesInCommit(F.CODE, "thread two"), "two.txt ");
  is("…and in the product repo as well", filesInCommit(F.PROD, "thread one"), "one-prod.md ");

  is(
    "both threads' files are on main in the code repo",
    onMain(F.CODE, "one.txt") + onMain(F.CODE, "two.txt"),
    "yesyes",
  );
  is(
    "both threads' files are on main in the product repo",
    onMain(F.PROD, "one-prod.md") + onMain(F.PROD, "two-prod.md"),
    "yesyes",
  );

  const check1 = land(1, ["--check", "--verbose"]);
  is("--check re-passes for thread one", check1.rc, "0");
  has("…and prints the line", check1.out, "— closing this tab loses nothing.");
  has("…and --verbose names each repo", check1.out, "ancestor-of-origin/main");

  ok("the closed marker is written", existsSync(threadFile(TID1, "closed")), "no closed marker");
  ok("the satellite is removed once its SHA is persisted", !isDir(SAT1), "the satellite was not removed");
  ok("T3's own worktree is left for T3", isDir(F.WT1), "T3's worktree was removed");

  is(
    "the satellite's branch is gone from the product repo",
    gOk(F.PROD, "rev-parse", "--verify", "-q", `refs/heads/t3/${TID1}`) ? "present" : "gone",
    "gone",
  );

  is(
    "the shared code checkout was fast-forwarded",
    g(F.CODE, "rev-parse", "HEAD"),
    g(F.CODE, "rev-parse", "origin/main"),
  );
});

// ── Case 2 ────────────────────────────────────────────────────────────────

kase("Case 2: a push that fails leaves the obligation in place", () => {
  fixture("c2");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(F.WT1, "one.txt"), "one\n");
  write(join(SAT1, "one-prod.md"), "one\n");

  // The product repo cannot be pushed to. The code repo, first in the ledger,
  // lands normally — which is what makes this a PARTIAL landing.
  gDo(F.PROD, "remote", "set-url", "--push", "origin", join(F.S, "origins/does-not-exist.git"));

  let r = land(1, ["thread one"], { merge: true });
  is("a failed push exits 3", r.rc, "3");
  has("and says which repo", r.out, `NOT CLOSED: push of ${F.PROD} failed`);

  const LANDED = threadFile(TID1, "landed");
  is(
    "the code repo's SHA is persisted",
    countLines(LANDED, (l) => l.split("\t")[0] === F.CODE),
    "1",
  );
  is(
    "the product repo's SHA is NOT persisted",
    countLines(LANDED, (l) => l.split("\t")[0] === F.PROD),
    "0",
  );
  ok(
    "no closed marker is written",
    !existsSync(threadFile(TID1, "closed")),
    "a closed marker was written despite the failure",
  );
  ok("the unlanded worktree is kept", isDir(SAT1), "the unlanded worktree was removed");
  is("…with its commit intact", g(SAT1, "log", "-1", "--format=%s"), "thread one");

  // The next close lands it.
  gDo(F.PROD, "remote", "set-url", "--push", "origin", join(F.S, `origins/land-${PID}-c2-prod.git`));
  r = land(1, ["thread one"], { merge: true });
  is("the re-run lands what was left", r.rc, "0");
  has("and prints the line", r.out, "— closing this tab loses nothing.");
  is("the product file is on main", onMain(F.PROD, "one-prod.md"), "yes");
  hasnt("the already-landed repo is not committed twice", r.out, `landed ${F.CODE}`);
  ok("now the closed marker is written", existsSync(threadFile(TID1, "closed")), "still no closed marker");
});

// ── Case 3 ────────────────────────────────────────────────────────────────

kase("Case 3: --check after cleanup, and a dropped obligation", () => {
  fixture("c3");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "one\n");
  land(1, ["thread one"]);
  const check = land(1, ["--check"]);
  is("--check passes with the satellite already gone", check.rc, "0");
  has("and prints the line", check.out, "— closing this tab loses nothing.");

  // Drop the product repo's SHA: now the ledger names a worktree that is not on
  // disk and has no landed SHA, which is an obligation nobody can account for.
  const LANDED = threadFile(TID1, "landed");
  const kept = readFileSync(LANDED, "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith(`${F.PROD}\t`));
  writeFileSync(LANDED, kept.map((l) => `${l}\n`).join(""));
  const r = land(1, ["thread one"], { merge: true });
  is("a worktree gone before landing exits 3", r.rc, "3");
  has("naming the path", r.out, `NOT CLOSED: worktree missing before landing: ${SAT1}`);
});

// ── Case 4 ────────────────────────────────────────────────────────────────

kase("Case 4: two threads allocate the same journal name", () => {
  // Same start minute for both threads, so journal-file.ts hands both the same
  // name — neither can see the other's worktree.
  fixture("c4", "2026-09-14T03:15:00.000Z", "2026-09-14T03:15:00.000Z");
  const J1 = jf(1, "same slug");
  const J2 = jf(2, "same slug");
  is("both threads pick the same path", basename(J1), basename(J2));
  is("…which is the unsuffixed one", basename(J1), "2015-same-slug.md");
  is(
    "…in the thread's OWN worktree, where the records live",
    J1,
    `${F.WT1}/journal/2026-09-13/2015-same-slug.md`,
  );
  entry(J1, "same-slug", "thread one's entry");
  entry(J2, "same-slug", "thread two's entry");

  land(1, ["thread one"]);
  const r2 = land(2, ["thread two"], { merge: true });
  is("the second thread still lands", r2.rc, "0");
  has("…saying it renamed around the collision", r2.out, "journal renamed:");
  is("the first thread's entry is on main", onMain(F.CODE, "journal/2026-09-13/2015-same-slug.md"), "yes");
  is("the second thread's entry is on main under -2", onMain(F.CODE, "journal/2026-09-13/2015-same-slug-2.md"), "yes");
  has(
    "neither entry overwrote the other",
    g(F.CODE, "show", "origin/main:journal/2026-09-13/2015-same-slug.md"),
    "thread one's entry",
  );
  is("the ledger now names the renamed path", basename(cat(threadFile(TID2, "journal"))), "2015-same-slug-2.md");
  const check2 = land(2, ["--check", "--verbose"]);
  is("…and --check verifies the renamed path, not the original", check2.rc, "0");
  has("naming it", check2.out, "journal  journal/2026-09-13/2015-same-slug-2.md  present");
});

// ── Case 4b ───────────────────────────────────────────────────────────────
//
// A second close — a correction to an entry already pushed — finds its own
// file on origin/main. Read as a collision, it would be moved to `-2`, and a
// third run would make it `-3`.

kase("Case 4b: re-landing your OWN entry does not rename it", () => {
  fixture("c4b");
  const J = jf(1, "same slug");
  entry(J, "same-slug", "first pass");
  land(1, ["thread one"]);
  const REL4B = `journal/2026-09-13/${basename(J)}`;
  is("the first close lands it under its own name", onMain(F.CODE, REL4B), "yes");

  // Correct the entry and close again — the same session, a second time.
  entry(join(F.WT1, REL4B), "same-slug", "second pass, corrected");
  const r = land(1, ["thread one again"], { merge: true });
  is("the second close lands", r.rc, "0");
  hasnt("and does not rename this session's own entry", r.out, "journal renamed");
  is("the entry is still at its original path", onMain(F.CODE, REL4B), "yes");
  is("no -2 was created", onMain(F.CODE, `journal/2026-09-13/${basename(J, ".md")}-2.md`), "no");
  has("and it carries the correction", g(F.CODE, "show", `origin/main:${REL4B}`), "second pass, corrected");
  is("the ledger still names the original path", basename(cat(threadFile(TID1, "journal"))), basename(J));
});

// ── Case 5 ────────────────────────────────────────────────────────────────

kase("Case 5: a conflict halts loud and changes nothing shared", () => {
  fixture("c5");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "contested.txt"), "this thread's version\n");

  // Somebody else lands a different version of the same new file first.
  const OTHER = join(F.S, "other");
  spawnSync("git", ["clone", "-q", join(F.S, `origins/land-${PID}-c5-prod.git`), OTHER], { stdio: "ignore" });
  gDo(OTHER, "config", "user.email", "t@example.com");
  gDo(OTHER, "config", "user.name", "tester");
  write(join(OTHER, "contested.txt"), "somebody else's version\n");
  gDo(OTHER, "add", "contested.txt");
  gDo(OTHER, "commit", "-q", "-m", "another writer");
  gDo(OTHER, "push", "-q", "origin", "main");

  const SHARED_BEFORE = g(F.PROD, "rev-parse", "HEAD");
  let r = land(1, ["thread one"], { merge: true });
  is("a conflict exits 3", r.rc, "3");
  has("naming the worktree it is in", r.out, `NOT CLOSED: conflict in ${SAT1}`);
  has("the conflict markers are in the worktree", cat(join(SAT1, "contested.txt")), "<<<<<<<");
  is("the shared checkout is untouched", g(F.PROD, "rev-parse", "HEAD"), SHARED_BEFORE);
  is("the shared checkout is clean", g(F.PROD, "status", "--porcelain"), "");
  ok(
    "no closed marker after a conflict",
    !existsSync(threadFile(TID1, "closed")),
    "a conflicted close still wrote the marker",
  );

  // Re-running the close over a conflicted worktree must not "resolve" it by
  // staging the markers. This is the retry the first cut never covered.
  const COMMITS_BEFORE = g(SAT1, "rev-list", "--count", "origin/main..HEAD");
  r = land(1, ["thread one"], { merge: true });
  is("a re-run over an unresolved conflict exits 3", r.rc, "3");
  has("naming the file that is still conflicted", r.out, `NOT CLOSED: unresolved conflict in ${SAT1}`);
  has("…and the file", r.out, "contested.txt");
  is(
    "the retry committed nothing over the markers",
    g(SAT1, "rev-list", "--count", "origin/main..HEAD"),
    COMMITS_BEFORE,
  );
  is(
    "and the markers are still in the working tree, not staged away",
    g(SAT1, "diff", "--name-only", "--diff-filter=U"),
    "contested.txt",
  );
  is("and no conflict markers reached main", g(F.PROD, "show", "origin/main:contested.txt"), "somebody else's version");

  // Resolved by hand, the same close lands.
  write(join(SAT1, "contested.txt"), "this thread's version, merged by hand\n");
  gDo(SAT1, "add", "contested.txt");
  r = land(1, ["thread one"], { merge: true });
  is("once resolved, the close lands", r.rc, "0");
  has("…and prints the line", r.out, "— closing this tab loses nothing.");
});

// ── Case 6 ────────────────────────────────────────────────────────────────
//
// A deploy that never starts is the failure a push-triggered deploy can have
// and a merger that deployed could not: a dropped webhook, a runner that is
// down, and silence looks exactly like success. So: a run that completes
// closes, a run that fails does NOT, and no run at all does NOT — for a repo
// that opted in with `.agents/deployable-prefixes.json`. One that did not has
// no deploy check at all.

// The poller lives in the repo, so it has to be ON main before the close runs —
// which is how the real one gets there. It is a bash script, as the repo's own
// `.agents/deploy/await-deploy-run.sh` is.
function writeAwaitStub(): void {
  write(
    join(F.CODE, ".agents/deploy/await-deploy-run.sh"),
    `#!/usr/bin/env bash
sha=""
while [ $# -gt 0 ]; do case "$1" in --sha) sha="$2"; shift 2 ;; *) shift ;; esac; done
echo "polled \${sha}" >&2
if [ -n "\${AWAIT_STUB_FAIL_SHA:-}" ] && [ "\${AWAIT_STUB_FAIL_SHA}" = "\${sha}" ]; then
  echo "deploy: failed (run_old)"
  exit 3
fi
printf '%s\\n' "\${AWAIT_STUB_LINE:-deploy: completed (run_stub)}"
exit "\${AWAIT_STUB_RC:-0}"
`,
  );
  gDo(F.CODE, "add", ".agents");
  gDo(F.CODE, "commit", "-q", "-m", "the deploy poller");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin", "main");
  gDo(F.WT1, "merge", "-q", "--no-edit", "origin/main");
}

// The prefix list is the opt-in: without it the deploy check is off. A RUN IS
// OWED ONLY WHEN THE LANDED DIFF CAN DEPLOY SOMETHING: this script reads the
// list out of the landed commit, never the shared checkout's working tree, and
// polls only when the diff since the trunk it left matches. Anything it cannot
// read (unparseable JSON) polls: never skip on an unknown.
function writePrefixList(json: string): void {
  write(join(F.CODE, ".agents/deployable-prefixes.json"), `${json}\n`);
  gDo(F.CODE, "add", ".agents");
  gDo(F.CODE, "commit", "-q", "-m", "the prefix list");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin", "main");
  gDo(F.WT1, "merge", "-q", "--no-edit", "origin/main");
}

const polledCount = (): string => countLines(threadFile(TID1, "deploy.log"), (l) => l.includes("polled "));

kase("Case 6: the landing CHECKS the push deployed, and never deploys", () => {
  // OFF UNLESS OPTED IN. A poller with no prefix list: the landing closes and
  // no deploy line is printed.
  fixture("c6off");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["thread one"], { merge: true });
  is("with no .agents/deployable-prefixes.json the deploy check is off", r.rc, "0");
  hasnt("…and nothing is polled", r.out, "deploy:");

  // OPTED IN WITHOUT A POLLER is the silent case again, so it is NOT CLOSED —
  // and stays so on the retry, because the push is owed a run nobody checked.
  fixture("c6nopoll");
  writePrefixList('["one"]');
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], { merge: true });
  isnt("a prefix list with no poller does NOT close", r.rc, "0");
  has("…and names the missing poller", r.out, ".agents/deploy/await-deploy-run.sh");
  r = land(1, ["thread one"], { merge: true });
  is("…nor does the retry", r.rc, "3");
  hasnt("…which prints no proof line", r.out, "loses nothing");

  fixture("c6");
  writeAwaitStub();
  writePrefixList('["one"]');
  write(join(F.WT1, "one.txt"), "one\n");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "prod\n");

  r = land(1, ["thread one"], { merge: true });
  is("a completed deploy run closes", r.rc, "0");
  has("…and the run is named in the report", r.out, "deploy: completed (run_stub)");
  has("…and the poller was asked about the landed commit", cat(threadFile(TID1, "deploy.log")), "polled ");
  hasnt(
    "the product repo, which has not opted in, was not polled",
    r.out,
    "deploy: completed (run_stub)\ndeploy: completed (run_stub)",
  );

  // NO RUN AT ALL IS NOT CLOSED. This is the whole reason the check exists: the
  // push is the only thing that deploys, and nothing else would notice it failing.
  fixture("c6b");
  writeAwaitStub();
  writePrefixList('["one"]');
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], {
    merge: true,
    extra: { AWAIT_STUB_RC: "3", AWAIT_STUB_LINE: "deploy: no run seen for sha:abc within 60s" },
  });
  isnt("a landing whose push started no deploy does NOT close", r.rc, "0");
  has("…and says so", r.out, "no run seen");
  has("…naming the checkout that is on origin undeployed", r.out, "nothing deployed it");

  // A run that FAILED is the same verdict, for the same reason.
  fixture("c6c");
  writeAwaitStub();
  writePrefixList('["one"]');
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], {
    merge: true,
    extra: { AWAIT_STUB_RC: "3", AWAIT_STUB_LINE: "deploy: failed (run_bad)" },
  });
  isnt("a failed deploy run does NOT close", r.rc, "0");
  has("…and names the run", r.out, "deploy: failed (run_bad)");

  // The journal-only close, the not-owed case: the entry is allocated by
  // journal-file.ts into this thread's own worktree, the landed diff touches
  // `journal/` and nothing under `apps/`, `integrations/` or `packages/`, so the
  // close says no run was owed and never asks the poller, and its deploy line
  // says why nothing was waited for.
  fixture("c6d");
  writeAwaitStub();
  writePrefixList('["apps/", "integrations/", "packages/"]');
  const J6D = jf(1, "journal only");
  entry(J6D, "journal-only", "a session that wrote only its journal");
  r = land(1, ["journal only"], { merge: true });
  is("a journal-only close lands", r.rc, "0");
  has("…and says no run was owed", r.out, "deploy: not owed (no deployable path)");
  hasnt("…and the poller was never asked", r.out, "deploy: completed");
  is("…nor even started", polledCount(), "0");
  is("…and the entry is on main", onMain(F.CODE, `journal/2026-09-13/${basename(J6D)}`), "yes");

  fixture("c6e");
  writeAwaitStub();
  writePrefixList('["apps/", "integrations/", "packages/"]');
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  write(join(F.WT1, "projects/ai/x/README.md"), "record\n");
  r = land(1, ["records only, in the code repo"], { merge: true });
  is("a landing touching only records closes", r.rc, "0");
  has("…and says no run was owed", r.out, "deploy: not owed (no deployable path)");
  hasnt("…and the poller was never asked", r.out, "deploy: completed");
  is("…nor even started", polledCount(), "0");

  // A path under a listed prefix is owed a run, and the verdict is the poller's.
  fixture("c6f");
  writeAwaitStub();
  writePrefixList('["apps/", "integrations/", "packages/"]');
  write(join(F.WT1, "packages/shared/x.ts"), "code\n");
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  r = land(1, ["code and a record"], { merge: true });
  is("a landing touching a deployable path closes on a completed run", r.rc, "0");
  has("…and the poller decided", r.out, "deploy: completed (run_stub)");
  hasnt("…not the prefix rule", r.out, "not owed");

  // THE LIST IS PARSED, NOT GREPPED. A pretty-printed list is the same list, and
  // a prefix matches only at the START of a path: `docs/apps/x.ts` is records.
  fixture("c6g");
  writeAwaitStub();
  writePrefixList('[\n  "apps/",\n  "integrations/",\n  "packages/"\n]');
  write(join(F.WT1, "docs/apps/x.ts"), "prose\n");
  r = land(1, ["a path with apps in the middle"], { merge: true });
  is("a mid-path prefix is not a match", r.rc, "0");
  has("…so no run is owed", r.out, "deploy: not owed (no deployable path)");

  // A LIST THAT CANNOT BE READ POLLS. Skipping on "I could not tell" is the one
  // way a deployed-nothing close ships a stale fleet with a green report.
  fixture("c6h");
  writeAwaitStub();
  writePrefixList("not json at all");
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  r = land(1, ["records under a broken list"], { merge: true });
  is("an unreadable list falls back to polling", r.rc, "0");
  has("…and the poller was asked", r.out, "deploy: completed (run_stub)");
  hasnt("…never skipped on an unknown", r.out, "not owed");

  // A PUSH EVENT CARRIES EVERY COMMIT'S FILES, NOT THE NET DIFF. A path added in
  // one commit and deleted in the next is in the payload's union and starts a run,
  // while `git diff` across the range shows nothing — so the close must read the
  // same union, or it reports `not owed` over a run that may have failed.
  fixture("c6i");
  writeAwaitStub();
  writePrefixList('["apps/", "integrations/", "packages/"]');
  write(join(F.WT1, "apps/x/y.ts"), "code\n");
  gDo(F.WT1, "add", "apps");
  gDo(F.WT1, "commit", "-q", "-m", "add it");
  gDo(F.WT1, "rm", "-q", "apps/x/y.ts");
  gDo(F.WT1, "commit", "-q", "-m", "remove it again");
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  r = land(1, ["a path that came and went"], { merge: true });
  is("a path touched by an intermediate commit closes on the poller's verdict", r.rc, "0");
  has("…and the poller was asked, as the deployer started a run", r.out, "deploy: completed (run_stub)");
  hasnt("…never not-owed on the net diff alone", r.out, "not owed");
});

// ── Case 6r ───────────────────────────────────────────────────────────────
//
// A FAILED DEPLOY IS STILL OWED ON THE RETRY. The landed SHA is persisted as
// soon as the push succeeds, before the run is polled, so a retry that finds
// HEAD at that SHA and the tree clean has nothing to land — and used to return
// there, skipping the poll, and print the safe-to-close line over a push whose
// deploy had failed. The obligation is persisted beside the SHA and cleared
// only by a run the poller calls good.

kase("Case 6r: a failed deploy is re-checked on the retry, never forgotten", () => {
  fixture("c6r");
  writeAwaitStub();
  writePrefixList('["one"]');
  write(join(F.WT1, "one.txt"), "one\n");
  const failing = { AWAIT_STUB_RC: "3", AWAIT_STUB_LINE: "deploy: failed (run_bad)" };
  let r = land(1, ["thread one"], { merge: true, extra: failing });
  is("the failed deploy does not close", r.rc, "3");
  is("…after polling once", polledCount(), "1");

  r = land(1, ["--check"], { merge: true });
  is("--check refuses while the deploy is still owed", r.rc, "3");
  has("…naming the owed run", r.out, "NOT CLOSED: the deploy of");
  hasnt("…and prints no proof line", r.out, "loses nothing");

  r = land(1, ["thread one"], { merge: true, extra: failing });
  is("a retry while the run is still failing does NOT close", r.rc, "3");
  is("…and it polled again", polledCount(), "2");

  r = land(1, ["thread one"], { merge: true });
  is("a retry whose run now completes closes", r.rc, "0");
  is("…having polled the same SHA a third time", polledCount(), "3");
  has("…and the run is named", r.out, "deploy: completed (run_stub)");

  r = land(1, ["--check"], { merge: true });
  is("--check passes once the deploy is proved", r.rc, "0");

  // A CORRECTIVE PUSH SETTLES IT. The run for the owed SHA stays failed for
  // good; the fix is new work, and its deploy — of a descendant of the owed
  // SHA — is what proves the repo deployed. Re-polling the old SHA first would
  // refuse every close, and the fix could never land through one.
  fixture("c6s");
  writeAwaitStub();
  writePrefixList('["one", "fix"]');
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["broken"], { merge: true, extra: failing });
  is("the broken push's deploy fails", r.rc, "3");
  const owed = cat(threadFile(TID1, "deploy-owed")).split("\t")[1] ?? "";
  write(join(F.WT1, "fix.txt"), "fix\n");
  r = land(1, ["the fix"], { merge: true, extra: { AWAIT_STUB_FAIL_SHA: owed } });
  is("the corrective push lands and closes", r.rc, "0");
  is("…with the fix on main", onMain(F.CODE, "fix.txt"), "yes");
  has("…settled by the new SHA's completed run", r.out, "deploy: completed (run_stub)");
  is("…and nothing is owed any more", cat(threadFile(TID1, "deploy-owed")), "");

  // THE OBLIGATION IS WRITTEN BEFORE THE LANDED SHA. A close killed between
  // the two (here, by a git that kills its caller on the first read after the
  // SHA is recorded) must leave the retry something to check, not a landed
  // SHA that lets it skip the poll.
  fixture("c6k");
  writeAwaitStub();
  writePrefixList('["one"]');
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  write(
    join(F.S, "killgit/git"),
    `#!/usr/bin/env bash\ncase " $* " in *" -C ${F.CODE} rev-parse --abbrev-ref HEAD "*) kill -9 $PPID; exit 1 ;; esac\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(F.S, "killgit/git"), 0o755);
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["killed"], { merge: true, extra: { PATH: `${join(F.S, "killgit")}:${process.env.PATH ?? ""}` } });
  isnt("the close was killed after the push", r.rc, "0");
  is("…before any poll", polledCount(), "");
  r = land(1, ["killed"], { merge: true, extra: failing });
  is("the retry checks the deploy it never polled, and refuses on a failed run", r.rc, "3");
  is("…having polled it", polledCount(), "1");
});

kase("Case 6p: a satellite's poller runs in the checkout that supplies it", () => {
  // A poller asks git or gh about ITS repo, from where it stands. Started in
  // the caller's directory (the thread's own worktree of another repo), a
  // satellite's poller asked about the wrong repo, and a push that deployed
  // fine stayed NOT CLOSED.
  fixture("c6p");
  write(
    join(F.PROD, ".agents/deploy/await-deploy-run.sh"),
    `#!/usr/bin/env bash
echo "deploy: completed for $(basename "$(git remote get-url origin)")"
`,
  );
  write(join(F.PROD, ".agents/deployable-prefixes.json"), '["one"]\n');
  gDo(F.PROD, "add", ".agents");
  gDo(F.PROD, "commit", "-q", "-m", "the prod poller");
  gDo(F.PROD, "push", "-q", "origin", "main");
  const SAT = writeRoot(1, F.PROD).out;
  write(join(SAT, "one-prod.md"), "prod\n");
  const r = land(1, ["thread one"], { merge: true });
  is("a satellite that opted in closes on its own poller's verdict", r.rc, "0");
  has("…which asked about the satellite's repo", r.out, `deploy: completed for ${basename(F.PROD)}.git`);
});

// ── Case 7 ────────────────────────────────────────────────────────────────

kase("Case 7: a journal the aggregator could not parse never lands", () => {
  fixture("c7");
  const J = jf(1, "broken entry");
  // Two front-matter blocks: the shape a concurrent append used to produce, and
  // the one the aggregator reads only the first of.
  write(
    J,
    lines(
      "---",
      "date: 2026-09-13",
      "slug: broken-entry",
      "---",
      "",
      "### broken-entry",
      "",
      "---",
      "date: 2026-09-13",
      "tags: []",
      "---",
    ),
  );

  let r = land(1, ["thread one"], { merge: true });
  is("unparseable front matter exits 3", r.rc, "3");
  has("naming the file", r.out, "NOT CLOSED: journal entry fails the schema");
  is(
    "and nothing was committed in the worktree",
    g(F.WT1, "log", "--oneline", "origin/main..HEAD").split("\n").filter(Boolean).length,
    "0",
  );
  is("so nothing reached main", onMain(F.CODE, `journal/2026-09-13/${basename(J)}`), "no");
  ok("no closed marker", !existsSync(threadFile(TID1, "closed")), "a broken journal still closed the session");

  // Repaired, the same close lands.
  entry(J, "broken-entry", "now it parses");
  r = land(1, ["thread one"], { merge: true });
  is("the repaired entry lands", r.rc, "0");
  has("…and prints the line", r.out, "— closing this tab loses nothing.");
});

// ── Case 7a ───────────────────────────────────────────────────────────────
//
// The same scripts, minus the checker — a rename nobody repointed, or a skills
// tree older than the close running on it. A close that skipped the gate in
// that case would print the safe-to-close line over an unchecked entry. The copy sits at its real relative path under a scratch root, beside
// what it imports, so it runs as the original does.

kase("Case 7a: a missing checker refuses the close rather than skipping", () => {
  fixture("c7a");
  const J = jf(1, "unchecked entry");
  entry(J, "unchecked-entry", "a valid entry, with nothing to check it");
  const NOROOT = join(F.S, "nocheck");
  const NOCHECK = join(NOROOT, ".agents/skills/close/scripts");
  cpSync(HERE, NOCHECK, { recursive: true });
  copyScripts(NOROOT);
  rmSync(join(NOCHECK, "check-journal-entry.ts"), { force: true });
  let r = land(1, ["thread one"], { merge: true, script: join(NOCHECK, "land.ts") });
  is("a missing checker exits 3", r.rc, "3");
  has("naming the script it wanted", r.out, `NOT CLOSED: journal check missing: ${NOCHECK}/check-journal-entry.ts`);
  is(
    "and nothing was committed in the worktree",
    g(F.WT1, "log", "--oneline", "origin/main..HEAD").split("\n").filter(Boolean).length,
    "0",
  );
  is("so nothing reached main", onMain(F.CODE, `journal/2026-09-13/${basename(J)}`), "no");

  // With the checker back, the same entry lands.
  r = land(1, ["thread one"], { merge: true });
  is("the entry lands once the checker is present", r.rc, "0");
});

// ── Case 7b ───────────────────────────────────────────────────────────────

kase("Case 7b: --check cannot certify an obligation that vanished", () => {
  fixture("c7b");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "prod\n");
  // The code repo lands; the product push fails, so its worktree is kept.
  gDo(F.PROD, "remote", "set-url", "--push", "origin", join(F.S, "origins/gone.git"));
  land(1, ["thread one"], { merge: true });
  // Now that kept worktree is deleted by hand — its work exists nowhere.
  rmSync(SAT1, { recursive: true, force: true });
  const r = land(1, ["--check"], { merge: true });
  is("--check refuses rather than certifying it", r.rc, "3");
  has("naming the worktree that went missing", r.out, `NOT CLOSED: worktree missing before landing: ${SAT1}`);
  hasnt("and never prints the safe-to-close line", r.out, "loses nothing");
});

// ── Case 7c ───────────────────────────────────────────────────────────────
//
// THE THREAD ID IS STDOUT ONLY. Node 22.x prints an ExperimentalWarning on
// stderr when it strips types or loads node:sqlite; captured with stderr merged
// in, that line became part of the id, and the close looked for its ledger
// under a path nobody wrote. stderr is still the message when thread.ts fails.

kase("Case 7c: a warning on thread.ts's stderr is not part of the thread id", () => {
  fixture("c7c");
  write(join(F.WT1, "one.txt"), "one\n");
  is("the close lands with the real thread.ts", land(1, ["thread one"]).rc, "0");
  const STUBROOT = join(F.S, "stubthread");
  const STUBDIR = join(STUBROOT, ".agents/skills/close/scripts");
  cpSync(HERE, STUBDIR, { recursive: true });
  copyScripts(STUBROOT);
  write(
    join(STUBDIR, "thread.ts"),
    `process.stderr.write("(node:1) ExperimentalWarning: Type Stripping is an experimental feature\\n");
if (process.env.STUB_THREAD_FAIL) {
  process.stderr.write("thread: no T3 thread owns this directory\\n");
  process.exit(2);
}
const a = process.argv[2];
const out = a === "--id" ? ${JSON.stringify(TID1)} : a === "--worktree" ? ${JSON.stringify(F.WT1)} : "t3code/one";
process.stdout.write(out + "\\n");
`,
  );
  let r = land(1, ["--check"], { merge: true, script: join(STUBDIR, "land.ts") });
  is("--check finds the thread's ledger despite the warning", r.rc, "0");
  has("…and prints the proof line", r.out, "— closing this tab loses nothing.");
  r = land(1, ["--check"], { merge: true, script: join(STUBDIR, "land.ts"), extra: { STUB_THREAD_FAIL: "1" } });
  is("a failing thread.ts still stops the close", r.rc, "2");
  has("…with its message", r.out, "land: no T3 thread owns this directory");

  // The same for the Next block: next-implement-command.ts's stdout is the
  // block, and a warning on its stderr must not print in the report.
  write(
    join(STUBDIR, "next-implement-command.ts"),
    `process.stderr.write("(node:1) ExperimentalWarning: Type Stripping is an experimental feature\\n");
if (process.env.STUB_NEXT_FAIL) {
  process.stderr.write("Error: no such project\\n");
  process.exit(1);
}
process.stdout.write("/implement stubbed\\n");
`,
  );
  const J = jf(1, "stub next");
  write(
    J,
    lines(
      "---",
      "date: 2026-09-13",
      'time: "20:15"',
      "slug: stub-next",
      "project: demo/2026-01-01_stub",
      "tags: []",
      "---",
      "",
      "### stub-next",
      "**Action:** shipped",
      "",
      "A project close.",
    ),
  );
  r = land(1, ["stub next"], { merge: true, script: join(STUBDIR, "land.ts"), extra: { STUB_NEXT_FAIL: "1" } });
  is("a failing next command stops the close", r.rc, "3");
  has("…with its refusal, not the warning", r.out, "NOT CLOSED: could not derive next action: Error: no such project");
  r = land(1, ["stub next"], { merge: true, script: join(STUBDIR, "land.ts") });
  is("the project close lands", r.rc, "0");
  has("…with the Next block from stdout", r.out, "**Next:**\n\n```\n/implement stubbed\n```");
  hasnt("…and no warning in the report", r.out, "ExperimentalWarning");
});

// ── Case 8 ────────────────────────────────────────────────────────────────

kase("Case 8: the auto-close gate, and what makes it go stale", () => {
  fixture("c8");
  is("before any close, the gate is open", land(1, ["--gate"]).out, "not-fired");

  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "one\n");
  is("with work outstanding it is still open", land(1, ["--gate"]).out, "not-fired");

  land(1, ["thread one"]);
  is("after a clean close it is shut", land(1, ["--gate"]).out, "fired");

  // The regression the per-caller key used to prevent: work done AFTER a close
  // must not be suppressed by that close's marker.
  write(join(F.WT1, "later.txt"), "later work\n");
  is("new work in a worktree re-opens it", land(1, ["--gate"]).out, "not-fired");

  land(1, ["thread one again"]);
  is("and closing again shuts it again", land(1, ["--gate"]).out, "fired");
  is("the later work reached main", onMain(F.CODE, "later.txt"), "yes");

  // A commit that was never pushed counts as outstanding too.
  write(join(F.WT1, "unpushed.txt"), "unpushed\n");
  gDo(F.WT1, "add", "unpushed.txt");
  gDo(F.WT1, "commit", "-q", "-m", "committed but not landed");
  is("an unpushed commit re-opens it", land(1, ["--gate"]).out, "not-fired");

  // A thread that never closed at all.
  is("another thread's marker is not this one's", land(2, ["--gate"]).out, "not-fired");
});

// ── Case 9 ────────────────────────────────────────────────────────────────
//
// The scripts live in a repo this thread holds as a SATELLITE — the workbench
// itself, for a thread T3 opened on a product repo — so the script-bearing worktree is in the ledger
// and is removed by the landing; here it sits AHEAD of T3's own worktree.
// Landing it removed the directory holding thread.sh; every later lookup then
// returned empty, and the T3-worktree guard, which compared against that empty
// string, removed T3's worktree and deleted its branch.
//
// The fixture has the PROD satellite carry the scripts at their real relative
// path. Which repo is which does not matter to the mechanism: what is under
// test is a landing driven from a worktree the same landing removes.
//
// `write-root.sh` normally registers the T3 worktree on its first call, so this
// order is not the common one — it is what you get when a satellite was created
// before the T3 worktree was ever registered. The point of the case is that the
// order must not matter at all.

kase("Case 9: landing the worktree the scripts run from", () => {
  fixture("c9");
  const SATDIR = writeRoot(1, F.PROD).out;
  copyScripts(SATDIR);
  write(join(SATDIR, "one-prod.md"), "prod\n");
  write(join(F.WT1, "one.txt"), "one\n");

  // Put the script-bearing satellite first, T3's worktree second.
  const LEDGER9 = threadFile(TID1, "worktrees");
  const rows = readFileSync(LEDGER9, "utf8").split("\n").filter(Boolean);
  const reordered = [...rows.filter((l) => l.includes(SATDIR)), ...rows.filter((l) => !l.includes(SATDIR))];
  writeFileSync(LEDGER9, reordered.map((l) => `${l}\n`).join(""));
  is("the script's own worktree is first in the ledger", (reordered[0] ?? "").split("\t")[0] ?? "", SATDIR);

  const T3_BRANCH_BEFORE = g(F.WT1, "rev-parse", "--abbrev-ref", "HEAD");
  const r = land(1, ["thread one"], { merge: true, script: join(SATDIR, ".agents/skills/close/scripts/land.ts") });

  is("the close lands", r.rc, "0");
  has("and prints the line", r.out, "— closing this tab loses nothing.");

  // The whole point of the case:
  ok(
    "T3's own worktree survives a run driven from a landed worktree",
    isDir(F.WT1),
    "T3's worktree was deleted — the regression this case exists for",
  );
  is(
    "…and T3's branch still exists",
    gOk(F.CODE, "rev-parse", "--verify", "-q", `refs/heads/${T3_BRANCH_BEFORE}`) ? "present" : "gone",
    "present",
  );
  ok("the script's own worktree is removed, last", !isDir(SATDIR), "the script's own worktree was never removed");
  is("both repos still reached main", onMain(F.CODE, "one.txt") + onMain(F.PROD, "one-prod.md"), "yesyes");
});

// ── Case 10 ───────────────────────────────────────────────────────────────
//
// End to end. `workbench` and a product repo are on `main` and a third repo is
// on `master`. A resolver that refuses a `master` repo outright ("no
// origin/main") leaves the worktree to be built by hand and the push done by
// hand, and this script never sees the repo at all. A close cannot vouch for
// what it could not touch.
//
// Every assertion below is about the `master` repo specifically. If the trunk
// name is ever spelled `main` again anywhere in the landing path, one of them
// fails rather than the whole suite quietly continuing to pass on `main` repos.

kase("Case 10: a satellite repo whose trunk is `master`", () => {
  fixture("c10");

  // The satellite: same construction as the fixture's repos, but on `master`.
  const MBARE = join(F.S, `origins/land-${PID}-c10-legacy.git`);
  const MREPO = join(F.S, `land-${PID}-c10-legacy`);
  gInit(MBARE, "master", true);
  gInit(MREPO, "master");
  gDo(MREPO, "config", "user.email", "t@example.com");
  gDo(MREPO, "config", "user.name", "tester");
  write(join(MREPO, "seed.txt"), "seed\n");
  gDo(MREPO, "add", "seed.txt");
  gDo(MREPO, "commit", "-q", "-m", "seed");
  gDo(MREPO, "remote", "add", "origin", MBARE);
  gDo(MREPO, "push", "-q", "-u", "origin", "master");
  gOk(MREPO, "remote", "set-head", "origin", "--auto");

  // 1. The resolver hands out a worktree at all — this is the step that used to
  //    refuse, and every later assertion depends on it.
  const w = writeRoot(1, MREPO, true);
  const MSAT = w.out;
  is("write-root accepts a master-trunk repo", w.rc, "0");
  is("and the satellite exists", isDir(MSAT) ? "yes" : "", "yes");
  is("branched from origin/master", g(MSAT, "rev-parse", "HEAD"), g(MREPO, "rev-parse", "origin/master"));

  // 2. It lands, with real work in it and in the two `main` repos beside it, so
  //    the mixed-trunk case is what is being exercised rather than a lone repo.
  write(join(MSAT, "legacy.txt"), "legacy\n");
  write(join(F.WT1, "one.txt"), "one\n");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "prod\n");
  const J10 = jf(1, "mixed trunks");
  entry(J10, "mixed-trunks", "a close across three repos, one of them on master");

  let r = land(1, ["thread one"], { merge: true });
  is("the close lands with a master-trunk repo in the ledger", r.rc, "0");
  has("and prints the line", r.out, "— closing this tab loses nothing.");

  // 3. The work actually reached origin/master — not a `main` branch quietly
  //    created beside it, which is what a hardcoded push would have produced.
  gOk(MREPO, "fetch", "-q", "origin", "master");
  is("the file is on origin/master", gOk(MREPO, "cat-file", "-e", "origin/master:legacy.txt") ? "yes" : "no", "yes");
  is(
    "and no stray origin/main was created",
    gOk(MREPO, "rev-parse", "--verify", "-q", "origin/main") ? "stray" : "clean",
    "clean",
  );

  // 4. The two `main` repos are untouched by the change — the regression that
  //    would matter most, since every repo in daily use is one of these.
  is("the main repos still landed", onMain(F.CODE, "one.txt") + onMain(F.PROD, "one-prod.md"), "yesyes");

  // 5. The report line names the trunk of the repo the JOURNAL landed in, because
  //    that is whose SHA it carries. A line that said `origin/master` beside a
  //    `main` SHA would be a false sentence with a real SHA in it.
  has("the report line names the trunk the SHA is on", r.out, "origin/main is at");
  is(
    "…and the SHA is the journal repo's",
    lastLine(r.out),
    `origin/main is at ${g(F.CODE, "rev-parse", "origin/main")} — closing this tab loses nothing.`,
  );

  // 6. The satellite is gone, like any other.
  is("the master satellite is removed", isDir(MSAT) ? "left" : "gone", "gone");

  // 7. And --check certifies it, which is the half that was missing when this was
  //    done by hand: nothing recorded that the repo had landed.
  r = land(1, ["--check"], { merge: true });
  is("--check certifies the master-trunk close", r.rc, "0");
});

// ── Case 11 ───────────────────────────────────────────────────────────────

kase("Case 11: the final report includes the generated next action", () => {
  fixture("c11");
  write(join(F.WT1, "projects/sales/2026-09-17_portal/README.md"), lines("---", "status: active", "---", "", "# Portal"));
  const J = jf(1, "portal");
  write(
    J,
    lines(
      "---",
      "date: 2026-09-13",
      'time: "20:15"',
      "slug: sales/2026-09-17_portal",
      "project: sales/2026-09-17_portal",
      "tags: []",
      "---",
      "",
      "### sales/2026-09-17_portal",
      "**Action:** shipped",
      "",
      "Portal phase shipped.",
    ),
  );

  const r = land(1, ["Ship portal phase"], { merge: true });
  is("the project close lands", r.rc, "0");
  has("the generated block states what shipped", r.out, "**Shipped:** Ship portal phase");
  has("the generated block labels the next action", r.out, "**Next:**");
  has("the generated block includes the exact command", r.out, "/project portal");
  has("the generated next action is its own fenced block", r.out, "**Next:**\n\n```\n/project portal\n```");
  has(
    "the generated block gives the journal's landed path, in the shared checkout",
    r.out,
    `**Journal:** [${basename(J)}](<${F.CODE}/journal/2026-09-13/${basename(J)}>)`,
  );
  is(
    "the proof remains the last line",
    lastLine(r.out),
    `origin/main is at ${g(F.CODE, "rev-parse", "origin/main")} — closing this tab loses nothing.`,
  );
});

// A ROADMAP project with two rows ready to implement and one blocked: the close
// must print TWO fenced blocks — one copy button per parallel session — and the
// blocked row as prose, not a heading, with the proof line still last.
kase("Case 11b: several next commands, each in its own block", () => {
  fixture("c11b");
  const P11B = join(F.WT1, "projects/sales/2026-09-18_par");
  mkdirSync(join(P11B, "specs/001-a"), { recursive: true });
  mkdirSync(join(P11B, "specs/002-b"), { recursive: true });
  write(join(P11B, "README.md"), lines("---", "status: active", "---", "", "# Par"));
  write(
    join(P11B, "ROADMAP.md"),
    lines(
      "# Roadmap: par",
      "",
      "| ID | Sub-feature | Depends on | Status | Sub-spec |",
      "|----|-------------|------------|--------|----------|",
      "| R1 | a | — | planned | `specs/001-a/` |",
      "| R2 | b | — | planned | `specs/002-b/` |",
      "| R3 | c | — | blocked: vendor reply | — |",
    ),
  );
  write(join(P11B, "specs/001-a/spec.md"), "# spec\n");
  write(join(P11B, "specs/002-b/spec.md"), "# spec\n");
  const J = jf(1, "par");
  write(
    J,
    lines(
      "---",
      "date: 2026-09-13",
      'time: "20:30"',
      "slug: sales/2026-09-18_par",
      "project: sales/2026-09-18_par",
      "tags: []",
      "---",
      "",
      "### sales/2026-09-18_par",
      "**Action:** specced",
      "",
      "Two rows specced.",
    ),
  );
  const r = land(1, ["Spec par rows"], { merge: true });
  is("the parallel close lands", r.rc, "0");
  has(
    "two commands are two fenced blocks",
    r.out,
    "**Next:**\n\n```\n/implement par r1\n```\n\n```\n/implement par r2\n```",
  );
  has("a comment line is escaped prose", r.out, "\n\\# par R3 is blocked: vendor reply");
  is(
    "the proof remains the last line after several blocks",
    lastLine(r.out),
    `origin/main is at ${g(F.CODE, "rev-parse", "origin/main")} — closing this tab loses nothing.`,
  );
});

// The journal schema tells a one-off close to write `project: null`. That is
// YAML's null, not a folder named "null" — reading it as a path refused every
// one-off close written to the schema.
kase("Case 11c: a one-off's `project: null` is no project", () => {
  fixture("c11c");
  const J = jf(1, "oneoff");
  write(
    J,
    lines(
      "---",
      "date: 2026-09-13",
      'time: "20:45"',
      "slug: one-off (a question)",
      "project: null",
      "tags: []",
      "---",
      "",
      "### one-off (a question)",
      "**Action:** investigated",
      "",
      "Answered a question.",
    ),
  );
  const r = land(1, ["Answer a question"], { merge: true });
  is("a project: null close lands", r.rc, "0");
  hasnt("a project: null close prints no Next", r.out, "**Next:**");
});

// ── Case 12 ───────────────────────────────────────────────────────────────
//
// The checker is the workbench's, and what is tested here is that land.ts finds it
// in a ledger worktree, runs it before the commit and honours its verdict — not
// the seven parts, which check-decision-records.test.ts owns. So a stand-in
// that rejects any changed record containing BAD, committed at the path land.ts
// resolves. It logs `<worktree>⇥<record>` for every record it sees to
// DR_STUB_LOG, so a row can prove WHERE it ran rather than only that the close
// passed — a stub run in the wrong worktree passes a clean record too.
function drStub(dir: string): void {
  write(
    join(dir, ".agents/checks/check-decision-records.ts"),
    `import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
let base = "HEAD";
if (argv[0] === "--since") {
  try {
    base = execSync(\`git merge-base HEAD \${argv[1]}\`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.error(\`stub: no merge base with \${argv[1]}\`);
    process.exit(2);
  }
}
const changed = (execSync(\`git diff --name-only \${base}\`, { encoding: "utf8" }) +
  execSync("git ls-files --others --exclude-standard", { encoding: "utf8" })).split("\\n").filter(Boolean);
let rc = 0;
for (const f of changed.filter((p) => /(^|\\/)decisions\\//.test(p))) {
  if (!existsSync(f)) continue;
  appendFileSync(process.env.DR_STUB_LOG || "/dev/null", \`\${process.env.PWD}\\t\${f}\\n\`);
  if (readFileSync(f, "utf8").includes("BAD")) { console.error(\`\${f}: (b) stub rejects it\`); rc = 1; }
}
if (rc === 0) console.log("OK — stub");
process.exit(rc);
`,
  );
  gDo(dir, "add", "-A");
  gDo(dir, "commit", "-q", "-m", "checker");
}

// fixture + the stub's log in the thread's environment.
let DR_LOG = "";
function drFixture(name: string): void {
  fixture(name);
  DR_LOG = join(F.S, "dr.log");
  F.env1 = { ...F.env1, DR_STUB_LOG: DR_LOG };
}

// third_repo <scenario> — a third main-trunk repo and this thread's satellite of
// it, registered AFTER the PROD satellite so it lands after the checker's.
function thirdRepo(name: string): { TREPO: string; TSAT: string } {
  const bare = join(F.S, `origins/land-${PID}-${name}-third.git`);
  const TREPO = join(F.S, `land-${PID}-${name}-third`);
  gInit(bare, "main", true);
  gInit(TREPO, "main");
  gDo(TREPO, "config", "user.email", "t@example.com");
  gDo(TREPO, "config", "user.name", "tester");
  write(join(TREPO, "seed.txt"), "seed\n");
  gDo(TREPO, "add", "seed.txt");
  gDo(TREPO, "commit", "-q", "-m", "seed");
  gDo(TREPO, "remote", "add", "origin", bare);
  gDo(TREPO, "push", "-q", "-u", "origin", "main");
  gOk(TREPO, "remote", "set-head", "origin", "--auto");
  return { TREPO, TSAT: writeRoot(1, TREPO).out };
}

kase("Case 12: the decision-record gate", () => {
  // 1. A malformed record is refused, and nothing is committed.
  drFixture("c12a");
  drStub(F.WT1);
  write(join(F.WT1, "decisions/0001-bad.md"), "BAD\n");
  write(join(F.WT1, "decisions/0002-also-bad.md"), "BAD\n");
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["thread one"], { merge: true });
  is("a malformed decision record exits 3", r.rc, "3");
  has(
    "naming the check's first violation",
    r.out,
    `NOT CLOSED: decision record rejected in ${F.WT1}: decisions/0001-bad.md: (b) stub rejects it`,
  );
  has("…and printing every other violation too", r.out, "decisions/0002-also-bad.md: (b) stub rejects it");
  is(
    "the worktree is left uncommitted",
    g(F.WT1, "status", "--porcelain", "-uall")
      .split("\n")
      .filter((l) => /decisions\/|one\.txt/.test(l)).length,
    "3",
  );
  is("so neither file reached main", onMain(F.CODE, "decisions/0001-bad.md") + onMain(F.CODE, "one.txt"), "nono");

  // 1b. The same record already COMMITTED in the worktree, as /implement commits
  //     before its close. Against HEAD it differs from nothing; the gate must
  //     measure from where the branch left the trunk, or it counts 0 records and
  //     lands the record unchecked.
  drFixture("c12a2");
  drStub(F.WT1);
  write(join(F.WT1, "decisions/0001-bad.md"), "BAD\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "a bad record, committed early");
  r = land(1, ["thread one"], { merge: true });
  is("a malformed record committed before the close exits 3", r.rc, "3");
  has("…naming it", r.out, "decisions/0001-bad.md: (b) stub rejects it");
  is("…and it did not reach main", onMain(F.CODE, "decisions/0001-bad.md"), "no");

  // 2. No decision record: the gate runs, passes, and FALLS THROUGH to the commit.
  //    A `return` in the gate would exit landOne here with one.txt uncommitted.
  drFixture("c12b");
  drStub(F.WT1);
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close with no decision record lands", r.rc, "0");
  is("and its file is committed and on main", onMain(F.CODE, "one.txt"), "yes");
  has("…with the safe-to-close line", r.out, "— closing this tab loses nothing.");

  // 2a. origin/<trunk> named by origin/HEAD but not yet a local ref: only the
  //     fetch creates it, so the gate must fetch before it measures from it, or
  //     every close in that repo — records or none — is refused.
  drFixture("c12b1");
  drStub(F.WT1);
  gDo(F.CODE, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  gDo(F.CODE, "update-ref", "-d", "refs/remotes/origin/main");
  is(
    "origin/main is absent locally before the close",
    gOk(F.CODE, "rev-parse", "-q", "--verify", "refs/remotes/origin/main") ? "present" : "absent",
    "absent",
  );
  write(join(F.WT1, "one.txt"), "one\n");
  write(join(F.WT1, "decisions/0001-scoped.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a trunk ref only the fetch creates does not block the close", r.rc, "0");
  is(
    "…and its file and record reached main",
    onMain(F.CODE, "one.txt") + onMain(F.CODE, "decisions/0001-scoped.md"),
    "yesyes",
  );
  is(
    "…with the record scoped from the fetched ref and checked",
    countLines(DR_LOG, (l) => l.endsWith("decisions/0001-scoped.md")),
    "1",
  );

  // 2b. A well-formed record lands beside it.
  drFixture("c12b2");
  drStub(F.WT1);
  write(join(F.WT1, "decisions/0001-good.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close carrying a clean record lands", r.rc, "0");
  is("and the record is on main", onMain(F.CODE, "decisions/0001-good.md"), "yes");

  // 3. A changed record with no checker anywhere in the ledger is refused, not
  //    skipped — a silent `[ -f ]` would land the record unchecked.
  drFixture("c12c");
  write(join(F.WT1, "projects/x/decisions/0001-a.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a record with no resolvable checker exits 3", r.rc, "3");
  has(
    "saying no worktree holds the checker",
    r.out,
    "no worktree this thread owns holds .agents/checks/check-decision-records.ts",
  );
  is("and it did not reach main", onMain(F.CODE, "projects/x/decisions/0001-a.md"), "no");

  //    A README edit in a decisions/ folder is not a record: with no checker,
  //    that close is not refused.
  rmSync(join(F.WT1, "projects/x/decisions/0001-a.md"));
  write(join(F.WT1, "projects/x/decisions/README.md"), "# Decision records\n");
  r = land(1, ["thread one"], { merge: true });
  is("a decisions/README.md alone needs no checker", r.rc, "0");

  //    The same with the record already COMMITTED: the no-checker question must
  //    measure from the trunk too, or it asks HEAD and finds nothing to refuse.
  fixture("c12c2");
  write(join(F.WT1, "projects/x/decisions/0001-a.md"), "fine\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "a record, committed early");
  is(
    "the record is committed and the index clean before the close",
    (gOk(F.WT1, "cat-file", "-e", "HEAD:projects/x/decisions/0001-a.md") ? "in-head" : "") +
      g(F.WT1, "status", "--porcelain"),
    "in-head",
  );
  r = land(1, ["thread one"], { merge: true });
  is("a committed record with no resolvable checker exits 3", r.rc, "3");
  has("…saying no worktree holds the checker", r.out, "no worktree this thread owns holds");
  is("…and it stayed off main", onMain(F.CODE, "projects/x/decisions/0001-a.md"), "no");

  // 4. The checker's own satellite lands BEFORE a repo whose records it must
  //    check. Its removal is deferred to the end; removed in turn, the third repo
  //    would find the resolved path gone and fail with no violation at all. The
  //    checker's worktree is a satellite when the thread is on a product repo
  //    and workbench is the satellite; the fixture gives the PROD satellite the
  //    checker, which puts it in the same ledger position.
  drFixture("c12d");
  let SAT1 = writeRoot(1, F.PROD).out;
  drStub(SAT1);
  let t = thirdRepo("c12d");
  write(join(t.TSAT, "decisions/0001-third.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a record in a repo landed after the checker's satellite lands", r.rc, "0");
  is("and reaches main", onMain(t.TREPO, "decisions/0001-third.md"), "yes");
  const tsat = t.TSAT;
  is(
    "the checker ran IN the third repo's worktree, on its record",
    countLines(DR_LOG, (l) => l === `${tsat}\tdecisions/0001-third.md`),
    "1",
  );
  is("the checker's satellite is still removed, last", isDir(SAT1) ? "left" : "gone", "gone");

  // 5. The same shape, but the third repo's record is bad on the first run. The
  //    checker's satellite has already landed when the close is refused, so its
  //    deferred removal never ran; the retry finds it already landed and must
  //    queue that removal again, or it is left on disk under the proof line.
  drFixture("c12e");
  SAT1 = writeRoot(1, F.PROD).out;
  drStub(SAT1);
  t = thirdRepo("c12e");
  write(join(t.TSAT, "decisions/0001-third.md"), "BAD\n");
  r = land(1, ["thread one"], { merge: true });
  is("the first run is refused on the third repo's record", r.rc, "3");
  is(
    "…after the checker's satellite landed",
    g(F.PROD, "log", "origin/main", "--format=%s")
      .split("\n")
      .filter((l) => l === "checker").length,
    "1",
  );
  write(join(t.TSAT, "decisions/0001-third.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("the retry lands", r.rc, "0");
  is("the already-landed checker satellite is removed on the retry", isDir(SAT1) ? "left" : "gone", "gone");
});

// ── Case 13 ───────────────────────────────────────────────────────────────
//
// The same shape as Case 12 for the second pre-commit checker. What is tested
// is that land.ts finds it, runs it with --since before the commit and honours
// its verdict; the schema's parts are check-integration-manifest.test.ts's.
function imStub(dir: string): void {
  write(
    join(dir, ".agents/checks/check-integration-manifest.ts"),
    `import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
let base = "HEAD";
if (argv[0] === "--since") {
  try {
    base = execSync(\`git merge-base HEAD \${argv[1]}\`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.error(\`stub: no merge base with \${argv[1]}\`);
    process.exit(2);
  }
}
const changed = (execSync(\`git diff --name-only \${base}\`, { encoding: "utf8" }) +
  execSync("git ls-files --others --exclude-standard", { encoding: "utf8" })).split("\\n").filter(Boolean);
let rc = 0;
for (const f of changed.filter((p) => /^integrations\\/[^/]+\\/README\\.md$/.test(p))) {
  if (!existsSync(f)) continue;
  if (readFileSync(f, "utf8").includes("BAD")) { console.error(\`\${f}: (k) stub rejects it\`); rc = 1; }
}
if (rc === 0) console.log("OK — stub");
process.exit(rc);
`,
  );
  gDo(dir, "add", "-A");
  gDo(dir, "commit", "-q", "-m", "manifest checker");
}

kase("Case 13: the integration-manifest gate", () => {
  // 1. A bad manifest is refused with every violation printed, nothing committed.
  fixture("c13a");
  imStub(F.WT1);
  write(join(F.WT1, "integrations/alpha/README.md"), "BAD\n");
  write(join(F.WT1, "integrations/beta/README.md"), "BAD\n");
  let r = land(1, ["thread one"], { merge: true });
  is("a bad integration manifest exits 3", r.rc, "3");
  has(
    "naming the check's first violation",
    r.out,
    `NOT CLOSED: integration manifest rejected in ${F.WT1}: integrations/alpha/README.md: (k) stub rejects it`,
  );
  has("…and printing every other violation too", r.out, "integrations/beta/README.md: (k) stub rejects it");
  is("…and it did not reach main", onMain(F.CODE, "integrations/alpha/README.md"), "no");

  // 2. The same manifest COMMITTED before the close is still measured from the trunk.
  fixture("c13b");
  imStub(F.WT1);
  write(join(F.WT1, "integrations/alpha/README.md"), "BAD\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "a bad manifest, committed early");
  r = land(1, ["thread one"], { merge: true });
  is("a bad manifest committed before the close exits 3", r.rc, "3");
  has("…naming it", r.out, "integrations/alpha/README.md: (k) stub rejects it");

  // 3. A clean manifest lands.
  fixture("c13c");
  imStub(F.WT1);
  write(join(F.WT1, "integrations/alpha/README.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close carrying a clean manifest lands", r.rc, "0");
  is("and the manifest is on main", onMain(F.CODE, "integrations/alpha/README.md"), "yes");

  // 4. A changed manifest with no checker in the ledger is reported, not refused:
  //    a workbench without that checker has no manifest schema to hold it to.
  fixture("c13d");
  write(join(F.WT1, "integrations/alpha/README.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a manifest with no resolvable checker still lands", r.rc, "0");
  has(
    "saying no checker looked at it",
    r.out,
    `note: integration manifests changed in ${F.WT1}; no .agents/checks/check-integration-manifest.ts to check them`,
  );

  //    A manifest outside integrations/<name>/ is not one: no checker needed.
  rmSync(join(F.WT1, "integrations"), { recursive: true, force: true });
  write(join(F.WT1, "docs/integrations/alpha/README.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a README.md outside integrations/<name>/ needs no checker", r.rc, "0");
});

// ── Case 14 ───────────────────────────────────────────────────────────────
//
// The third pre-commit checker, and the first that lives in the worktree it
// checks: the skills tree is `.agents/skills/` of the workbench, its checker is
// `.agents/checks/check-skills.ts`, and land.ts runs THAT copy over what the worktree
// changed under `.agents/skills/`. What is tested is that it is found, run with
// --since before the commit, and honoured — the rules themselves are
// check-skills.test.ts's. The stub writes a marker on every invocation (into
// the fixture HOME, which outlives the worktree), so "not invoked" is
// observable.
function skStub(dir: string): void {
  write(
    join(dir, ".agents/checks/check-skills.ts"),
    `import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
writeFileSync(\`\${process.env.HOME}/.skill-stub-invoked\`, "");
let base = "HEAD";
if (process.argv[2] === "--since") {
  try {
    base = execSync(\`git merge-base HEAD \${process.argv[3]}\`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.error(\`stub: no merge base with \${process.argv[3]}\`);
    process.exit(2);
  }
}
const changed = (execSync(\`git diff --name-only \${base}\`, { encoding: "utf8" }) +
  execSync("git ls-files --others --exclude-standard", { encoding: "utf8" })).split("\\n").filter(Boolean);
let rc = 0;
for (const f of changed.filter((p) => /^\\.agents\\/skills\\/[^/]+\\/SKILL\\.md$/.test(p))) {
  if (!existsSync(f)) continue;
  if (readFileSync(f, "utf8").includes("BAD")) { console.error(\`\${f}: stub rejects it\`); rc = 1; }
}
if (rc === 0) console.log("OK — stub");
process.exit(rc);
`,
  );
  gDo(dir, "add", "-A");
  gDo(dir, "commit", "-q", "-m", "skill checker");
}

const skInvoked = (): string => (existsSync(join(F.HOME_DIR, ".skill-stub-invoked")) ? "invoked" : "not");

kase("Case 14: the skill-manifest gate", () => {
  // 1. A bad manifest is refused with the violation printed, nothing committed.
  fixture("c14a");
  skStub(F.WT1);
  write(join(F.WT1, ".agents/skills/alpha/SKILL.md"), "BAD\n");
  let r = land(1, ["thread one"], { merge: true });
  is("a bad skill manifest exits 3", r.rc, "3");
  has(
    "naming the check's violation",
    r.out,
    `NOT CLOSED: skill manifest rejected in ${F.WT1}: .agents/skills/alpha/SKILL.md: stub rejects it`,
  );
  is("…and it did not reach main", onMain(F.CODE, ".agents/skills/alpha/SKILL.md"), "no");

  // 2. A clean manifest lands, and the checker ran.
  fixture("c14b");
  skStub(F.WT1);
  write(join(F.WT1, ".agents/skills/alpha/SKILL.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close carrying a clean skill manifest lands", r.rc, "0");
  is("and the manifest is on main", onMain(F.CODE, ".agents/skills/alpha/SKILL.md"), "yes");

  // 3. A changed manifest in a worktree without the checker is refused, not skipped.
  fixture("c14c");
  write(join(F.WT1, ".agents/skills/alpha/SKILL.md"), "fine\n");
  r = land(1, ["thread one"], { merge: true });
  is("a skill manifest with no checker in its worktree exits 3", r.rc, "3");
  has(
    "saying the worktree holds no .agents/checks/check-skills.ts",
    r.out,
    `skill manifests changed in ${F.WT1}, but ${F.WT1} holds no .agents/checks/check-skills.ts`,
  );

  // 4. Only a root-level file changed, or a path under a top-level folder that is
  //    NOT .agents/skills/ — a journal entry, a project record — and the checker is not
  //    invoked: the gate is scoped to `.agents/skills/`, not to "any top-level folder",
  //    because in this repo every close changes paths under one. A file under a
  //    skill folder that is NOT its SKILL.md (a state/ file) does invoke it —
  //    within .agents/skills/ the gate selects by folder, not by manifest.
  fixture("c14d");
  skStub(F.WT1);
  write(join(F.WT1, "seed.txt"), "edited\n");
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  write(join(F.WT1, "projects/x/README.md"), "record\n");
  r = land(1, ["thread one"], { merge: true });
  is("a change outside .agents/skills/ lands", r.rc, "0");
  is("…without invoking the skill checker", skInvoked(), "not");
  fixture("c14e");
  skStub(F.WT1);
  write(join(F.WT1, ".agents/skills/alpha/state/notes.md"), "learned\n");
  r = land(1, ["thread one"], { merge: true });
  is("a change under a skill folder lands when the checker passes", r.rc, "0");
  is("…and the skill checker was invoked for it", skInvoked(), "invoked");

  //    A change that only DELETES a file under a skill folder (state/_doc.md)
  //    still selects the folder: the checker decides what a missing file means.
  fixture("c14f");
  skStub(F.WT1);
  write(join(F.WT1, ".agents/skills/alpha/SKILL.md"), "fine\n");
  write(join(F.WT1, ".agents/skills/alpha/state/_doc.md"), "doc\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "alpha with state");
  // On the trunk already, so the deletion is the ONLY change since the base.
  gDo(F.WT1, "push", "-q", "origin", "HEAD:main");
  rmSync(join(F.WT1, ".agents/skills/alpha/state/_doc.md"));
  r = land(1, ["thread one"], { merge: true });
  is("a deletion under a skill folder lands when the checker passes", r.rc, "0");
  is("…and the skill checker was invoked for it", skInvoked(), "invoked");
});

// ── Case 14s ──────────────────────────────────────────────────────────────
//
// The secrets and standards gates. Both checkers sit in the workbench
// worktree's .agents/checks/. The secrets scan runs over every repo's change;
// the standards check over the workbench worktree that holds it, reading its
// tree rather than a range. What is tested is that each is found, run, and
// honoured — their rules are check-secrets.test.ts's and
// check-standards-refs.test.ts's.
function checksStub(dir: string): void {
  write(
    join(dir, ".agents/checks/check-secrets.ts"),
    `import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
let base = "HEAD";
if (process.argv[2] === "--since") base = execSync(\`git merge-base HEAD \${process.argv[3]}\`, { encoding: "utf8" }).trim();
const changed = (execSync(\`git diff --name-only \${base}\`, { encoding: "utf8" }) +
  execSync("git ls-files --others --exclude-standard", { encoding: "utf8" })).split("\\n").filter(Boolean);
const pat = "AK" + "IA"; // split, so the stub does not flag itself
let rc = 0;
for (const f of changed) {
  if (existsSync(f) && readFileSync(f, "utf8").includes(pat)) { console.error(\`\${f}: looks like a key\`); rc = 1; }
}
process.exit(rc);
`,
  );
  write(
    join(dir, ".agents/checks/check-standards-refs.ts"),
    // Reads what git reads, as the real checker does: `git grep` sees tracked
    // files only, and `--cached` the staged copies. A stub that walked the
    // filesystem saw an untracked file the real checker never would.
    `import { spawnSync } from "node:child_process";
const cached = process.argv[2] === "--cached";
const g = spawnSync("git", ["grep", ...(cached ? ["--cached"] : []), "-l", "-F", "-e", "Standards → Nonexistent", "--", "*.md"], { encoding: "utf8" });
if (g.status === 0) { console.error("cites a bullet that does not exist: Nonexistent"); process.exit(1); }
if (g.status !== 1) { console.error(\`git grep failed: \${g.stderr}\`); process.exit(2); }
`,
  );
  gDo(dir, "add", "-A");
  gDo(dir, "commit", "-q", "-m", "checks");
}

kase("Case 14s: the secrets and standards gates", () => {
  fixture("c14sa");
  checksStub(F.WT1);
  write(join(F.WT1, "config.txt"), "key = AKIA0000\n");
  let r = land(1, ["thread one"], { merge: true });
  is("a change carrying a secret exits 3", r.rc, "3");
  has("…naming the secret scan", r.out, `NOT CLOSED: secret scan rejected in ${F.WT1}: config.txt: looks like a key`);
  is("…and nothing reached main", onMain(F.CODE, "config.txt"), "no");

  fixture("c14sb");
  checksStub(F.WT1);
  let SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "leak.txt"), "key = AKIA0000\n");
  r = land(1, ["thread one"], { merge: true });
  is("a secret in a product repo is refused by the workbench's scanner", r.rc, "3");
  has("…in that repo's worktree", r.out, `secret scan rejected in ${SAT1}`);

  fixture("c14sc");
  checksStub(F.WT1);
  write(join(F.WT1, "notes.md"), "See § Standards → Nonexistent.\n");
  r = land(1, ["thread one"], { merge: true });
  is("a citation of a missing standard exits 3", r.rc, "3");
  has("…naming the standards check", r.out, `NOT CLOSED: standards citations rejected in ${F.WT1}`);
  is("…and the new file that carried it never reached main", onMain(F.CODE, "notes.md"), "no");

  fixture("c14sd");
  checksStub(F.WT1);
  write(join(F.WT1, "notes.md"), "clean\n");
  r = land(1, ["thread one"], { merge: true });
  is("a clean change passes both gates", r.rc, "0");

  // Each checker is found in whichever ledger worktree holds IT: a worktree with
  // some of .agents/checks/ must not hide a checker only a later one carries.
  fixture("c14se");
  checksStub(F.WT1);
  gDo(F.WT1, "rm", "-q", ".agents/checks/check-secrets.ts");
  gDo(F.WT1, "commit", "-q", "-m", "no scanner here");
  SAT1 = writeRoot(1, F.PROD).out;
  checksStub(SAT1);
  write(join(F.WT1, "config.txt"), "key = AKIA0000\n");
  r = land(1, ["thread one"], { merge: true });
  is("a scanner only a later ledger worktree holds still runs", r.rc, "3");
  has("…and refuses the secret", r.out, `secret scan rejected in ${F.WT1}`);
});

// ── Case 15 ───────────────────────────────────────────────────────────────

const RMP = "projects/demo/2026-01-01_rows";
const ROADMAP = join(HERE, "roadmap.ts");
function roadmap(...args: string[]): boolean {
  return (
    spawnSync(process.execPath, [...NODE_TS, ROADMAP, ...args], { stdio: "ignore" }).status === 0
  );
}
function tableHead(): string[] {
  return [
    "# Roadmap: rows",
    "",
    "| ID | Sub-feature | Depends on | Status | Sub-spec |",
    "|----|-------------|------------|--------|----------|",
  ];
}
function nextLine(text: string): string {
  return text
    .split("\n")
    .filter((l) => l.startsWith("next: "))
    .map((l) => l.slice("next: ".length))
    .join("\n");
}
function sedLines(p: string, from: RegExp | string, to: string): void {
  const text = readFileSync(p, "utf8");
  writeFileSync(
    p,
    text
      .split("\n")
      .map((l) => l.replace(from, to))
      .join("\n"),
  );
}

// Two sessions build two rows of one project in parallel and each flips its own
// row. The rows are adjacent lines, which git's line merge calls a conflict, so
// the second close used to stop with NOT CLOSED. land.ts wires roadmap-merge.ts
// in before it merges, and the table merges row by row.
kase("Case 15: two threads land adjacent roadmap rows", () => {
  fixture("c15");
  write(
    join(F.CODE, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | planned | `specs/001-first/` |",
      "| R2 | second | — | planned | `specs/002-second/` |",
      "| R3 | third | R1, R2 | planned | — |",
    ),
  );
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  for (const wt of [F.WT1, F.WT2]) {
    gDo(wt, "fetch", "-q", "origin");
    gDo(wt, "reset", "-q", "--hard", "origin/main");
  }
  // Each session flips its own row and re-derives next: from its own table, as
  // the close's project step does — so the two READMEs disagree.
  if (roadmap(join(F.WT1, RMP), "--set", "R1", "done")) roadmap(join(F.WT1, RMP), "--sync-next");
  if (roadmap(join(F.WT2, RMP), "--set", "R2", "done")) roadmap(join(F.WT2, RMP), "--sync-next");
  entry(jf(1, "row one"), "row-one", "thread one's row");
  entry(jf(2, "row two"), "row-two", "thread two's row");
  const r1 = land(1, ["row one"], { merge: true });
  is("the first row lands", r1.rc, "0");
  const r2 = land(2, ["row two"], { merge: true });
  is("the second, adjacent row lands too — no conflict", r2.rc, "0");
  if (r2.rc !== 0) process.stdout.write(`${r2.out.split("\n").slice(-3).join("\n")}\n`);
  gOk(F.CODE, "fetch", "-q", "origin");
  const rows = g(F.CODE, "show", `origin/main:${RMP}/ROADMAP.md`)
    .split("\n")
    .filter((l) => l.startsWith("| R"))
    .map((l) => {
      const f = l.split("|");
      return `${(f[1] ?? "").replace(/ /g, "")}=${(f[4] ?? "").replace(/^ +| +$/g, "")} `;
    })
    .join("");
  is("origin's roadmap has both rows done and R3 untouched", rows, "R1=done R2=done R3=planned ");
  is(
    "…and next: re-derived from the merged table, to R3",
    nextLine(g(F.CODE, "show", `origin/main:${RMP}/README.md`)),
    '"R3: third"',
  );
  has("the driver is registered in the repo's config", g(F.CODE, "config", "merge.roadmap.driver"), "roadmap-merge.ts");
});

// THE NEXT ACTION IS THE MERGED PROJECT'S. The same two parallel rows, each
// close naming the project: thread two's own table, before the merge, still
// shows R1 ready, and the Next line used to be derived from that copy — so the
// second close printed `/implement rows r1` for a row thread one had already
// landed. It must be derived from the table that lands.
kase("Case 15n: parallel rows print the next action of the merged table", () => {
  fixture("c15n");
  write(
    join(F.CODE, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | planned | `specs/001-first/` |",
      "| R2 | second | — | planned | `specs/002-second/` |",
      "| R3 | third | R1, R2 | planned | `specs/003-third/` |",
    ),
  );
  for (const s of ["001-first", "002-second", "003-third"]) write(join(F.CODE, RMP, "specs", s, "spec.md"), "# spec\n");
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  for (const wt of [F.WT1, F.WT2]) {
    gDo(wt, "fetch", "-q", "origin");
    gDo(wt, "reset", "-q", "--hard", "origin/main");
  }
  if (roadmap(join(F.WT1, RMP), "--set", "R1", "done")) roadmap(join(F.WT1, RMP), "--sync-next");
  if (roadmap(join(F.WT2, RMP), "--set", "R2", "done")) roadmap(join(F.WT2, RMP), "--sync-next");
  const journal = (n: 1 | 2, slug: string): void =>
    write(
      jf(n, slug),
      lines(
        "---",
        "date: 2026-09-13",
        'time: "20:15"',
        `slug: ${slug}`,
        "project: demo/2026-01-01_rows",
        "tags: []",
        "---",
        "",
        `### ${slug}`,
        "**Action:** shipped",
        "",
        "A row shipped.",
      ),
    );
  journal(1, "row-one");
  journal(2, "row-two");
  const r1 = land(1, ["row one"], { merge: true });
  is("the first row lands", r1.rc, "0");
  const r2 = land(2, ["row two"], { merge: true });
  is("the second row lands", r2.rc, "0");
  has("…and its Next is the merged table's R3", r2.out, "**Next:**\n\n```\n/implement rows r3\n```");
  hasnt("…never the row thread one already landed", r2.out, "/implement rows r1");
  is("…and the remembered next action is the merged one too", cat(threadFile(TID2, "next")), "/implement rows r3");
});

// The merge changed the table, but the merged table no longer reads (here a
// row the trunk added was never filled in), so next: cannot be re-derived.
// Pushing then would ship a README whose next: names the wrong row.
kase("Case 15b: next: that cannot be re-derived stops the close", () => {
  fixture("c15b");
  write(
    join(F.CODE, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | planned | `specs/001-first/` |",
      "| R2 | second | — | planned | `specs/002-second/` |",
    ),
  );
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT2, "fetch", "-q", "origin");
  gDo(F.WT2, "reset", "-q", "--hard", "origin/main");
  writeFileSync(
    join(F.CODE, RMP, "ROADMAP.md"),
    `${readFileSync(join(F.CODE, RMP, "ROADMAP.md"), "utf8")}| R3 | <name> | — | planned | — |\n`,
  );
  gDo(F.CODE, "commit", "-qam", "a row nobody filled in");
  gDo(F.CODE, "push", "-q", "origin", "main");
  sedLines(join(F.WT2, RMP, "ROADMAP.md"), "| R2 | second | — | planned |", "| R2 | second | — | done |");
  entry(jf(2, "row two"), "row-two", "thread two's row");
  const doneRows = (): string =>
    String(
      g(F.CODE, "show", `origin/main:${RMP}/ROADMAP.md`)
        .split("\n")
        .filter((l) => l.includes("| R2 | second | — | done |")).length,
    );
  let r = land(2, ["row two"], { merge: true });
  is("a next: that cannot be re-derived stops the close", r.rc, "3");
  has("…naming why", r.out, "NOT CLOSED: next: could not be re-derived");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…and nothing of it was pushed", doneRows(), "0");
  // The merge stays committed in the worktree. A re-run finds trunk already
  // merged, and must still re-derive next: before it pushes, not skip it.
  r = land(2, ["row two"], { merge: true });
  is("a re-run with the table still broken stops again", r.rc, "3");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…and still pushes nothing", doneRows(), "0");
});

// The trunk flipped a row and re-derived next:; this thread touched only the
// project's README body. The merged ROADMAP.md is the trunk's, but the README
// merge keeps OUR next: line — the old one — so the project must still be
// re-derived, because the push changes its README.
kase("Case 15c: a table only the trunk changed, a README only we changed", () => {
  fixture("c15c");
  write(
    join(F.CODE, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | planned | `specs/001-first/` |",
      "| R2 | second | — | planned | `specs/002-second/` |",
    ),
  );
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n\nBody.\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT2, "fetch", "-q", "origin");
  gDo(F.WT2, "reset", "-q", "--hard", "origin/main");
  if (roadmap(join(F.CODE, RMP), "--set", "R1", "done")) roadmap(join(F.CODE, RMP), "--sync-next");
  gDo(F.CODE, "commit", "-qam", "R1 done");
  gDo(F.CODE, "push", "-q", "origin", "main");
  sedLines(join(F.WT2, RMP, "README.md"), /^Body\.$/, "Body, edited by thread two.");
  entry(jf(2, "readme only"), "readme-only", "thread two's README");
  const r = land(2, ["readme only"], { merge: true });
  is("a README-only change over a trunk-only table change lands", r.rc, "0");
  gOk(F.CODE, "fetch", "-q", "origin");
  is(
    "…with next: derived from the table that landed",
    nextLine(g(F.CODE, "show", `origin/main:${RMP}/README.md`)),
    '"R2: second"',
  );
  has("…and thread two's edit", g(F.CODE, "show", `origin/main:${RMP}/README.md`), "Body, edited by thread two.");
});

// ── Case 12x ──────────────────────────────────────────────────────────────

/** A `git` that fails the reads matching any pattern and passes everything else to the real one. */
function failingGit(dir: string, ...patterns: string[]): void {
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const glob = patterns.map((p) => `*"${p}"*`).join("|");
  write(
    join(dir, "git"),
    `#!/usr/bin/env bash\ncase " $* " in ${glob}) echo "fatal: simulated read failure" >&2; exit 128 ;; esac\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(dir, "git"), 0o755);
}

kase("Case 12x: a failed git read never reads as clean", () => {
  // A git read that fails is not "nothing changed". A git whose untracked-file
  // listing fails would have hidden this record from the gate above, and the
  // close would have landed it unchecked.
  drFixture("c12x1");
  failingGit(join(F.S, "failgit"), " ls-files -z --others ");
  write(join(F.WT1, "projects/x/decisions/0001-a.md"), "fine\n");
  let r = land(1, ["thread one"], {
    merge: true,
    extra: { PATH: `${join(F.S, "failgit")}:${process.env.PATH ?? ""}` },
  });
  is("a failed git read of the change stops the close", r.rc, "3");
  has("…saying it could not list the change", r.out, `could not list what ${F.WT1} changed`);
  is("…and the record did not reach main", onMain(F.CODE, "projects/x/decisions/0001-a.md"), "no");

  // The same for the worktree's status: a failed read is not a clean tree.
  //     Read as empty, the work was never committed and the proof line vouched
  //     for a worktree still holding it.
  drFixture("c12x2");
  failingGit(join(F.S, "failst"), " status --porcelain ");
  write(join(F.WT1, "work.txt"), "work\n");
  r = land(1, ["thread one"], { merge: true, extra: { PATH: `${join(F.S, "failst")}:${process.env.PATH ?? ""}` } });
  is("a failed status read stops the close", r.rc, "3");
  has("…saying so", r.out, `NOT CLOSED: could not read the status of ${F.WT1}`);
  hasnt("…and prints no proof line", r.out, "closing this tab loses nothing");

  // The same for the count of commits the trunk lacks: an unreadable count is
  // not zero. Read through `|| echo 0`, the final check certified a worktree it
  // could not count, and the gate answered `fired` for one.
  fixture("c12x3");
  failingGit(join(F.S, "failrl"), " rev-list --count ");
  const FAILRL = { PATH: `${join(F.S, "failrl")}:${process.env.PATH ?? ""}` };
  write(join(F.WT1, "work.txt"), "work\n");
  r = land(1, ["thread one"], { merge: true, extra: FAILRL });
  is("a failed commit count stops the close", r.rc, "3");
  has("…saying so", r.out, `NOT CLOSED: could not count the commits in ${F.WT1}`);
  hasnt("…and prints no proof line", r.out, "closing this tab loses nothing");
  land(1, ["thread one"]);
  is("with the count readable, the gate is shut", land(1, ["--gate"]).out, "fired");
  is("…but an unreadable count opens it", land(1, ["--gate"], { extra: FAILRL }).out, "not-fired");

  // And for the two SHAs the push decision compares: HEAD and the trunk, each
  // read failing, are two empty strings, which compared equal and read as
  // "nothing to push" while a committed change sat unpushed.
  fixture("c12x4");
  failingGit(join(F.S, "failrp"), " rev-parse HEAD ", " rev-parse origin/main ");
  write(join(F.WT1, "work.txt"), "work\n");
  r = land(1, ["thread one"], { merge: true, extra: { PATH: `${join(F.S, "failrp")}:${process.env.PATH ?? ""}` } });
  is("a failed SHA read stops the close", r.rc, "3");
  has("…naming the read that failed", r.out, `NOT CLOSED: could not read origin/main in ${F.WT1}`);
  hasnt("…never calling it nothing to push", r.out, "nothing to push");
});

// ── Case 15r ──────────────────────────────────────────────────────────────
//
// A repo merged into the workbench with its history, its checkout removed. A
// thread that had landed there before still carries that line, and the next
// close must account for the SHA on the surviving trunk, not refuse.
// (land.test.sh built this in `fixture c15` a second time, on top of the
// first Case 15's world; it has a scenario of its own here.)

kase("Case 15r: a repo retired into another still lists in the ledger", () => {
  fixture("c15r");
  const LIB = join(F.S, `land-${PID}-c15r-lib`);
  gInit(join(F.S, `origins/land-${PID}-c15r-lib.git`), "main", true);
  gInit(LIB, "main");
  gDo(LIB, "config", "user.email", "t@example.com");
  gDo(LIB, "config", "user.name", "tester");
  write(join(LIB, "record.md"), "record\n");
  gDo(LIB, "add", "record.md");
  gDo(LIB, "commit", "-q", "-m", "lib record");
  const LIB_SHA = g(LIB, "rev-parse", "HEAD");
  gDo(F.CODE, "fetch", "-q", LIB, "main");
  gDo(F.CODE, "merge", "-q", "--allow-unrelated-histories", "--no-edit", "FETCH_HEAD");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin", "main");
  gDo(F.WT1, "merge", "-q", "--ff-only", "origin/main");
  rmSync(LIB, { recursive: true, force: true });

  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["thread one"], { merge: true });
  is("thread one lands before the stale line exists", r.rc, "0");
  const LANDED_FILE = threadFile(TID1, "landed");
  writeFileSync(LANDED_FILE, `${readFileSync(LANDED_FILE, "utf8")}${LIB}\t${LIB_SHA}\n`);
  r = land(1, ["--check", "--verbose"], { merge: true });
  is("--check passes when a retired repo's SHA is on a surviving trunk", r.rc, "0");
  has("…and says where it found it", r.out, `retired, ancestor-of-land-${PID}-c15r-code`);

  writeFileSync(LANDED_FILE, `${readFileSync(LANDED_FILE, "utf8")}${LIB}\t0123456789abcdef0123456789abcdef01234567\n`);
  r = land(1, ["--check"], { merge: true });
  is("--check refuses a retired repo's SHA that is on no surviving trunk", r.rc, "3");
  has(
    "…naming the repo and the SHA",
    r.out,
    `${LIB} is gone and 0123456789abcdef0123456789abcdef01234567 is on no surviving repo's trunk`,
  );
});

// ── Case 16 ───────────────────────────────────────────────────────────────
//
// No T3 database, a harness session id, the shell in the MAIN checkout: the
// journal allocation makes the session's worktree (a satellite of the
// workbench), and the close lands it and removes it — there is no harness
// worktree to keep. thread.ts says so ("has no worktree recorded"), which is
// the one empty answer land.ts reads as definite rather than as a failed lookup.

kase("Case 16: a session outside T3 that started in the main checkout", () => {
  fixture("c16");
  const NOT3: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: F.HOME_DIR,
    T3CODE_HOME: join(F.S, "no-t3"),
    LAND_PUSH_SLEEP: "0",
    CONTEXTIUM_SESSION: "cc-16",
    PWD: F.CODE,
  };
  const scripts = join(F.CODE, ".agents/skills/close/scripts");
  const J16 = sh(process.execPath, [...NODE_TS, join(scripts, "journal-file.ts"), "outside t3"], {
    cwd: F.CODE,
    env: NOT3,
  }).out;
  const made = J16.startsWith(`${F.HOME_DIR}/.cache/workbench/worktrees/`) && J16.includes("/cc-16/journal/");
  ok("the entry goes in a worktree made for the session", made, `outside-T3 journal path: ${J16}`);
  if (!made) return;
  entry(J16, "outside-t3", "a session outside T3");
  const W16 = J16.slice(0, J16.indexOf("/journal/"));
  write(join(W16, "work.txt"), "work\n");
  const r = sh(process.execPath, [...NODE_TS, join(scripts, "land.ts"), "outside t3"], {
    cwd: F.CODE,
    env: NOT3,
    merge: true,
  });
  is("it lands", r.rc, "0");
  is("…with its work on main", onMain(F.CODE, "work.txt"), "yes");
  is("…and the worktree the close made is removed", isDir(W16) ? "kept" : "removed", "removed");
  has("…ending on the proof line", lastLine(r.out), "— closing this tab loses nothing.");
});

// ── Case 17 ───────────────────────────────────────────────────────────────
//
// A pre-commit checker resolved from the ledger like the decision-record one.
// What is tested is that land.ts finds it, runs it with --since before the
// commit and honours its verdict; the parts themselves are check-scripts.test.ts's.
// The strict stub goes ON THE TRUNK before the case's own change, because the
// stub is itself a script under the checker's roots with no test beside it.
function scStub(dir: string): void {
  write(
    join(dir, ".agents/checks/check-scripts.ts"),
    `import { execSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const argv = process.argv.slice(2);
let base = "HEAD";
if (argv[0] === "--since") {
  try {
    base = execSync(\`git merge-base HEAD \${argv[1]}\`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    console.error(\`stub: no merge base with \${argv[1]}\`);
    process.exit(2);
  }
}
const changed = (execSync(\`git diff --name-only \${base}\`, { encoding: "utf8" }) +
  execSync("git ls-files --others --exclude-standard", { encoding: "utf8" })).split("\\n").filter(Boolean);
let rc = 0;
const ROOTS = /^\\.agents\\/.*\\.(sh|ts|mjs|js|py)$/;
const { readdirSync } = await import("node:fs");
const { basename, dirname } = await import("node:path");
for (const f of changed.filter((p) => ROOTS.test(p))) {
  if (!existsSync(f) || f.includes(".test.")) continue;
  const stem = basename(f).replace(/\\.[^.]*$/, "");
  if (!readdirSync(dirname(f)).some((n) => n.startsWith(\`\${stem}.test.\`))) {
    console.error(\`\${f}: (a) stub rejects it\`);
    rc = 1;
  }
}
if (rc === 0) console.log("OK — stub");
process.exit(rc);
`,
  );
  gDo(dir, "add", "-A");
  gDo(dir, "commit", "-q", "-m", "script checker");
  gDo(dir, "push", "-q", "origin", "HEAD:main");
}

kase("Case 17: the script-tests gate", () => {
  // 1. A script with no test is refused with every violation printed, nothing committed.
  fixture("c17a");
  scStub(F.WT1);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  write(join(F.WT1, ".agents/skills/y/scripts/other.ts"), "process.argv\n");
  let r = land(1, ["thread one"], { merge: true });
  is("a script with no test exits 3", r.rc, "3");
  has(
    "naming the check's first violation",
    r.out,
    `NOT CLOSED: script tests rejected in ${F.WT1}: .agents/skills/y/scripts/new.sh: (a) stub rejects it`,
  );
  has("…and printing every other violation too", r.out, ".agents/skills/y/scripts/other.ts: (a) stub rejects it");
  is("…and it did not reach main", onMain(F.CODE, ".agents/skills/y/scripts/new.sh"), "no");

  // 2. The same script COMMITTED before the close is still measured from the trunk.
  fixture("c17b");
  scStub(F.WT1);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "a script without a test, committed early");
  r = land(1, ["thread one"], { merge: true });
  is("an untested script committed before the close exits 3", r.rc, "3");
  has("…naming it", r.out, ".agents/skills/y/scripts/new.sh: (a) stub rejects it");

  // 3. The same script with its test beside it lands.
  fixture("c17c");
  scStub(F.WT1);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  write(join(F.WT1, ".agents/skills/y/scripts/new.test.sh"), "bash new.sh\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close carrying a tested script lands", r.rc, "0");
  is("and the script is on main", onMain(F.CODE, ".agents/skills/y/scripts/new.sh"), "yes");

  // 4. A changed script with no checker in any ledger worktree is refused, not skipped.
  fixture("c17d", undefined, undefined, false);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  write(join(F.WT1, ".agents/skills/y/scripts/new.test.sh"), "bash new.sh\n");
  r = land(1, ["thread one"], { merge: true });
  is("a script with no resolvable checker exits 3", r.rc, "3");
  has(
    "saying no worktree holds the checker",
    r.out,
    `scripts changed in ${F.WT1}, but no worktree this thread owns holds .agents/checks/check-scripts.ts`,
  );

  //    Removing a script's only TEST is a changed script too: the deleted path
  //    selects the gate, so a worktree without the checker is refused for it.
  fixture("c17e", undefined, undefined, false);
  write(join(F.WT1, ".agents/skills/y/scripts/old.sh"), "echo old\n");
  write(join(F.WT1, ".agents/skills/y/scripts/old.test.sh"), "bash old.sh\n");
  gDo(F.WT1, "add", "-A");
  gDo(F.WT1, "commit", "-q", "-m", "old with its test");
  gDo(F.WT1, "push", "-q", "origin", "HEAD:main");
  rmSync(join(F.WT1, ".agents/skills/y/scripts/old.test.sh"));
  r = land(1, ["thread one"], { merge: true });
  is("deleting a script's only test with no checker exits 3", r.rc, "3");
  has("…for want of the checker", r.out, `scripts changed in ${F.WT1}, but no worktree this thread owns holds`);

  //    No checker and no script changed: a journal entry and a record land.
  fixture("c17f", undefined, undefined, false);
  write(join(F.WT1, "journal/2026-09-29/1200-x.md"), "entry\n");
  write(join(F.WT1, "projects/x/README.md"), "record\n");
  write(join(F.WT1, "docs/notes.sh"), "prose\n"); // a .sh outside .agents/ is not one
  r = land(1, ["thread one"], { merge: true });
  is("a close that changes no script under .agents/ needs no checker", r.rc, "0");
});

// ── Case 18 ───────────────────────────────────────────────────────────────
//
// ONE LOCK PER REPO. land.ts takes `/tmp/<repo>-git.lock` through lock.sh's
// `lock_repo` before it merges and pushes — flock(1) where it exists, the
// portable symlink lock (`<lock>.lnk`) where not, or where LOCK_NO_FLOCK asks
// for it. Here another writer holds it, through the same lock.sh: the close
// must wait — pushing nothing — and land once it is released. Both modes are
// run. The wait is observed, not timed: the case watches for the close's own
// lock child (a process naming the lock file that is not the holder), and
// falls back to a fixed window where it cannot see one (no /proc).

/** Is some process other than <holder> naming <lock> on its command line? */
function lockWaiterSeen(lock: string, holder: number | undefined): boolean {
  let pids: string[] = [];
  try {
    pids = readdirSync("/proc");
  } catch {
    return false;
  }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid) || Number(pid) === holder) continue;
    let argv: string[] = [];
    try {
      argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    } catch {
      continue;
    }
    if (argv.includes(lock) && argv.some((a) => a.endsWith("lock.sh"))) return true;
  }
  return false;
}

function waitForLine(child: ChildProcess, needle: string): Promise<boolean> {
  return new Promise((done) => {
    let seen = "";
    child.stdout?.on("data", (b: Buffer) => {
      seen += b.toString();
      if (seen.includes(needle)) done(true);
    });
    child.on("exit", () => done(false));
  });
}

kase("Case 18: the repo lock another writer holds", async () => {
  for (const [mode, extra] of [
    ["flock", {}],
    ["portable", { LOCK_NO_FLOCK: "1" }],
  ] as [string, Record<string, string>][]) {
    const name = mode === "flock" ? "c18" : "c18p";
    fixture(name);
    write(join(F.WT1, "one.txt"), "one\n");
    const LOCK = `/tmp/${basename(F.CODE)}-git.lock`;
    const BARE = join(F.S, `origins/land-${PID}-${name}-code.git`);
    const originHead = (): string => sh("git", ["--git-dir", BARE, "rev-parse", "main"]).out;

    const holder = spawn(
      "bash",
      [
        "-c",
        '. "$0"; lock_repo "$1" 5 || exit 1; echo held; cat >/dev/null; lock_repo_release "$1"',
        join(HERE, "lock.sh"),
        LOCK,
      ],
      { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...extra } },
    );
    const held = await waitForLine(holder, "held\n");
    const before = originHead();

    const child = spawn(process.execPath, [...NODE_TS, LAND, "thread one"], {
      cwd: F.WT1,
      env: envOf(1, F.WT1, extra),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr?.on("data", (b: Buffer) => {
      out += b.toString();
    });
    let exitCode: number | null = null;
    const exited = new Promise<number>((done) =>
      child.on("exit", (code) => {
        exitCode = code ?? 1;
        done(exitCode);
      }),
    );

    let exitedWhileHeld = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (exitCode !== null) {
        exitedWhileHeld = true;
        break;
      }
      if (lockWaiterSeen(LOCK, holder.pid)) break;
      await sleep(100);
    }
    if (exitCode !== null) exitedWhileHeld = true;
    const during = originHead();
    holder.stdin?.end();
    const rc = await exited;

    is(`${mode}: the other writer holds the lock`, String(held), "true");
    is(
      `${mode}: a close waits while another writer holds the repo lock`,
      exitedWhileHeld ? `exited: ${out}` : "waiting",
      "waiting",
    );
    is(`${mode}: …and pushes nothing while it waits`, during, before);
    is(`${mode}: …then lands once the lock is released`, rc, "0");
    is(`${mode}: …and its file is on main`, onMain(F.CODE, "one.txt"), "yes");
    if (mode === "portable") {
      // lstat, not exists: the lock is a symlink to a pid, which never resolves.
      let left = "gone";
      try {
        lstatSync(`${LOCK}.lnk`);
        left = "left";
      } catch {}
      is("portable: …and leaves no lock behind", left, "gone");
    }
  }
});

// ── Case 19 ───────────────────────────────────────────────────────────────
//
// THE LAST LINE IS EARNED. It names the trunk as origin holds it NOW — fetched
// and compared, never read off a local ref that may be stale — and a landed SHA
// that origin no longer has is NOT CLOSED, however recently it was pushed.

kase("Case 19: the final line comes from a fresh fetch and an ancestry check", () => {
  fixture("c19");
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["thread one"], { merge: true });
  is("the close lands", r.rc, "0");
  const BARE = join(F.S, `origins/land-${PID}-c19-code.git`);

  // Another writer pushes after the close; nothing here fetches it.
  const OTHER = join(F.S, "other");
  spawnSync("git", ["clone", "-q", BARE, OTHER], { stdio: "ignore" });
  gDo(OTHER, "config", "user.email", "t@example.com");
  gDo(OTHER, "config", "user.name", "tester");
  write(join(OTHER, "later.txt"), "later\n");
  gDo(OTHER, "add", "later.txt");
  gDo(OTHER, "commit", "-q", "-m", "a later writer");
  gDo(OTHER, "push", "-q", "origin", "main");
  const tip = sh("git", ["--git-dir", BARE, "rev-parse", "main"]).out;
  isnt("the shared checkout's own origin/main is stale", g(F.CODE, "rev-parse", "origin/main"), tip);

  r = land(1, ["--check"]);
  is("--check still passes", r.rc, "0");
  is(
    "…and its last line names origin's trunk as fetched now",
    lastLine(r.out),
    `origin/main is at ${tip} — closing this tab loses nothing.`,
  );

  // Origin is rewound to before the landing: the landed SHA is on no trunk.
  const landed = readFileSync(threadFile(TID1, "landed"), "utf8")
    .split("\n")
    .filter((l) => l.startsWith(`${F.CODE}\t`))
    .map((l) => l.split("\t")[1] ?? "")
    .pop();
  const seed = sh("git", ["--git-dir", BARE, "rev-list", "--max-parents=0", "main"]).out.split("\n")[0] ?? "";
  sh("git", ["--git-dir", BARE, "update-ref", "refs/heads/main", seed]);
  r = land(1, ["--check"], { merge: true });
  is("a landed SHA origin no longer has is NOT CLOSED", r.rc, "3");
  has("…naming it and the trunk", r.out, `NOT CLOSED: ${landed} is not on origin/main in ${F.CODE}`);
  hasnt("…and never prints the safe-to-close line", r.out, "loses nothing");
});

// ── Case 20 ───────────────────────────────────────────────────────────────
//
// A KILL AT ANY POINT OF A LANDING LEAVES A RETRY THAT POLLS OR REFUSES. The
// order is: record the obligation for the SHA about to be pushed, push, record
// the landed SHA, poll, clear the obligation. Each gap is a kill point
// (LAND_TEST_KILL_AT), and at each one the retry below — its deploy failing —
// must poll and refuse, never close. The push touches a deployable path under
// a valid prefix list, the shape where a retry that finds HEAD already on
// origin sees an empty diff, calls it "not owed", and would close unpolled if
// the obligation were not on disk first. `polled:1` is reached only after a
// run completes, so its first run's deploy succeeds.

kase("Case 20: every kill point in a landing leaves a retry that polls or refuses", () => {
  const failing = { AWAIT_STUB_RC: "3", AWAIT_STUB_LINE: "deploy: failed (run_bad)" };
  const points: [string, string][] = [
    ["owed-replace:1", "the obligation's rename, before the push"],
    ["pushed:1", "after the push, before the landed SHA"],
    ["landed:1", "after the landed SHA, before the poll"],
    ["polled:1", "after a good poll, before the obligation is cleared"],
  ];
  for (const [point, where] of points) {
    fixture(`c20-${point.replace(/[^a-z0-9]/g, "")}`);
    writeAwaitStub();
    writePrefixList('["apps/", "integrations/", "packages/"]');
    write(join(F.WT1, "apps/x/y.ts"), "code\n");
    const first = point === "polled:1" ? {} : failing;
    let r = land(1, ["killed"], { merge: true, extra: { ...first, LAND_TEST_KILL_AT: point } });
    is(`${point}: the close was killed ${where}`, r.rc, "1");
    const before = Number(polledCount() || "0");
    r = land(1, ["killed"], { merge: true, extra: failing });
    is(`${point}: the retry refuses on the failed deploy`, r.rc, "3");
    hasnt(`${point}: …and prints no proof line`, r.out, "loses nothing");
    is(`${point}: …having polled`, Number(polledCount() || "0") - before, 1);
  }

  // A push that FAILS owes no run: the obligation recorded for it goes back to
  // what it was, and the next close pushes and polls as usual.
  fixture("c20-pushfail");
  writeAwaitStub();
  writePrefixList('["apps/"]');
  write(join(F.WT1, "apps/x/y.ts"), "code\n");
  const PUSHURL = g(F.CODE, "remote", "get-url", "origin");
  gDo(F.CODE, "remote", "set-url", "--push", "origin", join(F.S, "origins/gone.git"));
  let r = land(1, ["push fails"], { merge: true });
  is("a failed push does not close", r.rc, "3");
  has("…saying the push failed", r.out, "NOT CLOSED: push of");
  is("…and leaves no deploy owed for the unpushed SHA", cat(threadFile(TID1, "deploy-owed")), "");
  gDo(F.CODE, "remote", "set-url", "--push", "origin", PUSHURL);
  r = land(1, ["push fails"], { merge: true });
  is("the next close pushes and closes", r.rc, "0");
  is("…polling once", polledCount(), "1");
});
