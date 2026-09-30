// write-root.test.ts — every boundary the resolver has.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/write-root.test.ts
//
// write-root.sh STAYS BASH (it runs `git worktree add`, and it sources
// harness.sh and lock.sh), so this suite spawns it with `bash`. What it execs —
// thread.ts and trunk.ts — is TypeScript, run through `node`, and the last case
// proves it: a planted copy whose `thread.ts`/`trunk.ts` are poisoned still
// resolves.
//
// Fixtures are real git repos with real bare origins under a temp dir, plus a
// fixture state.sqlite and a throwaway HOME. Nothing here can reach the real
// cache, the real checkouts or the real T3 database. Every child's environment
// is built from nothing, so no harness session variable (CONTEXTIUM_SESSION,
// CLAUDE_CODE_SESSION_ID, CONTEXTIUM_HARNESS, …) leaks in from the shell running
// the suite. The cases run in order and share the fixtures, as the bash suite's did.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "write-root.sh");
const TMP = mkdtempSync(join(tmpdir(), "write-root-test-"));
const PID = process.pid;

after(() => {
  // The fixture checkouts own worktrees under the throwaway HOME; removing the
  // tree is enough, but prune first so no `.git/worktrees` entry outlives it.
  const checkouts = join(TMP, "checkouts");
  if (existsSync(checkouts)) {
    for (const wt of readdirSync(checkouts)) spawnSync("git", ["-C", join(checkouts, wt), "worktree", "prune"]);
  }
  rmSync(TMP, { recursive: true, force: true });
  for (const f of readdirSync("/tmp")) {
    if (f.startsWith(`wrt-${PID}-`) && f.endsWith("-git.lock")) rmSync(join("/tmp", f), { force: true });
  }
});

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.replace(/\n+$/, "");
}

const FAKE_HOME = join(TMP, "home");
const T3 = join(TMP, "t3");
for (const d of [FAKE_HOME, join(T3, "userdata"), join(TMP, "origins"), join(TMP, "checkouts")]) {
  mkdirSync(d, { recursive: true });
}

const TID = "cccccccc-1111-2222-3333-555555555555";
const LEDGER = join(FAKE_HOME, ".cache/workbench/threads", TID, "worktrees");

// A repo with a bare origin and one commit on main. The basename is prefixed
// with the pid so the /tmp lock the script takes cannot collide with a
// concurrent run of this same suite.
// The second argument is the TRUNK BRANCH and defaults to `main`. It is a
// parameter rather than a constant because a repo on `master` is the case the
// resolver exists for, and a fixture factory that can only build `main` cannot
// test it.
function mkrepo(tag: string, branch = "main"): string {
  const name = `wrt-${PID}-${tag}`;
  const bare = join(TMP, "origins", `${name}.git`);
  const wt = join(TMP, "checkouts", name);
  git("init", "-q", "--bare", "-b", branch, bare);
  git("init", "-q", "-b", branch, wt);
  git("-C", wt, "config", "user.email", "t@example.com");
  git("-C", wt, "config", "user.name", "tester");
  writeFileSync(join(wt, "seed.txt"), "seed\n");
  git("-C", wt, "add", "seed.txt");
  git("-C", wt, "commit", "-q", "-m", "seed");
  git("-C", wt, "remote", "add", "origin", bare);
  git("-C", wt, "push", "-q", "-u", "origin", branch);
  return wt;
}

const CODE = mkrepo("code");
const LIB = mkrepo("lib");

// The thread's T3 worktree: a LINKED worktree of CODE, on a branch named the way
// T3 names them. The `session/` prefix this script uses for satellites is not
// what T3 picks, and a resolver that assumed one would register the wrong branch.
const T3_WT = join(TMP, "t3-worktrees/thread-one");
mkdirSync(dirname(T3_WT), { recursive: true });
git("-C", CODE, "worktree", "add", "-q", "-b", "t3code/some-title", T3_WT, "main");

spawnSync(
  process.execPath,
  [
    "--experimental-sqlite",
    "--disable-warning=ExperimentalWarning",
    "-e",
    `
const { DatabaseSync } = require("node:sqlite");
const [dbPath, tid, wt] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(\`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)\`);
db.prepare(\`insert into projection_threads values (?,?,?,?,?,?,?,?)\`)
  .run(tid, "p", "T", "t3code/some-title", wt, "2026-09-14T03:15:51.803Z", "x", null);
`,
    join(T3, "userdata/state.sqlite"),
    TID,
    T3_WT,
  ],
  { stdio: "inherit" },
);

const E: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: FAKE_HOME, T3CODE_HOME: T3 };

interface Run {
  rc: number | null;
  out: string; // stdout+stderr, trailing newlines dropped (as `$(… 2>&1)` reads it)
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], env: Record<string, string> = E, script = SCRIPT): Run {
  const r = spawnSync("bash", [script, ...args], { encoding: "utf8", cwd, env, timeout: 180_000 });
  return {
    rc: r.status,
    out: `${r.stdout}${r.stderr}`.replace(/\n+$/, ""),
    stdout: r.stdout.replace(/\n+$/, ""),
    stderr: r.stderr.replace(/\n+$/, ""),
  };
}

const ledgerText = (): string => (existsSync(LEDGER) ? readFileSync(LEDGER, "utf8") : "");
const ledgerRows = (): string[][] =>
  ledgerText()
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => l.split("\t"));

// ── --main creates nothing and names the shared checkout ───────────────────

test("--main . names the shared checkout, not the worktree; creates nothing", () => {
  assert.equal(run(T3_WT, ["--main", "."]).out, CODE, "--main . names the shared checkout, not the worktree");
  assert.ok(!existsSync(join(FAKE_HOME, ".cache/workbench/worktrees")), "--main created something under the cache");
});

test("--main <path> names another repo's shared checkout", () => {
  assert.equal(run(T3_WT, ["--main", LIB]).out, LIB);
});

// ── The thread's own repo answers with the T3 worktree ─────────────────────

test("the thread's own repo resolves to its T3 worktree", () => {
  assert.equal(run(T3_WT, ["."]).out, T3_WT);
});

// ── … and registering it is what the first call also does ──────────────────

test("the T3 worktree is registered with its shared checkout and T3's branch", () => {
  const reg = ledgerRows()
    .filter((f) => f[0] === T3_WT)
    .map((f) => `${f[1]}|${f[2]}`)
    .join("\n");
  assert.equal(reg, `${CODE}|t3code/some-title`);
});

// ── A second repo gets a satellite ─────────────────────────────────────────

let LIBSAT = "";
test("a second repo gets a worktree of its own", () => {
  const r = run(T3_WT, [LIB]);
  LIBSAT = r.out;
  assert.ok(r.rc === 0 && existsSync(LIBSAT), `second-repo satellite not created (rc=${r.rc}): ${r.out}`);
  assert.ok(
    LIBSAT.includes(`/.cache/workbench/worktrees/wrt-${PID}-lib-`),
    "the satellite is keyed by basename and path hash",
  );
  assert.ok(LIBSAT.includes(`/${TID}`), "the satellite is named for the thread");
  assert.equal(
    git("-C", LIBSAT, "rev-parse", "--abbrev-ref", "HEAD"),
    `session/${TID}`,
    "the satellite is on the thread's branch",
  );
});

// ── A second call creates nothing and appends nothing ──────────────────────

test("a second call prints the same path and appends no ledger line", () => {
  const before = ledgerRows().length;
  assert.equal(run(T3_WT, [LIB]).out, LIBSAT, "a second call prints the same path");
  assert.equal(ledgerRows().length, before, "a second call appends no ledger line");
});

// ── Two spellings of one repo are one repo ─────────────────────────────────

test("'.' inside a satellite resolves back to the same satellite", () => {
  assert.equal(run(LIBSAT, ["."]).out, LIBSAT);
});

// A subdirectory of a worktree is still that worktree — `--show-toplevel` is
// what makes the resolver work from wherever a skill script happens to stand.
test("a subdirectory resolves to its worktree", () => {
  mkdirSync(join(LIBSAT, "sub/deeper"), { recursive: true });
  mkdirSync(join(T3_WT, "sub/deeper"), { recursive: true });
  assert.equal(
    run(join(LIBSAT, "sub/deeper"), ["."]).out,
    LIBSAT,
    "a subdirectory of a satellite resolves to the satellite",
  );
  assert.equal(
    run(join(T3_WT, "sub/deeper"), ["."]).out,
    T3_WT,
    "a subdirectory of the T3 worktree resolves to the T3 worktree",
  );
});

// Standing in the SHARED checkout is in no T3 thread, and two threads can both
// hold satellites of it, so nothing is inferred from them: it is a session of
// its own (thread.ts), with a worktree of its own.
test("standing in a shared checkout is a session of its own", () => {
  mkdirSync(join(LIB, "sub/deeper"), { recursive: true });
  const r = run(join(LIB, "sub/deeper"), ["."]);
  assert.equal(r.rc, 0, `standing in a shared checkout is a session of its own: ${r.out}`);
  assert.ok(r.out !== LIBSAT && r.out !== T3_WT, `shared checkout inherited a thread's worktree: ${r.out}`);
});

// ── Two repos with the same basename do not collide ────────────────────────

const DUP = join(TMP, "elsewhere", basename(LIB));
let DUPSAT = "";
test("same basename, different path, different worktree", () => {
  mkdirSync(join(TMP, "elsewhere"), { recursive: true });
  git("init", "-q", "-b", "main", DUP);
  git("-C", DUP, "config", "user.email", "t@example.com");
  git("-C", DUP, "config", "user.name", "tester");
  writeFileSync(join(DUP, "seed.txt"), "other\n");
  git("-C", DUP, "add", "seed.txt");
  git("-C", DUP, "commit", "-q", "-m", "seed");
  git("-C", DUP, "remote", "add", "origin", join(TMP, "origins", `wrt-${PID}-lib.git`));
  git("-C", DUP, "fetch", "-q", "origin", "main");
  const r = run(T3_WT, [DUP]);
  assert.notEqual(r.out, LIBSAT, "same-basename repos collided on one worktree");
  DUPSAT = r.out;
});

// ── Concurrency: two first calls, one worktree ─────────────────────────────

function runAsync(cwd: string, args: string[]): Promise<{ rc: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn("bash", [SCRIPT, ...args], { cwd, env: E });
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      out += b.toString();
    });
    child.on("close", (rc) => done({ rc, out: out.replace(/\n+$/, "") }));
  });
}

test("two concurrent first calls agree on one path", async () => {
  const CONC = mkrepo("conc");
  const [c1, c2] = await Promise.all([runAsync(T3_WT, [CONC]), runAsync(T3_WT, [CONC])]);
  assert.ok(
    c1.rc === 0 && c2.rc === 0 && c1.out === c2.out,
    `concurrent calls disagreed: rc=${c1.rc}/${c2.rc} '${c1.out}' vs '${c2.out}'`,
  );
  assert.equal(ledgerRows().filter((f) => f[1] === CONC).length, 1, "and left exactly one ledger line for it");
  const root = join(FAKE_HOME, ".cache/workbench/worktrees");
  const dirs = readdirSync(root).filter((k) => k.includes("conc") && existsSync(join(root, k, TID)));
  assert.equal(dirs.length, 1, "and exactly one worktree directory");
});

// ── Reclaim: the directory is gone, the branch and its commits are not ─────

test("a crashed close's worktree is recreated with its unlanded commit", () => {
  writeFileSync(join(DUPSAT, "unlanded.txt"), "work\n");
  git("-C", DUPSAT, "config", "user.email", "t@example.com");
  git("-C", DUPSAT, "config", "user.name", "tester");
  git("-C", DUPSAT, "add", "unlanded.txt");
  git("-C", DUPSAT, "commit", "-q", "-m", "work a crashed close never landed");
  const LOST_SHA = git("-C", DUPSAT, "rev-parse", "HEAD");
  rmSync(DUPSAT, { recursive: true, force: true });
  git("-C", DUP, "worktree", "prune");

  const r = run(T3_WT, [DUP]);
  assert.equal(r.stdout, DUPSAT, "a crashed close's worktree is recreated at the same path");
  assert.ok(r.stderr.includes(`reclaimed existing branch session/${TID}`), "and the reclaim is announced on stderr");
  assert.equal(git("-C", DUPSAT, "rev-parse", "HEAD"), LOST_SHA, "and its unlanded commit is still there");

  assert.equal(run(T3_WT, [DUP]).stderr, "", "a reclaim that is now a plain hit is silent");
});

// ── A repo with no TRUNK cannot be landed, so it is refused ────────────────

test("a repo with no trunk branch exits 2", () => {
  const NOREMOTE = join(TMP, "no-remote");
  git("init", "-q", "-b", "main", NOREMOTE);
  git("-C", NOREMOTE, "config", "user.email", "t@example.com");
  git("-C", NOREMOTE, "config", "user.name", "tester");
  writeFileSync(join(NOREMOTE, "f"), "x\n");
  git("-C", NOREMOTE, "add", "f");
  git("-C", NOREMOTE, "commit", "-q", "-m", "seed");
  const r = run(T3_WT, [NOREMOTE]);
  assert.equal(r.rc, 2, "a repo with no trunk branch exits 2");
  assert.ok(r.out.includes(`no trunk branch in ${NOREMOTE}`), `and names the repo: '${r.out}'`);
  // It refuses because it could not FIND a trunk, not because the trunk was not
  // called `main`. That wording was the bug this guards: a script that spells the
  // trunk `main` turns away every repo whose trunk is `master`.
  assert.ok(r.out.includes("origin/HEAD unset"), `and names the real condition: '${r.out}'`);
});

// ── A repo whose trunk is `master` gets a worktree like any other ─────────
// The reason `trunk.ts` exists. A repo whose trunk is `master` was once refused
// outright, so a session that had to write there built a worktree by hand that
// no close could land and no ledger recorded.
test("a master-trunk repo gets a satellite", () => {
  const MASTERREPO = mkrepo("master-trunk", "master");
  const r = run(T3_WT, [MASTERREPO]);
  assert.equal(r.rc, 0, "a master-trunk repo gets a satellite");
  assert.ok(existsSync(r.out), "and the satellite is a real directory");
  // Branched from the repo's OWN trunk, not from a `main` that does not exist.
  assert.equal(
    git("-C", r.out, "rev-parse", "HEAD"),
    git("-C", MASTERREPO, "rev-parse", "origin/master"),
    "branched from origin/master",
  );
  // And it is in the ledger, which is the half that was missing when it was done
  // by hand: land.ts walks the ledger, so a repo absent from it is landed by nobody.
  assert.ok(ledgerText().includes(MASTERREPO), "and is recorded in the ledger");
});

// ── Bad arguments ──────────────────────────────────────────────────────────

test("a relative path is refused", () => {
  const r = run(T3_WT, ["relative/path"]);
  assert.equal(r.rc, 2, "a relative path is refused");
  assert.ok(r.out.includes("want '.' or an absolute path"), "with the two spellings named");
});

// A bare word names no repo: a caller saying one must be told, not routed
// somewhere by a guess.
test("a bare word is refused", () => {
  const r = run(T3_WT, ["library"]);
  assert.equal(r.rc, 2, "a bare word is refused");
  assert.ok(r.out.includes("not a repo I know: 'library'"), "…as a repo it does not know");
});

test("a directory that is not a git repo is refused", () => {
  const r = run(T3_WT, [join(TMP, "origins")]);
  assert.equal(r.rc, 2, "a directory that is not a git repo is refused");
  assert.ok(r.out.includes("not a git repo"), "and says so");
});

test("a path that does not exist is refused", () => {
  const r = run(T3_WT, [join(TMP, "does-not-exist")]);
  assert.equal(r.rc, 2, "a path that does not exist is refused");
  assert.ok(r.out.includes("no such directory"), "and says so");
});

// ── Outside T3: the harness's session, or a generated one ─────────────────

const NO_T3: Record<string, string> = { PATH: E.PATH ?? "", HOME: FAKE_HOME, T3CODE_HOME: join(TMP, "nowhere") };

test("outside T3 with no session id, the resolver still answers", () => {
  const r = run(LIB, [LIB], NO_T3);
  assert.equal(r.rc, 0, `outside T3 with no session id: ${r.out}`);
  assert.ok(
    r.stdout.startsWith(join(FAKE_HOME, ".cache/workbench/worktrees/")),
    `…with a worktree under ~/.cache/workbench for a generated session: '${r.stdout}'`,
  );
  assert.match(git("-C", r.stdout, "rev-parse", "--abbrev-ref", "HEAD"), /^session\/session-/, "…on a session/ branch");
  assert.equal(run(LIB, [LIB], NO_T3).stdout, r.stdout, "…and the same worktree on the next call");
});

test("a recorded harness puts the worktree where that harness keeps them", () => {
  const r = run(LIB, [LIB], { ...NO_T3, CONTEXTIUM_SESSION: "cc-9", CONTEXTIUM_HARNESS: "claude" });
  assert.equal(r.stdout, join(LIB, ".claude/worktrees/cc-9"), `claude harness root: ${r.out}`);
  assert.equal(git("-C", r.stdout, "rev-parse", "--abbrev-ref", "HEAD"), "worktree-cc-9", "…on that harness's branch name");
});

// Codex keeps every repo's worktrees under one CODEX_HOME. One session writing
// two repos must get a worktree of EACH: keyed on the session alone, the second
// repo's call found the first one's folder and handed it back, and the edits
// meant for the second repo went into the first.
test("a harness root shared by every repo still gives each repo its own worktree", () => {
  const env = { ...NO_T3, CONTEXTIUM_SESSION: "cx-1", CONTEXTIUM_HARNESS: "codex", CODEX_HOME: join(TMP, "codex") };
  const lib = run(LIB, [LIB], env);
  assert.equal(lib.rc, 0, `codex, first repo: ${lib.out}`);
  const code = run(LIB, [CODE], env);
  assert.equal(code.rc, 0, `codex, second repo: ${code.out}`);
  assert.notEqual(code.stdout, lib.stdout, "the second repo was handed the first repo's worktree");
  assert.ok(code.stdout.startsWith(join(TMP, "codex/worktrees/")), `…still under CODEX_HOME: ${code.stdout}`);
  const common = (wt: string): string => git("-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
  assert.equal(common(code.stdout), common(CODE), "…and it is a worktree of the repo that was asked for");
});

// Grok keeps every repo's worktrees under ~/.grok, keyed per checkout (name
// plus path hash), so two checkouts both called `lib` get a folder each. A
// folder already at the target that is not a worktree of the repo asked for —
// made by hand, or by a layout that keyed coarser — is refused, never handed
// back as that repo's worktree.
test("grok: two checkouts called lib get a worktree each", () => {
  const env = { ...NO_T3, CONTEXTIUM_SESSION: "gk-1", CONTEXTIUM_HARNESS: "grok" };
  const lib = run(LIB, [LIB], env);
  assert.equal(lib.rc, 0, `grok, first repo: ${lib.out}`);
  const dup = run(DUP, [DUP], env);
  assert.equal(dup.rc, 0, `grok, same-basename repo: ${dup.out}`);
  assert.notEqual(dup.stdout, lib.stdout, "the same-basename repo was handed the first repo's worktree");
  assert.ok(dup.stdout.startsWith(join(FAKE_HOME, ".grok/worktrees/")), `…still under ~/.grok: ${dup.stdout}`);
  const common = (wt: string): string => git("-C", wt, "rev-parse", "--path-format=absolute", "--git-common-dir");
  assert.equal(common(dup.stdout), common(DUP), "…and it is a worktree of the repo that was asked for");
});

test("a target folder that belongs to another repo is refused", () => {
  const env = { ...NO_T3, CONTEXTIUM_SESSION: "gk-2", CONTEXTIUM_HARNESS: "grok" };
  const lib = run(LIB, [LIB], env);
  assert.equal(lib.rc, 0, `grok, first repo: ${lib.out}`);
  // Plant a worktree of LIB exactly where DUP's would go.
  const root = spawnSync("bash", ["-c", 'source "$0"; harness_worktree_root "$1"', join(HERE, "harness.sh"), DUP], {
    encoding: "utf8",
    env: { ...E, CONTEXTIUM_HARNESS: "grok" },
  }).stdout.trim();
  const target = join(root, basename(lib.stdout));
  git("-C", LIB, "worktree", "add", "-q", "-b", "foreign-gk-2", target, "main");
  const dup = run(DUP, [DUP], env);
  assert.equal(dup.rc, 2, `a repo was handed another repo's worktree: ${dup.stdout}`);
  assert.match(dup.out, /is not a worktree of/, "…and the refusal says why");
});

// ── The override is what makes a plain terminal usable ─────────────────────

test("WORKBENCH_THREAD_ID reaches the same satellite from a plain shell", () => {
  assert.equal(run(LIB, [LIB], { ...E, WORKBENCH_THREAD_ID: TID }).out, LIBSAT);
});

// ── A warning on thread.ts's stderr is not part of the id ──────────────────
// Node 22.x prints an ExperimentalWarning for type stripping on stderr. Read as
// `$(… --id 2>&1)` it became the head of the id, and the resolver built a
// ledger for a thread named `(node:111) ExperimentalWarning…`. The stand-in
// `node` warns on every run, as such a Node does.
test("a Node warning on stderr does not become part of the thread id", () => {
  const bin = join(TMP, "warn-bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "node"),
    `#!/usr/bin/env bash\necho "(node:111) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time" >&2\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  const r = run(LIB, [LIB], { ...E, PATH: `${bin}:${E.PATH ?? ""}`, WORKBENCH_THREAD_ID: TID });
  assert.equal(r.rc, 0, `failed: ${r.out}`);
  assert.equal(r.stdout, LIBSAT, "the same satellite, found through the same ledger");
  // The failure path keeps thread.ts's own message, minus its `thread: ` prefix.
  // Outside T3 every git tree is a session, so the failure is a shell standing
  // in no git tree at all.
  const bad = run(TMP, [LIB], { PATH: `${bin}:${E.PATH ?? ""}`, HOME: FAKE_HOME, T3CODE_HOME: join(TMP, "nowhere") });
  assert.equal(bad.rc, 2, "outside a thread it still exits 2");
  assert.match(bad.stderr, /^write-root: not in a thread: /m, `the error is thread.ts's: '${bad.stderr}'`);
  assert.doesNotMatch(bad.stderr, /write-root: thread: /, "…without thread.ts's own prefix");
});

// ── The callees are TypeScript, run through node, never bash or source ─────
// write-root.sh stays bash, but thread and trunk are TypeScript, and a
// resolver that still ran `bash thread.sh` would die once the .sh is deleted —
// or, sourcing a .ts, die on its first line. A planted copy of the script sits
// beside the real thread.ts and trunk.ts and beside a `thread.ts` and a
// `trunk.ts` that refuse loudly; it must still register the T3 worktree
// (thread.ts --worktree/--branch) and build a satellite (thread.ts --id,
// trunk.ts) — which it can only do if it ran the .ts files through node.
test("thread.ts and trunk.ts are run through node, never the .sh", () => {
  const root = join(TMP, "planted");
  const dir = join(root, ".agents/skills/close/scripts");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(root, ".agents/packages/cli-exit"), { recursive: true });
  for (const f of ["write-root.sh", "harness.sh", "lock.sh", "thread.ts", "trunk.ts"]) copyFileSync(join(HERE, f), join(dir, f));
  copyFileSync(join(HERE, "../../../packages/cli-exit/cli-exit.ts"), join(root, ".agents/packages/cli-exit/cli-exit.ts"));
  const trap = join(TMP, "sh-ran");
  for (const stem of ["thread", "trunk"]) {
    writeFileSync(
      join(dir, `${stem}.sh`),
      `echo ${stem}.sh >>'${trap}'\necho "${stem}: poisoned ${stem}.sh ran" >&2\nexit 2\n`,
    );
  }
  const home = join(TMP, "planted-home");
  mkdirSync(home, { recursive: true });
  const repo = mkrepo("planted-sat");
  const r = run(T3_WT, [repo], { ...E, HOME: home }, join(dir, "write-root.sh"));
  const ran = existsSync(trap) ? readFileSync(trap, "utf8").trim().split("\n").join(", ") : "";
  assert.equal(ran, "", `write-root.sh executed ${ran} instead of the .ts`);
  assert.equal(r.rc, 0, `planted write-root.sh failed: ${r.out}`);
  assert.ok(r.stdout.startsWith(join(home, ".cache/workbench/worktrees/")), `no satellite: ${r.out}`);
  const planted = readFileSync(join(home, ".cache/workbench/threads", TID, "worktrees"), "utf8");
  assert.ok(planted.includes(`${T3_WT}\t${CODE}\tt3code/some-title\n`), "the T3 worktree was registered via thread.ts");
  // Never sourced: bash cannot read TypeScript, and a `source x.ts` would only
  // fail at run time on the line that reached it.
  const text = readFileSync(SCRIPT, "utf8");
  assert.ok(!/^\s*(source|\.)\s+\S*\.ts/m.test(text), "write-root.sh sources a .ts file");
});

// ── A thread.ts that dies without its own `thread: ` line ──────────────────
// A Node start-up or import error prints no `thread: ` line. Under pipefail the
// grep that looks for one would exit the script before the fallback, leaving a
// bare exit 1 with no message; the fallback reports the last stderr line.
test("a thread.ts crash with no thread: line still exits 2 with its last line", () => {
  const root = join(TMP, "crashing");
  const dir = join(root, ".agents/skills/close/scripts");
  mkdirSync(dir, { recursive: true });
  for (const f of ["write-root.sh", "harness.sh", "lock.sh", "trunk.ts"]) copyFileSync(join(HERE, f), join(dir, f));
  writeFileSync(join(dir, "thread.ts"), 'process.stderr.write("a start-up failure\\n");\nprocess.exitCode = 1;\n');
  const r = run(
    T3_WT,
    [mkrepo("crashing-sat")],
    { ...E, HOME: join(TMP, "crashing-home") },
    join(dir, "write-root.sh"),
  );
  assert.equal(r.rc, 2, `the resolver exits 2, not a bare 1: ${r.out}`);
  assert.match(r.stderr, /^write-root: a start-up failure$/m, `and names the failure: '${r.stderr}'`);
});

// ── --existing answers only what the thread already has ────────────────────

let ADOPT = "";
test("--existing names the thread's own worktree, and creates nothing for another repo", () => {
  assert.equal(run(T3_WT, ["--existing", "."]).out, T3_WT, "--existing names the thread's own worktree of its repo");
  ADOPT = mkrepo("adopt");
  const r = run(T3_WT, ["--existing", ADOPT]);
  assert.equal(r.rc, 1, "--existing with no worktree of that repo exits 1");
  assert.equal(r.out, "", "…printing nothing");
  assert.ok(!ledgerText().includes(ADOPT), "--existing recorded something");
});

// ── --adopt records a worktree something else made ─────────────────────────

test("--adopt records a named worktree, and every later call answers it", () => {
  const NAMED = join(TMP, "named/my-slug");
  mkdirSync(dirname(NAMED), { recursive: true });
  git("-C", ADOPT, "worktree", "add", "-q", "-b", "worktree-my-slug", NAMED, "main");
  assert.equal(run(T3_WT, ["--adopt", NAMED]).out, NAMED, "--adopt prints the worktree");
  assert.equal(
    ledgerRows()
      .filter((f) => f[0] === NAMED)
      .map((f) => `${f[1]}|${f[2]}`)
      .join("\n"),
    `${ADOPT}|worktree-my-slug`,
    "…and records it with its repo and branch",
  );
  assert.equal(run(T3_WT, [ADOPT]).out, NAMED, "the default mode then answers the adopted worktree, making no satellite");
  assert.equal(run(T3_WT, ["--existing", ADOPT]).out, NAMED, "…and so does --existing");
  const again = run(T3_WT, ["--adopt", NAMED]);
  assert.equal(`${again.rc}|${ledgerRows().filter((f) => f[0] === NAMED).length}`, "0|1", "adopting it again is a no-op");

  const OTHER = join(TMP, "named/other");
  git("-C", ADOPT, "worktree", "add", "-q", "-b", "worktree-other", OTHER, "main");
  const second = run(T3_WT, ["--adopt", OTHER]);
  assert.equal(second.rc, 2, "a second worktree of the same repo is refused");
  assert.ok(second.out.includes(`already has ${NAMED}`), `…naming the one the thread already has: '${second.out}'`);
  const shared = run(T3_WT, ["--adopt", ADOPT]);
  assert.equal(shared.rc, 2, "the shared checkout itself cannot be adopted");
  assert.ok(shared.out.includes("is the shared checkout"), `…and says so: '${shared.out}'`);
});
