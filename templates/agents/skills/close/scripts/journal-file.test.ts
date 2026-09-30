// journal-file.test.ts — naming, collisions on both sides, and the resume path.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/journal-file.test.ts
//
// A fixture CODE repo with a bare origin stands in for workbench: it carries a
// copy of these scripts under `.agents/skills/close/scripts/`, exactly where the real
// ones live (and `.agents/packages/cli-exit/`, which every converted script
// imports three levels up), so the script under test finds its own repo the way
// the real one does — `git rev-parse --show-toplevel` from its own directory —
// and the journal lands in the thread's worktree of THAT repo.
//
// Local time is the journal's clock: every child runs with TZ pinned to the
// zone the fixtures' times are written for, and with no harness session
// variable from the shell running the suite.
//
// The cases run in order and share one fixture, as the shell suite did: each
// builds on the files the one before it left.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const TMP = mkdtempSync(join(tmpdir(), "jf-test-"));
// `jf-<pid>` keeps the /tmp lock write-root takes from colliding with a
// concurrent run of this suite.
const TAG = `jf-${process.pid}`;

after(() => {
  spawnSync("git", ["-C", join(TMP, `${TAG}-code`), "worktree", "prune"]);
  spawnSync("git", ["-C", join(TMP, `${TAG}-prod`), "worktree", "prune"]);
  rmSync(TMP, { recursive: true, force: true });
  for (const f of readdirSync("/tmp")) {
    if (f.startsWith(`${TAG}-`) && f.endsWith("-git.lock")) rmSync(join("/tmp", f), { force: true });
  }
});

function git(...args: string[]): void {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const is = (name: string, got: string, want: string): void => assert.equal(got, want, name);
const has = (name: string, got: string, needle: string): void =>
  assert.ok(got.includes(needle), `${name}: '${got}' lacks '${needle}'`);

const FAKE_HOME = join(TMP, "home");
const T3 = join(TMP, "t3");
mkdirSync(FAKE_HOME, { recursive: true });
mkdirSync(join(T3, "userdata"), { recursive: true });

const TID = "11111111-aaaa-bbbb-cccc-222222222222";
const LEDGER_DIR = join(FAKE_HOME, ".cache/workbench/threads", TID);

// The code repo and its origin, holding these scripts at their real path.
const CODEBARE = join(TMP, "code.git");
const CODE = join(TMP, `${TAG}-code`);
git("init", "-q", "--bare", "-b", "main", CODEBARE);
git("init", "-q", "-b", "main", CODE);
git("-C", CODE, "config", "user.email", "t@example.com");
git("-C", CODE, "config", "user.name", "tester");
mkdirSync(join(CODE, ".agents/skills/close/scripts"), { recursive: true });
mkdirSync(join(CODE, "journal"), { recursive: true });
mkdirSync(join(CODE, ".agents/packages/cli-exit"), { recursive: true });
for (const f of readdirSync(HERE)) {
  if (/\.(sh|ts)$/.test(f) && statSync(join(HERE, f)).isFile()) {
    copyFileSync(join(HERE, f), join(CODE, ".agents/skills/close/scripts", f));
  }
}
copyFileSync(join(REPO, "packages/cli-exit/cli-exit.ts"), join(CODE, ".agents/packages/cli-exit/cli-exit.ts"));
writeFileSync(join(CODE, "README.md"), "# Workbench\n");
git("-C", CODE, "add", "README.md", ".agents");
git("-C", CODE, "commit", "-q", "-m", "seed");
git("-C", CODE, "remote", "add", "origin", CODEBARE);
git("-C", CODE, "push", "-q", "-u", "origin", "main");

// The thread's own T3 worktree, of the code repo — the shape a workbench
// thread has, and the one the journal lands in.
const T3_WT = join(TMP, "t3wt");
git("-C", CODE, "worktree", "add", "-q", "-b", "t3code/a-title", T3_WT, "main");

// A second thread whose T3 worktree is of some OTHER repo — a product repo —
// so the code repo is a satellite for it, the shape the resume case needs.
const TID2 = "22222222-aaaa-bbbb-cccc-333333333333";
const LEDGER_DIR2 = join(FAKE_HOME, ".cache/workbench/threads", TID2);
const PRODBARE = join(TMP, "prod.git");
const PROD = join(TMP, `${TAG}-prod`);
git("init", "-q", "--bare", "-b", "main", PRODBARE);
git("init", "-q", "-b", "main", PROD);
git("-C", PROD, "config", "user.email", "t@example.com");
git("-C", PROD, "config", "user.name", "tester");
writeFileSync(join(PROD, "f"), "x\n");
git("-C", PROD, "add", "f");
git("-C", PROD, "commit", "-q", "-m", "seed");
git("-C", PROD, "remote", "add", "origin", PRODBARE);
git("-C", PROD, "push", "-q", "-u", "origin", "main");
const T3_WT2 = join(TMP, "t3wt2");
git("-C", PROD, "worktree", "add", "-q", "-b", "t3code/b-title", T3_WT2, "main");

// Written by a child Node with --experimental-sqlite: node:sqlite loads
// unflagged only from Node 22.13, and this suite runs on 22.6 too.
{
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "-e",
      `
const { DatabaseSync } = require("node:sqlite");
const [dbPath, tid, wt, tid2, wt2] = process.argv.slice(1);
const db = new DatabaseSync(dbPath);
db.exec(\`create table projection_threads (
  thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
  branch TEXT, worktree_path TEXT, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, deleted_at TEXT)\`);
const ins = db.prepare("insert into projection_threads values (?,?,?,?,?,?,?,?)");
ins.run(tid, "p", "T", "t3code/a-title", wt, "2026-09-14T03:15:51.803Z", "x", null);
ins.run(tid2, "p", "U", "t3code/b-title", wt2, "2026-09-14T03:15:51.803Z", "x", null);
db.close();
`,
      join(T3, "userdata/state.sqlite"),
      TID,
      T3_WT,
      TID2,
      T3_WT2,
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`fixture database: ${r.stderr}`);
}

// The script under test is the thread's OWN copy, as a session in a workbench
// worktree runs it.
const SCRIPT = join(T3_WT, ".agents/skills/close/scripts/journal-file.ts");

const HARNESS_VARS = ["CLAUDE_CODE_SESSION_ID", "CLAUDE_SESSION_ID", "CONTEXTIUM_SESSION", "CONTEXTIUM_HARNESS", "CODEX_THREAD_ID", "CODEX_SESSION_ID", "WORKBENCH_THREAD_ID"];
function childEnv(env: Record<string, string>): NodeJS.ProcessEnv {
  // NODE_OPTIONS=--no-warnings reaches the grandchildren too (thread.ts,
  // trunk.ts): Node 22.6–22.17 warn on stderr that type stripping is
  // experimental, and the cases read stdout and stderr merged.
  const e: NodeJS.ProcessEnv = { ...process.env, TZ: "America/Los_Angeles", NODE_OPTIONS: "--no-warnings" };
  for (const k of HARNESS_VARS) delete e[k];
  return { ...e, ...env };
}
const ENV = childEnv({ HOME: FAKE_HOME, T3CODE_HOME: T3 });

type Run = { out: string; rc: number };

/** `$(… 2>&1)`: stdout and stderr together, trailing newlines stripped. */
function spawnScript(script: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = ENV): Run {
  // --no-warnings: Node 22.6–22.17 warn that type stripping is experimental.
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", script, ...args], {
    encoding: "utf8",
    cwd,
    env,
    timeout: 120_000,
  });
  return { out: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n+$/, ""), rc: r.status ?? -1 };
}
const run = (...args: string[]): Run => spawnScript(SCRIPT, T3_WT, args);
const run2 = (...args: string[]): Run => spawnScript(join(CODE, ".agents/skills/close/scripts/journal-file.ts"), T3_WT2, args);

// ── The name ───────────────────────────────────────────────────────────────
//
// The session started 03:15 UTC on the 14th, which is 20:15 on the 13th in the
// pinned local zone (Los Angeles) — so it files under the 13th, the day the
// work happened.

test("the name", () => {
  const { out, rc } = run("The close that works in T3");
  is(
    "the path is <this repo's worktree>/journal/<start date>/<HHMM>-<slug>.md",
    out,
    `${T3_WT}/journal/2026-09-13/2015-the-close-that-works-in-t3.md`,
  );
  is("exits 0", String(rc), "0");
  assert.ok(existsSync(join(T3_WT, "journal/2026-09-13")), "no day folder");
  assert.ok(!existsSync(out), "the file itself was created");
  is("the chosen path is persisted for land.ts", readFileSync(join(LEDGER_DIR, "journal"), "utf8").trimEnd(), out);

  const mixed = run("  Mixed CASE, punctuation! and   spaces  ");
  is("the slug is kebabbed and trimmed", basename(mixed.out), "2015-mixed-case-punctuation-and-spaces.md");

  const long = run("a".repeat(90));
  // `wc -c` counted the trailing newline: 61 there is 60 characters here.
  is("a long slug is cut to 60 characters", String(basename(long.out, ".md").replace(/^2015-/, "").length), "60");

  const bang = run("!!!");
  is("a slug with nothing usable in it is refused", String(bang.rc), "2");
  has("and says why", bang.out, "no usable characters");
});

// ── A name taken in this worktree ──────────────────────────────────────────

test("a name taken in this worktree", () => {
  const FIRST = join(T3_WT, "journal/2026-09-13/2015-same-slug.md");
  writeFileSync(FIRST, "");
  const a = run("same slug");
  is("a name taken locally moves to -2", a.out, `${T3_WT}/journal/2026-09-13/2015-same-slug-2.md`);
  writeFileSync(a.out, "");
  const b = run("same slug");
  is("…then to -3", b.out, `${T3_WT}/journal/2026-09-13/2015-same-slug-3.md`);
});

// ── A name taken on origin/main by a thread that landed first ──────────────
//
// The other thread wrote it in ITS worktree, so nothing here can see it except
// by looking at the remote.

test("a name taken on origin/main by a thread that landed first", () => {
  const OTHER = join(TMP, "other-thread");
  git("clone", "-q", CODEBARE, OTHER);
  git("-C", OTHER, "config", "user.email", "t@example.com");
  git("-C", OTHER, "config", "user.name", "tester");
  mkdirSync(join(OTHER, "journal/2026-09-13"), { recursive: true });
  writeFileSync(join(OTHER, "journal/2026-09-13/2015-remote-slug.md"), "another session\n");
  git("-C", OTHER, "add", "journal");
  git("-C", OTHER, "commit", "-q", "-m", "another thread's close");
  git("-C", OTHER, "push", "-q", "origin", "main");

  assert.ok(
    !existsSync(join(T3_WT, "journal/2026-09-13/2015-remote-slug.md")),
    "fixture error: the name is visible locally",
  );

  const r = run("remote slug");
  is("a name taken only on origin/main still moves to -2", r.out, `${T3_WT}/journal/2026-09-13/2015-remote-slug-2.md`);
});

// ── --existing: the resume path ────────────────────────────────────────────

test("--existing: the resume path", () => {
  const RESUME = run("resume me").out;
  let r = run("--existing");
  is("--existing exits 1 while the file is unwritten", String(r.rc), "1");
  is("…and prints nothing", r.out, "");

  writeFileSync(RESUME, "written\n");
  r = run("--existing");
  is("--existing prints the path once the file is there", r.out, RESUME);
  is("…and exits 0", String(r.rc), "0");

  // A second close must resume on that file, not allocate a second one.
  r = run("resume me");
  is(
    "re-running with the same slug does not reuse a written name",
    r.out,
    `${T3_WT}/journal/2026-09-13/2015-resume-me-2.md`,
  );
});

// ── --check ────────────────────────────────────────────────────────────────

test("--check", () => {
  // A failed Land must reuse its entry, expose the validation error before any
  // repo is pushed, and accept a repair without allocating another filename.
  let r = run("--check");
  is("--check exits 1 while the allocated journal is unwritten", String(r.rc), "1");
  is("an unwritten journal check prints nothing", r.out, "");

  const CHECK_PATH = readFileSync(join(LEDGER_DIR, "journal"), "utf8").trimEnd();
  writeFileSync(
    CHECK_PATH,
    `---
date: 2026-09-13
time: "20:15"
slug: security-policy-ai
tags: []
---

### one-off (security policy and client data in AI)
**Action:** completed

Policy drafted.
`,
  );
  r = run("--check");
  is("the real filename-stem/title mismatch exits 3", String(r.rc), "3");
  has("the check exposes the existing validator's diagnosis", r.out, "front matter says slug");
  is(
    "a failed check preserves the allocated path",
    readFileSync(join(LEDGER_DIR, "journal"), "utf8").trimEnd(),
    CHECK_PATH,
  );
  is(
    "a failed check leaves the journal intact",
    readFileSync(CHECK_PATH, "utf8").split("\n")[3] ?? "",
    "slug: security-policy-ai",
  );

  writeFileSync(
    CHECK_PATH,
    readFileSync(CHECK_PATH, "utf8").replace(
      /^slug: security-policy-ai$/m,
      "slug: one-off (security policy and client data in AI)",
    ),
  );
  r = run("--check");
  is("repairing the title makes the same journal pass", String(r.rc), "0");
  is("a successful check prints the existing path", r.out, CHECK_PATH);
  r = run("--existing");
  is("resume still uses the repaired journal", r.out, CHECK_PATH);
});

// ── --existing after the close removed the worktree ────────────────────────
//
// `land.ts` merges the entry to the trunk and then REMOVES this thread's
// worktree of this repo — when that worktree is a satellite, which it is for
// a thread T3 opened on a product repo. Work continues in the same session, so
// the next close has to resume on the entry it already landed — but the
// recorded path is off disk until write-root re-adds the worktree at the same
// deterministic path, and the entry itself is safe on the trunk. Testing the
// path before that recreation reports the entry missing, and the allocator
// then files a second entry beside the landed one.
//
// Thread two is that shape: its T3 worktree is of the PROD repo, and the script
// runs out of the shared code checkout — the path the `~/.agents/skills` link
// resolves to — so the code repo is a satellite it creates on first write.

test("--existing after the close removed the worktree", () => {
  const first = run2("landed then removed");
  const LANDED = first.out;
  is("a thread on another repo files its journal in a satellite of this one", String(first.rc), "0");
  // Everything below writes to LANDED. When the allocation failed, it is the
  // error text, and writing to it as a filename would plant a file named
  // `write-root: not a repo I know: …` in this scripts folder. A failed
  // allocation ends the case here instead.
  assert.ok(first.rc === 0 && LANDED.startsWith("/"), `allocation failed, cannot continue: ${LANDED}`);
  const CODESAT = LANDED.slice(0, LANDED.indexOf("/journal/"));
  has("…under the thread's cache, not under its own T3 worktree", CODESAT, `/.cache/workbench/worktrees/${TAG}-code-`);
  writeFileSync(
    LANDED,
    `---
date: 2026-09-13
time: "20:15"
slug: landed-then-removed
tags: []
---

### landed-then-removed
**Action:** completed

The entry this session landed.
`,
  );
  git("-C", CODESAT, "add", "-A");
  git(
    "-C",
    CODESAT,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=tester",
    "commit",
    "-q",
    "-m",
    "close: land the entry",
  );
  // The other thread above landed first, so this branch merges the trunk before
  // pushing — exactly what land.ts does, and without it the entry never reaches
  // origin/main and this test would be red for the wrong reason.
  git("-C", CODESAT, "fetch", "-q", "origin", "main");
  git(
    "-C",
    CODESAT,
    "-c",
    "user.email=t@example.com",
    "-c",
    "user.name=tester",
    "merge",
    "-q",
    "--no-edit",
    "FETCH_HEAD",
  );
  git("-C", CODESAT, "push", "-q", "origin", "HEAD:main");
  const branch = spawnSync("git", ["-C", CODESAT, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" });
  const LANDED_BRANCH = (branch.stdout ?? "").trim();
  git("-C", CODE, "worktree", "remove", "--force", CODESAT);
  git("-C", CODE, "branch", "-q", "-D", LANDED_BRANCH);

  assert.ok(!existsSync(LANDED), "fixture error: the recorded path survived the removal");

  let r = run2("--existing");
  is("--existing recovers the landed entry after the worktree is gone", r.out, LANDED);
  is("…and exits 0", String(r.rc), "0");
  const line11 = existsSync(LANDED) ? (readFileSync(LANDED, "utf8").split("\n")[10] ?? "") : "";
  is("…and the entry is really back at that path", line11, "The entry this session landed.");

  r = run2("--check");
  is("--check validates the recovered entry rather than reporting it missing", String(r.rc), "0");
  is("…and prints the same path", r.out, LANDED);

  // A recorded path that is missing for any OTHER reason is still a miss — the
  // recovery is not allowed to turn "no entry yet" into a phantom one.
  writeFileSync(join(LEDGER_DIR2, "journal"), `${CODESAT}/journal/2026-09-13/2015-never-written.md\n`);
  r = run2("--existing");
  is("a recorded path absent from the trunk too still exits 1", String(r.rc), "1");
  is("…and prints nothing", r.out, "");
  writeFileSync(join(LEDGER_DIR2, "journal"), `${LANDED}\n`);
});

// ── A warning on thread.ts's stderr is not part of the thread id ──────────
// Node 22.x prints a type-stripping ExperimentalWarning on stderr in every
// child. Merged into the id, it put the chosen path in a ledger no close reads.
// The preload writes that warning in every Node this run starts.
test("a Node warning on thread.ts's stderr is not part of the thread id", () => {
  const preload = join(TMP, "strip-warns.mjs");
  writeFileSync(
    preload,
    'process.stderr.write("(node:111) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\\n");\n',
  );
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "warned slug"], {
    encoding: "utf8",
    cwd: T3_WT,
    env: { ...ENV, NODE_OPTIONS: `--no-warnings --import ${preload}` },
    timeout: 120_000,
  });
  const path = `${T3_WT}/journal/2026-09-13/2015-warned-slug.md`;
  is(`exits 0: ${r.stderr}`, String(r.status), "0");
  is("the path on stdout", r.stdout.trimEnd(), path);
  is("…persisted in this thread's own ledger", readFileSync(join(LEDGER_DIR, "journal"), "utf8").trimEnd(), path);
  const stray = readdirSync(dirname(LEDGER_DIR)).filter((d) => d.includes("ExperimentalWarning"));
  is("and no ledger named for the warning", stray.join(","), "");
});

// ── Usage and no thread ────────────────────────────────────────────────────

test("usage and no thread", () => {
  const r = run("--check", "unexpected");
  is("check rejects extra arguments", String(r.rc), "2");

  const r2 = spawnScript(SCRIPT, TMP, ["x"], childEnv({ HOME: FAKE_HOME, T3CODE_HOME: join(TMP, "nowhere") }));
  is("outside a thread it exits 2", String(r2.rc), "2");
  has("and says why, rather than choosing a path anyway", r2.out, "not in a thread");
});

// A harness may reach every skill script through a symlink (a skills folder
// linked to the repo's .agents/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "journal-file.ts");
  symlinkSync(join(HERE, "journal-file.ts"), link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...[]], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /usage: journal-file\.ts/);
});
