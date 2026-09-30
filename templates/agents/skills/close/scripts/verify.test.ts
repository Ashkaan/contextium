// verify.test.ts — which apps get verified, and what each outcome prints.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/verify.test.ts
//
// The runner is stubbed. `VERIFY_RUNNER` points at a program that does what
// `npm run` does — look the name up in ./package.json's scripts and execute it —
// so the fixtures exercise the real "did this half pass" path without needing
// npm, a node_modules tree, or the toolchain wrapper.
//
// Every fixture is built in a temporary folder by the test itself. The cases
// run in order and share one fixture, as the shell suite did: each builds on
// the tree the one before it left.
//
// HERMETIC. Every child runs with a scratch HOME, a T3CODE_HOME that does not
// exist, no harness session id, and its cwd in the scratch folder (no git
// repo): thread.ts would otherwise resolve the session this suite happens to
// run in, and verify would register and check the worktree the suite was
// started from.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "verify.ts");
const TMP = mkdtempSync(join(tmpdir(), "verify-test-"));
after(() => {
  spawnSync("chmod", ["-R", "u+rwx", TMP]);
  rmSync(TMP, { recursive: true, force: true });
});

const is = (name: string, got: string, want: string): void => assert.equal(got, want, name);
const has = (name: string, got: string, needle: string): void =>
  assert.ok(got.includes(needle), `${name}: '${got}' lacks '${needle}'`);
const hasnt = (name: string, got: string, needle: string): void =>
  assert.ok(!got.includes(needle), `${name}: '${got}' should not mention '${needle}'`);
const ok = (name: string, cond: boolean): void => assert.ok(cond, name);

function git(...args: string[]): void {
  const r = spawnSync("git", args, { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

const FAKE_HOME = join(TMP, "home");
const TID = "eeeeeeee-1111-2222-3333-666666666666";
const LEDGER_DIR = join(FAKE_HOME, ".cache/workbench/threads", TID);
mkdirSync(LEDGER_DIR, { recursive: true });
const LEDGER = join(LEDGER_DIR, "worktrees");

const RUNNER = join(TMP, "fake-npm.ts");
writeFileSync(
  RUNNER,
  `// Stands in for \`npm run <name>\`: look the script up where npm looks, run it
// where npm runs it, exit with what it exits with.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
const name = process.argv[2] ?? "";
const parsed: { scripts?: Record<string, string> } = JSON.parse(readFileSync("package.json", "utf8"));
const cmd = (parsed.scripts ?? {})[name] ?? "";
if (!cmd) {
  process.stderr.write(\`missing script: \${name}\\n\`);
  process.exit(1);
}
process.exit(spawnSync("sh", ["-c", cmd], { stdio: "inherit" }).status ?? 1);
`,
);
const RUNNER_CMD = `${process.execPath} --experimental-strip-types ${RUNNER}`;

type Env = Record<string, string>;
const E: Env = { HOME: FAKE_HOME, WORKBENCH_THREAD_ID: TID, VERIFY_RUNNER: RUNNER_CMD };

// The environment every child starts from: this process's, less anything that
// names the session or harness running the suite.
const BASE: NodeJS.ProcessEnv = { ...process.env, T3CODE_HOME: join(TMP, "no-t3") };
for (const k of [
  "WORKBENCH_THREAD_ID",
  "CLAUDE_PROJECT_DIR",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_SESSION_ID",
  "CONTEXTIUM_SESSION",
  "CONTEXTIUM_HARNESS",
  "VERIFY_SKILLS_TIMEOUT",
  "VERIFY_IMPORTER_CAP",
  "NODE_OPTIONS",
]) {
  delete BASE[k];
}

type Run = { OUT: string; RC: number };

/** `$(env … verify 2>&1)`: stdout and stderr together, trailing newlines stripped. */
function runWith(env: Env, cwd: string = TMP): Run {
  const e: NodeJS.ProcessEnv = { ...BASE, ...env };
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT], {
    encoding: "utf8",
    env: e,
    cwd,
    timeout: 300_000,
  });
  return { OUT: `${r.stdout ?? ""}${r.stderr ?? ""}`.replace(/\n+$/, ""), RC: r.status ?? -1 };
}
const run = (extra: Env = {}): Run => runWith({ ...E, ...extra });

const row = (...cols: string[]): string => `${cols.join("\t")}\n`;

// ── A workbench-shaped worktree with a bare origin ─────────────────────────

const BARE = join(TMP, "origin.git");
const WT = join(TMP, "wt");
git("init", "-q", "--bare", "-b", "main", BARE);
git("init", "-q", "-b", "main", WT);
git("-C", WT, "config", "user.email", "t@example.com");
git("-C", WT, "config", "user.name", "tester");

// app <domain/name> <check-script-or-> <test-script-or->
function app(name: string, check: string, testScript: string): void {
  const dir = join(WT, "apps", name);
  mkdirSync(join(dir, "src"), { recursive: true });
  let scripts = "";
  if (check !== "-") scripts = `"check": "${check}"`;
  if (testScript !== "-") scripts = `${scripts}${scripts ? ", " : ""}"test": "${testScript}"`;
  writeFileSync(join(dir, "package.json"), `{ "name": "${basename(name)}", "scripts": { ${scripts} } }\n`);
  writeFileSync(join(dir, "src/index.ts"), "// code\n");
}

app("health/green", "true", "true");
app("health/red-test", "true", "exit 1");
app("health/red-check", "exit 1", "true");
app("tools/bare", "-", "-");
app("tools/test-only", "-", "true");
app("health/untouched", "true", "true");

// `integrations/` and `packages/` hold shared code the importer pass reads, and
// `.agents/skills/` is here so this worktree answers the prove-check that finds
// the WORKBENCH row for the skills pass below. Empty directories are invisible
// to git, so each carries a file.
for (const d of ["integrations", "packages", ".agents/skills"]) mkdirSync(join(WT, d), { recursive: true });
writeFileSync(join(WT, "integrations/.keep"), "// shared\n");
writeFileSync(join(WT, "packages/.keep"), "// shared\n");
writeFileSync(join(WT, ".agents/skills/.keep"), "# skills\n");

git("-C", WT, "add", "apps", "integrations", "packages", ".agents");
git("-C", WT, "commit", "-q", "-m", "seed");
git("-C", WT, "remote", "add", "origin", BARE);
git("-C", WT, "push", "-q", "-u", "origin", "main");

// A product-repo-shaped worktree: no apps/ at all. The records live in the
// workbench itself, so a row without apps/ can only be a product repo's.
const PRODWT = join(TMP, "prodwt");
mkdirSync(join(PRODWT, "src"), { recursive: true });
git("init", "-q", "-b", "main", PRODWT);
git("-C", PRODWT, "config", "user.email", "t@example.com");
git("-C", PRODWT, "config", "user.name", "tester");
writeFileSync(join(PRODWT, "src/seed.ts"), "x\n");
git("-C", PRODWT, "add", "src");
git("-C", PRODWT, "commit", "-q", "-m", "seed");

writeFileSync(
  LEDGER,
  row(WT, join(TMP, "shared"), `t3/${TID}`) +
    row(PRODWT, join(TMP, "prodshared"), `t3/${TID}`) +
    row(join(TMP, "deleted-worktree"), join(TMP, "x"), `t3/${TID}`),
);

// The shell suite's `$OUT` and `$RC` carried from one block to the next.
let OUT = "";
let RC = 0;
const go = (extra: Env = {}): void => {
  ({ OUT, RC } = run(extra));
};

test("nothing changed yet: every app is at origin/main", () => {
  go();
  is("a thread that changed nothing exits 0", String(RC), "0");
  has("and says there was nothing to verify", OUT, "no app files changed");
});

test("an uncommitted edit brings exactly one app into scope", () => {
  appendFileSync(join(WT, "apps/health/green/src/index.ts"), "// edited\n");
  go();
  is("a green app exits 0", String(RC), "0");
  has("and is reported ok", OUT, "ok health/green");
  hasnt("an app nobody touched is not verified", OUT, "health/untouched");
  hasnt("a worktree with no apps/ contributes nothing", OUT, "prodwt");
});

test("an untracked file counts as a change", () => {
  writeFileSync(join(WT, "apps/tools/test-only/src/new.ts"), "// new\n");
  go();
  has("an untracked file brings its app into scope", OUT, "tools/test-only");
  has("an app missing one half is unverified, not failed", OUT, "unverified tools/test-only — no check script");
  is("…and that does not fail the close", String(RC), "0");
});

test("a committed change counts too, via origin/main...HEAD", () => {
  appendFileSync(join(WT, "apps/tools/bare/src/index.ts"), "// committed\n");
  git("-C", WT, "add", "apps/tools/bare/src/index.ts");
  git("-C", WT, "commit", "-q", "-m", "an app with neither script");
  go();
  has("a committed change is in scope", OUT, "tools/bare");
  has("an app with neither script names both", OUT, "unverified tools/bare — no check or test script");
  is("…and still does not fail the close", String(RC), "0");
});

// A workbench may keep its apps flat — `apps/<name>/` with no domain folder. The
// app is the nearest folder under apps/ that holds a package.json, whichever
// depth that is, and its label is that path without `apps/`.
test("an app directly under apps/ (a flat layout) is its own unit", () => {
  mkdirSync(join(WT, "apps/flatapp/src/deep"), { recursive: true });
  writeFileSync(join(WT, "apps/flatapp/package.json"), '{ "name": "flatapp", "scripts": { "check": "true", "test": "true" } }\n');
  writeFileSync(join(WT, "apps/flatapp/src/deep/index.ts"), "// flat\n");
  go();
  has("a flat apps/<name>/ app is found by its package.json", OUT, "ok flatapp");
  hasnt("and a folder inside it is not an app of its own", OUT, "flatapp/src");
  rmSync(join(WT, "apps/flatapp"), { recursive: true, force: true });
});

test("a red half halts, names the half, and hands back the exact command", () => {
  appendFileSync(join(WT, "apps/health/red-test/src/index.ts"), "// edited\n");
  go();
  is("a red test exits 1", String(RC), "1");
  has("naming the app and the half", OUT, "FAIL health/red-test test");
  has("with the rerun command", OUT, `rerun: cd ${WT}/apps/health/red-test && ${RUNNER_CMD} test`);
  hasnt("a failing app is not also reported ok", OUT, "ok health/red-test");
  has("the green app is still reported", OUT, "ok health/green");

  appendFileSync(join(WT, "apps/health/red-check/src/index.ts"), "// edited\n");
  go();
  has("a red check is caught too", OUT, "FAIL health/red-check check");
  is("and still exits 1", String(RC), "1");
});

test("the log is where the line says it is", () => {
  const LOGFILE = join(LEDGER_DIR, "verify/health-red-test-test.log");
  ok(`no log at ${LOGFILE}`, existsSync(LOGFILE));
  has("and the line points at it", OUT, `log: ${LOGFILE}`);
});

test("a ledger worktree that no longer exists is skipped, not fatal", () => {
  hasnt("a removed worktree does not crash the verify", OUT, "deleted-worktree");
});

test("no ledger at all", () => {
  const r = runWith({ HOME: join(TMP, "empty-home"), WORKBENCH_THREAD_ID: TID, VERIFY_RUNNER: RUNNER_CMD });
  is("a thread with no ledger exits 0", String(r.RC), "0");
  has("saying it owns no worktrees", r.OUT, "owns no worktrees");
});

test("no thread", () => {
  const env: NodeJS.ProcessEnv = { ...BASE, HOME: FAKE_HOME, T3CODE_HOME: join(TMP, "nowhere") };
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], { encoding: "utf8", env, cwd: TMP });
  const OUT3 = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  is("no thread exits 2", String(r.status), "2");
  has("and says so rather than verifying nothing silently", OUT3, "not in a thread");
});

// Node 22.x prints a type-stripping ExperimentalWarning on stderr in every
// child, thread.ts included. Merged into the thread id it named a thread with no
// ledger, and verify said "nothing to verify" and exited 0. The preload writes
// that warning in every Node this run starts, as such a Node does.
test("a Node warning on thread.ts's stderr is not part of the thread id", () => {
  const preload = join(TMP, "strip-warns.mjs");
  writeFileSync(
    preload,
    'process.stderr.write("(node:111) ExperimentalWarning: Type Stripping is an experimental feature and might change at any time\\n");\n',
  );
  const spawnIt = (extra: Env) =>
    spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT], {
      encoding: "utf8",
      env: { ...BASE, ...E, ...extra },
      cwd: TMP,
      timeout: 300_000,
    });
  const plain = spawnIt({});
  const warned = spawnIt({ NODE_OPTIONS: `--import ${preload}` });
  is("the same verdict", String(warned.status), String(plain.status));
  is("the same result lines", warned.stdout, plain.stdout);
});

// Change discovery that FAILED is not discovery that found nothing: a failed
// `git diff HEAD` or `git ls-files` dropped every uncommitted app from scope,
// and the close passed without running their checks.
test("a git read that fails halts rather than shrinking the verify set", () => {
  const bin = join(TMP, "failgit-bin");
  mkdirSync(bin, { recursive: true });
  const realGit = spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  for (const [name, match] of [
    ["diff", '*" diff HEAD --name-only "*'],
    ["ls-files", '*" ls-files --others "*'],
  ] as const) {
    writeFileSync(
      join(bin, "git"),
      `#!/usr/bin/env bash\ncase " $* " in ${match}) echo "fatal: index file corrupt" >&2; exit 128 ;; esac\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const r = run({ PATH: `${bin}:${process.env.PATH ?? ""}` });
    ok(`a failed ${name} exits non-zero (got ${r.RC}): ${r.OUT}`, r.RC !== 0);
    has(`a failed ${name} is named`, r.OUT, `FAIL verify — could not list the changed files in ${WT}`);
    has("…with git's own reason", r.OUT, "index file corrupt");
  }
});

// Registering the thread's own worktree is what gives a session that never
// asked the resolver a ledger at all. A registration that failed, with no
// ledger behind it, read as "nothing to verify" and exited 0.
// The session's own worktree is what thread.ts records in `<thread>/own` for a
// session outside T3 — the harness-neutral path, and one that needs no
// node:sqlite (flagged on Node 22.6) to stage. Pointed at a folder that is not a
// repo, write-root refuses it.
test("a failed registration of the thread's worktree is a failure", () => {
  const home = join(TMP, "reg-home");
  const notRepo = join(TMP, "reg-not-a-repo");
  mkdirSync(join(home, ".cache/workbench/threads", TID), { recursive: true });
  mkdirSync(notRepo, { recursive: true });
  writeFileSync(join(home, ".cache/workbench/threads", TID, "own"), `${notRepo}\n`);
  const r = runWith({ HOME: home, WORKBENCH_THREAD_ID: TID, VERIFY_RUNNER: RUNNER_CMD });
  is("a failed registration exits 1", String(r.RC), "1");
  has("naming the worktree it could not register", r.OUT, `FAIL verify — could not register ${notRepo}`);
  has("…with write-root's reason", r.OUT, "not a git repo");
  hasnt("and never says there was nothing to verify", r.OUT, "nothing to verify");
});

test("a manifest that cannot be parsed is a failure, not 'unverified'", () => {
  writeFileSync(join(WT, "apps/health/green/package.json"), '{ "name": "green", "scripts": { "check": "true", }\n');
  go();
  is("an unparseable package.json fails the close", String(RC), "1");
  has("naming the manifest", OUT, "could not be parsed");
  hasnt("and does not pass it off as merely unverified", OUT, "unverified health/green");
});

// ── A session confined to shared code verifies the apps that import it ─────
//
// The importer hole: a fix in `integrations/` with two consuming apps would run
// no check at all and report "no app files changed". The importer pass is reached
// ONLY when no app's own files moved, so every assertion above still holds.

const CLEAN = join(TMP, "clean");
const CLEDGER = LEDGER;
const commitPush = (dir: string, msg: string): void => {
  git("-C", dir, "add", "-A");
  git("-C", dir, "commit", "-q", "-m", msg);
  git("-C", dir, "push", "-q", "origin", "main");
};

test("a session confined to shared code verifies the apps that import it", () => {
  git("clone", "-q", BARE, CLEAN);
  git("-C", CLEAN, "config", "user.email", "t@example.com");
  git("-C", CLEAN, "config", "user.name", "tester");
  // Repair the manifest the previous block broke — this fixture is about scope.
  writeFileSync(
    join(CLEAN, "apps/health/green/package.json"),
    '{ "name": "green", "scripts": { "check": "true", "test": "true" } }\n',
  );
  // Two importers of one shared file, one non-importer.
  mkdirSync(join(CLEAN, "integrations/komodo"), { recursive: true });
  writeFileSync(join(CLEAN, "integrations/komodo/komodo.ts"), "export const x = 1;\n");
  const imp = 'import { x } from "../../../../integrations/komodo/komodo.ts";\n';
  writeFileSync(join(CLEAN, "apps/health/green/src/uses.ts"), imp);
  writeFileSync(join(CLEAN, "apps/tools/test-only/src/uses.ts"), imp);
  commitPush(CLEAN, "wiring");

  copyFileSync(CLEDGER, join(TMP, "ledger.bak"));
  writeFileSync(CLEDGER, row(CLEAN, join(TMP, "cshared"), `t3/${TID}`));

  // Now change ONLY the shared file.
  appendFileSync(join(CLEAN, "integrations/komodo/komodo.ts"), "export const y = 2;\n");

  go();
  is("a shared-only change exits 0 when its importers are green", String(RC), "0");
  has("it says why it widened the scope", OUT, "no app files changed — verifying");
  has("the first importer is verified", OUT, "ok health/green");
  // This fixture app declares no `check`, so being pulled into scope correctly
  // reports the app's own gap rather than a pass.
  has("the second importer is pulled in too", OUT, "unverified tools/test-only — no check script");
  hasnt("an app that imports nothing is left alone", OUT, "health/untouched");
  hasnt("and it no longer claims there was nothing to verify", OUT, "no app files changed in this thread");
});

test("a red importer fails the close", () => {
  writeFileSync(
    join(CLEAN, "apps/health/green/package.json"),
    '{ "name": "green", "scripts": { "check": "exit 1", "test": "true" } }\n',
  );
  commitPush(CLEAN, "red");
  appendFileSync(join(CLEAN, "integrations/komodo/komodo.ts"), "export const z = 3;\n");
  go();
  is("a broken importer fails the close", String(RC), "1");
  has("naming the app and half", OUT, "FAIL health/green check");
  writeFileSync(
    join(CLEAN, "apps/health/green/package.json"),
    '{ "name": "green", "scripts": { "check": "true", "test": "true" } }\n',
  );
  commitPush(CLEAN, "fixed");
});

test("past the cap the importers are named, not run", () => {
  appendFileSync(join(CLEAN, "integrations/komodo/komodo.ts"), "export const w = 4;\n");
  go({ VERIFY_IMPORTER_CAP: "1" });
  is("past the cap the close still exits 0", String(RC), "0");
  has("the apps are named rather than run", OUT, "past the cap");
  hasnt("and none of them is reported ok", OUT, "ok health/green");
});

test("an app edit keeps the narrow scope, cap or no cap", () => {
  appendFileSync(join(CLEAN, "apps/health/green/src/index.ts"), "// touched\n");
  go();
  has("an app edit is verified directly", OUT, "ok health/green");
  hasnt("and the importer pass never runs", OUT, "no app files changed — verifying");
  hasnt("so a co-importer stays out of scope", OUT, "tools/test-only");
});

// ── An integration that owns a suite is verified in pass 1 ────────────────
//
// The integration hole, and it is NOT the importer one above: pass 2 fires only
// when pass 1 verified nothing, so a session that touched an app AND an
// integration would verify the app and skip the integration entirely —
// harmless until an integration owns a suite, then its tests run on no close.

test("an integration that owns a suite is verified in pass 1", () => {
  mkdirSync(join(CLEAN, "integrations/withsuite"), { recursive: true });
  mkdirSync(join(CLEAN, "integrations/nosuite"), { recursive: true });
  writeFileSync(
    join(CLEAN, "integrations/withsuite/package.json"),
    '{ "name": "withsuite", "scripts": { "check": "true", "test": "true" } }\n',
  );
  writeFileSync(join(CLEAN, "integrations/nosuite/package.json"), '{ "name": "nosuite" }\n');
  writeFileSync(join(CLEAN, "integrations/withsuite/lib.ts"), "export const a = 1;\n");
  writeFileSync(join(CLEAN, "integrations/nosuite/lib.ts"), "export const b = 1;\n");
  commitPush(CLEAN, "integrations");

  // An app AND both integrations move, so pass 1 is non-empty and pass 2 is out.
  appendFileSync(join(CLEAN, "apps/health/green/src/index.ts"), "// touched\n");
  appendFileSync(join(CLEAN, "integrations/withsuite/lib.ts"), "export const a2 = 2;\n");
  appendFileSync(join(CLEAN, "integrations/nosuite/lib.ts"), "export const b2 = 2;\n");
  go();
  is("an app plus an integration exits 0 when both are green", String(RC), "0");
  has("the app is still verified directly", OUT, "ok health/green");
  has("and the integration that declares a suite is too", OUT, "ok integrations/withsuite");
  hasnt("an integration with no scripts is silent, not unverified", OUT, "integrations/nosuite");
  hasnt("and pass 2 is still not reached", OUT, "no app files changed — verifying");

  // A red integration half fails the close, exactly like a red app half.
  writeFileSync(
    join(CLEAN, "integrations/withsuite/package.json"),
    '{ "name": "withsuite", "scripts": { "check": "true", "test": "exit 1" } }\n',
  );
  go();
  is("a red integration test fails the close", String(RC), "1");
  has("naming the integration and the half", OUT, "FAIL integrations/withsuite test");
  writeFileSync(
    join(CLEAN, "integrations/withsuite/package.json"),
    '{ "name": "withsuite", "scripts": { "check": "true", "test": "true" } }\n',
  );

  // An integration alone, with no app touched at all: pass 1 still verifies it,
  // and pass 2 also runs because SEEN holds no APP — the importer fallback must
  // not be suppressed by an integration having verified itself.
  commitPush(CLEAN, "green");
  appendFileSync(join(CLEAN, "integrations/withsuite/lib.ts"), "export const a3 = 3;\n");
  go();
  is("an integration-only session exits 0", String(RC), "0");
  has("the integration verifies itself", OUT, "ok integrations/withsuite");

  // A manifest that exists and cannot be parsed is not a manifest with no
  // scripts: it fails, as a broken app manifest does. One that does not exist
  // at all stays silent.
  mkdirSync(join(CLEAN, "integrations/broken"), { recursive: true });
  mkdirSync(join(CLEAN, "integrations/nomanifest"), { recursive: true });
  writeFileSync(
    join(CLEAN, "integrations/broken/package.json"),
    '{ "name": "broken", "scripts": { "test": "true", }\n',
  );
  writeFileSync(join(CLEAN, "integrations/broken/lib.ts"), "export const c = 1;\n");
  writeFileSync(join(CLEAN, "integrations/nomanifest/lib.ts"), "export const d = 1;\n");
  go();
  is("a malformed integration manifest fails the close", String(RC), "1");
  has(
    "naming the manifest",
    OUT,
    `FAIL integrations/broken check — ${CLEAN}/integrations/broken/package.json could not be parsed`,
  );
  hasnt("an integration with no manifest is silent", OUT, "integrations/nomanifest");
  rmSync(join(CLEAN, "integrations/broken"), { recursive: true, force: true });
  rmSync(join(CLEAN, "integrations/nomanifest"), { recursive: true, force: true });

  copyFileSync(join(TMP, "ledger.bak"), CLEDGER);
});

// ── The skills tree ────────────────────────────────────────────────────────
//
// Built last and on its own ledger. The skills live at `.agents/skills/` of
// the WORKBENCH row — the ledger row whose worktree holds .agents/skills/ — so
// the fixtures below sit in the SAME row as the apps,
// not in a repo of their own. Until the code fixture carries a `.agents/skills/` change
// the pass finds no unit and prints nothing, which is what keeps every assertion
// above about apps only.

// A PRISTINE clone for the workbench row. `WT` by now carries every edit the
// app cases above made, two of them deliberately red, and an app FAIL would land
// in the exit code of every skills assertion below.
const WBCLEAN = join(TMP, "wb-clean");
const SK = join(WBCLEAN, ".agents/skills");
const WB_SHARED = join(TMP, "wb-shared");
let WB_CANON = "";
const SKLEDGER = LEDGER;
// What `land.ts` writes, and what verify reads to tell a landed row from a lost
// one. Beside the ledger, under the same thread directory.
const LANDED_FILE = join(dirname(LEDGER), "landed");

/** A bash suite: `#!/usr/bin/env bash` and a body. Bash suites still exist in
 *  other rows' folders and the hooks, and verify still runs them with bash. */
function suite(rel: string, body: string): void {
  mkdirSync(dirname(join(SK, rel)), { recursive: true });
  writeFileSync(join(SK, rel), `#!/usr/bin/env bash\n${body}\n`);
}

// Every case touches ONE path and cleans up after itself, so the unit under test
// is the only one in scope.
function sk(rel: string): void {
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  writeFileSync(join(SK, rel), "// touched\n");
  go();
}

const LOG = (name: string): string => join(LEDGER_DIR, "verify", name);
const SLOW = `30.${String(process.pid).padStart(7, "0")}`;

test("the skills tree: fixture", () => {
  git("clone", "-q", BARE, WBCLEAN);
  git("-C", WBCLEAN, "config", "user.email", "t@example.com");
  git("-C", WBCLEAN, "config", "user.name", "tester");

  // A skills tree: an AGENTS.md at its root, folders that carry suites and one
  // that does not, and a root-level suite for the launcher.
  writeFileSync(join(SK, "AGENTS.md"), "# skills\n");
  // A launcher that actually launches: a stub would report every `*.test.ts`
  // green whatever it contained — the one outcome a suite runner must not have.
  // Minimal on purpose: the real run.ts's flag handling is run.test.ts's
  // subject, and what is under test here is discovery, the workbench-row gate,
  // and the red/green reporting around it.
  writeFileSync(
    join(SK, "run.ts"),
    `import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const checkout = dirname(fileURLToPath(import.meta.url));
const [rel, ...rest] = process.argv.slice(2);
const r = spawnSync(process.execPath, ["--experimental-strip-types", join(checkout, rel ?? ""), ...rest], { stdio: "inherit" });
process.exit(r.status ?? 1);
`,
  );

  // node:test suites — the shape most real skill folders use, with no
  // `*.test.sh` beside them, which this function used to report as `no test
  // suites`.
  mkdirSync(join(SK, "tsgreen/scripts"), { recursive: true });
  mkdirSync(join(SK, "tsred/scripts"), { recursive: true });
  writeFileSync(
    join(SK, "tsgreen/scripts/ok.test.ts"),
    `import { strict as assert } from "node:assert";
import { test } from "node:test";
test("a passing node:test suite", () => {
  const n: number = 1;
  assert.equal(n, 1);
});
`,
  );
  writeFileSync(
    join(SK, "tsred/scripts/bad.test.ts"),
    `import { strict as assert } from "node:assert";
import { test } from "node:test";
test("a failing node:test suite", () => {
  assert.equal(1, 2, "the node:test assertion that failed");
});
`,
  );
  suite("run.test.sh", "exit 0");
  suite("alpha/verify.test.sh", "exit 0");
  suite("alpha/scripts/deep.test.sh", "exit 0");
  suite("beta/verify.test.sh", "exit 0");
  // The shape of .agents/skills/review: a flat folder of suites beside the
  // scripts they test, plus an `evals/` file that is NOT a suite and must not run.
  suite("review/code-review.test.sh", "exit 0");
  suite("review/policy-chain.test.sh", "exit 0");
  mkdirSync(join(SK, "review/evals"), { recursive: true });
  writeFileSync(
    join(SK, "review/evals/caller-contract.eval.ts"),
    'process.stderr.write("the eval ran as a suite\\n");\nprocess.exit(1);\n',
  );
  mkdirSync(join(SK, "gamma"), { recursive: true });
  writeFileSync(join(SK, "gamma/README.md"), "# no suites here\n");
  suite("red/bad.test.sh", 'echo "the assertion that failed" >&2; exit 1');
  // A duration unique to this run, so the check below that the watchdog took the
  // suite's own children with it finds this `sleep` and nothing else — not even
  // the one of another run of this suite going on at the same time.
  suite("slow/slow.test.sh", `sleep ${SLOW}`);
  // Reads the export the pass makes. cwd is the workbench worktree itself now, so
  // a suite could also ask git — this pins that the export still names that tree.
  suite(
    "cpd/cpd.test.sh",
    '[ -z "${CLAUDE_PROJECT_DIR:-}" ] || { echo "CLAUDE_PROJECT_DIR=[${CLAUDE_PROJECT_DIR:-}] leaked into a suite" >&2; exit 1; }',
  );

  // `.agents/checks/` and `.agents/generators/` are one unit each: a green
  // checks folder whose suites recurse, and a generators folder with a red one.
  mkdirSync(join(WBCLEAN, ".agents/checks/sub"), { recursive: true });
  mkdirSync(join(WBCLEAN, ".agents/generators"), { recursive: true });
  writeFileSync(join(WBCLEAN, ".agents/checks/c.ts"), "export const c = 1;\n");
  writeFileSync(
    join(WBCLEAN, ".agents/checks/c.test.ts"),
    'import { test } from "node:test";\ntest("a green check suite", () => {});\n',
  );
  writeFileSync(join(WBCLEAN, ".agents/checks/sub/d.test.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(WBCLEAN, ".agents/generators/g.ts"), "export const g = 1;\n");
  writeFileSync(
    join(WBCLEAN, ".agents/generators/bad.test.ts"),
    'import { strict as assert } from "node:assert";\nimport { test } from "node:test";\ntest("a red generator suite", () => assert.equal(1, 2));\n',
  );

  git("-C", WBCLEAN, "add", "--", ".agents");
  git("-C", WBCLEAN, "commit", "-q", "-m", "skills seed");
  git("-C", WBCLEAN, "push", "-q", "origin", "main");

  // The SHARED checkout of the workbench row — the tree a write through the
  // `~/.agents/skills` link lands in when it never reached a worktree.
  git("clone", "-q", BARE, WB_SHARED);
  git("-C", WB_SHARED, "config", "user.email", "t@example.com");
  git("-C", WB_SHARED, "config", "user.name", "tester");
  WB_CANON = realpathSync(WB_SHARED);

  writeFileSync(SKLEDGER, row(WBCLEAN, WB_CANON, `t3/${TID}`));
});

test("a skill folder whose suites pass", () => {
  sk("alpha/scratch.md");
  is("a skill folder whose suites pass exits 0", String(RC), "0");
  has("and is reported ok", OUT, "ok .agents/skills/alpha");
  hasnt("a folder nobody touched is not verified", OUT, ".agents/skills/beta");
  hasnt("and the unit is the folder under .agents/skills/, not .agents/skills/ itself", OUT, ".agents/skills/skills");
  rmSync(join(SK, "alpha/scratch.md"), { force: true });
});

// A change OUTSIDE .agents/skills/ in the same worktree is not a skill unit. The records
// live flat at the root of this repo, so a journal write is the common
// case: it must map to no unit at all rather than to a unit named `journal`.
test("a records-only change", () => {
  mkdirSync(join(WBCLEAN, "journal/2026-09-25"), { recursive: true });
  writeFileSync(join(WBCLEAN, "journal/2026-09-25/0100-scratch.md"), "// touched\n");
  go();
  is("a records-only change exits 0", String(RC), "0");
  hasnt("and maps to no skill unit", OUT, ".agents/skills/");
  has("so the apps line is the whole story", OUT, "no app files changed in this thread's worktrees");
  rmSync(join(WBCLEAN, "journal"), { recursive: true, force: true });
});

test("a folder with no suites", () => {
  sk("gamma/scratch.md");
  is("a folder with no suites does not fail the close", String(RC), "0");
  has("and says so rather than passing silently", OUT, "unverified .agents/skills/gamma — no test suites");
  rmSync(join(SK, "gamma/scratch.md"), { force: true });
});

test("node:test suites", () => {
  sk("tsgreen/scratch.md");
  is("a folder whose only suites are *.test.ts exits 0", String(RC), "0");
  has("and is reported ok", OUT, "ok .agents/skills/tsgreen");
  hasnt("and is NOT reported as having no test suites", OUT, "unverified .agents/skills/tsgreen — no test suites");
  rmSync(join(SK, "tsgreen/scratch.md"), { force: true });

  sk("tsred/scratch.md");
  is("a red *.test.ts fails the close", String(RC), "1");
  has("naming the folder and the suite", OUT, "FAIL .agents/skills/tsred .agents/skills/tsred/scripts/bad.test.ts");
  has(
    "and gives a rerun line that names run.ts",
    OUT,
    `rerun: cd ${WBCLEAN} && node --experimental-strip-types .agents/skills/run.ts tsred/scripts/bad.test.ts`,
  );
  rmSync(join(SK, "tsred/scratch.md"), { force: true });
});

test("a red bash suite", () => {
  sk("red/scratch.md");
  is("a red suite fails the close", String(RC), "1");
  has("naming the folder and the suite", OUT, "FAIL .agents/skills/red .agents/skills/red/bad.test.sh");
  has("with the rerun command", OUT, `rerun: cd ${WBCLEAN} && bash .agents/skills/red/bad.test.sh`);
  hasnt("and a failing folder is not also reported ok", OUT, "ok .agents/skills/red");
  has("the log is where the line says", OUT, `log: ${LOG("skills-red-bad.test.sh.log")}`);
  const log = existsSync(LOG("skills-red-bad.test.sh.log"))
    ? readFileSync(LOG("skills-red-bad.test.sh.log"), "utf8")
    : "";
  ok("the log does not carry the suite output", log.includes("the assertion that failed"));
  rmSync(join(SK, "red/scratch.md"), { force: true });
});

// A changed file directly under .agents/skills/ is its own unit. Without it the launcher
// every other script depends on would be the one ungated file.
test("a root-level change", () => {
  sk("run.ts");
  has("a root-level change maps to the root unit", OUT, "ok .agents/skills/(root)");
  hasnt("and does not drag in a folder", OUT, ".agents/skills/alpha");
  git("-C", WBCLEAN, "checkout", "-q", "--", ".agents/skills/run.ts");
});

// Suites recurse and filenames repeat, so the WHOLE repo-relative path is
// flattened into the log name — two `verify.test.sh` files must not write one log.
test("logs are named by the whole path", () => {
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  writeFileSync(join(SK, "beta/scratch.md"), "// touched\n");
  go();
  has("two folders each with a verify.test.sh both pass", OUT, "ok .agents/skills/alpha");
  has("…and both are reported", OUT, "ok .agents/skills/beta");
  ok(
    "the two verify.test.sh logs collided",
    existsSync(LOG("skills-alpha-verify.test.sh.log")) && existsSync(LOG("skills-beta-verify.test.sh.log")),
  );
  ok(".agents/skills/alpha/scripts/deep.test.sh never ran", existsSync(LOG("skills-alpha-scripts-deep.test.sh.log")));
  rmSync(join(SK, "alpha/scratch.md"), { force: true });
  rmSync(join(SK, "beta/scratch.md"), { force: true });
});

// A change under .agents/skills/review/ runs every suite in that flat folder and not
// its eval (the close's skills pass is what collects those suites).
test(".agents/skills/review", () => {
  sk("review/code-review.ts");
  is("a change under .agents/skills/review exits 0", String(RC), "0");
  has("and the folder is reported ok", OUT, "ok .agents/skills/review");
  ok(
    "a .agents/skills/review suite never ran",
    existsSync(LOG("skills-review-code-review.test.sh.log")) &&
      existsSync(LOG("skills-review-policy-chain.test.sh.log")),
  );
  ok("the eval ran as a suite", !existsSync(LOG("skills-review-evals-caller-contract.eval.ts.log")));
  rmSync(join(SK, "review/code-review.ts"), { force: true });
});

// The export the debate and author resolvers list as a rung.
test("CLAUDE_PROJECT_DIR", () => {
  sk("cpd/scratch.md");
  has(
    "CLAUDE_PROJECT_DIR is not exported to a suite (session-write-root would skip its T3 branch)",
    OUT,
    "ok .agents/skills/cpd",
  );
  rmSync(join(SK, "cpd/scratch.md"), { force: true });
});

// A hung suite must not hang the close — the one step that must not hang.
// Staged WITHOUT `sk`, which would run the 30-second suite once at the default
// 180s timeout before the assertion below runs it again at 1s — half a minute on
// every run of this file, spent proving nothing.
test("a hung suite", () => {
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  writeFileSync(join(SK, "slow/scratch.md"), "// touched\n");
  go({ VERIFY_SKILLS_TIMEOUT: "1" });
  is("a suite past the timeout fails the close", String(RC), "1");
  has(
    "and is reported as a timeout, not a generic red",
    OUT,
    "FAIL .agents/skills/slow .agents/skills/slow/slow.test.sh — timed out after 1s",
  );
  rmSync(join(SK, "slow/scratch.md"), { force: true });
});

// The bound is this process's own watchdog, not timeout(1) — stock macOS has
// neither timeout nor gtimeout. A `timeout` and `gtimeout` on PATH that exit 0
// at once would turn any verify that still delegated to them into a green
// suite; and the hung suite's own child must be gone once the close moves on.
test("the timeout is a watchdog, not timeout(1), and it takes the suite's children", () => {
  const bin = join(TMP, "lying-timeout-bin");
  mkdirSync(bin, { recursive: true });
  for (const name of ["timeout", "gtimeout"]) {
    writeFileSync(join(bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  writeFileSync(join(SK, "slow/scratch.md"), "// touched\n");
  const start = Date.now();
  try {
    go({ VERIFY_SKILLS_TIMEOUT: "1", PATH: `${bin}:${process.env.PATH ?? ""}` });
  } finally {
    rmSync(join(SK, "slow/scratch.md"), { force: true });
  }
  const took = Date.now() - start;
  is("without a working timeout(1) a hung suite still fails the close", String(RC), "1");
  has("…as a timeout", OUT, "FAIL .agents/skills/slow .agents/skills/slow/slow.test.sh — timed out after 1s");
  ok(`and the suite was stopped, not waited out (took ${took}ms)`, took < 20_000);
  const left = spawnSync("pgrep", ["-f", `sleep ${SLOW}`], { encoding: "utf8" });
  is(`the hung suite's sleep outlived it: ${left.stdout}`, left.stdout.trim(), "");
});

// A workbench without the run.ts launcher runs a node:test suite with Node
// directly, and says so in the rerun line.
test("no launcher", () => {
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  rmSync(join(SK, "run.ts"), { force: true });
  writeFileSync(join(SK, "tsgreen/scratch.md"), "// touched\n");
  writeFileSync(join(SK, "tsred/scratch.md"), "// touched\n");
  try {
    go();
  } finally {
    // Restored before any assertion can throw: every case below needs the launcher.
    rmSync(join(SK, "tsgreen/scratch.md"), { force: true });
    rmSync(join(SK, "tsred/scratch.md"), { force: true });
    git("-C", WBCLEAN, "checkout", "-q", "--", ".agents/skills/run.ts");
  }
  has("with no launcher a node:test suite still runs", OUT, "ok .agents/skills/tsgreen");
  has("a red one is still caught", OUT, "FAIL .agents/skills/tsred .agents/skills/tsred/scripts/bad.test.ts");
  has(
    "and its rerun line runs it with node",
    OUT,
    `rerun: cd ${WBCLEAN} && node --experimental-strip-types .agents/skills/tsred/scripts/bad.test.ts`,
  );
  hasnt("and names no launcher that is not there", OUT, "run.ts tsred");
});

// `.agents/checks/` and `.agents/generators/` hold no package.json for pass 1
// to find, so without a unit of their own their suites would run on no close.
test(".agents/checks and .agents/generators", () => {
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
  appendFileSync(join(WBCLEAN, ".agents/checks/c.ts"), "// touched\n");
  go();
  is("a green checks folder exits 0", String(RC), "0");
  has("and is one unit", OUT, "ok .agents/checks");
  ok("its nested bash suite ran", existsSync(LOG("checks-sub-d.test.sh.log")));
  ok("and its node:test suite ran", existsSync(LOG("checks-c.test.ts.log")));
  hasnt("a folder nobody touched is not verified", OUT, ".agents/generators");
  hasnt("and a checks-only change touches no skill unit", OUT, "ok .agents/skills/");
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });

  appendFileSync(join(WBCLEAN, ".agents/generators/g.ts"), "// touched\n");
  go();
  is("a red generator suite fails the close", String(RC), "1");
  has("naming the unit and the suite", OUT, "FAIL .agents/generators .agents/generators/bad.test.ts");
  has(
    "with a rerun line that runs it with node, never through the skills launcher",
    OUT,
    `rerun: cd ${WBCLEAN} && node --experimental-strip-types .agents/generators/bad.test.ts`,
  );
  has("and its log is named by the path", OUT, `log: ${LOG("generators-bad.test.ts.log")}`);
  spawnSync("git", ["-C", WBCLEAN, "checkout", "-q", "--", "."], { stdio: "ignore" });
});

// A deleted folder is the intent of the change; there is nothing to run.
test("a deleted folder", () => {
  git("-C", WBCLEAN, "rm", "-q", "-r", ".agents/skills/beta");
  go();
  is("deleting a folder does not fail the close", String(RC), "0");
  hasnt("and says nothing about it", OUT, ".agents/skills/beta");
  git("-C", WBCLEAN, "checkout", "-q", "HEAD", "--", ".agents/skills/beta");
});

// ── The workbench row's worktree is gone: landed, or lost ──────────────────
//
// `land.ts` removes each worktree after landing it and does NOT prune the
// ledger, so after ANY successful close the rows outlive the directories. Read
// naively, that makes every SECOND close of a thread halt here — `FAIL skills —
// ledger worktree ... is missing` — with nothing wrong. `land.ts` reads the same
// state and treats a landed row as spent; these cases are the agreement. With
// no LIVE workbench row, the gone rows are the only evidence there is.

test("the workbench row's worktree is gone: landed, or lost", () => {
  writeFileSync(SKLEDGER, row(join(TMP, "wb-gone"), WB_CANON, `t3/${TID}`));

  // LOST: no landing recorded for this repo, so the directory went without its
  // work. This is the case the check was written for and it still halts.
  rmSync(LANDED_FILE, { force: true });
  go();
  is("a workbench worktree that vanished unlanded halts", String(RC), "1");
  has("and names the path", OUT, "wb-gone");
  has("and calls it missing", OUT, "is missing");

  // LANDED: `land.ts` put this repo on its trunk and then removed the directory.
  writeFileSync(LANDED_FILE, row(WB_CANON, "deadbeef"));
  go();
  is("a workbench worktree removed by a completed landing does not halt", String(RC), "0");
  has("and says so rather than going silent", OUT, "already landed and was removed");
  hasnt("and is not reported as a failure", OUT, "FAIL skills");

  // ANOTHER repo's landing is not this one's. Keyed on the shared path, so a
  // `landed` file with rows in it cannot excuse an unrelated missing worktree.
  writeFileSync(LANDED_FILE, row(join(TMP, "some-other-repo"), "deadbeef"));
  go();
  is("a landing of a DIFFERENT repo does not excuse this row", String(RC), "1");
  has("and it is still called missing", OUT, "is missing");
  rmSync(LANDED_FILE, { force: true });

  // Put the live workbench row back for the cases below.
  writeFileSync(SKLEDGER, row(WBCLEAN, WB_CANON, `t3/${TID}`));
});

// ── The backstop ───────────────────────────────────────────────────────────
//
// A write that never reached a worktree — through the `~/.agents/skills` link
// into `.agents/skills/` of the shared checkout. When this worktree changed .agents/skills/ it is
// attributable to this session and halts; when it did not, it is somebody else's
// and must not stop an unrelated close.

test("the backstop", () => {
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  writeFileSync(join(WB_SHARED, ".agents/skills/stray.md"), "// stray\n");
  go();
  is("a stray file under .agents/skills/ of the shared checkout halts a skills session", String(RC), "1");
  has("naming it", OUT, "stray.md");
  has("and saying why it matters", OUT, "in no ledger");
  rmSync(join(SK, "alpha/scratch.md"), { force: true });

  // The same dirt, with nothing under .agents/skills/ changed in this worktree: another
  // session's work.
  go();
  is("the same dirt does not halt a close that never touched skills", String(RC), "0");
  has("but it is still reported", OUT, "owner unknown");
  hasnt("and it is not called a failure", OUT, "FAIL skills");

  // Dirt OUTSIDE .agents/skills/ in the shared checkout is not this pass's business: the
  // link exposes .agents/skills/ alone, and land.ts reports the rest of that tree.
  rmSync(join(WB_SHARED, ".agents/skills/stray.md"), { force: true });
  writeFileSync(join(WB_SHARED, "apps/stray.md"), "// stray\n");
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  go();
  is("shared dirt outside .agents/skills/ does not halt", String(RC), "0");
  hasnt("and is not reported here", OUT, "stray.md");
  rmSync(join(WB_SHARED, "apps/stray.md"), { force: true });
  rmSync(join(SK, "alpha/scratch.md"), { force: true });

  // A path the worktree DOES account for is not stray — it is this session's own
  // work, mid-flight, and halting on it would halt every close.
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  copyFileSync(join(SK, "alpha/scratch.md"), join(WB_SHARED, ".agents/skills/alpha/scratch.md"));
  go();
  is("a dirty path this thread's worktree accounts for does not halt", String(RC), "0");
  hasnt("and is not reported as stray", OUT, "does not account for");
  rmSync(join(WB_SHARED, ".agents/skills/alpha/scratch.md"), { force: true });
  rmSync(join(SK, "alpha/scratch.md"), { force: true });

  // A DIFFERENT edit at a path the worktree also changed is still stray: the
  // worktree's version is what lands, and nothing will ever land the shared one.
  writeFileSync(join(SK, "alpha/scratch.md"), "// worktree version\n");
  writeFileSync(join(WB_SHARED, ".agents/skills/alpha/scratch.md"), "// a DIFFERENT shared edit\n");
  go();
  is("a same-path, different-content shared edit halts", String(RC), "1");
  has("and is named", OUT, "alpha/scratch.md");
  rmSync(join(WB_SHARED, ".agents/skills/alpha/scratch.md"), { force: true });
  rmSync(join(SK, "alpha/scratch.md"), { force: true });
});

// ── No workbench row at all ────────────────────────────────────────────────
//
// Everything in this pass keys off that one row, so swallowing its absence
// closed a skills session having verified nothing and said nothing. A ledger
// holding only a product repo's row — live, but with no apps/ — is the shape.
test("no workbench row at all", () => {
  const NOWB = join(TMP, "no-workbench-home");
  mkdirSync(join(NOWB, ".cache/workbench/threads", TID), { recursive: true });
  writeFileSync(
    join(NOWB, ".cache/workbench/threads", TID, "worktrees"),
    row(PRODWT, join(TMP, "prodshared"), `t3/${TID}`),
  );
  const r = runWith({ HOME: NOWB, WORKBENCH_THREAD_ID: TID, VERIFY_RUNNER: RUNNER_CMD });
  is("a ledger with no workbench row does not halt the close", String(r.RC), "0");
  has("but it says so rather than checking nothing in silence", r.OUT, "no skill folder was checked");
  has("and names the trees it looked for", r.OUT, ".agents/skills/");
});

// ── A folder whose suites cannot be listed ────────────────────────────────
//
// Discovery that FAILED is not discovery that found nothing.
test("a folder whose suites cannot be listed", () => {
  if (process.getuid?.() === 0) {
    ok("an unlistable folder fails the close (skipped: running as root)", true);
    ok("rather than reading as a folder with no suites (skipped: running as root)", true);
    ok("and is not reported as a gap (skipped: running as root)", true);
    return;
  }
  mkdirSync(join(SK, "locked/inner"), { recursive: true });
  writeFileSync(join(SK, "locked/inner/x.test.sh"), "#!/usr/bin/env bash\nexit 0\n");
  writeFileSync(join(SK, "locked/scratch.md"), "// touched\n");
  chmodSync(join(SK, "locked/inner"), 0o000);
  try {
    go();
  } finally {
    chmodSync(join(SK, "locked/inner"), 0o755);
  }
  is("an unlistable folder fails the close", String(RC), "1");
  has("rather than reading as a folder with no suites", OUT, "could not list its test suites");
  hasnt("and is not reported as a gap", OUT, "unverified .agents/skills/locked");
  rmSync(join(SK, "locked"), { recursive: true, force: true });
});

// ── Found by the machine reviewer, round 2 ────────────────────────────────

test("found by the machine reviewer, round 2", () => {
  // A suite that TRAPS the timeout signal and exits 0 has still not finished. Any
  // exit-code scheme can be forged by the suite; the clock cannot. Each of these
  // two folders is PUSHED, not just committed: a commit ahead of origin/main is a
  // change, and an unpushed `own124` would fail every case after it.
  suite("trapper/trap.test.sh", 'trap "exit 0" TERM; sleep 30');
  git("-C", WBCLEAN, "add", "--", ".agents/skills/trapper");
  git("-C", WBCLEAN, "commit", "-q", "-m", "trapper");
  git("-C", WBCLEAN, "push", "-q", "origin", "main");
  writeFileSync(join(SK, "trapper/scratch.md"), "// touched\n");
  go({ VERIFY_SKILLS_TIMEOUT: "1" });
  is("a suite that traps the kill and exits 0 still fails the close", String(RC), "1");
  has(
    "and is still reported as a timeout",
    OUT,
    "FAIL .agents/skills/trapper .agents/skills/trapper/trap.test.sh — timed out after 1s",
  );
  hasnt("and is never reported ok", OUT, "ok .agents/skills/trapper");
  rmSync(join(SK, "trapper/scratch.md"), { force: true });

  // A suite that exits 124 of its OWN accord finished; it is red, not hung.
  suite("own124/x.test.sh", "exit 124");
  git("-C", WBCLEAN, "add", "--", ".agents/skills/own124");
  git("-C", WBCLEAN, "commit", "-q", "-m", "own124");
  git("-C", WBCLEAN, "push", "-q", "origin", "main");
  writeFileSync(join(SK, "own124/scratch.md"), "// touched\n");
  go();
  is("a suite that exits 124 by itself fails the close", String(RC), "1");
  hasnt("but is not called a timeout", OUT, "timed out");
  has("it gets the rerun line instead", OUT, `rerun: cd ${WBCLEAN} && bash .agents/skills/own124/x.test.sh`);
  rmSync(join(SK, "own124/scratch.md"), { force: true });

  // Git records the executable bit, so equal bytes are not the same file. A
  // shared `chmod +x` that nothing will land must not read as accounted for.
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  copyFileSync(join(SK, "alpha/scratch.md"), join(WB_SHARED, ".agents/skills/alpha/scratch.md"));
  chmodSync(join(WB_SHARED, ".agents/skills/alpha/scratch.md"), 0o755);
  go();
  is("equal bytes with a different mode still halts", String(RC), "1");
  has("and the file is named", OUT, "alpha/scratch.md");
  rmSync(join(WB_SHARED, ".agents/skills/alpha/scratch.md"), { force: true });
  rmSync(join(SK, "alpha/scratch.md"), { force: true });
});

// ── A gone row beside a LIVE workbench row ─────────────────────────────────
//
// With the workbench row present, a product repo's row whose worktree is gone is
// pass 1's business (skipped there) and not this pass's: the skills were never
// in that worktree, so its loss says nothing about them.
test("a gone row beside a live workbench row", () => {
  writeFileSync(
    SKLEDGER,
    row(WBCLEAN, WB_CANON, `t3/${TID}`) + row(join(TMP, "gone-product-wt"), join(TMP, "gone-shared"), `t3/${TID}`),
  );
  writeFileSync(join(SK, "alpha/scratch.md"), "// touched\n");
  go();
  is("a gone product row beside a live workbench row does not halt", String(RC), "0");
  has("and the skills are still verified", OUT, "ok .agents/skills/alpha");
  hasnt("and the gone row is not mentioned here", OUT, "gone-product-wt");
  rmSync(join(SK, "alpha/scratch.md"), { force: true });
});

// The harnesses reach every skill script through a symlink
// (~/.agents/skills -> <workbench>/.agents/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "verify.ts");
  symlinkSync(SCRIPT, link);

  const r = spawnSync(process.execPath, ["--experimental-strip-types", link, ...[]], {
    encoding: "utf8",
    cwd: TMP,
    env: {
      ...BASE,
      HOME: join(dir, "home"),
      T3CODE_HOME: join(dir, "nowhere"),
      WORKBENCH_THREAD_ID: "abababab-1111-2222-3333-444444444444",
    },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 0, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /nothing to verify/);
});
