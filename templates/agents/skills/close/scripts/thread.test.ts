// thread.test.ts — every resolution path and every refusal in thread.ts.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/thread.test.ts
//
// Each case builds a throwaway HOME, a fixture `state.sqlite` with the
// columns thread.ts reads, and fake git worktrees to stand in. T3CODE_HOME
// points at the fixture, so nothing here can reach the real database, and the
// ledger lives under the throwaway HOME, so nothing here can reach the real
// cache.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "thread.ts");
const TMP = mkdtempSync(join(tmpdir(), "thread-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function sh(cmd: string, args: string[], cwd?: string): void {
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr}`);
}

/** Run thread.ts in `cwd` with exactly `env` (plus PATH), stdout and stderr merged as `2>&1` reads them.
 * No harness session variable reaches it: the child env is built from nothing. */
function run(cwd: string, env: Record<string, string>, args: string[] = []): { code: number | null; out: string } {
  // --no-warnings: Node 22.6–22.17 warn that type stripping is experimental,
  // and that line is this process's, not thread.ts's answer.
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function expect(name: string, wantCode: number, wantOut: string, got: { code: number | null; out: string }): void {
  assert.equal(got.code, wantCode, `${name}: exit ${got.code}, wanted ${wantCode} — ${got.out}`);
  assert.ok(got.out.includes(wantOut), `${name}: output '${got.out}' lacks '${wantOut}'`);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const FAKE_HOME = join(TMP, "home");
const T3 = join(TMP, "t3");
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(join(T3, "userdata"), { recursive: true });

// Two fake T3 worktrees, both real git repos so `rev-parse --show-toplevel`
// answers. The second exists to prove a row is matched on its OWN path.
const WT_A = join(TMP, "wt-a");
const WT_B = join(TMP, "wt-b");
const NOT_A_THREAD = join(TMP, "plain-repo");
for (const d of [WT_A, WT_B, NOT_A_THREAD]) {
  mkdirSync(d, { recursive: true });
  sh("git", ["-C", d, "init", "-q"]);
}

const TID_A = "aaaaaaaa-1111-2222-3333-444444444444";
const TID_B = "bbbbbbbb-1111-2222-3333-444444444444";

sh(process.execPath, [
  "--experimental-sqlite",
  "--disable-warning=ExperimentalWarning",
  "-e",
  `
const { DatabaseSync } = require("node:sqlite");
const [dbPath, wtA, tidA, wtB, tidB] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(\`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)\`);
const ins = db.prepare(\`insert into projection_threads
  (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at)
  values (?, ?, ?, ?, ?, ?, ?, ?)\`);
ins.run(tidA, "p", "A", "t3code/some-title", wtA, "2026-09-14T03:15:51.803Z", "x", null);
ins.run(tidB, "p", "B", "t3code/other", wtB, "2026-09-01T17:04:00.000Z", "x", null);
// A thread T3 recorded no branch for: a null column must not shift the rest.
ins.run("cccccccc-1111-2222-3333-444444444444", "p", "C", null, "/wt/no-branch", "2026-09-02T00:00:00.000Z", "x", null);
// A deleted thread whose worktree path is reused: must NOT match.
ins.run("dddddddd-0000-0000-0000-000000000000", "p", "D", "t3code/dead",
  process.argv[6], "2026-08-01T00:00:00.000Z", "x", "2026-08-02T00:00:00.000Z");
`,
  join(T3, "userdata/state.sqlite"),
  WT_A,
  TID_A,
  WT_B,
  TID_B,
  NOT_A_THREAD,
]);

const ENV_OK = { HOME: FAKE_HOME, T3CODE_HOME: T3 };

// ── The database path: the shell stands in the thread's T3 worktree ─────────

test("db hit prints the thread id", () => {
  expect("db hit prints the thread id", 0, TID_A, run(WT_A, ENV_OK));
});

// Node 22 prints an ExperimentalWarning to stderr when node:sqlite loads, and
// every caller reads the id as `$(… thread.ts --id 2>&1)`: a warning there
// became part of the id, and a branch named `session/(node:111) Experimental…`
// refused. The id must be the whole output on such a Node. The stand-in `node`
// on PATH — the one thread.ts runs its database child with — warns exactly as
// Node 22 does, unless the run turns the warning off.
test("--id 2>&1 is the id alone on a Node that warns about node:sqlite", () => {
  const WARN_BIN = join(TMP, "warn-bin");
  mkdirSync(WARN_BIN, { recursive: true });
  writeFileSync(
    join(WARN_BIN, "node"),
    `#!/usr/bin/env bash
case " $* " in
  *" --disable-warning=ExperimentalWarning "*) ;;
  *) echo "(node:111) ExperimentalWarning: SQLite is an experimental feature and might change at any time" >&2 ;;
esac
exec "${process.execPath}" "$@"
`,
  );
  chmodSync(join(WARN_BIN, "node"), 0o755);
  const got = run(WT_A, { ...ENV_OK, PATH: `${WARN_BIN}:${process.env.PATH ?? ""}` }, ["--id"]);
  assert.equal(got.out, `${TID_A}\n`, `--id 2>&1 on a warning Node: '${got.out}'`);
});

test("db hit prints T3's own branch name", () => {
  expect("db hit prints T3's own branch name", 0, "t3code/some-title", run(WT_A, ENV_OK, ["--branch"]));
});

test("db hit prints the worktree path", () => {
  expect("db hit prints the worktree path", 0, WT_A, run(WT_A, ENV_OK, ["--worktree"]));
});

test("db hit prints created_at as stored", () => {
  expect("db hit prints created_at as stored", 0, "2026-09-14T03:15:51.803Z", run(WT_A, ENV_OK, ["--started"]));
});

// 03:15 UTC on the 14th is 20:15 on the 13th in Los Angeles — the case the
// journal's "file by session start, not close time" rule turns on.
test("started --local converts to local HHMM", () => {
  const env = { ...ENV_OK, TZ: "America/Los_Angeles" };
  expect("started --local converts to local HHMM", 0, "2015", run(WT_A, env, ["--started", "--local"]));
});

test("started --local-day is the local date", () => {
  const env = { ...ENV_OK, TZ: "America/Los_Angeles" };
  expect("started --local-day is the local date", 0, "2026-09-13", run(WT_A, env, ["--started", "--local-day"]));
});

test("--la is still accepted", () => {
  expect("--la is still accepted", 0, "0315", run(WT_A, { ...ENV_OK, TZ: "UTC" }, ["--started", "--la"]));
});

test("a second thread matches its own row", () => {
  expect("a second thread matches its own row", 0, TID_B, run(WT_B, ENV_OK));
});

// ── The ledger path: the shell stands in a satellite ────────────────────────

const SAT = join(TMP, "satellite");
mkdirSync(SAT, { recursive: true });
sh("git", ["-C", SAT, "init", "-q"]);
const LEDGER_A = join(FAKE_HOME, ".cache/workbench/threads", TID_A);
mkdirSync(LEDGER_A, { recursive: true });
writeFileSync(join(LEDGER_A, "worktrees"), `${SAT}\t${TMP}/shared\tt3/${TID_A}\n`);

test("satellite resolves through the ledger", () => {
  expect("satellite resolves through the ledger", 0, TID_A, run(SAT, ENV_OK));
});

// From the satellite the branch still comes from the db row, not from the
// ledger's `t3/<id>` — they are different branches and only one is T3's.
test("satellite still reports T3's branch", () => {
  expect("satellite still reports T3's branch", 0, "t3code/some-title", run(SAT, ENV_OK, ["--branch"]));
});

// ── Two ledgers claiming one path is corruption, not a coin toss ────────────

test("two ledgers claiming one path is ambiguous", () => {
  const LEDGER_B = join(FAKE_HOME, ".cache/workbench/threads", TID_B);
  mkdirSync(LEDGER_B, { recursive: true });
  writeFileSync(join(LEDGER_B, "worktrees"), `${SAT}\t${TMP}/shared\tt3/${TID_B}\n`);
  try {
    expect("two ledgers claiming one path is ambiguous", 2, "ambiguous", run(SAT, ENV_OK));
  } finally {
    rmSync(LEDGER_B, { recursive: true, force: true });
  }
});

// ── No thread at all ────────────────────────────────────────────────────────

test("a git repo T3 never heard of gets a generated session", () => {
  expect("a git repo T3 never heard of gets a generated session", 0, "session-", run(NOT_A_THREAD, ENV_OK));
});

// The deleted-thread row names that same path. If `deleted_at is null` were
// missing from the query this case would pass an id back instead of refusing.
test("a deleted thread does not match its old path", () => {
  const got = run(NOT_A_THREAD, ENV_OK);
  assert.ok(!got.out.includes("dddddddd"), "deleted thread matched");
});

test("outside any git repo there is no thread", () => {
  expect("outside any git repo there is no thread", 2, "not in a thread", run(TMP, ENV_OK));
});

// ── Outside T3: the harness's session ───────────────────────────────────────

const NO_T3 = { HOME: FAKE_HOME, T3CODE_HOME: `${TMP}/nowhere` };
const out = (cwd: string, args: string[] = [], env: Record<string, string> = {}): string =>
  run(cwd, { ...NO_T3, ...env }, args).out.replace(/\n$/, "");
const real = (p: string): string => realpathSync(p);

test("outside T3: a generated session, remembered, recorded, renewed after its close", () => {
  const gen1 = out(WT_A);
  assert.match(gen1, /^session-\d{8}-\d{6}-[0-9a-f]{6}$/, `no T3 and no session id: an id is generated (${gen1})`);
  assert.equal(out(WT_A), gen1, "…and remembered for the checkout");
  assert.match(out(WT_A, ["--started"]), /^20\d\d-.*T.*Z$/, "…its start is recorded");
  assert.ok(out(WT_A, ["--worktree"]).includes("no worktree recorded"), "…a main checkout is not its own worktree");
  mkdirSync(join(FAKE_HOME, ".cache/workbench/threads", gen1), { recursive: true });
  writeFileSync(join(FAKE_HOME, ".cache/workbench/threads", gen1, "closed"), "");
  assert.notEqual(out(WT_A), gen1, "…and a new one after its close landed");
});

test("outside T3: the harness's own session id wins", () => {
  assert.equal(out(WT_A, [], { CONTEXTIUM_SESSION: "my-session" }), "my-session");
});

test("outside T3: a linked worktree the harness started in is the session's own", () => {
  sh("git", ["-C", WT_A, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed"]);
  sh("git", ["-C", WT_A, "worktree", "add", "-q", "-b", "harness/one", join(TMP, "linked")]);
  const env = { CLAUDE_CODE_SESSION_ID: "cc-1" };
  assert.equal(out(join(TMP, "linked"), ["--worktree"], env), real(join(TMP, "linked")));
  assert.equal(out(join(TMP, "linked"), ["--branch"], env), "harness/one", "…and its branch is read from git");
});

// Two id-less sessions, each in a linked worktree of its own: two sessions, not
// one. Sharing a generated id would record the first one's worktree as both
// sessions' own, and the second session's close would land the first one's tree.
test("outside T3: id-less sessions in two worktrees get two ids", () => {
  sh("git", ["-C", WT_A, "worktree", "add", "-q", "-b", "harness/two", join(TMP, "linked2")]);
  sh("git", ["-C", WT_A, "worktree", "add", "-q", "-b", "harness/three", join(TMP, "linked3")]);
  const l2 = out(join(TMP, "linked2"));
  const l3 = out(join(TMP, "linked3"));
  assert.ok(l2 !== "" && l2 !== l3, `shared id-less session: ${l2} and ${l3}`);
  assert.equal(out(join(TMP, "linked3"), ["--worktree"]), real(join(TMP, "linked3")), "…each owning its own worktree");
  assert.equal(out(join(TMP, "linked2")), l2, "…and each remembered");
});

// ── The override ────────────────────────────────────────────────────────────

test("WORKBENCH_THREAD_ID answers --id with no db at all", () => {
  expect(
    "WORKBENCH_THREAD_ID answers --id with no db at all",
    0,
    "forced-id",
    run(TMP, { HOME: FAKE_HOME, T3CODE_HOME: `${TMP}/nowhere`, WORKBENCH_THREAD_ID: "forced-id" }),
  );
});

test("WORKBENCH_THREAD_ID still reads the row for --branch", () => {
  expect(
    "WORKBENCH_THREAD_ID still reads the row for --branch",
    0,
    "t3code/some-title",
    run(TMP, { ...ENV_OK, WORKBENCH_THREAD_ID: TID_A }, ["--branch"]),
  );
});

test("an override naming no row is refused, not guessed", () => {
  expect(
    "an override naming no row is refused, not guessed",
    2,
    "no thread",
    run(TMP, { ...ENV_OK, WORKBENCH_THREAD_ID: "no-such-thread" }, ["--branch"]),
  );
});

// ── Usage ───────────────────────────────────────────────────────────────────

// A null branch is an empty column, not a missing one: --branch refuses and
// --worktree still reads the worktree column (the bash `read` collapsed the
// run of tabs, so --branch printed the path and --worktree the timestamp).
test("a null branch leaves the other columns where they are", () => {
  const env = { ...ENV_OK, WORKBENCH_THREAD_ID: "cccccccc-1111-2222-3333-444444444444" };
  expect("--branch refuses", 2, "has no branch recorded", run(NOT_A_THREAD, env, ["--branch"]));
  expect("--worktree reads its own column", 0, "/wt/no-branch", run(NOT_A_THREAD, env, ["--worktree"]));
  expect("--started reads its own column", 0, "2026-09-02T00:00:00.000Z", run(NOT_A_THREAD, env, ["--started"]));
});

test("an unknown flag is refused", () => {
  expect("an unknown flag is refused", 2, "usage:", run(WT_A, ENV_OK, ["--nonsense"]));
});
