// land-cases.ts — the cases the close's spec names as the hard gate, and every
// one the close has grown since. Not a suite itself: the eight `land*.test.ts`
// files beside land.ts each run one range of these cases.
//
// WHY EIGHT FILES. The cases run strictly one after another, and every one
// spawns land.ts and its helpers as Node processes. In bash that cost a few
// milliseconds a child; in TypeScript it is a Node start each, and the whole
// suite takes minutes — past the 180 s verify.ts gives one suite. The files
// are processes that `node --test` runs side by side and verify.ts times one
// at a time, while every case and expected string stays in this one file.
// Three files were enough until every landing began running verify.ts first
// (the `land` helper below), which put the gates file alone past four
// minutes; the eight are cut from each case's measured time to finish in
// about two minutes apiece, the live-check case (27) in a file of its own.
//
// Run them all:
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
// Nothing is stubbed except what is not this script's job: the push-checks
// waiter (`await-push-checks.ts` owns its own behavior — what is tested here is
// that its VERDICT is honoured, and which repo and SHA it is asked about), and
// the pre-commit checkers, whose rules their own suites own.
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
  appendFileSync,
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
  realpathSync,
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

/**
 * Register every case numbered from..to (inclusive), in file order — those
 * whose label (`Case 14g`) `pick` accepts, when one number's cases are too
 * long for one file.
 */
export function runCases(from: number, to: number, pick: (label: string) => boolean = () => true): void {
  let chain: Promise<void> = Promise.resolve();
  for (const c of CASES) {
    const n = caseNumber(c.name);
    if (n < from || n > to) continue;
    if (!pick(c.name.split(":")[0] ?? "")) continue;
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
  // Static imports only. A dynamic `import(…)` is a script's lazy half, loaded
  // on a path no fixture reaches, and copying it could put `integrations/`
  // into every fixture repo — which the close then reads as a workbench app
  // change in a product repo (Case 9).
  for (const m of src.matchAll(/(?:from|import)\s+["'](\.{1,2}\/[^"']+)["']/g)) {
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
  // The review receipt's reader, which verify.ts and land.ts run as a program
  // by path rather than import.
  copyWithImports(join(HERE, "../../implement-audit/scripts/audit-dedupe.ts"), destRoot, seen);
}

// The harness-links check land.ts runs from the shared checkout after every
// landing (Case 22).
const HL_CHECK_REL = ".agents/checks/check-harness-config-links.ts";

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
  /** The land.ts `land` runs when a case names none: a stubbed copy (writeAwaitStub). */
  script?: string;
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
      // The harness-links check every landing runs from the shared checkout,
      // as a stub that finds nothing. Case 22 replaces it where it is what is
      // being tested.
      write(join(dir, HL_CHECK_REL), 'console.log("OK — stub");\n');
      gDo(dir, "add", ".agents");
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
  // Each scenario owns its fake session; explicit per-test overrides still win.
  // LAND_GH: a stand-in that answers `--version`, so the push check asks the
  // stub waiter whether or not this machine has gh.
  return {
    ...process.env,
    WORKBENCH_THREAD_ID: "",
    LAND_GH: process.execPath,
    ...(n === 1 ? F.env1 : F.env2),
    ...extra,
    PWD: cwd,
  };
}

// Run land.ts as thread N, from that thread's own T3 worktree. `merge` is the
// bash suite's `2>&1`.
//
// A landing first gets what a session's § 1 and § 3 give it, since land.ts
// refuses without them: a journal entry, committed on its own so each
// case's commit holds only its own files, and a verify run over the worktrees
// as they are now. `bare` leaves both out, for the cases about those refusals.
// The entry is recorded the way journal-file.ts records one — its path in the
// thread's `journal` file — rather than by running it: that script has its own
// suite, and a second and a half on every case's first landing is what pushed
// these files past verify.ts's bound.
function land(
  n: 1 | 2,
  args: string[],
  opt: { merge?: boolean; extra?: Record<string, string>; script?: string; bare?: boolean } = {},
): Res {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  const script = opt.script ?? F.script;
  const landing = args.some((a) => !a.startsWith("-")) && !args.includes("--check") && !args.includes("--gate");
  if (landing && !opt.bare) prereqs(n, script);
  return sh(process.execPath, [...NODE_TS, script ?? LAND, ...args], {
    cwd,
    env: envOf(n, cwd, opt.extra),
    merge: opt.merge ?? false,
  });
}
function prereqs(n: 1 | 2, script?: string): void {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  const ref = threadFile(n === 1 ? TID1 : TID2, "journal");
  if (!isFile(ref) || !isFile(cat(ref))) {
    const J = join(cwd, `journal/2026-09-13/0000-auto-${n}.md`);
    entry(J, `auto-${n}`, `thread ${n}'s entry`);
    write(ref, `${J}\n`);
    gDo(cwd, "add", "--", J);
    gDo(cwd, "commit", "-q", "-m", "journal");
  }
  // A retry over the same content needs no second run: the record still
  // describes it. Measured by what verify measures — every ledger worktree's
  // HEAD and its working tree, untracked files included — through a scratch
  // index, so nothing in the worktree is touched.
  const key = contentKey(n);
  if (VERIFIED_AT.get(`${F.S}:${n}`) === key) return;
  verify(n, script ? join(dirname(script), "verify.ts") : join(HERE, "verify.ts"));
  VERIFIED_AT.set(`${F.S}:${n}`, key);
}

const VERIFIED_AT = new Map<string, string>();
function contentKey(n: 1 | 2): string {
  const ledger = threadFile(n === 1 ? TID1 : TID2, "worktrees");
  const wts = isFile(ledger)
    ? cat(ledger)
        .split("\n")
        .map((l) => l.split("\t")[0] ?? "")
    : [n === 1 ? F.WT1 : F.WT2];
  const idx = join(F.S, `key-index-${n}`);
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  return wts
    .filter((wt) => wt !== "" && isDir(wt))
    .map((wt) => {
      rmSync(idx, { force: true });
      spawnSync("git", ["-C", wt, "add", "-A"], { env, stdio: "ignore" });
      const tree = sh("git", ["-C", wt, "write-tree"], { env }).out;
      return `${wt} ${g(wt, "rev-parse", "HEAD")} ${tree} ${g(wt, "rev-parse", "origin/main")}`;
    })
    .join("\n");
}

// Run verify.ts as thread N, the way § 1 does. No app in a fixture has a real
// toolchain, so a declared half passes (`true <half>`); a skill suite runs for
// real. A script that is not there runs nothing (the case about a missing one).
function verify(n: 1 | 2, script = join(HERE, "verify.ts"), extra: Record<string, string> = {}): Res {
  const cwd = n === 1 ? F.WT1 : F.WT2;
  if (!isFile(script)) return { rc: 0, out: "" };
  return sh(process.execPath, ["--experimental-strip-types", script], {
    cwd,
    env: envOf(n, cwd, { VERIFY_RUNNER: "true", WORKBENCH_THREAD_ID: n === 1 ? TID1 : TID2, ...extra }),
    merge: true,
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
// The push deploys, and this script only checks: a merger that ran the deploy
// would deploy the shared checkout, which another session may hold dirty. The
// failure a push path can have is a deploy that never starts — a workflow that
// never starts, a runner that is gone — and silence would look exactly like
// success. So: a run that completes closes, a run that fails does NOT, and no
// run at all where one was expected does NOT.

// The waiter is land's own sibling, so the stub replaces it in a COPY of these
// scripts, run as that copy's land.ts (`F.script`, which `land` uses until the
// next fixture). It logs what it was asked and from where, and answers from
// the environment: AWAIT_STUB_RC and AWAIT_STUB_LINE for every repo, or only
// for the one whose name ends in AWAIT_STUB_ONLY. Both repos' origins are
// given GitHub names, mapped back to their bare origins with `insteadOf`,
// because land.ts asks GitHub only about a repo whose origin names one.
function writeAwaitStub(): void {
  const STUBROOT = join(F.S, "stubchecks");
  const STUBDIR = join(STUBROOT, ".agents/skills/close/scripts");
  cpSync(HERE, STUBDIR, { recursive: true });
  copyScripts(STUBROOT);
  write(
    join(STUBDIR, "await-push-checks.ts"),
    `const arg = (f: string): string => process.argv[process.argv.indexOf(f) + 1] ?? "";
const repo = arg("--repo");
const sha = arg("--sha");
process.stderr.write(\`polled \${sha} \${repo}\\ncwd \${process.cwd()}\\n\`);
if (process.env.AWAIT_STUB_FAIL_SHA === sha) {
  process.stdout.write("deploy: failure (run_old)\\ndeploy failure\\n");
  process.exit(1);
}
const only = process.env.AWAIT_STUB_ONLY;
const mine = !only || repo.endsWith(only);
process.stdout.write(\`\${(mine && process.env.AWAIT_STUB_LINE) || "deploy: success (run_stub)"}\\n\`);
process.exit(mine ? Number(process.env.AWAIT_STUB_RC ?? "0") : 0);
`,
  );
  asGitHub(F.CODE);
  asGitHub(F.PROD);
  F.script = join(STUBDIR, "land.ts");
}

/** Give <repo>'s origin a GitHub URL that git still reaches as the bare origin. */
function asGitHub(repo: string): void {
  const bare = g(repo, "config", "--get", "remote.origin.url");
  const url = `https://github.com/test/${basename(repo)}.git`;
  gDo(repo, "config", `url.${bare}.insteadOf`, url);
  gDo(repo, "config", "remote.origin.url", url);
}

// EVERY PUSH IS OWED ITS CHECKS. An earlier close read
// `.agents/deployable-prefixes.json` out of the landed commit and skipped the
// poll for a push that touched no listed path; the workflows decide from their
// own diff what to run, so a list here drifts from theirs, and the list and the
// skip went together. A list left in a commit is not read.
function writeLeftoverPrefixList(): void {
  write(join(F.CODE, ".agents/deployable-prefixes.json"), '["apps/", "integrations/", "packages/"]\n');
  gDo(F.CODE, "add", ".agents");
  gDo(F.CODE, "commit", "-q", "-m", "a leftover prefix list");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin", "main");
  gDo(F.WT1, "merge", "-q", "--no-edit", "origin/main");
}

const polledLines = (): string[] =>
  cat(threadFile(TID1, "deploy.log"))
    .split("\n")
    .filter((l) => l.startsWith("polled "));
const polledCount = (): string => countLines(threadFile(TID1, "deploy.log"), (l) => l.includes("polled "));

kase("Case 6: the landing CHECKS the push deployed, and never deploys", () => {
  fixture("c6");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  const SAT1 = writeRoot(1, F.PROD).out;
  write(join(SAT1, "one-prod.md"), "prod\n");

  let r = land(1, ["thread one"], { merge: true });
  is("a push whose checks all passed closes", r.rc, "0");
  has("…and the check is named in the report", r.out, "deploy: success (run_stub)");
  is(
    "…and each repo was asked about its own landed commit, by the name its origin gives",
    polledLines().sort().join("\n"),
    [
      `polled ${g(F.CODE, "rev-parse", "origin/main")} test/${basename(F.CODE)}`,
      `polled ${g(F.PROD, "rev-parse", "origin/main")} test/${basename(F.PROD)}`,
    ]
      .sort()
      .join("\n"),
  );

  // NO DEPLOY AT ALL IS NOT CLOSED. This is the whole reason the check exists: the
  // push is the only thing that deploys, and nothing else would notice it failing.
  fixture("c6b");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], {
    merge: true,
    extra: {
      AWAIT_STUB_RC: "1",
      AWAIT_STUB_LINE: "expected a deploy for test/x and none started (abc1234 ran deploy)",
    },
  });
  isnt("a landing whose push started no deploy does NOT close", r.rc, "0");
  has("…and says so", r.out, "expected a deploy for test/x and none started");
  has("…naming the checkout that is on origin undeployed", r.out, "is on origin but its deploy did not succeed");

  // A check that FAILED is the same verdict, for the same reason.
  fixture("c6c");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["thread one"], {
    merge: true,
    extra: { AWAIT_STUB_RC: "1", AWAIT_STUB_LINE: "deploy: failure (run_bad)\ndeploy failure" },
  });
  isnt("a failed deploy does NOT close", r.rc, "0");
  has("…and names the check", r.out, "NOT CLOSED: deploy failure — ");

  // The journal-only close. With a prefix list it was the not-owed case: the
  // landed diff touched only `journal/`, the list said no run would start, and
  // the poller was never asked. Now every push's checks are waited for, so the
  // close waits like any other — and a prefix list still sitting in the commit
  // changes nothing.
  fixture("c6d");
  writeAwaitStub();
  writeLeftoverPrefixList();
  const J6D = jf(1, "journal only");
  entry(J6D, "journal-only", "a session that wrote only its journal");
  r = land(1, ["journal only"], { merge: true });
  is("a journal-only close lands", r.rc, "0");
  has("…and waits for the run like any other", r.out, "deploy: success (run_stub)");
  hasnt("…never `not owed`", r.out, "not owed");
  is("…polled exactly once", polledCount(), "1");
  is("…and the entry is on main", onMain(F.CODE, `journal/2026-09-13/${basename(J6D)}`), "yes");

  fixture("c6e");
  writeAwaitStub();
  writeLeftoverPrefixList();
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  write(join(F.WT1, "projects/ai/x/README.md"), "record\n");
  r = land(1, ["records only, in the code repo"], { merge: true });
  is("a landing touching only records closes on its run", r.rc, "0");
  has("…which the poller was asked about", r.out, "deploy: success (run_stub)");
  hasnt("…never `not owed`", r.out, "not owed");

  // A failed check on a records-only push refuses like any other: the push
  // checks run whatever paths changed, and one that failed is a check the close
  // must not read as passed.
  fixture("c6f");
  writeAwaitStub();
  write(join(F.WT1, "journal/2026-09-25/1200-x.md"), "entry\n");
  r = land(1, ["records only, failed run"], {
    merge: true,
    extra: { AWAIT_STUB_RC: "1", AWAIT_STUB_LINE: "deploy: failure (run_bad)\ndeploy failure" },
  });
  isnt("a records-only push whose run failed does NOT close", r.rc, "0");
  has("…naming the run", r.out, "deploy: failure (run_bad)");

  // EVERY CHECK ON THE COMMIT IS WAITED FOR AND NAMED. A push that starts three
  // workflows is waited on for all three, not the one named `deploy`.
  fixture("c6g");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["three workflows"], {
    merge: true,
    extra: { AWAIT_STUB_LINE: "deploy: success (a)\nsync: success (b)\nrebuild: success (c)" },
  });
  is("a push whose three workflows passed closes", r.rc, "0");
  has("…naming deploy", r.out, "  deploy: success (a)\n");
  has("…naming sync", r.out, "  sync: success (b)\n");
  has("…naming rebuild", r.out, "  rebuild: success (c)\n");
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
  write(join(F.WT1, "one.txt"), "one\n");
  const failing = { AWAIT_STUB_RC: "1", AWAIT_STUB_LINE: "deploy: failure (run_bad)\ndeploy failure" };
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
  has("…and the run is named", r.out, "deploy: success (run_stub)");

  r = land(1, ["--check"], { merge: true });
  is("--check passes once the deploy is proved", r.rc, "0");

  // A CORRECTIVE PUSH SETTLES IT. The run for the owed SHA stays failed for
  // good; the fix is new work, and its deploy — of a descendant of the owed
  // SHA — is what proves the repo deployed. Re-polling the old SHA first would
  // refuse every close, and the fix could never land through one.
  fixture("c6s");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["broken"], { merge: true, extra: failing });
  is("the broken push's deploy fails", r.rc, "3");
  const owed = cat(threadFile(TID1, "deploy-owed")).split("\t")[1] ?? "";
  write(join(F.WT1, "fix.txt"), "fix\n");
  r = land(1, ["the fix"], { merge: true, extra: { AWAIT_STUB_FAIL_SHA: owed } });
  is("the corrective push lands and closes", r.rc, "0");
  is("…with the fix on main", onMain(F.CODE, "fix.txt"), "yes");
  has("…settled by the new SHA's completed run", r.out, "deploy: success (run_stub)");
  is("…and nothing is owed any more", cat(threadFile(TID1, "deploy-owed")), "");

  // THE OBLIGATION IS WRITTEN BEFORE THE LANDED SHA. A close killed between
  // the two (here, by a git that kills its caller on the first read after the
  // SHA is recorded) must leave the retry something to check, not a landed
  // SHA that lets it skip the poll.
  fixture("c6k");
  writeAwaitStub();
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

// ── Case 6t ───────────────────────────────────────────────────────────────
//
// EVERY REPO IS ASKED, WHATEVER IT CARRIES. land's own waiter is asked about
// every landed repo by name, so nothing in the landed tree is needed — and an
// owed SHA whose worktree is gone is polled exactly the same way.

kase("Case 6t: every repo is polled, and an owed SHA without its worktree", () => {
  fixture("c6t");
  writeAwaitStub();
  write(join(F.WT1, "apps/x/one.ts"), "code\n");
  let r = land(1, ["no poller anywhere"], { merge: true });
  is("a landing of a repo that carries no poller is polled", r.rc, "0");
  is("…once", polledCount(), "1");

  fixture("c6u");
  writeAwaitStub();
  const SAT = writeRoot(1, F.PROD).out;
  write(join(SAT, "one-prod.md"), "prod\n");
  const failing = { AWAIT_STUB_ONLY: "-prod", AWAIT_STUB_RC: "1", AWAIT_STUB_LINE: "deploy failure" };
  r = land(1, ["thread one"], { merge: true, extra: failing });
  is("the satellite's failed deploy does not close", r.rc, "3");
  const owed = g(F.PROD, "rev-parse", "origin/main");
  has("…with the obligation kept", cat(threadFile(TID1, "deploy-owed")), `${F.PROD}\t${owed}`);
  gDo(F.PROD, "worktree", "remove", "--force", SAT);
  r = land(1, ["thread one"], { merge: true, extra: failing });
  is("a retry after the worktree vanished still refuses on a failed deploy", r.rc, "3");
  is("…having polled the owed SHA again", polledLines().pop() ?? "", `polled ${owed} test/${basename(F.PROD)}`);
  is(
    "…from the shared checkout",
    cat(threadFile(TID1, "deploy.log"))
      .split("\n")
      .filter((l) => l.startsWith("cwd "))
      .pop() ?? "",
    `cwd ${realpathSync(F.PROD)}`,
  );
  r = land(1, ["thread one"], { merge: true });
  is("…and a retry whose deploy passed closes", r.rc, "0");
  is("…settling it", cat(threadFile(TID1, "deploy-owed")), "");

  // AN OBLIGATION AN OLDER CLOSE LEFT names a SHA its poller owed; it is
  // polled the same way, and a deploy that passed settles it.
  const OLD = g(F.PROD, "rev-list", "--max-parents=0", "HEAD").split("\n")[0] ?? "";
  write(threadFile(TID1, "deploy-owed"), `${F.PROD}\t${OLD}\n`);
  r = land(1, ["thread one"], { merge: true });
  is("an older obligation is polled", r.rc, "0");
  is("…about that SHA", polledLines().pop() ?? "", `polled ${OLD} test/${basename(F.PROD)}`);
  is("…and settled", cat(threadFile(TID1, "deploy-owed")), "");
});

// ── Case 6p ───────────────────────────────────────────────────────────────
//
// A REPO WHOSE ORIGIN IS NOT ON GITHUB has nobody to ask, so it closes saying
// so. Every other case's fixture is that repo: a local bare origin.

kase("Case 6p: a repo whose origin is not on GitHub closes, saying so", () => {
  fixture("c6p");
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["thread one"], { merge: true });
  is("it closes", r.rc, "0");
  has("…saying why nothing was waited for", r.out, `no deploy reported for ${F.CODE} — its origin is not on GitHub`);
  is("…and owes nothing", cat(threadFile(TID1, "deploy-owed")), "");

  // AN SSH HOST ALIAS IS RESOLVED. An origin like `git@github-work:…` names a
  // ~/.ssh/config alias for github.com, and read by its text it would be "not
  // on GitHub" and waited for not at all. What
  // `ssh -G` says the alias connects to decides; a stub `ssh` answers here.
  fixture("c6q");
  writeAwaitStub();
  const real = g(F.CODE, "remote", "get-url", "origin");
  const aliasUrl = (host: string): string => `git@${host}:test/${basename(F.CODE)}.git`;
  for (const host of ["github-alias", "gitlab-alias"])
    gDo(F.CODE, "config", "--add", `url.${real}.insteadOf`, aliasUrl(host));
  write(
    join(F.S, "sshstub/ssh"),
    '#!/bin/sh\n[ "$1" = -G ] || exit 255\ncase "$2" in github-alias) echo "hostname github.com" ;; *) echo "hostname $2" ;; esac\n',
  );
  chmodSync(join(F.S, "sshstub/ssh"), 0o755);
  const SSHPATH = { PATH: `${join(F.S, "sshstub")}:${process.env.PATH ?? ""}` };
  gDo(F.CODE, "config", "remote.origin.url", aliasUrl("github-alias"));
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["through an alias"], { merge: true, extra: SSHPATH });
  is("a repo whose origin is an alias for github.com closes on its checks", r.rc, "0");
  is(
    "…asked about by the name in its origin",
    polledLines().pop() ?? "",
    `polled ${g(F.CODE, "rev-parse", "origin/main")} test/${basename(F.CODE)}`,
  );
  gDo(F.CODE, "config", "remote.origin.url", aliasUrl("gitlab-alias"));
  write(join(F.WT1, "two.txt"), "two\n");
  r = land(1, ["through another host's alias"], { merge: true, extra: SSHPATH });
  is("an alias for another host is not on GitHub", r.rc, "0");
  has("…and says so", r.out, `no deploy reported for ${F.CODE} — its origin is not on GitHub`);

  // NO `gh` ON THIS MACHINE. A repo on GitHub with nothing to ask it through
  // closes saying so, and the waiter is never started.
  fixture("c6nogh");
  writeAwaitStub();
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["no gh"], { merge: true, extra: { LAND_GH: join(F.S, "no-such-gh") } });
  is("a GitHub repo on a machine without gh closes", r.rc, "0");
  has("…saying so", r.out, `no push checks read for test/${basename(F.CODE)} — the gh CLI is not installed`);
  is("…and the waiter was never asked", polledCount(), "0");
  is("…and owes nothing", cat(threadFile(TID1, "deploy-owed")), "");
});

// ── Case 6w ───────────────────────────────────────────────────────────────
//
// A PRODUCT REPO IS WAITED FOR TOO. A Pages site connected to git carries no
// wrangler file and no workflow, and a close that waited only for workflows
// would wait for nothing there; its `Cloudflare Pages` check is waited for like
// any other.
// A repo GitHub reports nothing for, and expected nothing of, closes with the
// waiter's line.

kase("Case 6w: a product repo's checks are waited for, and its silence is said", () => {
  fixture("c6w");
  writeAwaitStub();
  let SAT = writeRoot(1, F.PROD).out;
  write(join(SAT, "one-prod.md"), "prod\n");
  let PRODNAME = `test/${basename(F.PROD)}`;
  let r = land(1, ["thread one"], {
    merge: true,
    extra: { AWAIT_STUB_ONLY: "-prod", AWAIT_STUB_RC: "3", AWAIT_STUB_LINE: `no deploy reported for ${PRODNAME}` },
  });
  is("a product repo GitHub reports nothing for closes", r.rc, "0");
  has("…saying so", r.out, `  no deploy reported for ${PRODNAME}\n`);
  is("…and owes nothing", cat(threadFile(TID1, "deploy-owed")), "");

  // A FAILED CHECK IS NOT CLOSED, and stays owed for the retry.
  fixture("c6w2");
  writeAwaitStub();
  SAT = writeRoot(1, F.PROD).out;
  PRODNAME = `test/${basename(F.PROD)}`;
  write(join(SAT, "one-prod.md"), "prod\n");
  r = land(1, ["thread one"], {
    merge: true,
    extra: {
      AWAIT_STUB_ONLY: "-prod",
      AWAIT_STUB_RC: "1",
      AWAIT_STUB_LINE: "Cloudflare Pages: failure (https://pages.test/1)\nCloudflare Pages failure",
    },
  });
  is("a product repo whose Pages build failed does NOT close", r.rc, "3");
  const failedSha = g(F.PROD, "rev-parse", "origin/main");
  has("…naming the check", r.out, "NOT CLOSED: Cloudflare Pages failure — ");
  has("…with the obligation kept", cat(threadFile(TID1, "deploy-owed")), `${F.PROD}\t${failedSha}`);
  r = land(1, ["--check"], { merge: true });
  is("--check refuses while the deploy is owed", r.rc, "3");
  r = land(1, ["thread one"], { merge: true });
  is("a retry whose check now passed closes", r.rc, "0");
  is(
    "…having polled the owed SHA again",
    polledLines()
      .filter((l) => l.endsWith(PRODNAME))
      .join("\n"),
    `polled ${failedSha} ${PRODNAME}\npolled ${failedSha} ${PRODNAME}`,
  );
  is("…and settled it", cat(threadFile(TID1, "deploy-owed")), "");
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
  has(
    "…handing the stub's command off to a fresh session, in its own block",
    r.out,
    "**Next:**\n\nRun each `/implement` in a fresh session, one per row; rows listed together can run in parallel.\n\n```\n/implement stubbed\n```",
  );
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

  // A close paused for the user's answer (end-of-turn.ts --pause) is dealt
  // with once a new close completes, which removes both markers.
  write(threadFile(TID1, "reopened"), "");
  write(threadFile(TID1, "paused"), "Which plan should I keep?\n");
  write(join(F.WT1, "answer.txt"), "answered\n");
  land(1, ["thread one answered"]);
  ok("a completed close removes reopened", !existsSync(threadFile(TID1, "reopened")), "reopened survived the close");
  ok("…and paused", !existsSync(threadFile(TID1, "paused")), "paused survived the close");
  ok("…and writes closed-once", existsSync(threadFile(TID1, "closed-once")), "no closed-once marker");

  // A later landing that is refused clears `closed` as it starts,
  // and must leave `closed-once` for the end-of-turn check.
  write(join(F.WT1, "refused.txt"), "refused\n");
  const PURL = g(F.CODE, "remote", "get-url", "origin");
  gDo(F.CODE, "remote", "set-url", "--push", "origin", join(F.S, "origins/gone.git"));
  is("a refused later landing does not close", land(1, ["thread one refused"]).rc, "3");
  ok("…clearing closed", !existsSync(threadFile(TID1, "closed")), "closed survived a refused landing");
  ok("…but keeping closed-once", existsSync(threadFile(TID1, "closed-once")), "closed-once was lost");
  gDo(F.CODE, "remote", "set-url", "--push", "origin", PURL);
  is("…and the next landing closes", land(1, ["thread one refused"]).rc, "0");

  // A thread closed before closed-once existed: only `closed`. A refused
  // landing from that state must still leave closed-once behind.
  rmSync(threadFile(TID1, "closed-once"), { force: true });
  write(join(F.WT1, "legacy.txt"), "legacy\n");
  gDo(F.CODE, "remote", "set-url", "--push", "origin", join(F.S, "origins/gone.git"));
  is("a refused landing from a legacy closed thread does not close", land(1, ["thread one legacy"]).rc, "3");
  ok(
    "…and still leaves closed-once",
    existsSync(threadFile(TID1, "closed-once")),
    "closed-once missing after a legacy refusal",
  );
  gDo(F.CODE, "remote", "set-url", "--push", "origin", PURL);
  is("…and the next landing closes", land(1, ["thread one legacy"]).rc, "0");

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

// A HELD CLOSE KEEPS THE WORKTREE ITS SCRIPTS RUN FROM. The release runs the
// same scripts again, from the same worktree; a hold that removed it left
// --release with nothing to run, and a retry from another copy without the
// journal (Contextium v9.2.0 review). The removal waits for the release.
kase("Case 9h: a held close keeps its scripts' worktree until release", () => {
  fixture("c9h");
  const SATDIR = writeRoot(1, F.PROD).out;
  copyScripts(SATDIR);
  write(join(SATDIR, "one-prod.md"), "prod\n");
  write(join(F.WT1, "one.txt"), "one\n");
  const script = join(SATDIR, ".agents/skills/close/scripts/land.ts");
  let r = land(1, ["thread one", "--hold"], { merge: true, script });
  is("the held landing exits 4", r.rc, "4");
  ok("…and keeps the worktree its scripts run from", isDir(SATDIR), "the held close removed its own scripts");
  r = land(1, ["--release"], { merge: true, script });
  is("the release, run from that worktree, passes", r.rc, "0");
  has("…and prints the line", r.out, "— closing this tab loses nothing.");
  ok("…and only then removes it", !isDir(SATDIR), `the scripts' worktree was never removed:\n${r.out}\n${g(SATDIR, "status", "--short")}`);
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
  has("each field is its own paragraph", r.out, "**Shipped:** Ship portal phase\n\n**Journal:** ");
  has("the project's state follows the journal", r.out, ")\n\n**Project:** portal is **active**.\n\n**Next:**");
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

// A ROADMAP project with rows ready to implement and one blocked: the close
// hands EACH ready row off as its own `/implement` command, in its own block
// for a fresh session, the blocked row as prose, not a heading, with the proof
// line still last. Nothing starts a row on its own.
kase("Case 11b: several next commands, each in its own block for a fresh session", () => {
  fixture("c11b");
  const P11B = join(F.WT1, "projects/sales/2026-09-18_par");
  mkdirSync(join(P11B, "specs/001-a"), { recursive: true });
  mkdirSync(join(P11B, "specs/002-b"), { recursive: true });
  mkdirSync(join(P11B, "specs/004-d"), { recursive: true });
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
      "| R3 | c | — | blocked: 2099-01-01 vendor reply | — |",
      "| R4 | d | — | in-progress | `specs/004-d/` |",
    ),
  );
  write(join(P11B, "specs/001-a/spec.md"), "# spec\n");
  write(join(P11B, "specs/002-b/spec.md"), "# spec\n");
  write(join(P11B, "specs/004-d/spec.md"), "# spec\n");
  write(join(P11B, "specs/001-a/plan.md"), "- spec-audit: grok round-1; spirit MATCH\n");
  write(join(P11B, "specs/004-d/plan.md"), "- spec-audit: grok round-1; spirit MATCH\n");
  // The in-progress row predates this close; this session did not add or
  // change a half-built row.
  gDo(F.WT1, "add", "projects");
  gDo(F.WT1, "commit", "-q", "-m", "existing project state");
  gDo(F.WT1, "push", "-q", "origin", "HEAD:main");
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
    "the handoff says each command runs in a fresh session",
    r.out,
    "Run each `/implement` in a fresh session, one per row; rows listed together can run in parallel.",
  );
  has("a ready row is its own block", r.out, "\n```\n/implement par r1\n```\n");
  has("…and so is the next", r.out, "\n```\n/implement par r2\n```\n");
  hasnt("…never two commands in one block", r.out, "/implement par r1\n/implement par r2");
  hasnt("…and nothing promises an automatic start", r.out, "automatically");
  has("a comment line is a list item", r.out, "\n- par R3 is blocked: 2099-01-01 vendor reply");
  hasnt("…never an escaped hash", r.out, "\\#");
  has("the project's state is its own line", r.out, "\n\n**Project:** par is **active**");
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
  rmSync(join(F.WT1, "integrations/alpha"), { recursive: true, force: true });
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

// ── Case 14g ──────────────────────────────────────────────────────────────
//
// The workbench gate and the merged tree. check-roadmap-decisions.ts runs from
// the workbench worktree's OWN copy, only in a workbench worktree (one holding
// .agents/skills/close/scripts/land.ts), over its project changes, and again
// on the merged tree when the trunk merge brought commits in; each app the
// branch changed runs its own `check` on that merged tree. The roadmap rules
// are check-roadmap-decisions.test.ts's; what is tested is that land.ts finds
// the gate, refuses without it, and that the merged tree is judged.

kase("Case 14g: the workbench roadmap gate and an app's check on the merged tree", () => {
  // 1. A workbench worktree with a project change and no gate is refused, not skipped.
  fixture("c14ge");
  const GATE = ".agents/skills/close/scripts/check-roadmap-decisions.ts";
  gDo(F.WT1, "rm", "-q", GATE);
  write(join(F.WT1, "projects/d/2026-01-01_p/README.md"), "fine\n");
  let r = land(1, ["thread one"], { merge: true });
  is("no roadmap gate in the worktree exits 3", r.rc, "3");
  has(
    "…with the merge-trunk hint",
    r.out,
    `something left open in a roadmap or report inputs changed in ${F.WT1}, but ${F.WT1} holds no ${GATE} — merge origin/main into the branch`,
  );

  // 2. An app's own check on the merged tree: a shared builder gains an
  //    argument on one branch while another branch adds a caller of it; each
  //    type-checks alone, the merged tree does not. The trunk here gains an app
  //    whose check fails beside this branch's file; the branch's own close
  //    passes its first run and is refused on the merged tree, before the push.
  fixture("c14gj");
  gDo(F.WT2, "pull", "-q", "origin", "main");
  const check = `node -e "const f=require('fs');require('fs').writeFileSync(process.env.HOME+'/.app-check-invoked','');if(f.existsSync('a.ts')&&f.existsSync('raise.ts')){console.error('a.ts(1,1): error TS2554: Expected 7 arguments, but got 6.');process.exit(2)}"`;
  write(
    join(F.WT2, "apps/x/package.json"),
    `${JSON.stringify({ name: "x", private: true, scripts: { check } }, null, 2)}\n`,
  );
  write(join(F.WT2, "apps/x/raise.ts"), "export const raise = 1;\n");
  gDo(F.WT2, "add", "-A");
  gDo(F.WT2, "commit", "-q", "-m", "the trunk changes the app");
  gDo(F.WT2, "push", "-q", "origin", "HEAD:main");
  write(join(F.WT1, "apps/x/a.ts"), "export const a = 1;\n");
  rmSync(join(F.HOME_DIR, ".app-check-invoked"), { force: true });
  r = land(1, ["thread one"], { merge: true });
  is("an app that fails its check only on the merged tree exits 3", r.rc, "3");
  has(
    "naming the app and the check's error line",
    r.out,
    `NOT CLOSED: apps/x's check fails on the merged tree in ${F.WT1}: a.ts(1,1): error TS2554: Expected 7 arguments, but got 6.`,
  );
  is("…and nothing of it was pushed", onMain(F.CODE, "apps/x/a.ts"), "no");
  //     The refusal leaves the merge committed; an unchanged retry must not push it.
  r = land(1, ["thread one"], { merge: true });
  is("an unchanged retry is refused again", r.rc, "3");
  has("…on the same check", r.out, "apps/x's check fails on the merged tree");
  is("…and still nothing was pushed", onMain(F.CODE, "apps/x/a.ts"), "no");

  //     The same app with a check that passes beside it lands, after the check ran.
  fixture("c14gk");
  gDo(F.WT2, "pull", "-q", "origin", "main");
  const pass = `node -e "require('fs').writeFileSync(process.env.HOME+'/.app-check-invoked','')"`;
  write(
    join(F.WT2, "apps/x/package.json"),
    `${JSON.stringify({ name: "x", private: true, scripts: { check: pass } }, null, 2)}\n`,
  );
  gDo(F.WT2, "add", "-A");
  gDo(F.WT2, "commit", "-q", "-m", "the trunk adds the app");
  gDo(F.WT2, "push", "-q", "origin", "HEAD:main");
  write(join(F.WT1, "apps/x/a.ts"), "export const a = 1;\n");
  rmSync(join(F.HOME_DIR, ".app-check-invoked"), { force: true });
  r = land(1, ["thread one"], { merge: true });
  is("an app whose check passes on the merged tree lands", r.rc, "0");
  is("…after its check ran", existsSync(join(F.HOME_DIR, ".app-check-invoked")) ? "invoked" : "not", "invoked");

  // 8c. The same failure through shared code: this branch changes a package's
  //     signature while the trunk adds an app calling the old one. The branch
  //     touches no app, so only an importer of the changed package can catch
  //     it; the merged-tree run checks the trunk's new caller and refuses.
  fixture("c14gl");
  gDo(F.WT2, "pull", "-q", "origin", "main");
  const sig = `node -e "if(require('fs').readFileSync('../../packages/p/p.ts','utf8').includes('b: number')){console.error('caller.ts(1,1): error TS2554: Expected 2 arguments, but got 1.');process.exit(2)}"`;
  write(
    join(F.WT2, "apps/y/package.json"),
    `${JSON.stringify({ name: "y", private: true, scripts: { check: sig } }, null, 2)}\n`,
  );
  write(join(F.WT2, "apps/y/caller.ts"), 'import { p } from "../../packages/p/p.ts";\np(1);\n');
  gDo(F.WT2, "add", "-A");
  gDo(F.WT2, "commit", "-q", "-m", "the trunk adds a caller of the package");
  gDo(F.WT2, "push", "-q", "origin", "HEAD:main");
  write(join(F.WT1, "packages/p/p.ts"), "export const p = (a: number, b: number): number => a + b;\n");
  r = land(1, ["thread one"], { merge: true });
  is("a package change that breaks a trunk caller only on the merged tree exits 3", r.rc, "3");
  has(
    "naming the importing app and its check's error line",
    r.out,
    `NOT CLOSED: apps/y's check fails on the merged tree in ${F.WT1}: caller.ts(1,1): error TS2554: Expected 2 arguments, but got 1.`,
  );
  is("…and nothing of it was pushed", onMain(F.CODE, "packages/p/p.ts"), "no");

  // 3. The REAL roadmap gate over a row-by-row ROADMAP merge: two threads each add
  //    a row to one project, the second landing after the first. Thread one
  //    also finishes R1, so thread two's own table still says R1 is next while
  //    the merged one says R2 (R2 depends on R1). The merged table leaves
  //    nothing open, so it lands, and next: is the merged table's.
  fixture("c14gi");
  write(join(F.CODE, RMP, "ROADMAP.md"), lines(...tableHead(), "| R1 | first | — | planned | `specs/001-first/` |"));
  write(join(F.CODE, RMP, "specs/001-first/spec.md"), "# spec\n");
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "a project");
  gDo(F.CODE, "push", "-q", "origin", "main");
  for (const wt of [F.WT1, F.WT2]) {
    gDo(wt, "fetch", "-q", "origin");
    gDo(wt, "reset", "-q", "--hard", "origin/main");
  }
  const addRow = (wt: string, row: string): void => {
    writeFileSync(join(wt, RMP, "ROADMAP.md"), `${readFileSync(join(wt, RMP, "ROADMAP.md"), "utf8")}${row}\n`);
    roadmap(join(wt, RMP), "--sync-next");
  };
  roadmap(join(F.WT1, RMP), "--set", "R1", "done");
  addRow(F.WT1, "| R3 | third | — | planned | — |");
  addRow(F.WT2, "| R2 | second | R1 | planned | — |");
  is("thread two's own table names R1", nextLine(cat(join(F.WT2, RMP, "README.md"))), '"R1: first"');
  const r1 = land(1, ["thread one"], { merge: true });
  is("the first row's project change lands past the real checker", r1.rc, "0");
  const r2 = land(2, ["thread two"], { merge: true });
  is("the second lands on the merged table", r2.rc, "0");
  if (r2.rc !== 0) process.stdout.write(`${r2.out.split("\n").slice(-3).join("\n")}\n`);
  gOk(F.CODE, "fetch", "-q", "origin");
  const merged = g(F.CODE, "show", `origin/main:${RMP}/ROADMAP.md`);
  has("origin's ROADMAP holds thread one's row", merged, "| R3 | third |");
  has("…and thread two's", merged, "| R2 | second |");
  is(
    "…and next: is the merged table's first ready row, not thread two's own",
    nextLine(g(F.CODE, "show", `origin/main:${RMP}/README.md`)),
    '"R2: second"',
  );
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

// A HALF-BUILT PIECE DOES NOT LAND: a close means the work is done. A report
// this push writes as `partial` used to land and return its row to `planned`
// for the next landing; now the close refuses before anything is pushed, and a re-run lands it once the report is
// `complete`. A partial report this push did not touch is someone else's.
kase("Case 15p: a partial report is NOT CLOSED and nothing lands", () => {
  fixture("c15p");
  write(
    join(F.CODE, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | in-progress | `specs/001-first/` |",
      "| R2 | second | — | in-progress | `specs/002-second/` |",
      "| R3 | third | — | in-progress | `specs/003-third/` |",
    ),
  );
  for (const s of ["001-first", "002-second", "003-third"]) write(join(F.CODE, RMP, `specs/${s}/spec.md`), "# spec\n");
  // R2 already carries a partial report from an earlier landing; another thread
  // is on it now, and this push does not touch its report.
  write(join(F.CODE, RMP, "specs/002-second/report.md"), "---\nspec: x\nspec-status: partial\n---\n");
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  const before = g(F.CODE, "rev-parse", "origin/main");
  const report = (status: string) => `---\nspec: x\nspec-status: ${status}\n---\n\n# Implementation Report\n`;
  write(join(F.WT1, RMP, "specs/001-first/report.md"), report("partial"));
  write(join(F.WT1, RMP, "specs/003-third/report.md"), report("complete"));
  entry(jf(1, "partial"), "partial", "landing one of R1");
  const r = land(1, ["landing one of R1"], { merge: true });
  is("a partial landing does not close", r.rc, "3");
  has("…and says NOT CLOSED", r.out, "NOT CLOSED: something left open in a roadmap or report rejected");
  has(
    "…naming R1's report and its row",
    r.out,
    `${RMP}/specs/001-first/report.md: reads partial, and its row R1 is "in-progress"`,
  );
  is("…R2's partial report, not in this push, is not named", String(r.out.includes("002-second/report.md")), "false");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…and nothing is pushed", g(F.CODE, "rev-parse", "origin/main"), before);
  has(
    "…and the report is still in the worktree",
    readFileSync(join(F.WT1, RMP, "specs/001-first/report.md"), "utf8"),
    "partial",
  );
});

// A PROJECT FOLDER GIT WOULD QUOTE. Without -z git prints a path holding a
// non-ASCII byte C-quoted (`"projects/demo/2026-01-01_caf\303\251/…"`), which
// matched no report or project pattern: a partial report went unseen, and a
// table changed with no `next:` re-derive landed its stale `next:`.
kase("Case 15q: a project folder with an accent is judged and re-derived", () => {
  fixture("c15q");
  const QP = "projects/demo/2026-01-01_café-rows";
  write(
    join(F.CODE, QP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | planned | `specs/001-first/` |",
      "| R2 | second | — | in-progress | `specs/002-second/` |",
      "| R3 | third | — | planned | `specs/003-third/` |",
    ),
  );
  for (const s of ["001-first", "002-second", "003-third"]) write(join(F.CODE, QP, `specs/${s}/spec.md`), "# spec\n");
  write(
    join(F.CODE, QP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  write(join(F.WT1, QP, "specs/002-second/report.md"), "---\nspec: x\nspec-status: partial\n---\n");
  // R1 is set done by hand with no --sync-next, so only the close's re-derive
  // can move `next:` off R1.
  roadmap(join(F.WT1, QP), "--set", "R1", "done");
  entry(jf(1, "accent"), "accent", "a landing in a quoted folder");
  const r = land(1, ["a landing in a quoted folder"], { merge: true });
  is("a partial report under the accented folder does not close", r.rc, "3");
  has(`…and names it, under ${QP}`, r.out, `${QP}/specs/002-second/report.md: reads partial, and its row R2`);
  // Finished: the report complete and R2 done. The re-run lands, and `next:`
  // is re-derived from the landed table.
  write(join(F.WT1, QP, "specs/002-second/report.md"), "---\nspec: x\nspec-status: complete\n---\n");
  roadmap(join(F.WT1, QP), "--set", "R2", "done");
  const r2 = land(1, ["a landing in a quoted folder"], { merge: true });
  is("the finished landing lands", r2.rc, "0");
  if (r2.rc !== 0) process.stdout.write(`${r2.out.split("\n").slice(-3).join("\n")}\n`);
  gOk(F.CODE, "fetch", "-q", "origin");
  const rows = g(F.CODE, "show", `origin/main:${QP}/ROADMAP.md`)
    .split("\n")
    .filter((l) => l.startsWith("| R"))
    .map((l) => {
      const f = l.split("|");
      return `${(f[1] ?? "").replace(/ /g, "")}=${(f[4] ?? "").replace(/^ +| +$/g, "")} `;
    })
    .join("");
  is(`the rows under ${QP} land as set`, rows, "R1=done R2=done R3=planned ");
  is(
    `…and next: in ${QP}/README.md is re-derived from the landed table`,
    nextLine(g(F.CODE, "show", `origin/main:${QP}/README.md`)),
    '"R3: third"',
  );
});

// A STEP WAITING ON THE USER, OR A HALF-BUILT ROW, HOLDS THE CLOSE. Each open row the
// push adds is printed on its own line above the one NOT CLOSED, nothing is
// pushed, and the worktree keeps the change for the re-run.
kase("Case 15o: a manual row and an in-progress row are NOT CLOSED", () => {
  fixture("c15o");
  write(join(F.CODE, RMP, "ROADMAP.md"), lines(...tableHead(), "| R1 | first | — | done | — |"));
  write(join(F.CODE, RMP, "README.md"), "---\nproject: rows\nstatus: completed\n---\n\n# Project: rows\n");
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "roadmap");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  const before = g(F.CODE, "rev-parse", "origin/main");
  write(
    join(F.WT1, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | done | — |",
      "| R4 | renew | — | planned | manual |",
      "| R5 | build | — | in-progress | — |",
    ),
  );
  entry(jf(1, "open rows"), "open-rows", "two open rows");
  const r = land(1, ["two open rows"], { merge: true });
  is("the close is refused", r.rc, "3");
  has(
    "…naming R4 as a step waiting on the user",
    r.out,
    'ROADMAP.md: R4 "planned" (Sub-spec manual): a step waiting on the user',
  );
  has("…and R5 as half-built", r.out, 'ROADMAP.md: R5 "in-progress" (Sub-spec —): half-built');
  has("…above one NOT CLOSED", r.out, "NOT CLOSED: something left open in a roadmap or report rejected");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…nothing is pushed", g(F.CODE, "rev-parse", "origin/main"), before);
  has("…and the worktree still holds the rows", readFileSync(join(F.WT1, RMP, "ROADMAP.md"), "utf8"), "| R4 | renew |");
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
  write(join(F.CODE, RMP, "specs/003-third/plan.md"), "- spec-audit: grok round-1; spirit MATCH\n");
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
  has(
    "…and its handoff is the merged table's R3",
    r2.out,
    "\n```\n/implement rows r3\n```\n",
  );
  hasnt("…never the row thread one already landed", r2.out, "/implement rows r1");
  is("…and the remembered next action is the merged one too", cat(threadFile(TID2, "next")), "/implement rows r3");
});

// The merge changed the table, but the merged table no longer reads (here a
// row the trunk added was never filled in), so next: cannot be re-derived.
// Pushing then would ship a README whose next: names the wrong row.
kase("Case 15b: next: that cannot be re-derived stops the close", () => {
  /** The trunk's table gains a row nobody filled in after thread two's base. */
  const brokenTrunk = (name: string): void => {
    fixture(name);
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
  };
  const doneRows = (): string =>
    String(
      g(F.CODE, "show", `origin/main:${RMP}/ROADMAP.md`)
        .split("\n")
        .filter((l) => l.includes("| R2 | second | — | done |")).length,
    );

  // A branch that changes the table itself: the roadmap gate reads the merged
  // table first, and a table it cannot read holds the close on its own
  // (Contextium v9.2.0 review) — before, it was skipped as if deleted and only
  // the re-derive below caught it.
  brokenTrunk("c15b");
  sedLines(join(F.WT2, RMP, "ROADMAP.md"), "| R2 | second | — | planned |", "| R2 | second | — | done |");
  entry(jf(2, "row two"), "row-two", "thread two's row");
  let r = land(2, ["row two"], { merge: true });
  is("a merged table the roadmap gate cannot read stops the close", r.rc, "3");
  has("…naming the table and why", r.out, "ROADMAP.md: roadmap.ts cannot read it — placeholder row R3");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…and nothing of it was pushed", doneRows(), "0");
  // The merge stays committed in the worktree. A re-run finds trunk already
  // merged, and must still judge the table before it pushes, not skip it.
  r = land(2, ["row two"], { merge: true });
  is("a re-run with the table still broken stops again", r.rc, "3");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("…and still pushes nothing", doneRows(), "0");

  // A branch that touches only the project's README: the gate judges no table
  // this push changed, and the re-derive of next: is what refuses.
  brokenTrunk("c15b2");
  write(join(F.WT2, RMP, "README.md"), `${readFileSync(join(F.WT2, RMP, "README.md"), "utf8")}\nA note.\n`);
  entry(jf(2, "row two"), "row-two", "thread two's row");
  r = land(2, ["row two"], { merge: true });
  is("a next: that cannot be re-derived stops the close", r.rc, "3");
  has("…naming why", r.out, "NOT CLOSED: next: could not be re-derived");
  gOk(F.CODE, "fetch", "-q", "origin");
  hasnt("…and nothing of the README was pushed", g(F.CODE, "show", `origin/main:${RMP}/README.md`), "A note.");
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

// A PROJECT WAITING ON ANOTHER'S ROW IS FREED IN THE SAME PUSH. This
// push finishes other-proj R2 and touches nothing of the waiting project, whose
// R1 names `other-proj R2` in Depends on; the waiting README must land `active`
// in the same push, not a day later.
kase("Case 15s: a project waiting on another project's row is re-derived in the same push", () => {
  fixture("c15s");
  const OTHER = "projects/demo/2026-01-02_other-proj";
  const WAIT = "projects/web/2026-01-01_waiting";
  write(
    join(F.CODE, OTHER, "ROADMAP.md"),
    lines(...tableHead(), "| R1 | first | — | done | — |", "| R2 | the decision | — | planned | — |"),
  );
  write(
    join(F.CODE, OTHER, "README.md"),
    '---\nproject: other\nstatus: active\nnext: "R2: the decision"\n---\n\n# P\n',
  );
  write(join(F.CODE, WAIT, "ROADMAP.md"), lines(...tableHead(), "| R1 | migrate | other-proj R2 | planned | — |"));
  write(
    join(F.CODE, WAIT, "README.md"),
    '---\nproject: waiting\nstatus: blocked\nblocked-on: "R1: waits on other-proj R2"\n---\n\n# P\n',
  );
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", "two projects");
  gDo(F.CODE, "push", "-q", "origin", "main");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  if (roadmap(join(F.WT1, OTHER), "--set", "R2", "done")) roadmap(join(F.WT1, OTHER), "--sync-next");
  entry(jf(1, "decided"), "decided", "the decision is made");
  const r = land(1, ["the decision is made"], { merge: true });
  is("the landing lands", r.rc, "0");
  if (r.rc !== 0) process.stdout.write(`${r.out.split("\n").slice(-3).join("\n")}\n`);
  gOk(F.CODE, "fetch", "-q", "origin");
  const readme = g(F.CODE, "show", `origin/main:${WAIT}/README.md`);
  has("…the waiting project reads active", readme, "status: active");
  has("…and names its next row", readme, 'next: "R1: migrate"');
  hasnt("…with no blocked-on left", readme, "blocked-on:");
  has(
    "…in the re-derive commit",
    g(F.CODE, "show", "--name-only", "--format=%s", "origin/main"),
    `next: re-derived from the merged table)\n\n${WAIT}/README.md`,
  );
});

// A folder outside projects/ that holds a README.md and a ROADMAP.md — the
// project templates, whose rows are placeholders on purpose — is not a project,
// and editing both must not stop the close on a table that never reads.
kase("Case 15d: the templates folder is not a project", () => {
  fixture("c15d");
  const TPL = ".agents/skills/demo/references/templates";
  write(join(F.WT2, TPL, "ROADMAP.md"), lines(...tableHead(), "| R1 | <name> | — | planned | — |"));
  write(join(F.WT2, TPL, "README.md"), "---\nproject: project-name-slug\nstatus: active\n---\n\n# Project\n");
  entry(jf(2, "templates"), "templates", "thread two's templates");
  const r = land(2, ["templates"], { merge: true });
  is("a templates folder with placeholder rows lands", r.rc, "0");
  hasnt("…without trying to re-derive it", r.out, "could not be re-derived");
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
  // The gate reads through the exported unlandedWork, and an
  // unreadable status opens it exactly as before.
  failingGit(join(F.S, "failst3"), " status --porcelain ");
  is(
    "…and so does an unreadable status",
    land(1, ["--gate"], { extra: { PATH: `${join(F.S, "failst3")}:${process.env.PATH ?? ""}` } }).out,
    "not-fired",
  );

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

  // And for the script gate's own read, when no worktree holds the checker:
  //     its listing failing read as "no script changed", the gate was skipped,
  //     and the untracked script landed with no checker ever run. The two
  //     checkers before it are stubbed so this gate makes the first
  //     untracked-file listing, and only that one fails: the reads after it
  //     cannot stand in for this one's refusal. They are pushed, so the
  //     untracked script is the whole change.
  fixture("c12x5", undefined, undefined, false);
  drStub(F.WT1);
  imStub(F.WT1);
  gDo(F.WT1, "push", "-q", "origin", "HEAD:main");
  const ONCE = join(F.S, "failonce");
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  write(
    join(ONCE, "git"),
    `#!/usr/bin/env bash\ncase " $* " in *" ls-files -z --others "*) [ -e "${ONCE}/done" ] || { : > "${ONCE}/done"; echo "fatal: simulated read failure" >&2; exit 128; } ;; esac\nexec "${real}" "$@"\n`,
  );
  chmodSync(join(ONCE, "git"), 0o755);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  r = land(1, ["thread one"], { merge: true, extra: { PATH: `${ONCE}:${process.env.PATH ?? ""}` } });
  is("a failed listing in the script gate stops the close", r.rc, "3");
  has("…saying it could not list the change", r.out, `could not list what ${F.WT1} changed`);
  is("…and the script did not reach main", onMain(F.CODE, ".agents/skills/y/scripts/new.sh"), "no");
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
  // § 1 of the close, as the session runs it: land.ts refuses without a pass.
  const v = sh(process.execPath, [...NODE_TS, join(scripts, "verify.ts")], { cwd: F.CODE, env: NOT3, merge: true });
  is("verify passes for the session", v.rc, "0");
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
  write(join(F.WT1, ".agents/skills/y/scripts/new.test.sh"), "bash .agents/skills/y/scripts/new.sh\n");
  r = land(1, ["thread one"], { merge: true });
  is("a close carrying a tested script lands", r.rc, "0");
  is("and the script is on main", onMain(F.CODE, ".agents/skills/y/scripts/new.sh"), "yes");

  // 4. A changed script with no checker in any ledger worktree is refused, not skipped.
  fixture("c17d", undefined, undefined, false);
  write(join(F.WT1, ".agents/skills/y/scripts/new.sh"), "echo new\n");
  write(join(F.WT1, ".agents/skills/y/scripts/new.test.sh"), "bash .agents/skills/y/scripts/new.sh\n");
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
  write(join(F.WT1, ".agents/skills/y/scripts/old.test.sh"), "bash .agents/skills/y/scripts/old.sh\n");
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
  write(join(F.WT1, "site/public/app.js"), "x\n"); // nor a .js: part (c) judges .agents/ only
  r = land(1, ["thread one"], { merge: true });
  is("a close that changes no script under .agents/ needs no checker", r.rc, "0");

  //    Part (c) reads every file under .agents/: a .cjs there is the checker's
  //    to judge, so a worktree without it is refused for one.
  fixture("c17g", undefined, undefined, false);
  write(join(F.WT1, ".agents/site/app.cjs"), "x\n");
  r = land(1, ["thread one"], { merge: true });
  is("a .agents/site/app.cjs with no checker exits 3", r.rc, "3");
  has("…for want of the checker", r.out, `scripts changed in ${F.WT1}, but no worktree this thread owns holds`);
  //    A dependency's file under node_modules/ is never the checker's.
  fixture("c17i", undefined, undefined, false);
  write(join(F.WT1, ".agents/site/node_modules/m/index.js"), "x\n");
  r = land(1, ["thread one"], { merge: true });
  is("a .js under node_modules/ needs no checker", r.rc, "0");
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

    prereqs(1);
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
  const failing = { AWAIT_STUB_RC: "1", AWAIT_STUB_LINE: "deploy: failure (run_bad)\ndeploy failure" };
  const points: [string, string][] = [
    ["owed-replace:1", "the obligation's rename, before the push"],
    ["pushed:1", "after the push, before the landed SHA"],
    ["landed:1", "after the landed SHA, before the poll"],
    ["polled:1", "after a good poll, before the obligation is cleared"],
  ];
  for (const [point, where] of points) {
    fixture(`c20-${point.replace(/[^a-z0-9]/g, "")}`);
    writeAwaitStub();
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

// ── Case 21: land.ts's script roots are check-scripts.ts's ROOTS ─────────
//
// changedScripts decides whether a close runs check-scripts.ts at all, by a
// regex of the checker's roots — a second copy of a list the checker owns. A
// root moved in one and left behind in the other would let a script-only
// change close without its tests ever being asked for. Read from both
// sources, so neither can move alone.
kase("Case 21: land.ts's script roots are check-scripts.ts's ROOTS", () => {
  const land = readFileSync(join(HERE, "land.ts"), "utf8");
  const m = /\/\^(.*?)\\\/\.\*\\\.\(sh\|ts\|mjs\|js\|cjs\|py\)\$\/s/.exec(land);
  assert.ok(m?.[1], "land.ts: the changedScripts root regex was not found");
  // `\.agents` or `(a|b(c|d))` → the plain paths it matches.
  const body = m[1].replace(/\\\//g, "/").replace(/\\\./g, ".");
  const inner = body.startsWith("(") && body.endsWith(")") ? body.slice(1, -1) : body;
  const roots: string[] = [];
  for (const alt of inner.split(/\|(?![^(]*\))/)) {
    const group = /^(.*)\((.*)\)$/.exec(alt);
    if (group) for (const g of (group[2] ?? "").split("|")) roots.push(`${group[1]}${g}`);
    else roots.push(alt);
  }
  const checker = readFileSync(join(REPO, "checks/check-scripts.ts"), "utf8");
  const block = /const ROOTS = \[([\s\S]*?)\];/.exec(checker);
  assert.ok(block?.[1], "check-scripts.ts: ROOTS was not found");
  const want = [...block[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
  is(
    "land.ts's script roots match check-scripts.ts's ROOTS",
    JSON.stringify([...roots].sort()),
    JSON.stringify([...want].sort()),
  );
});

// ── Case 22: every landing checks the harness home links ─────────────────
//
// The close runs check-harness-config-links.ts from the shared checkout after
// it lands, and on drift its `--fix`, printing one line per relinked path and
// one per displaced file it kept. Drift, a failed fix, a missing check and a
// crashing one are all lines in the close's output, never a refusal: the links
// are host state, not the thread's diff. The check here is a stub speaking the
// real one's protocol (`fixed: <link> -> <target>`, `kept the displaced file
// at <path>`, `Error: …` and a `Relink with:` footer); what the real check
// finds is check-harness-config-links.test.ts's to test.

/** A links-check stub that records each run in HOME and behaves as HL_STUB_MODE says. */
const HL_STUB = `import { appendFileSync } from "node:fs";
const fix = process.argv.includes("--fix");
const H = process.env.HOME ?? "";
appendFileSync(\`\${H}/.hl-runs\`, fix ? "fix\\n" : "report\\n");
const mode = process.env.HL_STUB_MODE ?? "clean";
if (mode === "clean") process.exit(0);
if (!fix) {
  console.error("Error: a link drifted");
  console.error("Relink with: node --experimental-strip-types check-harness-config-links.ts --fix");
  process.exit(1);
}
if (mode === "drift") {
  console.log(\`fixed: \${H}/.grok/config.toml -> /the/target\`);
  console.log(\`kept the displaced file at \${H}/.grok/config.toml.pre-link\`);
  process.exit(0);
}
console.error(\`Error: refusing to relink \${H}/.grok/config.toml — it is a real directory with files in it.\`);
console.error("Relink with: node --experimental-strip-types check-harness-config-links.ts --fix");
process.exit(1);
`;

function commitOnTrunk(subject: string): void {
  gDo(F.CODE, "add", "-A");
  gDo(F.CODE, "commit", "-q", "-m", subject);
  gDo(F.CODE, "push", "-q", "origin", "HEAD:main");
}

const linkLines = (out: string): string[] => out.split("\n").filter((l) => l.includes("harness-links:"));
const hlRuns = (): string => {
  const p = join(F.HOME_DIR, ".hl-runs");
  return isFile(p) ? cat(p).split("\n").join(" ") : "";
};

kase("Case 22: every landing checks the harness home links, relinks drift, never refuses", () => {
  // (a) Clean: the check runs once, in report mode, and the close says nothing.
  fixture("c22-clean");
  write(join(F.CODE, HL_CHECK_REL), HL_STUB);
  commitOnTrunk("the links check stub");
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["clean links"], { merge: true, extra: { HL_STUB_MODE: "clean" } });
  is("(a) a close over clean links lands", r.rc, "0");
  is("(a) …and prints no harness-links line", linkLines(r.out).join("\n"), "");
  is("(a) …having run the check once, in report mode, and never its --fix", hlRuns(), "report");

  // (b) Drift the fix repairs: it prints both lines, and the close still lands.
  fixture("c22-drift");
  write(join(F.CODE, HL_CHECK_REL), HL_STUB);
  commitOnTrunk("the links check stub");
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["drifted links"], { merge: true, extra: { HL_STUB_MODE: "drift" } });
  is("(b) drift does not stop the close", r.rc, "0");
  has("(b) …which prints the proof line", r.out, "— closing this tab loses nothing.");
  is("(b) …having run the report, then the fix", hlRuns(), "report fix");
  is(
    "(b) …and prints one relinked line and one kept-file line",
    linkLines(r.out).join("\n"),
    [
      "- harness-links: relinked ~/.grok/config.toml -> /the/target",
      `- harness-links: the file that stood there is kept at ${F.HOME_DIR}/.grok/config.toml.pre-link — inspect it`,
    ].join("\n"),
  );

  // (c) Drift the fix refuses: the refusal is printed, and the close still lands.
  fixture("c22-unfixable");
  write(join(F.CODE, HL_CHECK_REL), HL_STUB);
  commitOnTrunk("the links check stub");
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["unfixable links"], { merge: true, extra: { HL_STUB_MODE: "unfixable" } });
  is("(c) an unfixable link does not stop the close", r.rc, "0");
  has("(c) …which prints the proof line", r.out, "— closing this tab loses nothing.");
  has(
    "(c) …and names what was not fixed",
    r.out,
    `- harness-links: NOT FIXED — refusing to relink ${F.HOME_DIR}/.grok/config.toml — it is a real directory with files in it.`,
  );
  has(
    "(c) …and how to see the details",
    r.out,
    `- harness-links: details: node --experimental-strip-types ${join(F.CODE, HL_CHECK_REL)}`,
  );

  // (d) The check is missing from the shared checkout: a warning, then the close.
  fixture("c22-missing");
  gDo(F.CODE, "rm", "-q", HL_CHECK_REL);
  commitOnTrunk("the links check is gone");
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["no links check"], { merge: true });
  is("(d) a missing check does not stop the close", r.rc, "0");
  has("(d) …which prints the proof line", r.out, "— closing this tab loses nothing.");
  is(
    "(d) …and warns, naming the check",
    linkLines(r.out).join("\n"),
    `- harness-links: WARNING not checked — no checkout this thread landed holds ${HL_CHECK_REL}`,
  );

  // (e) The check crashes: a warning carrying its error, then the close.
  fixture("c22-crash");
  write(join(F.CODE, HL_CHECK_REL), 'throw new TypeError("the links check blew up");\n');
  commitOnTrunk("a crashing links check");
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["crashing links check"], { merge: true });
  is("(e) a crashing check does not stop the close", r.rc, "0");
  has("(e) …which prints the proof line", r.out, "— closing this tab loses nothing.");
  is(
    "(e) …and warns with the error it threw",
    linkLines(r.out).join("\n"),
    "- harness-links: WARNING the check failed (exit 1): TypeError: the links check blew up — links not checked",
  );
});

// ── Case 23 ───────────────────────────────────────────────────────────────
//
// A HELD CLOSE PRINTS NO LAST LINE UNTIL IT IS RELEASED. A close that changed
// something live lands with --hold: it pushes and waits for the deploy, then
// stops before its last line so the live checks run while the session is still
// open. Whatever they find is fixed and landed again, or asked; --release
// re-proves everything against a fresh trunk and only then prints the report
// and the line — so a finding from the live checks is never asked below a
// close's last line.

kase("Case 23: a held close prints its last line only on release", () => {
  fixture("c23");
  write(join(F.WT1, "one.txt"), "one\n");
  let r = land(1, ["ship the page", "--hold"], { merge: true });
  is("a held landing exits 4", r.rc, "4");
  has("…says it is held and how to release it", r.out, "HELD: landed and deployed");
  hasnt("…prints no report", r.out, "**Shipped:**");
  hasnt("…and never the safe-to-close line", r.out, "loses nothing");
  is("…the change is on origin", onMain(F.CODE, "one.txt"), "yes");
  ok("…no closed marker is written", !existsSync(threadFile(TID1, "closed")), "closed marker written while held");
  is("…so the auto-close gate says it is held, not closed", land(1, ["--gate"]).out, "held");

  // A plain --check while held runs the checks but keeps the hold.
  r = land(1, ["--check"], { merge: true });
  is("a --check while held exits 4", r.rc, "4");
  hasnt("…prints no line", r.out, "loses nothing");
  ok("…keeps the hold", existsSync(threadFile(TID1, "held")), "--check cleared the hold");
  ok("…and writes no closed marker", !existsSync(threadFile(TID1, "closed")), "--check closed a held close");

  // The live checks find something: a fix left uncommitted refuses the release.
  write(join(F.WT1, "fix.txt"), "fix\n");
  r = land(1, ["--release"], { merge: true });
  is("a release over an unlanded fix is NOT CLOSED", r.rc, "3");
  has("…naming the worktree", r.out, `NOT CLOSED: uncommitted changes left in ${F.WT1}`);
  hasnt("…and never prints the line", r.out, "loses nothing");

  // The fix is landed, held again; the release reports the first subject.
  r = land(1, ["fix what the live check found", "--hold"], { merge: true });
  is("the fix lands held", r.rc, "4");
  is("…and is on origin", onMain(F.CODE, "fix.txt"), "yes");
  r = land(1, ["--release"], { merge: true });
  is("the release passes", r.rc, "0");
  has("…reports what the close shipped", r.out, "**Shipped:** ship the page");
  const tip = sh("git", ["--git-dir", join(F.S, `origins/land-${PID}-c23-code.git`), "rev-parse", "main"]).out;
  is(
    "…and ends on the line, from a fresh fetch",
    lastLine(r.out),
    `origin/main is at ${tip} — closing this tab loses nothing.`,
  );
  ok("…writing the closed marker", existsSync(threadFile(TID1, "closed")), "no closed marker after release");
  ok("…and clearing the hold", !existsSync(threadFile(TID1, "held")), "held marker left after release");

  r = land(1, ["--release"], { merge: true });
  is("a release with nothing held is NOT CLOSED", r.rc, "3");
  has("…saying so", r.out, "NOT CLOSED: nothing is held");
});

// ── Case 24 ───────────────────────────────────────────────────────────────
//
// THE CLOSE REFUSES WITHOUT ITS PREREQUISITES. Verify
// had to have passed on the content every worktree holds now, and the thread
// has to have a journal entry — one opened on a product repo too. Each was a
// SKILL.md sentence the model had to remember; land.ts now asks.

kase("Case 24: no verify, a stale verify, or no journal is NOT CLOSED", () => {
  // (a) A skill changed, an entry written, verify never run.
  fixture("c24a");
  write(join(F.WT1, ".agents/skills/foo/notes.md"), "notes\n");
  entry(jf(1, "never verified"), "never-verified", "verify was never run");
  const before = g(F.CODE, "rev-parse", "origin/main");
  let r = land(1, ["thread one"], { merge: true, bare: true });
  is("(a) a close verify never ran on exits 3", r.rc, "3");
  has("(a) …saying verify never ran on the worktree", r.out, `verify: ${F.WT1}: verify never ran on this worktree`);
  has(
    "(a) …and refusing with what to run",
    r.out,
    "NOT CLOSED: verify has not passed on this worktree as it is now — run verify.ts",
  );
  gOk(F.CODE, "fetch", "-q", "origin");
  is("(a) …and nothing reaches main", g(F.CODE, "rev-parse", "origin/main"), before);
  is(
    "(a) …nor is anything committed in the worktree",
    g(F.WT1, "log", "--oneline", "origin/main..HEAD").split("\n").filter(Boolean).length,
    "0",
  );

  // (b) Verify passed, then a skill script changed.
  is("(b) verify passes", verify(1).rc, 0);
  write(join(F.WT1, ".agents/skills/foo/scripts/x.ts"), "export {};\n");
  r = land(1, ["thread one"], { merge: true, bare: true });
  is("(b) an edit after verify passed exits 3", r.rc, "3");
  has("(b) …listing the edited path", r.out, `changed since verify passed: .agents/skills/foo/scripts/x.ts`);

  // (c) Verify again; afterwards only the records the close writes move.
  is("(c) verify passes again", verify(1).rc, 0);
  write(join(F.WT1, "knowledge/notes/x.md"), "a fact\n");
  write(join(F.WT1, "projects/demo/p/README.md"), "# a project readme\n");
  entry(cat(threadFile(TID1, "journal")), "never-verified", "the entry, written after verify");
  r = land(1, ["thread one"], { merge: true, bare: true });
  is("(c) journal, knowledge and project README edits after verify still land", r.rc, "0");
  is("(c) …with the script on main", onMain(F.CODE, ".agents/skills/foo/scripts/x.ts"), "yes");

  // (d) A verify run that failed.
  fixture("c24d");
  write(join(F.WT1, ".agents/skills/foo/scripts/red.test.sh"), "exit 1\n");
  entry(jf(1, "red verify"), "red-verify", "verify failed");
  ok("(d) verify fails", verify(1).rc !== 0, "verify passed over a red suite");
  r = land(1, ["thread one"], { merge: true, bare: true });
  is("(d) a close whose last verify failed exits 3", r.rc, "3");
  has("(d) …saying the last run failed", r.out, `verify: ${F.WT1}: the last run failed`);

  // (e) A thread whose only work is in a product repo, with no journal entry.
  fixture("c24e");
  const SAT = writeRoot(1, F.PROD).out;
  write(join(SAT, "prod.md"), "prod\n");
  is("(e) verify passes", verify(1).rc, 0);
  const prodBefore = g(F.PROD, "rev-parse", "origin/main");
  r = land(1, ["thread one"], { merge: true, bare: true });
  is("(e) a product-only thread with no journal exits 3", r.rc, "3");
  has("(e) …saying what to run", r.out, "NOT CLOSED: no journal entry for this thread — run journal-file.ts");
  gOk(F.PROD, "fetch", "-q", "origin");
  is("(e) …and nothing is pushed", g(F.PROD, "rev-parse", "origin/main"), prodBefore);
  hasnt("(e) …and no proof line is printed", r.out, "loses nothing");

  // (f) verify.ts itself is missing: refused, never read as a pass.
  fixture("c24f");
  write(join(F.WT1, "one.txt"), "one\n");
  const NOROOT = join(F.S, "noverify");
  const NOVERIFY = join(NOROOT, ".agents/skills/close/scripts");
  cpSync(HERE, NOVERIFY, { recursive: true });
  copyScripts(NOROOT);
  rmSync(join(NOVERIFY, "verify.ts"), { force: true });
  r = land(1, ["thread one"], { merge: true, script: join(NOVERIFY, "land.ts") });
  is("(f) a missing verify.ts exits 3", r.rc, "3");
  has("(f) …naming the script it wanted", r.out, `NOT CLOSED: verify check missing: ${NOVERIFY}/verify.ts`);
});

// ── Case 24r ──────────────────────────────────────────────────────────────
//
// IMPLEMENTATION SOURCE LANDS ONLY ON A REVIEW OF WHAT IS PUSHED
//. A thread whose report carries a coverage block
// is refused without a receipt; with one, the trunk merge can still move a
// dependency the review relied on, and the push is refused naming it — nothing
// reaches main, and the merge stays for the remaining review allowance.
const AUDIT_TS = join(HERE, "../../implement-audit/scripts/audit-dedupe.ts");
function receipt(rounds: string, ...args: string[]): Res {
  return sh(process.execPath, ["--experimental-strip-types", AUDIT_TS, ...args], {
    cwd: F.WT1,
    env: { ...envOf(1, F.WT1), CODE_REVIEW_LOOP_ID: TID1, CODE_REVIEW_ROUND_STATE_DIR: rounds },
    merge: true,
  });
}
function approveReceipt(report: string, base = "HEAD"): void {
  const rounds = join(F.S, "rounds");
  const b = receipt(
    rounds,
    "begin",
    "--repo",
    F.WT1,
    "--tree",
    "t",
    "--mode",
    "range",
    "--bucket",
    "build",
    "--base",
    base,
    "--scope",
    ".agents/skills/foo",
    "--report",
    report,
  );
  if (!b.out.includes("RECEIPT=review")) throw new Error(`receipt begin: ${b.out}`);
  const res = join(F.S, "result.json");
  write(
    res,
    JSON.stringify({
      vendor: "grok/grok-4",
      findings: [],
      coverage: ["E1", "D1"].map((id) => ({ id, status: "checked", evidence: ["read"] })),
    }),
  );
  const f = receipt(rounds, "finish", "--repo", F.WT1, "--rc", "0", "--result", res);
  if (!f.out.includes("APPROVED=1")) throw new Error(`receipt finish: ${f.out}`);
}

kase("Case 24r: implementation source lands only on a review receipt of what is pushed", () => {
  fixture("c24r");
  write(join(F.CODE, ".agents/skills/foo/dep.ts"), "export const dep = 1;\n");
  commitOnTrunk("a dependency");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  write(join(F.WT1, ".agents/skills/foo/x.ts"), "export const x = 2;\n");
  const REPORT = join(F.WT1, "projects/demo/p/specs/001-x/report.md");
  write(
    REPORT,
    `# r\n<!-- review-coverage:v1 -->\n${JSON.stringify({
      base: "HEAD",
      scope: ".agents/skills/foo",
      entryPoints: [{ id: "E1", path: ".agents/skills/foo/x.ts" }],
      dependencies: [{ id: "D1", path: ".agents/skills/foo/dep.ts", why: "x reads it" }],
      claims: [],
    })}\n<!-- /review-coverage -->\n`,
  );
  entry(jf(1, "reviewed"), "reviewed", "a reviewed change");

  // (a) No receipt.
  let r = land(1, ["thread one"], { merge: true });
  is("(a) implementation work with no receipt exits 3", r.rc, "3");
  has(
    "(a) …naming the unreviewed source",
    r.out,
    `review: ${F.WT1}: no review receipt for implementation source (.agents/skills/foo/x.ts)`,
  );
  has("(a) …through the verify gate", r.out, "NOT CLOSED: verify has not passed");

  // (b) A receipt, then the trunk moves the dependency it relied on.
  approveReceipt(REPORT);
  write(join(F.CODE, ".agents/skills/foo/dep.ts"), "export const dep = 2;\n");
  commitOnTrunk("another session moves the dependency");
  const before = g(F.CODE, "rev-parse", "origin/main");
  r = land(1, ["thread one"], { merge: true });
  is("(b) a merge that moves covered content exits 3", r.rc, "3");
  has("(b) …naming the moved dependency", r.out, `review: ${F.WT1}: changed since the review: .agents/skills/foo/dep.ts`);
  has("(b) …and the recovery", r.out, "the independent review no longer covers what");
  gOk(F.CODE, "fetch", "-q", "origin");
  is("(b) …and nothing reaches main", g(F.CODE, "rev-parse", "origin/main"), before);

  // (c) The merged content reviewed (from where the branch now leaves the
  // trunk, as validate.ts passes --base): it lands.
  approveReceipt(REPORT, g(F.WT1, "merge-base", "HEAD", "origin/main"));
  r = land(1, ["thread one"], { merge: true });
  is("(c) a receipt of the merged content lands", r.rc, "0");
  is("(c) …with the change on main", onMain(F.CODE, ".agents/skills/foo/x.ts"), "yes");
});

// ── Case 25 ───────────────────────────────────────────────────────────────
//
// A FINISHED SPEC'S ROW CLOSES ITSELF. A push writing a report
// `complete` sets every row naming that spec `done` before the gates read the
// table, and again on the merged tree; `closed:` and `absorbed by` rows, rows
// already done, and rows of a spec another session's report finished are left
// alone. The model used to run `roadmap.ts --set <ID> done` itself (§ 2).

/** A project on the trunk with the given rows and a spec folder per row, both worktrees reset to it. */
function seedRows(...rows: string[]): void {
  write(join(F.CODE, RMP, "ROADMAP.md"), lines(...tableHead(), ...rows));
  for (const m of rows.join("\n").matchAll(/specs\/(\d{3}-[a-z]+)\//g))
    write(join(F.CODE, RMP, `specs/${m[1]}/spec.md`), "# spec\n");
  write(
    join(F.CODE, RMP, "README.md"),
    '---\nproject: rows\nstatus: active\nnext: "R1: first"\n---\n\n# Project: rows\n',
  );
  commitOnTrunk("roadmap");
  for (const wt of [F.WT1, F.WT2]) {
    gDo(wt, "fetch", "-q", "origin");
    gDo(wt, "reset", "-q", "--hard", "origin/main");
  }
}
const complete = (extra = ""): string =>
  `---\nspec: x\nspec-status: complete\n---\n\n# Implementation Report\n${extra}`;
/** `R1=done R2=planned …` from origin/main's table. */
function mainRows(): string {
  gOk(F.CODE, "fetch", "-q", "origin");
  return g(F.CODE, "show", `origin/main:${RMP}/ROADMAP.md`)
    .split("\n")
    .filter((l) => l.startsWith("| R"))
    .map((l) => {
      const f = l.split("|");
      return `${(f[1] ?? "").trim()}=${(f[4] ?? "").trim()}`;
    })
    .join(" ");
}

kase("Case 25: a finished spec's row is set done by the close", () => {
  // (a) One push finishing three specs, rows of every kind.
  fixture("c25a");
  seedRows(
    "| R1 | first | — | in-progress | `specs/001-first/` |",
    "| R2 | second | — | closed: dropped | `specs/002-second/` |",
    "| R3 | third | — | absorbed by R1 | `specs/003-third/` |",
    "| R4 | fourth | — | planned | `specs/004-fourth/` |",
    "| R5 | again | — | in-progress | `specs/001-first/` |",
  );
  for (const s of ["001-first", "002-second", "003-third"]) write(join(F.WT1, RMP, `specs/${s}/report.md`), complete());
  let r = land(1, ["finish R1"], { merge: true });
  is("(a) the close lands", r.rc, "0");
  is(
    "(a) R1 and R5 (the same spec) are done; closed:, absorbed by and planned rows are untouched",
    mainRows(),
    "R1=done R2=closed: dropped R3=absorbed by R1 R4=planned R5=done",
  );
  has("(a) …saying which row it set", r.out, `roadmap: ${RMP} R1 set done — specs/001-first reads complete`);
  is(
    "(a) …and next: is re-derived in the same landing",
    nextLine(g(F.CODE, "show", `origin/main:${RMP}/README.md`)),
    '"R4: fourth"',
  );

  // (b) A row already done: no write, no extra commit.
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete("\nA later note.\n"));
  r = land(1, ["note on R1"], { merge: true });
  is("(b) a report edit on a done row lands", r.rc, "0");
  hasnt("(b) …setting nothing", r.out, "set done");

  // (c) A partial report is not promoted, and the partial gate refuses it.
  fixture("c25c");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |", "| R2 | second | — | planned | — |");
  write(join(F.WT1, RMP, "specs/001-first/report.md"), "---\nspec: x\nspec-status: partial\n---\n");
  r = land(1, ["half of R1"], { merge: true });
  is("(c) a partial report is NOT CLOSED", r.rc, "3");
  has("(c) …by the partial gate", r.out, "reads partial");
  has("(c) …and its row stays in-progress", cat(join(F.WT1, RMP, "ROADMAP.md")), "| R1 | first | — | in-progress |");

  // (d) The trunk merge brings another session's complete report for R2,
  // landed without its row: this push's promotion leaves R2 alone.
  fixture("c25d");
  seedRows(
    "| R1 | first | — | in-progress | `specs/001-first/` |",
    "| R2 | second | — | in-progress | `specs/002-second/` |",
    "| R3 | third | — | planned | — |",
  );
  write(join(F.CODE, RMP, "specs/002-second/report.md"), complete());
  commitOnTrunk("another session's report");
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete());
  r = land(1, ["finish R1"], { merge: true });
  is("(d) the close lands over the merge", r.rc, "0");
  is("(d) only this push's row is done", mainRows(), "R1=done R2=in-progress R3=planned");

  // (e) The trunk merge brings a row naming THIS push's finished spec.
  fixture("c25e");
  seedRows("| R1 | first | — | done | `specs/001-first/` |");
  write(join(F.WT1, RMP, "specs/006-new/spec.md"), "# spec\n");
  write(join(F.WT1, RMP, "specs/006-new/report.md"), complete());
  sedLines(join(F.CODE, RMP, "ROADMAP.md"), /^(\| R1 .*)$/, "$1\n| R6 | new | — | planned | `specs/006-new/` |");
  commitOnTrunk("a row for the new spec");
  r = land(1, ["finish the new spec"], { merge: true });
  is("(e) the close lands", r.rc, "0");
  is("(e) the merged-in row naming this push's spec is done", mainRows(), "R1=done R6=done");
  is(
    "(e) …both files committed on the merged tree",
    filesInCommit(F.CODE, "finish the new spec (finished rows set done on the merged table)"),
    `${RMP}/README.md ${RMP}/ROADMAP.md `,
  );

  // (f) A table roadmap.ts cannot read: promotion skips it, the re-derive refuses.
  fixture("c25f");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  write(
    join(F.WT1, RMP, "ROADMAP.md"),
    lines(
      ...tableHead(),
      "| R1 | first | — | in-progress | `specs/001-first/` |",
      "| R2 | second | — | planned | sideways |",
    ),
  );
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete());
  r = land(1, ["finish R1"], { merge: true });
  is("(f) a malformed table is NOT CLOSED", r.rc, "3");
  hasnt("(f) …and no row was set", r.out, "set done");
});

// ── Case 26 ───────────────────────────────────────────────────────────────
//
// THE RECORD CARRIES WHAT THE SCRIPTS FOUND. The audit lines of every
// spec the push changed are quoted in the journal entry without the model
// copying them; the harness-link lines are in the report on landing and on
// release; and the report block is saved to the thread's state before the
// close is marked closed.

kase("Case 26: audit lines, harness links and the saved report", () => {
  // (a) A spec with both audit lines: both quoted under **Changes:**.
  fixture("c26a");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  write(join(F.WT1, RMP, "specs/001-first/plan.md"), "# plan\n\n- spec-audit: codex round-1; spirit MATCH\n");
  write(
    join(F.WT1, RMP, "specs/001-first/report.md"),
    complete("\n**implement-audit:** `round-1; clean`\n| 4. implement-audit | ✅ |\n"),
  );
  const J = jf(1, "audit lines");
  write(
    J,
    "---\ndate: 2026-09-13\ntime: 20:15\nslug: audit-lines\ntags: []\n---\n\n### audit-lines\n**Action:** shipped\n\nFinished R1.\n\n**Changes:**\n- built R1\n",
  );
  let r = land(1, ["finish R1"], { merge: true });
  is("(a) the close lands", r.rc, "0");
  const landed = g(F.CODE, "show", `origin/main:journal/2026-09-13/${basename(J)}`);
  has(
    "(a) the spec-audit line is quoted under Changes, after what was there",
    landed,
    "**Changes:**\n- built R1\n- spec-audit: codex round-1; spirit MATCH\n- **implement-audit:** `round-1; clean`",
  );
  hasnt("(a) …and the table row is not taken for a line", landed, "| 4. implement-audit");

  // (b) Already quoted, with other spacing: not written twice.
  fixture("c26b");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  write(join(F.WT1, RMP, "specs/001-first/plan.md"), "# plan\n\n- spec-audit: codex round-1; spirit MATCH\n");
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete());
  const J2 = jf(1, "quoted");
  write(
    J2,
    "---\ndate: 2026-09-13\ntime: 20:15\nslug: quoted\ntags: []\n---\n\n### quoted\n**Action:** shipped\n\nFinished R1.\n\n**Changes:**\n-  spec-audit:   codex round-1;  spirit MATCH\n",
  );
  r = land(1, ["finish R1"], { merge: true });
  is("(b) the close lands", r.rc, "0");
  is(
    "(b) …with the line quoted once",
    String((g(F.CODE, "show", `origin/main:journal/2026-09-13/${basename(J2)}`).match(/spec-audit:/g) ?? []).length),
    "1",
  );

  // (c) A spec with no audit line: nothing written, nothing refused.
  fixture("c26c");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete());
  r = land(1, ["finish R1"], { merge: true });
  is("(c) a spec with no audit line lands", r.rc, "0");
  hasnt("(c) …quoting nothing", r.out, "audit line(s)");

  // (d) The report block is saved before the close is marked closed, and the
  // reader's delivered mark is cleared with it.
  write(threadFile(TID1, "report-delivered"), "");
  write(join(F.WT1, "two.txt"), "two\n");
  r = land(1, ["second landing"], { merge: true });
  is("(d) the close lands", r.rc, "0");
  const saved = isFile(threadFile(TID1, "report")) ? cat(threadFile(TID1, "report")) : "no saved report";
  is("(d) the saved report is the printed block", r.out.slice(r.out.indexOf("**Shipped:**")), saved);
  ok("(d) …ending on the proof line", saved.endsWith("closing this tab loses nothing."), saved);
  ok("(d) …and the delivered mark is cleared", !existsSync(threadFile(TID1, "report-delivered")), "still there");

  // (e) A held landing that relinked a drifted home link: the release's report
  // carries the line, under **Harness links:**, above the proof line.
  fixture("c26e");
  write(join(F.CODE, HL_CHECK_REL), HL_STUB);
  commitOnTrunk("the links check stub");
  write(join(F.WT1, "one.txt"), "one\n");
  r = land(1, ["drift, held", "--hold"], { merge: true, extra: { HL_STUB_MODE: "drift" } });
  is("(e) the held landing exits 4", r.rc, "4");
  hasnt("(e) …printing no harness line before the report", r.out, "harness-links:");
  r = land(1, ["--release"], { merge: true });
  is("(e) the release passes", r.rc, "0");
  has(
    "(e) …and its report carries the relinked line",
    r.out,
    "**Harness links:**\n\n- harness-links: relinked ~/.grok/config.toml -> /the/target",
  );
  ok(
    "(e) …above the proof line",
    r.out.indexOf("**Harness links:**") < r.out.indexOf("loses nothing"),
    "the harness links came after the proof line",
  );
  ok("(e) …and the lines are gone once the close is done", !existsSync(threadFile(TID1, "harness-links")), "kept");

  // (f) A release whose report cannot be saved is NOT CLOSED, hold intact.
  fixture("c26f");
  write(join(F.WT1, "one.txt"), "one\n");
  is("(f) the held landing exits 4", land(1, ["held", "--hold"], { merge: true }).rc, "4");
  write(join(threadFile(TID1, "report"), "in-the-way"), "a directory where the report goes\n");
  r = land(1, ["--release"], { merge: true });
  is("(f) a release that cannot save its report exits 3", r.rc, "3");
  has("(f) …saying so", r.out, `NOT CLOSED: could not save the report to ${threadFile(TID1, "report")}`);
  hasnt("(f) …printing no proof line", r.out, "loses nothing");
  ok("(f) …the hold is kept", existsSync(threadFile(TID1, "held")), "the hold was cleared");
  ok("(f) …no closed marker is written", !existsSync(threadFile(TID1, "closed")), "closed was written");
  rmSync(threadFile(TID1, "report"), { recursive: true, force: true });
  r = land(1, ["--release"], { merge: true });
  is("(f) the retried release passes", r.rc, "0");

  // (g) A landing whose report cannot be saved, then a --check: the check
  // prints its line but does not mark closed what has no report.
  fixture("c26g");
  write(join(F.WT1, "one.txt"), "one\n");
  write(join(threadFile(TID1, "report"), "in-the-way"), "a directory where the report goes\n");
  r = land(1, ["thread one"], { merge: true });
  is("(g) a landing that cannot save its report exits 3", r.rc, "3");
  r = land(1, ["--check"], { merge: true });
  is("(g) a --check after it passes its checks", r.rc, "0");
  has("(g) …saying it marks nothing closed", r.out, "closed: not marked — no report of this close is saved");
  ok("(g) …and no closed marker is written", !existsSync(threadFile(TID1, "closed")), "--check closed it");
  rmSync(threadFile(TID1, "report"), { recursive: true, force: true });
  r = land(1, ["thread one"], { merge: true });
  is("(g) landing again saves the report and closes", r.rc, "0");
  ok("(g) …with the closed marker", existsSync(threadFile(TID1, "closed")), "no closed marker");

  // (h) The trunk changes the audit line of a spec this push also changed:
  // the merged verdict is quoted too, and committed before the push.
  fixture("c26h");
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  write(join(F.CODE, RMP, "specs/001-first/plan.md"), "# plan\n\n- spec-audit: codex round-1; spirit MATCH\n");
  commitOnTrunk("plan, audited");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  write(join(F.WT1, RMP, "specs/001-first/report.md"), complete());
  write(join(F.CODE, RMP, "specs/001-first/plan.md"), "# plan\n\n- spec-audit: codex round-2; spirit MATCH\n");
  commitOnTrunk("plan, re-audited");
  r = land(1, ["finish R1"], { merge: true });
  is("(h) the close lands over the merge", r.rc, "0");
  const entryOnMain = g(F.CODE, "show", `origin/main:${relative(F.WT1, cat(threadFile(TID1, "journal")))}`);
  has("(h) the verdict this branch saw is quoted", entryOnMain, "- spec-audit: codex round-1; spirit MATCH");
  has("(h) …and the merged one too", entryOnMain, "- spec-audit: codex round-2; spirit MATCH");
});

// ── Case 27 ───────────────────────────────────────────────────────────────
//
// LIVE CHECKS ARE OWED, RUN AND PROVED BEFORE A HELD CLOSE IS RELEASED.
// A spec's tasks.md declares its live checks in a `live-checks` block; the push
// that writes the spec `complete` owes them, holds whatever flag it was given,
// and --release runs each command check itself and accepts an evidence check
// only from a record taken on the deployment live now. What is live is each
// repo's trunk on its bare origin, read for real, or a stubbed answer from a
// file (LIVE_CHECKS_TEST_SOURCES) where a case needs the live commit to differ.
// A stubbed target also records no deployment (`<target>#deployment`: null)
// and no check still running on its trunk (`<target>#pending`: []): an origin
// with a GitHub name is read as GitHub, through `insteadOf` or an SSH alias
// alike, and this fixture has no deployments or checks for gh to list.

const liveStub = (): string => join(F.S, "live.json");
const LIVE_ENV = (): Record<string, string> => ({
  LIVE_CHECKS_TEST_SOURCES: liveStub(),
  LAND_LIVE_CHECK_TIMEOUT: "2",
});
function liveLand(args: string[], extra: Record<string, string> = {}, bare = false): Res {
  return land(1, args, { merge: true, extra: { ...LIVE_ENV(), ...extra }, bare });
}
/** <answers> with no deployment recorded, and nothing still building the trunk,
 *  for each target it names, unless it says otherwise. */
function noDeploy(answers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...answers };
  for (const k of Object.keys(answers)) {
    if (k.includes("#")) continue;
    if (!(`${k}#deployment` in out)) out[`${k}#deployment`] = null;
    if (!(`${k}#pending` in out)) out[`${k}#pending`] = [];
  }
  return out;
}
/** What the stub calls live, per target; a target it does not name is read for real. */
function stubLive(answers: Record<string, unknown>): void {
  write(liveStub(), JSON.stringify(noDeploy(answers)));
}
/** The commit live on the workbench target, as the stub answers it. */
function deployed(sha: string): void {
  stubLive({ workbench: sha });
}
function originTip(repo: "code" | "prod"): string {
  return sh("git", ["--git-dir", join(F.S, `origins/land-${PID}-${basename(F.S)}-${repo}.git`), "rev-parse", "main"])
    .out;
}
/** A spec of the rows project, finished in thread one's worktree, with these tasks. */
function finishSpec(spec: string, tasks: string): void {
  write(join(F.WT1, RMP, `specs/${spec}/tasks.md`), tasks);
  write(join(F.WT1, RMP, `specs/${spec}/report.md`), complete());
}
const liveBlock = (...ls: string[]): string => `# Tasks\n\n\`\`\`live-checks\n${ls.join("\n")}\n\`\`\`\n`;
const owedKeys = (): string =>
  isFile(threadFile(TID1, "live-owed"))
    ? (JSON.parse(cat(threadFile(TID1, "live-owed"))) as { key: string }[]).map((o) => o.key).join(" ")
    : "none";
const owedCommit = (key: string): string =>
  (JSON.parse(cat(threadFile(TID1, "live-owed"))) as { key: string; commit: string }[]).find((o) => o.key === key)
    ?.commit ?? "unbound";

kase("Case 27: live checks are owed, run and proved before a held close is released", () => {
  // (a) Workbench checks: owed and held without --hold, never cleared by a
  // landing, refused until each passes on what is live, then released.
  fixture("c27a");
  seedRows(
    "| R1 | first | — | in-progress | `specs/001-first/` |",
    "| R2 | second | — | planned | `specs/002-second/` |",
  );
  finishSpec(
    "001-first",
    liveBlock(
      `home | workbench | command | test -f "$LIVE_CHECKS_TEST_SOURCES.ok"`,
      "shot | workbench | evidence | the page shows one",
    ),
  );
  let r = liveLand(["ship R1"]);
  is("(a) a landing that owes live checks holds without --hold", r.rc, "4");
  has(
    "(a) …listing the command check",
    r.out,
    'owed: rows/001-first/home — command on workbench: test -f "$LIVE_CHECKS_TEST_SOURCES.ok"',
  );
  has("(a) …and how to record the evidence one", r.out, "land.ts --live-start rows/001-first/shot; capture it;");
  has("(a) …ending on HELD", lastLine(r.out), "HELD: landed and deployed");
  const tip1 = originTip("code");
  is("(a) …each owed check bound to the commit it landed", owedCommit("rows/001-first/home"), tip1);
  const gate = land(1, ["--gate"]).out;
  is("(a) --gate says held", gate.split("\n")[0] ?? "", "held");
  has("(a) …with the owed checks", gate, "owed: rows/001-first/shot");
  is("(a) --check while held exits 4", liveLand(["--check"]).rc, "4");

  write(join(F.WT1, "two.txt"), "two\n");
  r = liveLand(["a plain landing"]);
  is("(a) an ordinary landing while held is refused", r.rc, "3");
  has("(a) …saying so", r.out, "NOT CLOSED: a hold is open — land with --hold, or --release");
  is("(a) …and the hold is intact", cat(threadFile(TID1, "held")), "ship R1");
  is("(a) …nothing of it was pushed", onMain(F.CODE, "two.txt"), "no");
  rmSync(join(F.WT1, "two.txt"));

  deployed(tip1);
  r = liveLand(["--release"]);
  is("(a) a release with a failing command and no evidence is refused", r.rc, "3");
  has("(a) …the command's failure named", r.out, "live check rows/001-first/home failed (exit 1)");
  has(
    "(a) …the missing evidence named, with how to record it",
    r.out,
    "live check rows/001-first/shot has no evidence — land.ts --live-start rows/001-first/shot",
  );
  hasnt("(a) …and no proof line", r.out, "loses nothing");
  ok("(a) …the hold is kept", isFile(threadFile(TID1, "held")), "hold cleared");

  const shot = join(F.S, "shot.png");
  write(shot, "png\n");
  r = liveLand(["--live-pass", "rows/001-first/nope", shot, "--saw", "x"]);
  has(
    "(a) --live-pass of an id not owed is refused, naming the owed",
    r.out,
    "rows/001-first/nope is not an owed live check — owed: rows/001-first/home, rows/001-first/shot",
  );
  has(
    "(a) --live-start of a command check is refused",
    liveLand(["--live-start", "rows/001-first/home"]).out,
    "is a command check",
  );
  r = liveLand(["--live-pass", "rows/001-first/shot", shot, "--saw", "one"]);
  has("(a) --live-pass with no --live-start is refused", r.out, "rows/001-first/shot has no --live-start");
  is("(a) --live-start records what is live", liveLand(["--live-start", "rows/001-first/shot"]).rc, "0");
  has(
    "(a) --live-pass of a missing file is refused",
    liveLand(["--live-pass", "rows/001-first/shot", join(F.S, "none.png"), "--saw", "one"]).out,
    "is missing or empty",
  );
  has(
    "(a) --live-pass without --saw is refused",
    liveLand(["--live-pass", "rows/001-first/shot", shot, "--saw", " "]).out,
    '--saw "<what the evidence shows>" is required',
  );
  deployed("e".repeat(40));
  r = liveLand(["--live-pass", "rows/001-first/shot", shot, "--saw", "one"]);
  is("(a) a capture after the revision moved is refused", r.rc, "3");
  has("(a) …as void", r.out, "workbench changed since --live-start");
  deployed(tip1);
  liveLand(["--live-start", "rows/001-first/shot"]);
  is(
    "(a) a capture on the same revision is recorded",
    liveLand(["--live-pass", "rows/001-first/shot", shot, "--saw", "one is shown"]).rc,
    "0",
  );

  // A fix landed --hold whose spec declares its own `home`: three owed, two keys named home.
  // Its check imports a package only the repo's own checkout resolves — here an
  // ignored node_modules inside it, as a shared node_modules in a parent folder
  // serves every checkout under it. The run tree, made elsewhere, must resolve
  // it the same way, or it fails on "Cannot find package".
  write(join(F.CODE, "node_modules/live-dep/package.json"), '{"name":"live-dep","type":"module","main":"index.js"}\n');
  write(join(F.CODE, "node_modules/live-dep/index.js"), "export default 1;\n");
  appendFileSync(join(F.CODE, ".git/info/exclude"), "node_modules/\n");
  finishSpec(
    "002-second",
    liveBlock(`home | workbench | command | node --input-type=module -e 'await import("live-dep")'`),
  );
  r = liveLand(["fix what the live check found", "--hold"]);
  is("(a) the fix lands held", r.rc, "4");
  is(
    "(a) …and three checks are owed, home under each spec",
    owedKeys(),
    "rows/001-first/home rows/001-first/shot rows/002-second/home",
  );
  const tip2 = originTip("code");
  deployed(tip2);
  write(`${liveStub()}.ok`, "ok\n");
  r = liveLand(["--release"]);
  is("(a) evidence taken before the fix deployed is void at release", r.rc, "3");
  has("(a) …saying so", r.out, "NOT CLOSED: live check rows/001-first/shot: its evidence was taken on");
  liveLand(["--live-start", "rows/001-first/shot"]);
  liveLand(["--live-pass", "rows/001-first/shot", shot, "--saw", "one is shown"]);
  r = liveLand(["--release"]);
  is("(a) every check passed on what is live: released", r.rc, "0");
  has("(a) …reporting the first held subject", r.out, "**Shipped:** ship R1");
  has(
    "(a) …each command check that passed",
    r.out,
    '- rows/001-first/home — `test -f "$LIVE_CHECKS_TEST_SOURCES.ok"` passed on workbench at',
  );
  has(
    "(a) …each expectation beside what was seen",
    r.out,
    "- rows/001-first/shot — expected: the page shows one — saw: one is shown ([",
  );
  has("(a) …and ends on the proof line", lastLine(r.out), "closing this tab loses nothing.");
  ok(
    "(a) …the hold and the owed checks are gone",
    !isFile(threadFile(TID1, "held")) && !isFile(threadFile(TID1, "live-owed")),
    "left",
  );

  // (b) A check on another repo, declared in workbench, binds at that repo's
  // push, and release reads that repo live: not containing, unreadable,
  // moving mid-check, hanging, a relative command, then released. The repo
  // is named as GitHub names it, so both origins get GitHub names (the stub
  // waiter answers their push checks).
  fixture("c27b");
  writeAwaitStub();
  const T = `repo:test/${basename(F.PROD)}`;
  seedRows("| R1 | first | — | in-progress | `specs/001-first/` |");
  finishSpec(
    "001-first",
    liveBlock(
      `api | ${T} | command | if [ -f "$LIVE_CHECKS_TEST_SOURCES.flip" ]; then cp "$LIVE_CHECKS_TEST_SOURCES.flip" "$LIVE_CHECKS_TEST_SOURCES"; fi`,
      `slow | ${T} | command | if [ -f "$LIVE_CHECKS_TEST_SOURCES.hang" ]; then sleep 30 & echo $! > "$LIVE_CHECKS_TEST_SOURCES.pid"; wait; fi`,
      `rel | ${T} | command | test -f ./.agents/skills/close/scripts/land.ts`,
      `fresh | ${T} | command | test ! -e ./dirt.txt`,
    ),
  );
  r = liveLand(["ship the other repo's check"]);
  is("(b) a check on a repo this thread lands nothing in is refused", r.rc, "3");
  has(
    "(b) …before the push, saying there is nothing to check there",
    r.out,
    `owes a live check on ${T}, which builds from test/${basename(F.PROD)} — this thread lands nothing there`,
  );
  is("(b) …so nothing was pushed", onMain(F.CODE, `${RMP}/specs/001-first/tasks.md`), "no");
  const SAT = writeRoot(1, F.PROD).out;
  write(join(SAT, "page.md"), "page\n");
  r = liveLand(["ship the other repo's check"]);
  is("(b) with that repo landed second, it holds", r.rc, "4");
  const prodTip = originTip("prod");
  is("(b) …the check bound at that repo's push", owedCommit("rows/001-first/api"), prodTip);

  const prodSeed = g(F.PROD, "rev-parse", "origin/main~1");
  stubLive({ [T]: prodSeed });
  r = liveLand(["--release"]);
  is("(b) a live repo older than the landing is refused", r.rc, "3");
  has("(b) …one NOT CLOSED line for the four checks it fails", r.out, "NOT CLOSED: 4 live checks not proved");
  has(
    "(b) …as not containing it",
    r.out,
    `live check rows/001-first/api: the live ${T} does not contain ${prodTip.slice(0, 12)}`,
  );
  stubLive({ [T]: "c".repeat(40) });
  has(
    "(b) a live commit the repo does not have is refused",
    liveLand(["--release"]).out,
    "which " + F.PROD + " does not have",
  );
  stubLive({ [T]: { throw: "origin 503" } });
  has(
    "(b) an unreadable revision is refused, naming why",
    liveLand(["--release"]).out,
    `cannot read the live revision of ${T}: origin 503`,
  );
  stubLive({ [T]: prodTip });
  write(`${liveStub()}.flip`, JSON.stringify(noDeploy({ [T]: prodTip.slice(0, 12) })));
  r = liveLand(["--release"]);
  is("(b) a deploy landing during the checks is refused", r.rc, "3");
  has("(b) …saying the repo changed", r.out, `the live ${T} changed during the checks`);
  rmSync(`${liveStub()}.flip`);
  stubLive({ [T]: prodTip });
  write(`${liveStub()}.hang`, "");
  r = liveLand(["--release"]);
  has(
    "(b) a command that hangs is killed and failed",
    r.out,
    "live check rows/001-first/slow failed: killed after 2 s",
  );
  const alive = (): boolean => {
    const pid = Number(readFileSync(`${liveStub()}.pid`, "utf8").trim());
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  is("(b) …and the child it started is killed with it", String(alive()), "false");
  // With no timeout(1) or gtimeout (stock macOS), the fallback still ends the
  // command's whole process group: it killed only bash, and the sleep it
  // started outlived the check (Contextium v9.2.0 review).
  rmSync(`${liveStub()}.pid`, { force: true });
  const t0 = Date.now();
  r = liveLand(["--release"], { LAND_TIMEOUT_BINS: "" });
  has(
    "(b) with no timeout program, a command that hangs is killed and failed",
    r.out,
    "live check rows/001-first/slow failed: killed after 2 s",
  );
  is("(b) …and with no timeout program the child is killed too", String(alive()), "false");
  is("(b) …within the limit, not when the child ends", String(Date.now() - t0 < 25_000), "true");
  rmSync(`${liveStub()}.hang`);
  rmSync(`${liveStub()}.pid`, { force: true });
  write(join(F.CODE, "dirt.txt"), "left in the shared checkout\n");
  r = liveLand(["--release"]);
  is("(b) with every check passing it releases — the relative command ran in the declaring repo", r.rc, "0");
  has("(b) …the command saw the landed tree, not the shared checkout", r.out, "- rows/001-first/fresh — ");
  has(
    "(b) …listing it",
    r.out,
    `- rows/001-first/rel — \`test -f ./.agents/skills/close/scripts/land.ts\` passed on ${T} at`,
  );

  // (c) A malformed block is refused before the push; an empty one owes
  // nothing; an interrupted push leaves its obligations for the re-run.
  fixture("c27c");
  seedRows(
    "| R1 | first | — | in-progress | `specs/001-first/` |",
    "| R2 | second | — | planned | `specs/002-second/` |",
  );
  finishSpec("001-first", liveBlock("home | workbench | command"));
  r = liveLand(["ship R1"]);
  is("(c) a malformed block is refused", r.rc, "3");
  has(
    "(c) …naming the file and line",
    r.out,
    `NOT CLOSED: the live-checks block in ${RMP}/specs/001-first/tasks.md is malformed — line 4: 3 field(s)`,
  );
  is("(c) …before the push", onMain(F.CODE, `${RMP}/specs/001-first/report.md`), "no");
  finishSpec("001-first", liveBlock("w | repo:acme/elsewhere | command | true"));
  r = liveLand(["ship R1"]);
  is("(c) a check on a repo no ledger checkout is refused", r.rc, "3");
  has(
    "(c) …before the push, naming the repo",
    r.out,
    "owes a live check on repo:acme/elsewhere, which builds from acme/elsewhere — this thread lands nothing there",
  );
  finishSpec("001-first", "# Tasks\n\n```live-checks\n```\n");
  r = liveLand(["ship R1"]);
  is("(c) an empty block owes nothing and closes", r.rc, "0");
  has(
    "(c) …with a warning naming the spec",
    r.out,
    `live-checks: ${RMP}/specs/001-first/tasks.md:3: an empty live-checks block`,
  );
  hasnt("(c) …and no hold", r.out, "HELD:");

  finishSpec("002-second", liveBlock("ping | workbench | command | true"));
  r = liveLand(["ship R2"], { LAND_TEST_KILL_AT: "pushed:1" });
  isnt("(c) a close killed after its push does not finish", r.rc, "0");
  is("(c) …and its owed check is on disk", owedKeys(), "rows/002-second/ping");
  r = liveLand(["ship R2"], { LAND_TEST_KILL_AT: "landings-done:1" });
  isnt("(c) a close killed after its deploy, before it holds, does not finish", r.rc, "0");
  r = liveLand(["--check"]);
  is("(c) …and a --check after it is NOT CLOSED", r.rc, "3");
  has(
    "(c) …saying the landing must run again",
    r.out,
    "live checks are owed but the landing that owes them did not finish",
  );
  hasnt("(c) …never printing the proof line", r.out, "loses nothing");
  is("(c) …and --gate lets the close run again", land(1, ["--gate"]).out, "not-fired");
  r = liveLand(["ship R2"]);
  is("(c) the re-run holds on it", r.rc, "4");
  has("(c) …listing it", r.out, "owed: rows/002-second/ping");
  deployed(originTip("code"));
  is("(c) …and releases once it passes", liveLand(["--release"]).rc, "0");

  // (d) A push that edits a report already `complete` on the trunk does not
  // write it complete, so it owes none of that spec's checks: they were owed,
  // and proved, by the close that finished it. One that turns a `partial`
  // report `complete` still owes them — otherwise a typo fix in a finished
  // report is refused for checks on a repo it never touched.
  fixture("c27d");
  seedRows("| R1 | first | — | done | `specs/001-first/` |", "| R2 | second | — | in-progress | `specs/002-second/` |");
  write(join(F.CODE, RMP, "specs/001-first/tasks.md"), liveBlock("home | repo:acme/elsewhere | command | true"));
  // Finished in spec-state.ts's own words, not only `complete`.
  write(join(F.CODE, RMP, "specs/001-first/report.md"), '---\nspec: x\nspec-status: "Shipped"\n---\n');
  write(join(F.CODE, RMP, "specs/002-second/tasks.md"), liveBlock("ping | workbench | command | true"));
  write(join(F.CODE, RMP, "specs/002-second/report.md"), "---\nspec: x\nspec-status: partial\n---\n");
  commitOnTrunk("R1 finished, R2 part-built");
  gDo(F.WT1, "fetch", "-q", "origin");
  gDo(F.WT1, "reset", "-q", "--hard", "origin/main");
  write(
    join(F.WT1, RMP, "specs/001-first/report.md"),
    '---\nspec: x\nspec-status: "Shipped"\n---\n\nA repaired paragraph.\n',
  );
  r = liveLand(["repair R1's report"]);
  is("(d) editing a report already complete on the trunk owes nothing and closes", r.rc, "0");
  hasnt("(d) …naming none of its checks", r.out, "001-first/home");
  hasnt("(d) …and no hold", r.out, "HELD:");
  is("(d) …with nothing on disk owed", owedKeys(), "none");
  write(
    join(F.WT1, RMP, "specs/001-first/tasks.md"),
    liveBlock("home | repo:acme/elsewhere | command | true", "broken | workbench | command"),
  );
  r = liveLand(["break R1's block"]);
  is("(d) a malformed line added to a finished spec's block is refused", r.rc, "3");
  has("(d) …naming the line", r.out, `the live-checks block in ${RMP}/specs/001-first/tasks.md is malformed`);
  write(join(F.WT1, RMP, "specs/001-first/tasks.md"), liveBlock("home | repo:acme/elsewhere | command | true"));
  // A folder with no spec.md is not a spec (spec-state.ts), so its block owes nothing.
  write(join(F.WT1, RMP, "specs/003-loose/tasks.md"), liveBlock("loose | workbench | command | false"));
  write(join(F.WT1, RMP, "specs/003-loose/report.md"), complete());
  r = liveLand(["a report-only folder"]);
  is("(d) a report-only folder's block owes nothing", r.rc, "0");
  hasnt("(d) …and is not listed", r.out, "003-loose/loose");
  write(join(F.WT1, RMP, "specs/002-second/report.md"), complete());
  r = liveLand(["finish R2"]);
  is("(d) turning a partial report complete still owes its checks", r.rc, "4");
  has("(d) …listing them", r.out, "owed: rows/002-second/ping");
  // Held, the trunk already holds R2's complete report from this close's own
  // push; a corrected check must still replace the one it owes.
  write(join(F.WT1, RMP, "specs/002-second/tasks.md"), liveBlock("ping | workbench | command | false"));
  r = liveLand(["fix R2's check", "--hold"]);
  is("(d) a held re-landing that corrects an owed check holds again", r.rc, "4");
  is(
    "(d) …owing the corrected command, not the old one",
    (JSON.parse(cat(threadFile(TID1, "live-owed"))) as { key: string; body: string }[]).find(
      (o) => o.key === "rows/002-second/ping",
    )?.body ?? "none",
    "false",
  );
  // Emptied, then restored: the restored check is owed again.
  write(join(F.WT1, RMP, "specs/002-second/tasks.md"), "# Tasks\n\n```live-checks\n```\n");
  liveLand(["drop R2's check", "--hold"]);
  is("(d) a held re-landing that empties the block owes nothing for it", owedKeys(), "");
  write(join(F.WT1, RMP, "specs/002-second/tasks.md"), liveBlock("ping | workbench | command | false"));
  liveLand(["restore R2's check", "--hold"]);
  is("(d) …and one that restores it owes it again", owedKeys(), "rows/002-second/ping");
  // An obligation the declaration no longer says (left by a push that failed
  // after recording it) is put back in step with the block on the next landing.
  const owedFile = threadFile(TID1, "live-owed");
  const stale = (JSON.parse(cat(owedFile)) as { key: string; body: string }[]).map((o) =>
    o.key === "rows/002-second/ping" ? { ...o, body: "exit 9" } : o,
  );
  write(owedFile, JSON.stringify(stale));
  write(join(F.WT1, "note.txt"), "an unrelated change\n");
  liveLand(["an unrelated change", "--hold"]);
  is(
    "(d) a stale owed check is replaced by what the block declares",
    (JSON.parse(cat(owedFile)) as { key: string; body: string }[]).find((o) => o.key === "rows/002-second/ping")
      ?.body ?? "none",
    "false",
  );
  // An obligation for a spec that is no longer there at all is cleared.
  write(
    owedFile,
    JSON.stringify([
      ...(JSON.parse(cat(owedFile)) as object[]),
      { ...(JSON.parse(cat(owedFile)) as object[])[0], key: "rows/004-gone/x", spec: `${RMP}/specs/004-gone`, id: "x" },
    ]),
  );
  write(join(F.WT1, "note.txt"), "another unrelated change\n");
  liveLand(["another unrelated change", "--hold"]);
  is("(d) an owed check whose spec is gone is cleared", owedKeys(), "rows/002-second/ping");
});
