// Test harness for resolve-scope.ts — boundary cases mirror SPEC § 4 of
// validate-rebuild.spec.md. The subject is spawned as a program against a
// fixture repo built in a tmpdir.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/resolve-scope.test.ts
//
// peers: resolve-scope.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "resolve-scope.ts");
const TMP = mkdtempSync(join(tmpdir(), "resolve-scope-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const mktemp = (): string => mkdtempSync(join(TMP, `d${++n}-`));

function makeRepo(): string {
  const d = mktemp();
  const git = (...a: string[]) => execFileSync("git", ["-C", d, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  for (const dir of [
    "apps/foo",
    "apps/bar",
    "integrations/baz",
    "projects/p/2026-01-01_x",
    "apps/dom/wanted",
    "apps/dom/sibling",
  ]) {
    mkdirSync(join(d, dir), { recursive: true });
  }
  writeFileSync(join(d, "apps/foo/a.ts"), "a\n");
  writeFileSync(join(d, "apps/foo/b.ts"), "b\n");
  writeFileSync(join(d, "apps/bar/c.ts"), "c\n");
  writeFileSync(join(d, "apps/dom/wanted/w.ts"), "w\n");
  writeFileSync(join(d, "apps/dom/sibling/s.ts"), "s\n");
  writeFileSync(join(d, "integrations/baz/d.ts"), "d\n");
  writeFileSync(join(d, "projects/p/2026-01-01_x/notes.md"), "e\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return d;
}

interface Run {
  rc: number;
  out: string;
}
function spawn(args: string[], env: NodeJS.ProcessEnv, cwd?: string): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env,
    cwd,
    timeout: 60000,
  });
  return { rc: r.status ?? -1, out: `${r.stdout}${nodeNoise(r.stderr)}` };
}

/**
 * Node's own process warnings — on 22.6, type stripping's ExperimentalWarning
 * and the typeless-package.json notice, each with a "(Use `node --trace-…`"
 * hint — are not the subject's output.
 */
const nodeNoise = (stderr: string): string =>
  stderr
    .split("\n")
    .filter((l) => !/^\(node:\d+\) |^\(Use `node --trace-/.test(l))
    .join("\n");
const runScript = (repo: string, ...args: string[]): Run => spawn(args, { ...process.env, CLAUDE_PROJECT_DIR: repo });

// ── Case 1: blank scope, no staged files → empty stdout, exit 0 ──
test("case1 blank-no-staged-empty", () => {
  const r = runScript(makeRepo(), "--scope", "");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  const body = r.out.split("\n").filter((l) => l !== "");
  assert.deepEqual(body, [], `expected empty body, got: ${body.join("\n")}`);
});

// ── Case 2: blank scope with 1 staged .ts → emits it ──
test("case2 blank-with-staged", () => {
  const repo = makeRepo();
  writeFileSync(join(repo, "new.ts"), "x\n");
  execFileSync("git", ["-C", repo, "add", "new.ts"]);
  const r = runScript(repo, "--scope", "");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(/^new\.ts$/m.test(r.out), `missing new.ts: ${r.out}`);
});

// ── Case 3: apps/non-existent → fail loud ──
test("case3 app-not-found-fails", () => {
  const r = runScript(makeRepo(), "--scope", "apps/nonexistent");
  assert.notEqual(r.rc, 0, "expected non-zero on missing app");
  assert.ok(r.out.includes("app not found"), "missing err msg");
});

// ── Case 4: apps/foo → emits 2 .ts files ──
test("case4 apps-foo-two-files", () => {
  const r = runScript(makeRepo(), "--scope", "apps/foo");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(r.out.includes("apps/foo/a.ts"), `missing a.ts: ${r.out}`);
  assert.ok(r.out.includes("apps/foo/b.ts"), "missing b.ts");
});

// ── Case 5: bare name 'bar' matches apps/bar ──
test("case5 bare-name-matches-app", () => {
  const r = runScript(makeRepo(), "--scope", "bar");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(r.out.includes("apps/bar/c.ts"), `missing c.ts: ${r.out}`);
});

// ── Case 5b: apps/<domain>/<app> resolves to THE APP, not the domain ──
//
// Apps are grouped by domain, and this branch used to take the first path
// segment and nothing else — so `apps/dom/wanted` resolved to `apps/dom` and
// dragged every sibling in with it. Downstream that is not a wider scope, it is
// a WRONG verdict: layer 1 fails the caller's phase on a type error in an app
// the caller never named.
test("case5b nested-app-does-not-widen-to-domain", () => {
  const r = runScript(makeRepo(), "--scope", "apps/dom/wanted");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(r.out.includes("apps/dom/wanted/w.ts"), `missing w.ts: ${r.out}`);
  assert.equal(r.out.includes("apps/dom/sibling/s.ts"), false, `the sibling app leaked in: ${r.out}`);
});

// ── Case 5c: a DOMAIN scope still means the whole domain ──
//
// The widening is only wrong when the caller named something narrower. Asking
// for the domain by name still gets the domain.
test("case5c domain-scope-still-means-the-domain", () => {
  const r = runScript(makeRepo(), "--scope", "apps/dom");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(r.out.includes("apps/dom/wanted/w.ts"), `missing w.ts: ${r.out}`);
  assert.ok(r.out.includes("apps/dom/sibling/s.ts"), `missing s.ts: ${r.out}`);
});

// ── Case 5d: a path that is not a directory fails loud, never widens ──
//
// The ONLY input the old first-segment fallback could still catch was a typo,
// and widening a typo to its parent domain is the bug above wearing a hat.
test("case5d nested-nonexistent-app-fails-loud", () =>
  assert.equal(runScript(makeRepo(), "--scope", "apps/dom/nope").rc, 1));

// ── Case 6: integrations/baz → emits 1 .ts file ──
test("case6 integration-match", () => {
  const r = runScript(makeRepo(), "--scope", "integrations/baz");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}`);
  assert.ok(r.out.includes("integrations/baz/d.ts"), `missing d.ts: ${r.out}`);
});

// ── Case 7: glob matching no files → fail loud ──
test("case7 no-match-glob-fails", () =>
  assert.notEqual(runScript(makeRepo(), "--scope", "nothing/*.ts").rc, 0, "expected non-zero on no-match glob"));

// ── Case 8 (Fix B): CLAUDE_PROJECT_DIR unset but cwd inside a git repo →
// resolve root via git rev-parse; apps/foo → emits 2 files (exit 0) ──
test("case8 env-unset-in-repo-resolves-via-git", () => {
  const repo = makeRepo();
  const r = spawn(["--scope", "apps/foo"], { HOME: repo, PATH: "/usr/bin:/bin" }, repo);
  assert.equal(r.rc, 0, `expected zero with env unset inside repo; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("apps/foo/a.ts"), `missing a.ts with env unset: ${r.out}`);
});

// ── Case 9 (Fix B): CLAUDE_PROJECT_DIR unset AND outside a git repo →
// hard-error preserved at exit 1 ──
test("case9 env-unset-outside-repo-hard-errors", () => {
  const nongit = mktemp();
  const r = spawn(["--scope", "apps/foo"], { HOME: nongit, PATH: "/usr/bin:/bin" }, nongit);
  assert.equal(r.rc, 1, `expected exit 1 unset+outside-repo; got ${r.rc}`);
  assert.ok(r.out.includes("not inside a git repo"), `missing hard-error msg: ${r.out}`);
});

// ── Case 10: run from a LINKED WORKTREE, where .git is a file rather than a
// directory. /implement runs Phase 4 inside one, so this is the
// common path, not an edge. Both env-set and env-unset resolutions must work. ──
test("case10 runs-inside-linked-worktree", () => {
  const repo = makeRepo();
  const wt = `${repo}-wt`;
  spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "wtbranch", wt], { stdio: "ignore" });
  try {
    assert.ok(
      existsSync(join(wt, ".git")) && statSync(join(wt, ".git")).isFile(),
      "expected .git to be a FILE in the worktree",
    );

    let r = spawn(["--scope", "apps/foo"], { HOME: wt, PATH: "/usr/bin:/bin" }, wt);
    assert.equal(r.rc, 0, `expected zero inside worktree; got ${r.rc}: ${r.out}`);
    assert.ok(r.out.includes("apps/foo/a.ts"), `missing a.ts inside worktree: ${r.out}`);

    r = runScript(wt, "--scope", "apps/foo");
    assert.equal(r.rc, 0, `expected zero with env set to worktree; got ${r.rc}: ${r.out}`);
  } finally {
    spawnSync("git", ["-C", repo, "worktree", "remove", "--force", wt], { stdio: "ignore" });
  }
});

// ── Case 11: an unreadable directory inside the scope fails loud ──
//
// The walk used to swallow a readdir error and return what it had, so a scope
// with an unreadable subtree resolved to a short list at exit 0 and validation
// passed without ever looking at the files it could not read.
test("case11 unreadable-scope-directory-fails", () => {
  const repo = makeRepo();
  const locked = join(repo, "apps/foo/locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "hidden.ts"), "h\n");
  chmodSync(locked, 0o000);
  try {
    const r = runScript(repo, "--scope", "apps/foo");
    assert.notEqual(r.rc, 0, `an unreadable directory in scope exited ${r.rc}: ${r.out}`);
    assert.ok(r.out.includes("apps/foo/locked"), `the error does not name the unreadable directory: ${r.out}`);
  } finally {
    chmodSync(locked, 0o755);
  }
});

/** A PATH whose `git` fails whenever its arguments include `sub`, else runs the real one. */
function failingGitPath(sub: string): string {
  const bin = mktemp();
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nfor a in "$@"; do [ "$a" = "${sub}" ] && { echo "fatal: simulated ${sub} failure" >&2; exit 128; }; done\nexec /usr/bin/git "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  return `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`;
}

// ── Case 11b: a package that is not TypeScript still has files in scope ──
//
// The layers find each file's package and run its own lint and tests, so a
// JavaScript (or any other) package must reach them; filtering to *.ts made a
// JS-only package an empty scope that passed without running anything.
// Installed dependencies and git internals stay out.
test("case11b non-typescript-packages-in-scope", () => {
  const repo = makeRepo();
  for (const dir of ["apps/jsapp/src", "apps/jsapp/node_modules/dep", "integrations/py"]) {
    mkdirSync(join(repo, dir), { recursive: true });
  }
  writeFileSync(join(repo, "apps/jsapp/package.json"), '{"name":"jsapp"}\n');
  writeFileSync(join(repo, "apps/jsapp/src/index.js"), "x\n");
  writeFileSync(join(repo, "apps/jsapp/node_modules/dep/i.js"), "x\n");
  writeFileSync(join(repo, "integrations/py/client.py"), "x\n");
  let r = runScript(repo, "--scope", "apps/jsapp");
  assert.equal(r.rc, 0, `expected zero exit; got ${r.rc}: ${r.out}`);
  const lines = r.out.split("\n");
  assert.ok(lines.includes("apps/jsapp/src/index.js"), `index.js missing: ${r.out}`);
  assert.ok(lines.includes("apps/jsapp/package.json"), `package.json missing: ${r.out}`);
  assert.equal(r.out.includes("node_modules"), false, `installed deps listed: ${r.out}`);
  r = runScript(repo, "--scope", "integrations/py");
  assert.ok(r.out.split("\n").includes("integrations/py/client.py"), `client.py missing: ${r.out}`);
});

// ── Case 12: a failed project-history read is not an empty history ──
test("case12 projects-scope-failed-git-log-fails", () => {
  const repo = makeRepo();
  const r = spawn(["--scope", "projects/p"], { ...process.env, CLAUDE_PROJECT_DIR: repo, PATH: failingGitPath("log") });
  assert.notEqual(r.rc, 0, `a failing git log exited ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("simulated log failure"), `git's own error was not surfaced: ${r.out}`);
});

// ── Case 12b: a failed `git show` of a matched commit fails loud too ──
test("case12b projects-scope-failed-git-show-fails", () => {
  const repo = makeRepo();
  const r = spawn(["--scope", "projects/p"], {
    ...process.env,
    CLAUDE_PROJECT_DIR: repo,
    PATH: failingGitPath("show"),
  });
  assert.notEqual(r.rc, 0, `a failing git show exited ${r.rc}: ${r.out}`);
});

// ── Case 12c: the project branch still resolves on the happy path ──
test("case12c projects-scope-resolves-code-by-subject", () => {
  const r = runScript(makeRepo(), "--scope", "projects/p");
  assert.equal(r.rc, 0, `expected zero; got ${r.rc}: ${r.out}`);
  assert.ok(r.out.includes("apps/foo/a.ts"), `missing apps/foo/a.ts: ${r.out}`);
});

// ── Case 13: a staged list larger than spawnSync's default 1 MiB is whole ──
test("case13 blank-scope-large-staged-list-is-complete", () => {
  const repo = makeRepo();
  const deep = join(repo, "s", "x".repeat(180));
  mkdirSync(deep, { recursive: true });
  const N = 6000;
  for (let i = 0; i < N; i++) writeFileSync(join(deep, `f${i}.ts`), "");
  execFileSync("git", ["-C", repo, "add", "s"]);
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--scope", ""], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60000,
  });
  assert.equal(r.status, 0, `expected zero; got ${r.status}: ${r.stderr}`);
  const lines = r.stdout.split("\n").filter((l) => l !== "");
  assert.equal(lines.length, N, `expected all ${N} staged paths, got ${lines.length}`);
});

// ── Case 13b: a failed staged-file capture is not an empty staging area ──
test("case13b blank-scope-failed-git-diff-fails", () => {
  const repo = makeRepo();
  const r = spawn(["--scope", ""], { ...process.env, CLAUDE_PROJECT_DIR: repo, PATH: failingGitPath("diff") });
  assert.notEqual(r.rc, 0, `a failing git diff exited ${r.rc}: ${r.out}`);
});
