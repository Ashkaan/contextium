// session-write-root.test.ts — acceptance for session-write-root.ts, both faces:
// the program (spawned) and the library (imported by a spawned `node -e`, so
// this suite still runs the subject as a program of its own).
//
// Every case runs against a throwaway git repo under $TMPDIR with
// CLAUDE_WORKTREE_HOME pointed inside it, so no test can create a worktree in
// the harness's real worktree folder (see setup-worktree.test.ts's header). The
// in-thread cases also point HOME and T3CODE_HOME into the sandbox, so the
// thread ledger and every worktree write-root.sh makes stay there too.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/session-write-root.test.ts
//
// peers: session-write-root.ts, setup-worktree.sh, session-key.ts,
//        ../../close/scripts/{harness.sh, thread.ts, write-root.sh}

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
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
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_EXIT = resolve(HERE, "../../../packages/cli-exit/cli-exit.ts");
const CLOSE = resolve(HERE, "../../close/scripts");

const SANDBOX = mkdtempSync(join(tmpdir(), "swr-test-"));
after(() => rmSync(SANDBOX, { recursive: true, force: true }));

// ── Fixture: a real git repo with the scripts in place ────────────────────
//
// The SUT asks whether the target root is a git work tree with a REMOTE, so the
// plant path does not have to mean anything beyond one thing: the TypeScript
// copies import ../../../packages/cli-exit/cli-exit.ts, so they sit three
// levels below a planted copy of it, as they do in an installed `.agents/`.
// harness.sh is planted where the copy looks for it (../../close/scripts), and
// no thread.ts beside it: the copy is in no thread, so it takes the per-session
// path. The fixture needs a remote to be treated as real.
/** Plant the SUT and its helpers under `<root>/.agents/`; returns the SUT's path. */
function plant(root: string): string {
  const bin = join(root, ".agents/skills/implement/scripts");
  mkdirSync(bin, { recursive: true });
  for (const f of ["session-write-root.ts", "setup-worktree.sh", "session-key.ts"]) {
    copyFileSync(join(HERE, f), join(bin, f));
  }
  chmodSync(join(bin, "setup-worktree.sh"), 0o755);
  mkdirSync(join(root, ".agents/packages/cli-exit"), { recursive: true });
  copyFileSync(CLI_EXIT, join(root, ".agents/packages/cli-exit/cli-exit.ts"));
  mkdirSync(join(root, ".agents/skills/close/scripts"), { recursive: true });
  copyFileSync(join(CLOSE, "harness.sh"), join(root, ".agents/skills/close/scripts/harness.sh"));
  return join(bin, "session-write-root.ts");
}
const REPO = join(SANDBOX, "repo");
const FIX = plant(REPO);
const BIN = dirname(FIX);

const git = (...a: string[]) => execFileSync("git", a, { encoding: "utf8" });
git("-C", REPO, "init", "-q");
git("-C", REPO, "config", "user.email", "t@t.t");
git("-C", REPO, "config", "user.name", "t");
// A remote is what marks this as a real checkout rather than a scratch dir. The
// URL is never contacted: only `git remote` (the NAME list) is read.
git("-C", REPO, "remote", "add", "origin", join(SANDBOX, "not-a-real-remote.git"));
writeFileSync(join(REPO, "seed.txt"), "seed\n");
git("-C", REPO, "add", "-A");
git("-C", REPO, "commit", "-qm", "seed");

const WT_HOME = join(SANDBOX, "worktrees");

// Clean identity baseline. This suite usually runs INSIDE a live harness
// session, whose session id is inherited by every child process — so unsetting
// CLAUDE_SESSION_ID alone does not produce a session-less environment, and the
// "no session" cases would silently exercise the real session instead. Every
// name is cleared here and set explicitly only by the cases that test them, and
// so is every helper override and thread variable a caller's shell may carry.
const BASE_ENV: NodeJS.ProcessEnv = { ...process.env, CLAUDE_WORKTREE_HOME: WT_HOME };
for (const k of [
  "CLAUDE_SESSION_ID",
  "CLAUDE_CODE_SESSION_ID",
  "CONTEXTIUM_SESSION",
  "CONTEXTIUM_HARNESS",
  "CONTEXT_WRITE_ROOT",
  "CLAUDE_PROJECT_DIR",
  "WORKBENCH_THREAD_ID",
  "T3CODE_HOME",
  "SETUP_WORKTREE_SCRIPT",
  "SESSION_KEY_SCRIPT",
  "THREAD_SCRIPT",
  "WRITE_ROOT_SCRIPT",
]) {
  delete BASE_ENV[k];
}

/** `$(cd <cwd> && VARS… session-write-root.ts <args> 2>&1)`, and its exit code.
 *  `--no-warnings` because Node 22's type-stripping ExperimentalWarning would
 *  otherwise head every captured answer. */
function swr(
  args: string[],
  extra: NodeJS.ProcessEnv = {},
  cwd = REPO,
  sut = FIX,
): { rc: number; out: string } {
  const env: NodeJS.ProcessEnv = { ...BASE_ENV, ...extra };
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", sut, ...args], {
    encoding: "utf8",
    env,
    cwd,
    timeout: 120000,
  });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}`.replace(/\n+$/, "") };
}

function sessionKey(raw: string): string {
  return execFileSync(process.execPath, ["--no-warnings", "--experimental-strip-types", join(BIN, "session-key.ts"), raw], {
    encoding: "utf8",
  }).trim();
}

const sessionDirs = (): string[] =>
  existsSync(WT_HOME) ? readdirSync(WT_HOME).filter((d) => d.startsWith("session-")) : [];

// ── No session id → main checkout (terminal runs, test suites) ────────────
test("no session id at all → main checkout", () => assert.equal(swr([]).out, REPO));

// ── --main always reports the main checkout ───────────────────────────────
test("--main → main checkout", () => assert.equal(swr(["--main"], { CLAUDE_PROJECT_DIR: REPO }).out, REPO));

// ── CONTEXT_WRITE_ROOT overrides everything ───────────────────────────────
test("CONTEXT_WRITE_ROOT wins", () =>
  assert.equal(
    swr([], { CONTEXT_WRITE_ROOT: "/tmp/override-xyz", CLAUDE_SESSION_ID: "abc" }).out,
    "/tmp/override-xyz",
  ));

// …including over the refusal a copy outside every repo gives. The override is
// documented to win over everything, so it must be read before the main
// checkout is resolved, not after.
test("CONTEXT_WRITE_ROOT wins outside every repo", async (t) => {
  const loose = plant(join(SANDBOX, "loose"));
  const bare = swr([], {}, SANDBOX, loose);
  await t.test("without it, a copy outside every repo refuses", () => assert.equal(bare.rc, 1, bare.out));
  await t.test("CONTEXT_WRITE_ROOT wins outside every repo", () =>
    assert.equal(swr([], { CONTEXT_WRITE_ROOT: "/tmp/override-xyz" }, SANDBOX, loose).out, "/tmp/override-xyz"),
  );
  await t.test("CONTEXT_WRITE_ROOT wins outside every repo (--no-create)", () =>
    assert.equal(
      swr(["--no-create"], { CONTEXT_WRITE_ROOT: "/tmp/override-xyz" }, SANDBOX, loose).out,
      "/tmp/override-xyz",
    ),
  );
});

// ── The retired records flag is a usage error, not a silent default ──────
//
// The records flag answered "where are the records" out of a second checkout,
// before the records lived in this repo. A stale caller
// must be told so at the call site rather than handed the default mode's answer
// as if it had asked for it — the same exit 1 as any other unknown flag. The
// flag is assembled rather than written, so the repo-wide sweep for the retired
// spelling finds no caller here.
test("the retired records flag is a usage error now", () => assert.equal(swr([`--${"lib"}${"rary"}`]).rc, 1));

// ── A cwd outside every repo still answers the repo the script lives in ───
//
// The records live in this repo, so a script read from `.agents/skills/` and run from
// `/tmp` has exactly one right answer: its own checkout. FIX is the copy
// planted inside REPO, so that is what it must name.
test("--main from a non-repo cwd → the script's own repo", () => assert.equal(swr(["--main"], {}, "/tmp").out, REPO));

// ── A cwd inside ANOTHER repo still answers the script's repo ─────────────
//
// Every caller writes into the repo this script lives in. Standing in a product
// checkout while running a records script must not send the record there.
test("--main from a cwd in another repo → the script's own repo", () => {
  const elsewhere = join(SANDBOX, "elsewhere-git");
  mkdirSync(elsewhere, { recursive: true });
  git("-C", elsewhere, "init", "-q");
  assert.equal(swr(["--main"], {}, elsewhere).out, REPO);
});

// ── --slug is the SSOT for the session-<key> rule ─────────────────────────
const key = sessionKey("test-session-1");
test("--slug → session-<key>", () =>
  assert.equal(
    swr(["--slug"], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" }).out,
    `session-${key}`,
  ));

// --slug must NOT be silenced by CONTEXT_WRITE_ROOT (the guard needs the real one)
test("--slug ignores CONTEXT_WRITE_ROOT", () =>
  assert.equal(
    swr(["--slug"], { CONTEXT_WRITE_ROOT: "/tmp/x", CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" })
      .out,
    `session-${key}`,
  ));

// ── CLAUDE_CODE_SESSION_ID is honoured when CLAUDE_SESSION_ID is absent ───
// An ordinary shell call under Claude Code gets CLAUDE_CODE_SESSION_ID, NOT
// CLAUDE_SESSION_ID. Reading only the latter makes every scaffold degrade to the
// main checkout — the exact bug being fixed, back again and silent. If this case ever reverts to printing the main checkout, the
// whole mechanism is inert.
test("CLAUDE_CODE_SESSION_ID alone yields the slug, and is not ignored", async (t) => {
  const out = swr(["--slug"], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_CODE_SESSION_ID: "test-session-1" }).out;
  await t.test("CLAUDE_CODE_SESSION_ID alone yields the slug", () => assert.equal(out, `session-${key}`));
  await t.test("CLAUDE_CODE_SESSION_ID is not ignored", () =>
    assert.notEqual(out, REPO, "degraded to the main checkout"),
  );
});

// The harness-neutral name, read through harness.sh, yields the same slug.
test("CONTEXTIUM_SESSION alone yields the slug", () =>
  assert.equal(
    swr(["--slug"], { CLAUDE_PROJECT_DIR: REPO, CONTEXTIUM_SESSION: "test-session-1" }).out,
    `session-${key}`,
  ));

// CLAUDE_SESSION_ID wins when both are set and disagree.
test("CLAUDE_SESSION_ID takes precedence", () =>
  assert.equal(
    swr(["--slug"], {
      CLAUDE_PROJECT_DIR: REPO,
      CLAUDE_SESSION_ID: "explicit-wins",
      CLAUDE_CODE_SESSION_ID: "test-session-1",
    }).out,
    `session-${sessionKey("explicit-wins")}`,
  ));

// ── A foreign target root is honoured verbatim ────────────────────────────
// Every migrated script's own suite points CLAUDE_PROJECT_DIR at a `mktemp -d`
// fixture — frequently not a git repo at all. Session isolation must not reach
// into those: without this gate the resolver tries to create a worktree inside
// a non-repo fixture and the suite dies with a resolver error instead of
// writing its file.
test("non-repo fixture root honoured verbatim", () => {
  const foreign = join(SANDBOX, "foreign");
  mkdirSync(foreign, { recursive: true });
  assert.equal(swr([], { CLAUDE_PROJECT_DIR: foreign, CLAUDE_SESSION_ID: "test-session-1" }).out, foreign);
});
test("foreign git repo root honoured verbatim", () => {
  const foreignGit = join(SANDBOX, "foreign-git");
  mkdirSync(foreignGit, { recursive: true });
  git("-C", foreignGit, "init", "-q");
  assert.equal(swr([], { CLAUDE_PROJECT_DIR: foreignGit, CLAUDE_SESSION_ID: "test-session-1" }).out, foreignGit);
});

// ── --no-create never creates ─────────────────────────────────────────────
test("--no-create with no worktree → main checkout, and created nothing", async (t) => {
  const out = swr(["--no-create"], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "never-made" }).out;
  await t.test("--no-create with no worktree → main checkout", () => assert.equal(out, REPO));
  await t.test("--no-create created nothing", () =>
    assert.deepEqual(sessionDirs(), [], `a worktree appeared under ${WT_HOME}`),
  );
});

// ── Default mode CREATES the worktree — the whole point ───────────────────
const expected = join(WT_HOME, `session-${key}`);
test("default mode creates + returns the worktree, on disk, with its marker", async (t) => {
  const out = swr([], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" }).out;
  await t.test("default mode creates + returns the worktree", () => assert.equal(out, expected));
  await t.test("worktree exists on disk", () => assert.ok(existsSync(expected), `missing: ${expected}`));
  await t.test("session marker written", () =>
    assert.ok(existsSync(join(expected, `.claude-session-${key}`)), `missing marker in ${expected}`),
  );
});

// ── Second call is idempotent (re-claim, not a second worktree) ───────────
test("second call returns the same worktree; exactly one worktree exists", async (t) => {
  const out2 = swr([], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" }).out;
  await t.test("second call returns the same worktree", () => assert.equal(out2, expected));
  await t.test("exactly one worktree exists", () => assert.equal(sessionDirs().length, 1));
});

// ── --no-create now FINDS the worktree it refused to make ─────────────────
test("--no-create finds an existing worktree", () =>
  assert.equal(swr(["--no-create"], { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" }).out, expected));

// ── A failed worktree listing is an error, not "no worktree" ──────────────
// Read as "nothing" on failure, a git that failed listed nothing, and the
// resolver answered the main checkout for a session that HAS a worktree — its
// writes would go where no close lands them.
test("a failed worktree listing exits 1, saying so", async (t) => {
  const failgit = join(SANDBOX, "failgit");
  mkdirSync(failgit, { recursive: true });
  const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(failgit, "git"),
    `#!/usr/bin/env bash
case " $* " in *" worktree list "*) echo "fatal: simulated read failure" >&2; exit 128 ;; esac
exec "${realGit}" "$@"
`,
  );
  chmodSync(join(failgit, "git"), 0o755);
  const r = swr(["--no-create"], {
    PATH: `${failgit}:${process.env.PATH ?? ""}`,
    CLAUDE_PROJECT_DIR: REPO,
    CLAUDE_SESSION_ID: "test-session-1",
  });
  await t.test("a failed worktree listing exits 1", () => assert.equal(r.rc, 1));
  await t.test("…saying so", () => assert.ok(r.out.includes("could not list the worktrees"), `got: ${r.out}`));
});

// ── Invoked from INSIDE a worktree → that worktree, not main ──────────────
// The regression setup-worktree.sh's own callers hit: resolving from cwd made a
// worktree look like "main".
test("cwd inside a worktree → that worktree", () =>
  assert.equal(swr(["--no-create"], { CLAUDE_SESSION_ID: "other-session" }, expected).out, expected));

// ── --main from inside a worktree still names the MAIN checkout ───────────
test("--main from inside a worktree → main checkout", () =>
  assert.equal(swr(["--main"], { CLAUDE_SESSION_ID: "other-session" }, expected).out, REPO));

// ── Creator failure fails LOUD, never silently to the main checkout ───────
test("creator failure exits non-zero, refuses the main checkout explicitly, and does not print main root", async (t) => {
  const r = swr([], {
    CLAUDE_PROJECT_DIR: REPO,
    CLAUDE_SESSION_ID: "boom-session",
    SETUP_WORKTREE_SCRIPT: "/nonexistent/creator.sh",
  });
  await t.test("creator failure exits non-zero", () => assert.notEqual(r.rc, 0, `rc=${r.rc}`));
  await t.test("creator failure refuses the main checkout explicitly", () =>
    assert.ok(r.out.includes("refusing to write to the main checkout"), `stderr was: ${r.out}`),
  );
  await t.test("creator failure does not print main root", () => assert.notEqual(r.out, REPO, `printed ${REPO}`));
});

// ── Bad flag is a usage error ─────────────────────────────────────────────
test("unknown flag exits 1", () => assert.equal(swr(["--bogus"]).rc, 1));

// ── The library face returns the same answer as the program ──────────────
function viaImport(code: string, extra: NodeJS.ProcessEnv): string {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", "--input-type=module", "-e", code], {
    encoding: "utf8",
    cwd: REPO,
    env: { ...BASE_ENV, ...extra },
    timeout: 120000,
  });
  return `${r.stdout}${r.stderr}`;
}
test("ts sessionWriteRoot matches the program", () =>
  assert.equal(
    viaImport(
      `import { sessionWriteRoot, inWriteRoot } from ${JSON.stringify(FIX)};
       process.stdout.write(sessionWriteRoot() + "|" + inWriteRoot("knowledge", "x.md"));`,
      { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "test-session-1" },
    ),
    `${expected}|${expected}/knowledge/x.md`,
  ));

// A failing resolver must THROW, not return the main checkout.
test("ts throws when the resolver fails", () => {
  const out = viaImport(
    `import { sessionWriteRoot } from ${JSON.stringify(FIX)};
     try { console.log("RETURNED:" + sessionWriteRoot()); }
     catch (e) { console.log("THREW"); }`,
    { CLAUDE_PROJECT_DIR: REPO, CLAUDE_SESSION_ID: "boom2", SETUP_WORKTREE_SCRIPT: "/nonexistent/creator.sh" },
  );
  assert.ok(out.includes("THREW"), `got: ${out}`);
});

// ── Inside a thread: the ledger's worktree, created only for a real session ──
//
// thread.ts names every session — an id-less one gets a generated id so its
// close can land — and the default mode must not turn a READ by that id-less
// session into a worktree. A session whose harness exports an id gets one, and
// --no-create then answers it from the ledger. The real thread.ts and
// write-root.sh run here, against a sandbox HOME (ledger, generated ids, new
// worktrees) and a T3CODE_HOME with no database, so the session is a plain
// harness session in the main checkout.
test("inside a thread", async (t) => {
  const thrHome = join(SANDBOX, "thr-home");
  mkdirSync(thrHome, { recursive: true });
  const origin = join(SANDBOX, "thr-origin.git");
  git("init", "-q", "--bare", "-b", "main", origin);
  const THR = join(SANDBOX, "thr-repo");
  git("init", "-q", "-b", "main", THR);
  git("-C", THR, "config", "user.email", "t@t");
  git("-C", THR, "config", "user.name", "t");
  writeFileSync(join(THR, "seed.txt"), "seed\n");
  git("-C", THR, "add", "-A");
  git("-C", THR, "commit", "-qm", "seed");
  git("-C", THR, "remote", "add", "origin", origin);
  git("-C", THR, "push", "-q", "-u", "origin", "main");
  git("-C", THR, "remote", "set-head", "origin", "main");
  const sut = plant(THR);
  writeFileSync(join(THR, ".git/info/exclude"), ".agents/\n", { flag: "a" });

  const inThread = (args: string[], extra: NodeJS.ProcessEnv = {}) =>
    swr(
      args,
      {
        HOME: thrHome,
        T3CODE_HOME: join(SANDBOX, "no-t3"),
        THREAD_SCRIPT: join(CLOSE, "thread.ts"),
        WRITE_ROOT_SCRIPT: join(CLOSE, "write-root.sh"),
        ...extra,
      },
      THR,
      sut,
    );
  const worktreeCount = () => git("-C", THR, "worktree", "list").split("\n").filter(Boolean).length;

  const idless = inThread([]);
  await t.test("an id-less session's read resolves to the main checkout", () => assert.equal(idless.out, THR));
  await t.test("…and makes no worktree", () => assert.equal(worktreeCount(), 1));

  const real = inThread([], { CONTEXTIUM_SESSION: "real-one" });
  await t.test("a session with an id gets its worktree", () => {
    assert.equal(real.rc, 0, real.out);
    assert.notEqual(real.out, THR);
    assert.ok(existsSync(real.out), `got [${real.out}]`);
  });
  // From write-root.sh, not setup-worktree.sh: the per-session creator would
  // also hand back a worktree here, but one in no ledger — the close never lands it.
  await t.test("…recorded in the thread's ledger", () => {
    const threads = join(thrHome, ".cache/workbench/threads");
    const ledgered = (existsSync(threads) ? readdirSync(threads) : [])
      .map((tid) => join(threads, tid, "worktrees"))
      .filter((f) => existsSync(f))
      .flatMap((f) => readFileSync(f, "utf8").split("\n"))
      .map((line) => line.split("\t")[0]);
    assert.ok(ledgered.includes(real.out), `ledger lines: ${JSON.stringify(ledgered)}`);
  });
  await t.test("…which --no-create then answers", () =>
    assert.equal(inThread(["--no-create"], { CONTEXTIUM_SESSION: "real-one" }).out, real.out),
  );
});
