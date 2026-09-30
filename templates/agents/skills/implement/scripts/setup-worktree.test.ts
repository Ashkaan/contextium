// Test harness for setup-worktree.sh, which stays bash (it runs `git worktree
// add`, the rule's tier-1 reason); this suite spawns it with `bash`. One case
// per boundary of its contract.
//
// The last block proves the resolver runs its converted helpers — session-key,
// session-write-root, thread, roadmap, spec-state, open-clarifications,
// detect-stage — as `.ts` files through `node --experimental-strip-types`, and
// never looks for the retired `.sh` names: a copy of the resolver is planted in
// a tree that holds ONLY the `.ts` helpers (and harness.sh, which it sources).
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/setup-worktree.test.ts
//
// peers: setup-worktree.sh

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_SCRIPT = join(HERE, "setup-worktree.sh");
const CLI_EXIT = resolve(HERE, "../../../packages/cli-exit/cli-exit.ts");
const CLOSE_SCRIPTS = resolve(HERE, "../../close/scripts");

const TMP = mkdtempSync(join(tmpdir(), "setup-worktree-test-"));
after(() => {
  // A read-only fixture (case_roadmap_readonly_warns restores it, but a failed
  // assertion may not reach that line) must not block the cleanup.
  spawnSync("chmod", ["-R", "u+w", TMP]);
  rmSync(TMP, { recursive: true, force: true });
});
let n = 0;
const mktemp = (): string => mkdtempSync(join(TMP, `d${++n}-`));

// The suite's own environment, minus anything that would point the resolver at
// a real tree or a real session: every case sets what it needs explicitly. HOME
// is a throwaway: the script records each worktree in this thread's ledger under
// ~/.cache. The suite runs as the claude harness, whose location and branch
// names these cases assert; the default-harness case covers the rest.
const SUITE_HOME = mkdtempSync(join(TMP, "home-"));
const LEDGERS = join(SUITE_HOME, ".cache/workbench/threads");
const BASE_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  HOME: SUITE_HOME,
  T3CODE_HOME: join(SUITE_HOME, ".t3"),
  CODEX_HOME: join(SUITE_HOME, ".codex"),
  CONTEXTIUM_HARNESS: "claude",
};
for (const k of [
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CONTEXTIUM_SESSION",
  "WORKBENCH_THREAD_ID",
  "CONTEXT_WRITE_ROOT",
  "CLAUDE_WORKTREE_HOME",
]) {
  delete BASE_ENV[k];
}

interface Run {
  rc: number;
  out: string;
  err: string;
  all: string;
}

// setup-worktree.sh puts a worktree where the recorded harness keeps its own
// (harness.sh), which for most harnesses is OUTSIDE the case's repo. Two
// consequences for this harness:
//
//   1. Every case builds a throwaway repo with mktemp and asserts against
//      "$repo/.claude/worktrees/...". Left alone, the script would write
//      somewhere else entirely and those assertions would inspect a directory it
//      never touched.
//   2. Worse, "somewhere else" could be the developer's REAL worktree folder.
//
// So every invocation pins CLAUDE_WORKTREE_HOME back into the case's own repo.
// The assertions below are unchanged and still describe the real contract; this
// shim only supplies the location the harness was always implicitly assuming, and
// it exercises the override path in the bargain.
function runSetup(
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  opts: { cwd?: string; script?: string; noShim?: boolean } = {},
): Run {
  const env: NodeJS.ProcessEnv = { ...BASE_ENV, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  if (!opts.noShim && env.CLAUDE_WORKTREE_HOME === undefined) {
    env.CLAUDE_WORKTREE_HOME = `${env.CLAUDE_PROJECT_DIR ?? ""}/.claude/worktrees`;
  }
  const r = spawnSync("bash", [opts.script ?? REAL_SCRIPT, ...args], {
    encoding: "utf8",
    env,
    cwd: opts.cwd,
    timeout: 120000,
  });
  return { rc: r.status ?? -1, out: r.stdout, err: r.stderr, all: `${r.stdout}${r.stderr}` };
}

const git = (cwd: string, ...a: string[]): string =>
  execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const gitOk = (cwd: string, ...a: string[]): boolean =>
  spawnSync("git", ["-C", cwd, ...a], { stdio: "ignore" }).status === 0;

// Build a hermetic upstream + downstream pair so origin/HEAD resolves.
function makeRepo(): string {
  const upstream = mktemp();
  git(upstream, "init", "--quiet", "--bare");
  const downstream = mktemp();
  git(downstream, "init", "--quiet");
  git(downstream, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "--quiet", "-m", "init");
  git(downstream, "remote", "add", "origin", upstream);
  if (!gitOk(downstream, "push", "--quiet", "origin", "master"))
    git(downstream, "push", "--quiet", "origin", "HEAD:main");
  git(downstream, "fetch", "--quiet", "origin");
  // Set origin/HEAD explicitly (push didn't always set it).
  const headBranch = git(downstream, "rev-parse", "--abbrev-ref", "HEAD").trim();
  gitOk(downstream, "remote", "set-head", "origin", headBranch);
  return downstream;
}

function makeRepoNoRemote(): string {
  const d = mktemp();
  git(d, "init", "--quiet");
  git(d, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "--quiet", "-m", "init");
  return d;
}

const wt = (repo: string, name: string): string => join(repo, ".claude/worktrees", name);
const branchOf = (dir: string): string => git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim();

// ── Mode 3: --print-regex ──
test("--print-regex", () => {
  const r = runSetup(["--print-regex"]);
  assert.equal(r.out.replace(/\n$/, ""), "^[a-z][a-z0-9-]{0,63}$", `got: ${r.out}`);
});

// ── Mode 2: --validate-slug ──
test("--validate-slug valid", () => assert.equal(runSetup(["--validate-slug", "my-slug"]).rc, 0));
test("--validate-slug invalid", () => assert.equal(runSetup(["--validate-slug", "BadSlug"]).rc, 2));
test("--validate-slug empty", () => assert.equal(runSetup(["--validate-slug", ""]).rc, 2));

// ── Mode 1: create from origin/HEAD (worktree+branch absent) ──
test("create-fresh (worktree+branch absent → -b new branch)", () => {
  const repo = makeRepo();
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  assert.equal(r.out.replace(/\n$/, ""), `WORKTREE_DIR=${wt(repo, "my-slug")}`, `wrong stdout: ${r.out}`);
  assert.ok(existsSync(wt(repo, "my-slug")), "worktree dir missing");
  assert.ok(existsSync(join(wt(repo, "my-slug"), ".claude-session-abc")), "marker missing");
  assert.equal(branchOf(wt(repo, "my-slug")), "worktree-my-slug", "wrong branch");
});

// ── Mode 1: branch survives prior worktree removal ──
test("branch-survives (no -B reset, local commits preserved)", () => {
  const repo = makeRepo();
  // Create + remove worktree, branch keeps the tip.
  runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  // Add a commit on the worktree so the branch tip diverges from origin/HEAD.
  const dir = wt(repo, "my-slug");
  git(dir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "--quiet", "-m", "local");
  const tipBefore = git(dir, "rev-parse", "HEAD").trim();
  // Remove the worktree; the branch survives.
  git(repo, "worktree", "remove", "--force", dir);
  // Reinvoke — must reuse branch (no -B reset).
  runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  const tipAfter = git(dir, "rev-parse", "HEAD").trim();
  assert.equal(tipAfter, tipBefore, `branch tip changed (${tipBefore} → ${tipAfter})`);
});

// ── Mode 1: no remote — falls back to HEAD ──
test("no-remote (falls back to HEAD with WARN)", () => {
  const repo = makeRepoNoRemote();
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  assert.equal(r.rc, 0, `expected exit 0, got ${r.rc}; out: ${r.all}`);
  assert.ok(r.all.includes(`WORKTREE_DIR=${wt(repo, "my-slug")}`), `missing WORKTREE_DIR; out: ${r.all}`);
  assert.ok(r.all.includes("WARN: origin/HEAD unresolvable"), `missing WARN; out: ${r.all}`);
});

// ── Mode 1: re-claim existing worktree, branch matches ──
// Re-claim is for the SAME session re-entering (a resumed session calls this
// again). Same slug, same id, same worktree, no complaint.
test("reclaim (same session, existing worktree, branch matches)", () => {
  const repo = makeRepo();
  const first = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).out;
  const second = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).out;
  assert.equal(second, first, `stdout differs (${first} vs ${second})`);
  assert.ok(existsSync(join(wt(repo, "my-slug"), ".claude-session-abc")), "own marker missing after re-claim");
});

// ── A DIFFERENT session must NOT be able to join an existing worktree ──
// Session `def` succeeding against session `abc`'s worktree and dropping its own
// marker beside it would be two sessions on one git index — the precise failure
// worktrees exist to prevent, merely relocated from the main tree into a
// worktree. Refuse instead.
test("foreign-claim (second session refused, holder untouched)", () => {
  const repo = makeRepo();
  runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "def" });
  assert.notEqual(r.rc, 0, "second session was allowed into another's worktree");
  assert.equal(
    existsSync(join(wt(repo, "my-slug"), ".claude-session-def")),
    false,
    "refused but still planted the second marker",
  );
  assert.ok(existsSync(join(wt(repo, "my-slug"), ".claude-session-abc")), "clobbered the holder's marker");
  assert.ok(r.all.includes("already claimed by another session"), `refused without naming the conflict: ${r.all}`);
});

// ── A worktree of ANOTHER repo at this path is never reclaimed ──
// Two checkouts sharing a basename can share a worktree root (a harness that
// keys its root by folder name), so the same slug names the same folder for
// both. Branch name and session marker then both match; only the repository
// identity tells them apart, and handing the other repo's worktree back sends
// this repo's edits into it.
test("other-repo (same slug and session, another repo's worktree refused)", () => {
  const a = makeRepo();
  const b = makeRepo();
  const home = join(mktemp(), "worktrees");
  const env = (repo: string) => ({ CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc", CLAUDE_WORKTREE_HOME: home });
  assert.equal(runSetup(["my-slug"], env(a)).rc, 0, "first repo's worktree was not created");
  const r = runSetup(["my-slug"], env(b));
  assert.notEqual(r.rc, 0, `handed repo b the worktree of repo a: ${r.all}`);
  assert.ok(r.all.includes("is not a worktree of"), `refused without naming the repo mismatch: ${r.all}`);
  assert.equal(r.out.includes("WORKTREE_DIR="), false, `printed a WORKTREE_DIR anyway: ${r.out}`);
});

// ── Mode 1: worktree exists, branch differs — fail loud ──
test("branch-differs (fail loud)", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, ".claude/worktrees"), { recursive: true });
  // Create worktree manually on a different branch
  gitOk(repo, "worktree", "add", "-b", "some-other-branch", wt(repo, "my-slug"));
  assert.notEqual(runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).rc, 0);
});

// ── Mode 1: slug fails regex ──
test("bad-slug (regex miss → exit 2, no git state)", () => {
  const repo = makeRepo();
  assert.equal(runSetup(["Bad-Slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).rc, 2);
});

// ── Mode 1: CLAUDE_PROJECT_DIR unset AND outside a git repo → fail loud ──
// (Fix B: the git fallback only resolves inside a repo; run from a non-git
// temp dir so the hard-error path is exercised.)
test("missing CLAUDE_PROJECT_DIR outside repo (fail loud)", () => {
  const nongit = mktemp();
  assert.notEqual(runSetup(["my-slug"], { CLAUDE_SESSION_ID: "abc" }, { cwd: nongit }).rc, 0);
});

// ── Mode 1 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo →
// resolve root via git rev-parse and create the worktree ──
// The point of the case is the CLAUDE_PROJECT_DIR-unset fallback to `git
// rev-parse`, so the worktree home is pinned explicitly here instead of being
// derived from the variable the case exists to unset.
test("env-unset-in-repo resolves via git rev-parse", () => {
  const repo = makeRepo();
  const r = runSetup(
    ["my-slug"],
    { CLAUDE_SESSION_ID: "abc", CLAUDE_WORKTREE_HOME: join(repo, ".claude/worktrees") },
    { cwd: repo },
  );
  assert.equal(r.rc, 0, `expected exit 0, got ${r.rc}; out: ${r.all}`);
  assert.ok(/WORKTREE_DIR=.*\/\.claude\/worktrees\/my-slug$/m.test(r.all), `missing WORKTREE_DIR; out: ${r.all}`);
});

// ── Mode 1: CLAUDE_PROJECT_DIR points at non-repo ──
test("non-repo dir (fail loud)", () => {
  const d = mktemp();
  assert.notEqual(runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: d, CLAUDE_SESSION_ID: "abc" }).rc, 0);
});

// ── Mode 1: no session id anywhere → the one thread.ts generates, not a refusal ──
test("no session id (a generated one names the marker)", () => {
  const repo = makeRepo();
  const home = join(repo, ".claude/worktrees");
  const r = runSetup(["my-slug"], { CLAUDE_WORKTREE_HOME: home }, { cwd: repo });
  assert.equal(r.rc, 0, `rc ${r.rc}; out: ${r.all}`);
  assert.equal(r.out, `WORKTREE_DIR=${join(home, "my-slug")}\n`, `out: ${r.all}`);
  const t = spawnSync(process.execPath, ["--experimental-strip-types", join(CLOSE_SCRIPTS, "thread.ts"), "--id"], {
    encoding: "utf8",
    env: BASE_ENV,
    cwd: repo,
  });
  const sid = (t.stdout ?? "").trim();
  assert.ok(sid.startsWith("session-"), `thread.ts --id gave '${sid}': ${t.stderr}`);
  assert.ok(existsSync(join(home, "my-slug", `.claude-session-${sid}`)), `no marker for the generated session '${sid}'`);
});

// ── The worktree is in this thread's ledger, so the close lands it ──
test("adopted-for-close (in the ledger, markers not committable)", () => {
  const repo = makeRepo();
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "led" });
  const ledger = join(LEDGERS, "led/worktrees");
  const rows = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n") : [];
  const line = rows.map((l) => l.split("\t")).find((f) => f[0] === wt(repo, "my-slug"));
  assert.equal(line?.[2], "worktree-my-slug", `ledger: [${rows.join("|")}]; out: ${r.all}`);
  const status = git(wt(repo, "my-slug"), "status", "--porcelain");
  assert.equal(status, "", `the markers would be committed: ${status}`);
});

// ── A thread that already has a worktree of this repo builds there ──
test("thread-worktree-reused (no second worktree of one repo)", () => {
  const repo = makeRepo();
  const own = `${repo}.own`;
  git(repo, "worktree", "add", "-q", "-b", "thread-own", own);
  spawnSync("bash", [join(CLOSE_SCRIPTS, "write-root.sh"), "--adopt", own], {
    env: { ...BASE_ENV, CLAUDE_SESSION_ID: "has" },
    cwd: repo,
    stdio: "ignore",
  });
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "has" });
  rmSync(own, { recursive: true, force: true });
  assert.equal(r.all, `WORKTREE_DIR=${realpathSync(repo)}.own\n`, `out: ${r.all}`);
  assert.equal(existsSync(wt(repo, "my-slug")), false, "a second worktree was made beside it");
});

// ── No harness recorded: beside the repo, on a session/ branch ──
test("default-harness (beside the repo, session/ branch)", () => {
  const repo = makeRepo();
  const want = join(dirname(repo), `${basename(repo)}.worktrees`, "my-slug");
  const r = runSetup(
    ["my-slug"],
    { CONTEXTIUM_HARNESS: "default", CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "dflt" },
    { noShim: true },
  );
  assert.equal(r.all, `WORKTREE_DIR=${want}\n`, `out: ${r.all}`);
  assert.equal(branchOf(want), "session/my-slug");
});

// ── Mode 1b: --slug + --shard creates composite worktree ──
test("slug-shard-fresh (composite worktree + branch)", () => {
  const repo = makeRepo();
  const r = runSetup(["--slug", "my-slug", "--shard", "foo"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  assert.equal(r.rc, 0, `exit ${r.rc}; out: ${r.out}`);
  assert.ok(/^SLUG=my-slug$/m.test(r.out), `missing SLUG line; out: ${r.out}`);
  assert.ok(/^SHARD=foo$/m.test(r.out), `missing SHARD line; out: ${r.out}`);
  assert.ok(
    new RegExp(`WORKTREE_DIR=${wt(repo, "my-slug-foo")}$`, "m").test(r.out),
    `wrong WORKTREE_DIR; out: ${r.out}`,
  );
  assert.ok(existsSync(wt(repo, "my-slug-foo")), "composite worktree dir missing");
  assert.equal(branchOf(wt(repo, "my-slug-foo")), "worktree-my-slug-foo", "wrong branch");
});

// ── Mode 1b: composite overflows 64-char regex → fail ──
test("slug-shard-overflow (composite > 64 chars → exit 2)", () => {
  const repo = makeRepo();
  // 35-char slug + 30-char shard + hyphen = 66 chars, blows the 64 ceiling.
  const r = runSetup(["--slug", "aaaaabbbbbcccccdddddeeeeefffffggggg", "--shard", "hhhhhiiiiijjjjjkkkkklllllmmmmm"], {
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_SESSION_ID: "abc",
  });
  assert.equal(r.rc, 2);
});

// ── Mode 1b: bad shard token (uppercase) → fail ──
test("slug-shard-bad-shard (regex miss → exit 2)", () => {
  const repo = makeRepo();
  assert.equal(
    runSetup(["--slug", "my-slug", "--shard", "Bad_Shard"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).rc,
    2,
  );
});

// ── Mode 1b: missing --shard arg ──
test("slug-shard-missing-shard (fail loud)", () => {
  const repo = makeRepo();
  assert.notEqual(runSetup(["--slug", "my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" }).rc, 0);
});

// ── ROADMAP.md rows ─────────────────────────────────────────────────────────
// A records fixture the script finds through CONTEXT_WRITE_ROOT, holding one
// project `rmx` with a two-row roadmap: R1 has a spec folder, R2 has none.
const ROADMAP = [
  "# Roadmap: t",
  "",
  "| ID | Sub-feature | Depends on | Status | Sub-spec |",
  "|----|-------------|------------|--------|----------|",
  "| R1 | a | — | planned | `specs/001-a/` |",
  "| R2 | b | — | planned | — |",
  "",
].join("\n");
function makeRecords(): string {
  const lib = mktemp();
  const p = join(lib, "projects/t/2026-01-01_rmx");
  mkdirSync(join(p, "specs/001-a"), { recursive: true });
  writeFileSync(join(p, "README.md"), "---\nproject: rmx\nstatus: active\n---\n\n# P\n");
  writeFileSync(join(p, "ROADMAP.md"), ROADMAP);
  writeFileSync(join(p, "specs/001-a/spec.md"), "# spec\n");
  return lib;
}
const rmxDir = (lib: string): string => join(lib, "projects/t/2026-01-01_rmx");
/** The Status cell of row <id> (the old suite's awk reader). */
function rmStatus(lib: string, id: string): string {
  for (const line of readFileSync(join(rmxDir(lib), "ROADMAP.md"), "utf8").split("\n")) {
    const f = line.split("|");
    if (new RegExp(`^ *${id} *$`).test(f[1] ?? "")) return (f[4] ?? "").replace(/^ +| +$/g, "");
  }
  return "";
}
/** `compgen -G "$repo/.claude/worktrees/rmx*"` or a `worktree-rmx*` branch. */
function leftBehind(repo: string, withBranch = true): boolean {
  const home = join(repo, ".claude/worktrees");
  if (existsSync(home) && readdirSync(home).some((d) => d.startsWith("rmx"))) return true;
  return withBranch && git(repo, "branch", "--list", "worktree-rmx*").trim() !== "";
}

test("roadmap row among many specs starts", () => {
  // A row whose spec is not the last one spec-state prints. The reader that
  // picks the row's state used to quit on its match; spec-state then died of
  // SIGPIPE writing its next line, and under pipefail this script exited 141 with
  // nothing on stderr and no worktree.
  const repo = makeRepo();
  const lib = makeRecords();
  for (let i = 10; i <= 60; i++) {
    mkdirSync(join(rmxDir(lib), `specs/0${i}-x`), { recursive: true });
    writeFileSync(join(rmxDir(lib), `specs/0${i}-x/spec.md`), "# spec\n");
  }
  const r = runSetup(["--slug", "rmx", "--shard", "r1"], {
    CONTEXT_WRITE_ROOT: lib,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_SESSION_ID: "abc",
  });
  assert.equal(r.rc, 0, `rc ${r.rc}; out: ${r.all}`);
  assert.ok(existsSync(wt(repo, "rmx-r1")), `no worktree; out: ${r.all}`);
});

// A project that lives in the repo itself (no CONTEXT_WRITE_ROOT): the row is
// read from the main checkout, and the in-progress flip must land in the new
// worktree's copy — a flip in the shared checkout is a dirty file no close
// commits, and land.ts then will not fast-forward that checkout.
test("roadmap flip lands in the worktree, the shared checkout stays clean", () => {
  const repo = makeRepo();
  const lib = makeRecords();
  cpSync(join(lib, "projects"), join(repo, "projects"), { recursive: true });
  git(repo, "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "projects");
  git(repo, "push", "-q", "origin", "HEAD");
  git(repo, "fetch", "-q", "origin");
  writeFileSync(join(repo, ".git/info/exclude"), `${readFileSync(join(repo, ".git/info/exclude"), "utf8")}.claude/\n`);
  const r = runSetup(
    ["--slug", "rmx", "--shard", "r1"],
    { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" },
    { cwd: repo },
  );
  const p = "projects/t/2026-01-01_rmx/ROADMAP.md";
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.all}`);
  const status = git(repo, "status", "--porcelain");
  assert.equal(status, "", `the shared checkout was written: ${status}`);
  const wtRoadmap = readFileSync(join(wt(repo, "rmx-r1"), p), "utf8");
  assert.ok(wtRoadmap.includes("| R1 | a | — | in-progress |"), `the worktree's R1 is not in-progress: ${wtRoadmap}`);
});

test("roadmap --shard r1 flips R1 to in-progress", () => {
  const repo = makeRepo();
  const lib = makeRecords();
  const r = runSetup(["--slug", "rmx", "--shard", "r1"], {
    CONTEXT_WRITE_ROOT: lib,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_SESSION_ID: "abc",
  });
  assert.equal(r.rc, 0, `rc ${r.rc}, R1 is '${rmStatus(lib, "R1")}'; out: ${r.all}`);
  assert.equal(rmStatus(lib, "R1"), "in-progress", `R1 is '${rmStatus(lib, "R1")}'; out: ${r.all}`);
  assert.ok(existsSync(wt(repo, "rmx-r1")), "no worktree");
});

test("roadmap bare slug resolves R1 and flips it", () => {
  const repo = makeRepo();
  const lib = makeRecords();
  const r = runSetup(["rmx"], { CONTEXT_WRITE_ROOT: lib, CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
  assert.equal(r.rc, 0, `rc ${r.rc}, R1 is '${rmStatus(lib, "R1")}'; out: ${r.all}`);
  assert.equal(rmStatus(lib, "R1"), "in-progress", `R1 is '${rmStatus(lib, "R1")}'; out: ${r.all}`);
});

test("roadmap open marker refuses in both forms, nothing created", async (t) => {
  for (const form of ["shard", "bare"] as const) {
    await t.test(form, () => {
      const repo = makeRepo();
      const lib = makeRecords();
      writeFileSync(join(rmxDir(lib), "specs/001-a/spec.md"), "FR-1 [NEEDS CLARIFICATION: which store?]\n");
      const args = form === "shard" ? ["--slug", "rmx", "--shard", "r1"] : ["rmx"];
      const r = runSetup(args, { CONTEXT_WRITE_ROOT: lib, CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc" });
      assert.notEqual(r.rc, 0, `roadmap_marker_refuses (${form}) — exit 0`);
      assert.ok(r.err.includes("which store?"), `marker not in stderr: ${r.err}`);
      if (form === "bare") assert.ok(r.err.includes("needs-planning"), `stage not named: ${r.err}`);
      assert.equal(leftBehind(repo), false, "a worktree or branch was left behind");
      assert.equal(rmStatus(lib, "R1"), "planned", "R1 flipped");
    });
  }
});

test("roadmap r99 refuses with the ID list, nothing created", () => {
  const repo = makeRepo();
  const lib = makeRecords();
  const r = runSetup(["--slug", "rmx", "--shard", "r99"], {
    CONTEXT_WRITE_ROOT: lib,
    CLAUDE_PROJECT_DIR: repo,
    CLAUDE_SESSION_ID: "abc",
  });
  assert.notEqual(r.rc, 0, `rc ${r.rc}; err: ${r.err}`);
  assert.ok(r.err.includes("rows: R1, R2"), `rc ${r.rc}; err: ${r.err}`);
  assert.equal(leftBehind(repo), false, "a worktree or branch was left behind");
});

test("roadmap named row that is not ready, has no spec, or is complete refuses", async (t) => {
  for (const [sid, want] of [
    ["r2", "has no spec yet"],
    ["r1-done", "not ready"],
    ["r1-blocked", "not ready"],
  ] as const) {
    await t.test(sid, () => {
      const repo = makeRepo();
      const lib = makeRecords();
      const road = join(rmxDir(lib), "ROADMAP.md");
      if (sid === "r1-done") {
        writeFileSync(road, readFileSync(road, "utf8").replace("| R1 | a | — | planned |", "| R1 | a | — | done |"));
      } else if (sid === "r1-blocked") {
        writeFileSync(
          road,
          readFileSync(road, "utf8").replace("| R1 | a | — | planned |", "| R1 | a | — | blocked: vendor |"),
        );
      }
      const r = runSetup(["--slug", "rmx", "--shard", sid.split("-")[0] ?? sid], {
        CONTEXT_WRITE_ROOT: lib,
        CLAUDE_PROJECT_DIR: repo,
        CLAUDE_SESSION_ID: "abc",
      });
      assert.notEqual(r.rc, 0, `rc ${r.rc}; err: ${r.err}`);
      assert.ok(r.err.includes(want), `rc ${r.rc}; err: ${r.err}`);
      assert.equal(leftBehind(repo, false), false, "a worktree was left behind");
    });
  }
  await t.test("complete", () => {
    const repo = makeRepo();
    const lib = makeRecords();
    writeFileSync(join(rmxDir(lib), "specs/001-a/report.md"), "---\nspec-status: complete\n---\n");
    const r = runSetup(["--slug", "rmx", "--shard", "r1"], {
      CONTEXT_WRITE_ROOT: lib,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_SESSION_ID: "abc",
    });
    assert.notEqual(r.rc, 0, `rc ${r.rc}; err: ${r.err}`);
    assert.ok(r.err.includes("already reported complete"), `rc ${r.rc}; err: ${r.err}`);
  });
  await t.test("completed project", () => {
    const repo = makeRepo();
    const lib = makeRecords();
    const readme = join(rmxDir(lib), "README.md");
    writeFileSync(readme, readFileSync(readme, "utf8").replace(/^status: active/m, "status: completed"));
    const r = runSetup(["--slug", "rmx", "--shard", "r1"], {
      CONTEXT_WRITE_ROOT: lib,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_SESSION_ID: "abc",
    });
    assert.notEqual(r.rc, 0, `rc ${r.rc}; err: ${r.err}`);
    assert.ok(r.err.includes("not active"), `rc ${r.rc}; err: ${r.err}`);
    assert.equal(rmStatus(lib, "R1"), "planned");
  });
});

test("roadmap read-only ROADMAP.md warns, worktree still created", () => {
  const repo = makeRepo();
  const lib = makeRecords();
  const p = rmxDir(lib);
  chmodSync(join(p, "ROADMAP.md"), 0o444);
  chmodSync(p, 0o555);
  let r: Run;
  try {
    r = runSetup(["--slug", "rmx", "--shard", "r1"], {
      CONTEXT_WRITE_ROOT: lib,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_SESSION_ID: "abc",
    });
  } finally {
    chmodSync(p, 0o755);
    chmodSync(join(p, "ROADMAP.md"), 0o644);
  }
  assert.equal(r.rc, 0, `rc ${r.rc}; err: ${r.err}`);
  assert.ok(r.err.includes("WARN: could not mark R1 in-progress"), `rc ${r.rc}; err: ${r.err}`);
  assert.ok(existsSync(wt(repo, "rmx-r1")), `rc ${r.rc}; err: ${r.err}`);
});

// ── The helpers run as TypeScript, through node ─────────────────────────────
//
// setup-worktree.sh stays bash, but every helper it runs became a `.ts` file:
// session-key, session-write-root (this skill), thread, roadmap, spec-state,
// open-clarifications (close), detect-stage (project). A copy of the resolver is
// planted in a tree holding ONLY those `.ts` files — no `.sh` of any of them —
// plus harness.sh, the one bash file it sources. A resolver still reaching for a
// `.sh` fails here, and a resolver that SOURCED a `.ts` would die on its first
// line of TypeScript. The close and project helpers are stubs that log their
// argv (they belong to other skills and are tested there); session-key,
// session-write-root and harness.sh are the real files. No write-root.sh is
// planted, so the resolver records nothing and only warns.

const STUB = (name: string, body: string): string => `import { appendFileSync } from "node:fs";
const args: string[] = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG ?? "/dev/null", ${JSON.stringify(name)} + " " + args.join(" ") + "\\n");
${body}
`;

function plantTree(): { script: string; log: string } {
  const root = mktemp();
  const impl = join(root, ".agents/skills/implement/scripts");
  const close = join(root, ".agents/skills/close/scripts");
  const project = join(root, ".agents/skills/project/scripts");
  const packages = join(root, ".agents/packages/cli-exit");
  for (const d of [impl, close, project, packages]) mkdirSync(d, { recursive: true });
  copyFileSync(REAL_SCRIPT, join(impl, "setup-worktree.sh"));
  copyFileSync(join(HERE, "session-key.ts"), join(impl, "session-key.ts"));
  copyFileSync(join(HERE, "session-write-root.ts"), join(impl, "session-write-root.ts"));
  copyFileSync(CLI_EXIT, join(packages, "cli-exit.ts"));
  copyFileSync(join(CLOSE_SCRIPTS, "harness.sh"), join(close, "harness.sh"));
  writeFileSync(join(close, "thread.ts"), STUB("thread.ts", 'process.stdout.write("session-planted\\n");'));
  writeFileSync(
    join(close, "roadmap.ts"),
    STUB("roadmap.ts", 'if (!args.includes("--set")) process.stdout.write("R1\\tplanned\\tyes\\tspecs/001-a\\ta\\n");'),
  );
  writeFileSync(
    join(close, "spec-state.ts"),
    STUB("spec-state.ts", 'process.stdout.write("specs/001-a\\tnone\\tno report\\n");'),
  );
  writeFileSync(join(close, "open-clarifications.ts"), STUB("open-clarifications.ts", ""));
  writeFileSync(
    join(project, "detect-stage.ts"),
    STUB(
      "detect-stage.ts",
      "process.stdout.write(`stage: ready-to-implement\\nactive-spec: ${args[0]}/specs/001-a/spec.md\\nnext-row: R1\\n`);",
    ),
  );
  return { script: join(impl, "setup-worktree.sh"), log: join(root, "stub.log") };
}
const logOf = (log: string): string => (existsSync(log) ? readFileSync(log, "utf8") : "");

test("the session key comes from session-key.ts, run by node", () => {
  const { script } = plantTree();
  const repo = makeRepo();
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "cse_01HFo2Jk" }, { script });
  assert.equal(r.rc, 0, `the resolver could not key the session without a session-key.ts: ${r.all}`);
  const key = execFileSync(
    process.execPath,
    ["--experimental-strip-types", join(HERE, "session-key.ts"), "cse_01HFo2Jk"],
    {
      encoding: "utf8",
    },
  ).trim();
  assert.ok(
    existsSync(join(wt(repo, "my-slug"), `.claude-session-${key}`)),
    `no marker .claude-session-${key}: ${r.all}`,
  );
});

test("the records root comes from session-write-root.ts, and a named row runs roadmap/spec-state/open-clarifications .ts", () => {
  const { script, log } = plantTree();
  const repo = makeRepo();
  const lib = makeRecords();
  const r = runSetup(
    ["--slug", "rmx", "--shard", "r1"],
    {
      CONTEXT_WRITE_ROOT: lib,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_SESSION_ID: "abc",
      STUB_LOG: log,
    },
    { script },
  );
  const calls = logOf(log);
  assert.equal(r.rc, 0, r.all);
  assert.ok(calls.includes(`roadmap.ts ${rmxDir(lib)}\n`), `roadmap.ts never read the row: [${calls}] ${r.all}`);
  assert.ok(calls.includes(`spec-state.ts ${rmxDir(lib)}\n`), `spec-state.ts never ran: [${calls}]`);
  assert.ok(
    calls.includes(`open-clarifications.ts ${rmxDir(lib)}/specs/001-a\n`),
    `open-clarifications.ts never ran: [${calls}]`,
  );
  assert.ok(
    calls.includes(`roadmap.ts ${rmxDir(lib)} --set R1 in-progress\n`),
    `the row was never flipped through roadmap.ts: [${calls}]`,
  );
});

test("a bare slug asks detect-stage.ts for the row", () => {
  const { script, log } = plantTree();
  const repo = makeRepo();
  const lib = makeRecords();
  const r = runSetup(
    ["rmx"],
    { CONTEXT_WRITE_ROOT: lib, CLAUDE_PROJECT_DIR: repo, CLAUDE_SESSION_ID: "abc", STUB_LOG: log },
    { script },
  );
  const calls = logOf(log);
  assert.equal(r.rc, 0, r.all);
  assert.ok(calls.includes(`detect-stage.ts ${rmxDir(lib)}\n`), `detect-stage.ts never ran: [${calls}] ${r.all}`);
  assert.ok(calls.includes(`roadmap.ts ${rmxDir(lib)} --set R1 in-progress\n`), `R1 was never flipped: [${calls}]`);
});

test("with no session id the resolver asks thread.ts, run by node", () => {
  const { script, log } = plantTree();
  const repo = makeRepo();
  const r = runSetup(["my-slug"], { CLAUDE_PROJECT_DIR: repo, STUB_LOG: log }, { script });
  const calls = logOf(log);
  assert.equal(r.rc, 0, `rc ${r.rc}: ${r.all}`);
  assert.ok(calls.includes("thread.ts --id\n"), `thread.ts never ran: [${calls}] ${r.all}`);
  assert.ok(existsSync(join(wt(repo, "my-slug"), ".claude-session-session-planted")), `no marker: ${r.all}`);
});

test("the resolver sources only harness.sh, and names no retired .sh helper", () => {
  const text = readFileSync(REAL_SCRIPT, "utf8");
  const sourced = [...text.matchAll(/^\s*(?:source|\.)\s+(\S+)/gm)].map((m) => m[1]);
  assert.deepEqual(sourced, ['"$CLOSE_SCRIPTS/harness.sh"'], `setup-worktree.sh sources ${sourced.join(", ")}`);
  for (const stem of [
    "session-key",
    "session-write-root",
    "thread",
    "roadmap",
    "spec-state",
    "open-clarifications",
    "detect-stage",
    "update-shard-status",
  ]) {
    const code = text
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
    assert.equal(code.includes(`${stem}.sh`), false, `setup-worktree.sh still runs ${stem}.sh`);
  }
  assert.ok(statSync(REAL_SCRIPT).mode & 0o100, "setup-worktree.sh is not executable");
});
