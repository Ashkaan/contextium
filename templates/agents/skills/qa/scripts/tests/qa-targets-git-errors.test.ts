#!/usr/bin/env -S node --experimental-strip-types
// qa-targets-git-errors.test.ts — a git read that FAILS inside qa-targets.ts
// must halt (exit 2), never read as "no web app changed". Each git subcommand
// the script reads is failed in turn by a shim on PATH that exits 128 for that
// one subcommand and runs the real git for everything else. The script is
// spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/qa-targets-git-errors.test.ts
//
// peers:
//   .agents/skills/qa/scripts/qa-targets.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const TARGETS = join(dirname(fileURLToPath(import.meta.url)), "..", "qa-targets.ts");
const TMP = mkdtempSync(join(tmpdir(), "qa-targets-git-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const SHIM = join(TMP, "shim");
mkdirSync(SHIM);
writeFileSync(
  join(SHIM, "git"),
  `#!/bin/sh
if [ -n "\${FAIL_GIT:-}" ] && [ "$1" = "$FAIL_GIT" ]; then
  echo "fatal: simulated $1 failure" >&2
  exit 128
fi
exec "${REAL_GIT}" "$@"
`,
);
chmodSync(join(SHIM, "git"), 0o755);

const git = (dir: string, ...args: string[]): void => {
  execFileSync(REAL_GIT, ["-C", dir, ...args], { stdio: "ignore" });
};
function astro(dir: string): void {
  mkdirSync(join(dir, "src/pages"), { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    `{"name":"${basename(dir)}","private":true,"dependencies":{"astro":"^4.0.0"}}\n`,
  );
  writeFileSync(join(dir, "src/pages/index.astro"), "<h1>hi</h1>\n");
}

/** Run with the shim on PATH, failing `failGit` (or nothing). */
function run(repo: string, failGit: string, ...args: string[]): { rc: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", TARGETS, "--repo", repo, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${SHIM}:${process.env.PATH ?? ""}`, FAIL_GIT: failGit },
  });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}

// A shared package imported by one web app; the change is in the package, so
// only the import fan-out can find the app. Its one git read is import-map.ts's
// `git ls-files` (it replaced a per-file `git grep`).
const R = join(TMP, "repo");
mkdirSync(R);
git(R, "init", "-q", ".");
git(R, "config", "user.email", "t@example.com");
git(R, "config", "user.name", "t");
astro(join(R, "apps/web/site"));
mkdirSync(join(R, "packages/ui"), { recursive: true });
writeFileSync(join(R, "packages/ui/package.json"), '{"name":"@acme/ui","private":true}\n');
writeFileSync(join(R, "packages/ui/button.ts"), "export const b = 1\n");
writeFileSync(join(R, "apps/web/site/src/uses.ts"), 'import { b } from "../../../../packages/ui/button"\n');
git(R, "add", "-A");
git(R, "commit", "-qm", "base");

// The cases share one repo whose state moves between them, so each result is
// taken here, in order, and asserted below.
const control = run(R, "", "packages/ui/button.ts");
const fanOutFail = run(R, "ls-files", "packages/ui/button.ts");
appendFileSync(join(R, "apps/web/site/src/pages/index.astro"), "change\n");
const editControl = run(R, "");
const diffFail = run(R, "diff");
const lsFilesFail = run(R, "ls-files");
const revParseFail = run(R, "rev-parse");
git(R, "checkout", "-q", "--", ".");

test("control: the fan-out finds the app", () => assert.equal(`${control.rc} ${control.out}`, `0 ${R}/apps/web/site`));
test("a failed git ls-files in the fan-out is exit 2", () => assert.equal(fanOutFail.rc, 2));
test("and prints no targets", () => assert.equal(fanOutFail.out, ""));
test("and says the listing failed, once", () =>
  assert.equal(fanOutFail.err.split("\n").filter((l) => l.includes("could not list")).length, 1, fanOutFail.err));

test("control: an uncommitted edit is found", () => assert.equal(editControl.rc, 0, editControl.err));
test("a failed git diff is exit 2", () => assert.equal(diffFail.rc, 2));
test("a failed git ls-files is exit 2", () => assert.equal(lsFilesFail.rc, 2));
// A git error from `rev-parse --verify HEAD` (exit 128) is not "no commit yet":
// reading it as unborn scans the staged set only and misses this unstaged edit.
test("a failed git rev-parse is exit 2, not an unborn repo", () => assert.equal(revParseFail.rc, 2));
test("and a failed rev-parse prints no targets", () => assert.equal(revParseFail.out, ""));

// A repo with no commit yet: `git diff HEAD` cannot run, and must not be taken
// for a failure — the new files are all untracked and still counted.
const U = join(TMP, "unborn");
mkdirSync(U);
git(U, "init", "-q", ".");
astro(join(U, "apps/web/site"));
const unbornUntracked = run(U, "");
git(U, "add", "-A");
const unbornStaged = run(U, "");
// Unborn, with an unstaged edit on top of a staged file, and an untracked app:
// staged, unstaged and untracked are all read.
astro(join(U, "apps/web/other"));
appendFileSync(join(U, "apps/web/site/src/pages/index.astro"), "edit\n");
const unbornAll = run(U, "");
// An app edited only in the working tree and never staged: `git add -N`
// (intent to add) puts its paths in the index with no content, so the staged
// read and `ls-files --others` both skip them — only the unstaged read sees it.
astro(join(U, "apps/web/intent"));
git(U, "add", "-N", "apps/web/intent");
const unbornIntent = run(U, "");
const unbornDiffFail = run(U, "diff");

test("a repo with no commit still lists its untracked app", () =>
  assert.equal(`${unbornUntracked.rc} ${unbornUntracked.out}`, `0 ${U}/apps/web/site`));
test("and its staged app", () => assert.equal(`${unbornStaged.rc} ${unbornStaged.out}`, `0 ${U}/apps/web/site`));
test("no commit: staged, unstaged and untracked apps are all listed", () =>
  assert.equal(`${unbornAll.rc} ${unbornAll.out.replaceAll("\n", " ")}`, `0 ${U}/apps/web/other ${U}/apps/web/site`));
test("no commit: an app only in the working tree (never staged) is listed", () =>
  assert.ok(unbornIntent.out.split("\n").includes(`${U}/apps/web/intent`), unbornIntent.out));
test("no commit: a failed unstaged read is exit 2", () => assert.equal(unbornDiffFail.rc, 2));
