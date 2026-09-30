// trunk.test.ts — the resolver behind every close script's trunk name.
//
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/trunk.test.ts
//
// Fixtures are real git repos with real bare origins under a temp dir. The
// `master` rows are the ones that matter: a repo on `master` is the case this
// file exists to keep working. The cases run in order and share the fixtures: the fallback
// cases break the repos the earlier cases read.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "trunk.ts");
const TMP = mkdtempSync(join(tmpdir(), "trunk-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function git(...args: string[]): string {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return (r.stdout ?? "").replace(/\n+$/, "");
}

function trunk(...args: string[]): { code: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout.replace(/\n+$/, "") };
}

// A checkout with a bare origin whose default branch is `branch`.
function mkrepo(name: string, branch: string): string {
  const origin = join(TMP, "origins", `${name}.git`);
  const work = join(TMP, "checkouts", name);
  mkdirSync(join(TMP, "origins"), { recursive: true });
  mkdirSync(join(TMP, "checkouts"), { recursive: true });
  git("init", "-q", "--bare", `--initial-branch=${branch}`, origin);
  git("init", "-q", `--initial-branch=${branch}`, work);
  git("-C", work, "config", "user.email", "t@t");
  git("-C", work, "config", "user.name", "T");
  writeFileSync(join(work, "f"), "x\n");
  git("-C", work, "add", "-A");
  git("-C", work, "commit", "-qm", "init");
  git("-C", work, "remote", "add", "origin", origin);
  git("-C", work, "push", "-q", "-u", "origin", branch);
  git("-C", work, "remote", "set-head", "origin", "--auto");
  return work;
}

const MAIN = mkrepo("main-repo", "main");
const MASTER = mkrepo("master-repo", "master");
const ODD = mkrepo("odd-repo", "trunk");

// ── The two spellings ──────────────────────────────────────────────────
test("main repo: name", () => assert.equal(trunk(MAIN).stdout, "main"));
test("main repo: ref", () => assert.equal(trunk("--ref", MAIN).stdout, "origin/main"));
test("master repo: name", () => assert.equal(trunk(MASTER).stdout, "master"));
test("master repo: ref", () => assert.equal(trunk("--ref", MASTER).stdout, "origin/master"));

// A trunk called neither. Nothing in the resolver may hardcode the two common
// names when the remote states the answer outright.
test("arbitrary trunk name is read, not guessed", () => assert.equal(trunk(ODD).stdout, "trunk"));

// ── Asked from inside a WORKTREE, not just the checkout ────────────────
// Every caller in land.ts runs `git -C <worktree>`, so the resolver has to
// answer the same there. A worktree shares the checkout's refs, so this is the
// same origin/HEAD by a different path — asserted because "obvious" is how a
// `--git-common-dir` assumption gets broken later.
test("from inside a worktree", () => {
  const WT = join(TMP, "wt-master");
  git("-C", MASTER, "worktree", "add", "-q", "-b", "side", WT);
  try {
    assert.equal(trunk("--ref", WT).stdout, "origin/master");
  } finally {
    git("-C", MASTER, "worktree", "remove", "--force", WT);
  }
});

// ── Fallback 2: origin/HEAD unset, remote reachable ────────────────────
// `git clone` sets origin/HEAD; `git remote add` after the fact does not, so an
// unset head is an ordinary state rather than a corrupt one.
test("origin/HEAD unset: asks the remote", () => {
  git("-C", MASTER, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  assert.equal(trunk(MASTER).stdout, "master");
});
// And CACHES it, so the next call needs no network.
test("and writes the answer back", () => {
  assert.equal(git("-C", MASTER, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"), "origin/master");
});

// ── Fallback 3: origin/HEAD unset AND the remote is gone ───────────────
// The floor. A probe of the two names that cover every repo here, `main` first.
test("unreachable remote falls back to the probe", () => {
  git("-C", MASTER, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  git("-C", MASTER, "remote", "set-url", "origin", join(TMP, "origins/does-not-exist.git"));
  assert.equal(trunk(MASTER).stdout, "master");
});

// `main` wins the probe when BOTH tracking refs exist — it is the newer default
// and the one every repo here uses.
test("probe prefers main over master", () => {
  git("-C", MAIN, "symbolic-ref", "-d", "refs/remotes/origin/HEAD");
  git("-C", MAIN, "update-ref", "refs/remotes/origin/master", git("-C", MAIN, "rev-parse", "HEAD"));
  git("-C", MAIN, "remote", "set-url", "origin", join(TMP, "origins/does-not-exist.git"));
  assert.equal(trunk(MAIN).stdout, "main");
});

// ── Refusals. It never guesses. ────────────────────────────────────────
test("no remote at all", () => {
  const NOTHING = join(TMP, "checkouts/nothing");
  git("init", "-q", "--initial-branch=main", NOTHING);
  const r = trunk(NOTHING);
  assert.equal(r.code, 2, "no remote at all: exit 2");
  assert.ok(r.out.includes("no trunk branch"), `no remote at all: says why — '${r.out}'`);
});

test("missing dir", () => {
  const r = trunk(join(TMP, "not-a-repo"));
  assert.equal(r.code, 2, "missing dir: exit 2");
  assert.ok(r.out.includes("not a git repo"), `missing dir: says why — '${r.out}'`);
});

test("a plain directory is not a repo", () => {
  const NOTGIT = join(TMP, "plain");
  mkdirSync(NOTGIT, { recursive: true });
  assert.equal(trunk(NOTGIT).code, 2);
});

test("no argument", () => {
  const r = trunk();
  assert.equal(r.code, 2, "no argument: exit 2");
  assert.ok(r.out.includes("usage"), `no argument: usage — '${r.out}'`);
});

test("two repos at once", () => {
  const r = trunk(MAIN, MASTER);
  assert.equal(r.code, 2, "two repos at once: exit 2");
  assert.ok(r.out.includes("one repo at a time"), `two repos at once: says why — '${r.out}'`);
});
