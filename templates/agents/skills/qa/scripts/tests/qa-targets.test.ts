#!/usr/bin/env -S node --experimental-strip-types
// qa-targets.test.ts — the web-target enumerator, against hermetic temp repos.
//
// Each case builds a repo with real package.json files and lets the REAL
// detect-app.ts classify them — a stubbed detector would test this suite's idea
// of what web means rather than the one /qa actually uses. Only the crash cases
// swap in a stub, because a detector that fails on demand is the one thing the
// real one will not do. The script is spawned, never imported.
//
// The baseline case replays fixtures/qa-targets-baseline/ — a real web app's
// package.json (astro) beside two non-web apps (apps/notes/dashboard, unknown;
// apps/tools/renderer, render) and a shared component only the web app
// imports — through the argument shape validate.ts uses (`--repo <dir> [--base
// <sha>]`), and holds the output to what the bash original printed for the same
// tree, with the temp repo's path written as @REPO@.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/qa-targets.test.ts
//
// peers:
//   .agents/skills/qa/scripts/qa-targets.ts
//   .agents/skills/qa/scripts/detect-app.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TARGETS = join(HERE, "..", "qa-targets.ts");
const BASELINE = join(HERE, "fixtures", "qa-targets-baseline");

const TMP = mkdtempSync(join(tmpdir(), "qa-targets-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  rc: number | null;
  out: string;
  err: string;
}
function run(args: string[], opts: { env?: Record<string, string>; input?: string; timeout?: number } = {}): Run {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", TARGETS, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...opts.env },
    input: opts.input,
    timeout: opts.timeout ?? 120_000,
  });
  return { rc: r.status, out: r.stdout.replace(/\n+$/, ""), err: r.stderr };
}
const lines = (out: string): string[] => out.split("\n").filter(Boolean);

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();
}
function newRepo(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(dir);
  git(dir, "init", "-q", ".");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  return dir;
}
function put(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

// A directory detect-app.ts calls `astro` — a package.json naming astro is the
// whole signal, no config file needed.
function makeAstro(dir: string): void {
  put(join(dir, "package.json"), `{"name":"${basename(dir)}","private":true,"dependencies":{"astro":"^4.0.0"}}\n`);
  put(join(dir, "src/pages/index.astro"), "<h1>hi</h1>\n");
}
// A CLI: a `bin` and no web toolchain, which detect-app.ts exits 3 on.
function makeCli(dir: string): void {
  put(join(dir, "package.json"), `{"name":"${basename(dir)}","private":true,"bin":{"x":"./src/x.js"}}\n`);
  put(join(dir, "src/x.js"), "console.log(1)\n");
}
/** A runtime-written stub detector: a tiny sh script, executed directly. */
function stub(name: string, body: string): string {
  const path = join(TMP, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// ── The baseline: the bash original's output for a real web app ──────
// The fixture's manifests are committed as `package.fixture.json`: a real
// `package.json` would make this repo's own qa-targets walk read the fixture as
// a web app, and every close touching it would owe a /qa of a folder with no
// server. The copy gets its real names back before the repo is made.
function restoreManifests(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) restoreManifests(path);
    else if (entry.name === "package.fixture.json") renameSync(path, join(dir, "package.json"));
  }
}

test("matches the bash original on the baseline fixture, --repo --base (validate.ts's shape)", () => {
  const repo = join(TMP, "baseline");
  cpSync(join(BASELINE, "tree"), repo, { recursive: true });
  restoreManifests(repo);
  git(repo, "init", "-q", ".");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");
  // The shared component and the render target's README are committed; the
  // note in the unclassifiable app stays untracked.
  cpSync(join(BASELINE, "change"), repo, { recursive: true });
  git(repo, "add", "packages", "apps/tools");
  git(repo, "commit", "-qm", "change");
  const expect = (file: string): string => readFileSync(join(BASELINE, file), "utf8").replaceAll("@REPO@", repo);

  const withBase = spawnSync(
    process.execPath,
    ["--experimental-strip-types", TARGETS, "--repo", repo, "--base", base],
    {
      encoding: "utf8",
    },
  );
  assert.equal(withBase.stdout, expect("expected.stdout"));
  assert.equal(`${withBase.status}\n`, expect("expected.status"));

  const noBase = spawnSync(process.execPath, ["--experimental-strip-types", TARGETS, "--repo", repo], {
    encoding: "utf8",
  });
  assert.equal(noBase.stdout, expect("expected-no-base.stdout"));
  assert.equal(`${noBase.status}\n`, expect("expected-no-base.status"));
});

// ── 0 targets ─────────────────────────────────────────────────────────

const R0 = newRepo("zero");
put(join(R0, "apps/tools/toolchain/checks/thing.sh"), "#!/usr/bin/env bash\necho hi\n");
git(R0, "add", "apps");
git(R0, "commit", "-qm", "init");
{
  const r = run(["--repo", R0, "apps/tools/toolchain/checks/thing.sh"]);
  test("a toolchain-only change exits 0", () => assert.equal(r.rc, 0, r.err));
  test("a toolchain-only change has no targets", () => assert.equal(r.out, ""));
}
{
  const r = run(["--repo", R0]);
  test("a clean tree exits 0", () => assert.equal(r.rc, 0, r.err));
  test("a clean tree has no targets", () => assert.equal(r.out, ""));
}
{
  makeCli(join(R0, "apps/media/cli-thing"));
  const r = run(["--repo", R0, "apps/media/cli-thing/src/x.js"]);
  test("a CLI change exits 0", () => assert.equal(r.rc, 0, r.err));
  test("a CLI is not a target", () => assert.equal(r.out, ""));
}

// ── 1 target, and the nesting that used to break the walk ─────────────

const R1 = newRepo("one");
makeAstro(join(R1, "apps/web/portal"));
git(R1, "add", "apps");
git(R1, "commit", "-qm", "init");
{
  const r = run(["--repo", R1, "apps/web/portal/src/pages/index.astro"]);
  test("a nested apps/<domain>/<app> resolves to the APP", () => assert.equal(r.out, `${R1}/apps/web/portal`));
  test("and not to the domain directory", () => assert.ok(!lines(r.out).includes(`${R1}/apps/web`)));
}
{
  // Two files in one app are one target, not two.
  put(join(R1, "apps/web/portal/src/util.ts"), "export const x = 1\n");
  const r = run(["--repo", R1, "apps/web/portal/src/pages/index.astro", "apps/web/portal/src/util.ts"]);
  test("two files in one app are one target", () => assert.equal(lines(r.out).length, 1));
}
{
  // The worktree root itself can be the app — a standalone site repo has no
  // apps/ layer at all.
  const RR = newRepo("root-app");
  makeAstro(RR);
  git(RR, "add", "package.json", "src");
  git(RR, "commit", "-qm", "init");
  const r = run(["--repo", RR, "src/pages/index.astro"]);
  test("a web worktree root is itself a target", () => assert.equal(r.out, RR));
}

// ── 2 targets ─────────────────────────────────────────────────────────

const R2 = newRepo("two");
makeAstro(join(R2, "apps/web/portal"));
makeAstro(join(R2, "apps/billing/dashboard"));
makeCli(join(R2, "apps/media/cli-thing"));
git(R2, "add", "apps");
git(R2, "commit", "-qm", "init");
{
  const r = run([
    "--repo",
    R2,
    "apps/web/portal/src/pages/index.astro",
    "apps/billing/dashboard/src/pages/index.astro",
    "apps/media/cli-thing/src/x.js",
  ]);
  test("two web apps are two targets", () => assert.equal(lines(r.out).length, 2));
  test("the first app is listed", () => assert.ok(lines(r.out).includes(`${R2}/apps/web/portal`), r.out));
  test("the second app is listed", () => assert.ok(lines(r.out).includes(`${R2}/apps/billing/dashboard`), r.out));
  test("the CLI beside them is not", () => assert.ok(!r.out.includes("cli-thing"), r.out));
  test("the list is sorted LC_ALL=C", () =>
    assert.deepEqual(
      lines(r.out),
      [...lines(r.out)].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    ));
}

// ── A shared package fans out to its consumers ────────────────────────
//
// The file itself lives in no app, so the walk-up finds nothing. Reporting "no
// UI changed" there is the failure this case exists for: both apps just changed
// what they render.

const RS = newRepo("shared");
makeAstro(join(RS, "apps/web/portal"));
makeAstro(join(RS, "apps/billing/dashboard"));
put(join(RS, "packages/ui/button.ts"), "export const Button = () => null\n");
put(
  join(RS, "apps/web/portal/src/uses.ts"),
  'import { Button } from "../../../../packages/ui/button"\nexport const a = Button\n',
);
put(
  join(RS, "apps/billing/dashboard/src/uses.ts"),
  'import { Button } from "../../../../packages/ui/button"\nexport const b = Button\n',
);
git(RS, "add", "apps", "packages");
git(RS, "commit", "-qm", "init");
{
  const r = run(["--repo", RS, "packages/ui/button.ts"]);
  test("a shared package change reaches both consumers", () => assert.equal(lines(r.out).length, 2, r.out));
  test("consumer one", () => assert.ok(r.out.includes(`${RS}/apps/web/portal`), r.out));
  test("consumer two", () => assert.ok(r.out.includes(`${RS}/apps/billing/dashboard`), r.out));
  test("the package itself is not a target", () => assert.ok(!r.out.includes("packages/ui"), r.out));
}
{
  // A shared file nobody imports pulls in nothing.
  put(join(RS, "packages/ui/orphan.ts"), "export const orphan = 1\n");
  const r = run(["--repo", RS, "packages/ui/orphan.ts"]);
  test("an unimported shared file has no consumers", () => assert.equal(r.out, ""));
}

// ── Deleted files, and the input plumbing ─────────────────────────────

// A DELETED page is a UI change. The walk-up only needs the path's directory
// chain, which survives the deletion — so the app is still a target. Asserting
// the opposite means a deletion-only UI change enumerates nothing and skips /qa
// entirely.
test("a DELETED page still targets its app", () =>
  assert.equal(run(["--repo", R2, "apps/web/portal/src/pages/gone.astro"]).out, `${R2}/apps/web/portal`));

// A path whose whole app is gone has nothing to walk up to.
test("a path with no surviving app above it is no target", () =>
  assert.equal(run(["--repo", R2, "apps/vanished/app/src/pages/index.astro"]).out, ""));

test("--files-file dedupes", () => {
  writeFileSync(join(TMP, "list"), "apps/web/portal/src/pages/index.astro\n\napps/web/portal/src/pages/index.astro\n");
  assert.equal(lines(run(["--repo", R2, "--files-file", join(TMP, "list")]).out).length, 1);
});

test("--files-file - reads stdin", () =>
  assert.equal(
    run(["--repo", R2, "--files-file", "-"], { input: "apps/billing/dashboard/src/pages/index.astro\n" }).out,
    `${R2}/apps/billing/dashboard`,
  ));

test("a relative --files-file is read from inside --repo", () => {
  writeFileSync(join(R2, "changed.txt"), "apps/billing/dashboard/src/pages/index.astro\n");
  const r = run(["--repo", R2, "--files-file", "changed.txt"]);
  rmSync(join(R2, "changed.txt"));
  assert.equal(r.out, `${R2}/apps/billing/dashboard`, r.err);
});

test("a missing --files-file is a caller error", () =>
  assert.equal(run(["--repo", R2, "--files-file", join(TMP, "no-such-list")]).rc, 2));

test("an untracked edit is seen with no explicit list", () => {
  // With no list at all, the changed set comes from the worktree itself.
  put(join(R2, "apps/web/portal/src/fresh.ts"), "export const fresh = 1\n");
  const r = run(["--repo", R2]);
  rmSync(join(R2, "apps/web/portal/src/fresh.ts"));
  assert.ok(lines(r.out).includes(`${R2}/apps/web/portal`), r.out);
});

// ── --base: a UI change that is already COMMITTED ─────────────────────
//
// /implement-audit reviews BASE_SHA..HEAD *plus* uncommitted, so a session that
// committed its UI change has it in the review and nowhere in `git diff HEAD`.
// Without --base this enumerated nothing and answered "skipped-not-web" for a
// change that was all pixels.

const RB = newRepo("committed");
makeAstro(join(RB, "apps/web/portal"));
put(join(RB, "apps/tools/toolchain/thing.sh"), "#!/usr/bin/env bash\necho hi\n");
git(RB, "add", "apps");
git(RB, "commit", "-qm", "init");
const BASE_SHA = git(RB, "rev-parse", "HEAD");
put(join(RB, "apps/web/portal/src/pages/index.astro"), "<h1>changed</h1>\n");
git(RB, "add", "apps/web/portal");
git(RB, "commit", "-qm", "edit the page");

test("without --base a committed UI change is invisible", () => assert.equal(run(["--repo", RB]).out, ""));
test("with --base it is found", () =>
  assert.equal(run(["--repo", RB, "--base", BASE_SHA]).out, `${RB}/apps/web/portal`));
{
  const r = run(["--repo", RB, "--base", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"]);
  test("an unresolvable --base is a HALT", () => assert.equal(r.rc, 2));
  test("and says why", () => assert.ok(r.err.includes("would silently read as 'no UI changed'"), r.err));
}

// ── The fan-out is a WALK, not one hop ────────────────────────────────
//
// A shared component is usually not imported by the app directly — it goes
// through a barrel. A single-hop walk stops at that barrel, finds it is not web,
// and reports no target, so every barrel-exported shared change bypassed QA.

const RH = newRepo("hops");
makeAstro(join(RH, "apps/web/portal"));
put(join(RH, "packages/ui/button.ts"), "export const Button = () => null\n");
put(join(RH, "packages/ui/index.ts"), 'export { Button } from "./button"\n');
put(
  join(RH, "apps/web/portal/src/uses.ts"),
  'import { Button } from "../../../../packages/ui/index"\nexport const a = Button\n',
);
git(RH, "add", "apps", "packages");
git(RH, "commit", "-qm", "init");
{
  // Run now: the cycle case below rewrites this repo's barrel before any test
  // body runs.
  const r = run(["--repo", RH, "packages/ui/button.ts"]);
  test("a change two hops from the app still reaches it", () => assert.equal(r.out, `${RH}/apps/web/portal`));
}

// A chain longer than any cap anyone would pick. The first version stopped at
// six hops and returned SUCCESS with importers still queued — a silent "no UI
// changed" for a change that had one. Termination comes from the visited set,
// not from a depth bound.
const RD = newRepo("deep");
makeAstro(join(RD, "apps/web/portal"));
put(join(RD, "packages/chain/hop00.ts"), "export const leaf = 1\n");
for (let i = 1; i <= 9; i++) {
  const hop = (n: number): string => `hop${String(n).padStart(2, "0")}`;
  put(join(RD, `packages/chain/${hop(i)}.ts`), `export { leaf } from "./${hop(i - 1)}"\n`);
}
put(
  join(RD, "apps/web/portal/src/deep.ts"),
  'import { leaf } from "../../../../packages/chain/hop09"\nexport const deep = leaf\n',
);
git(RD, "add", "apps", "packages");
git(RD, "commit", "-qm", "init");
test("a ten-hop chain still reaches the app", () =>
  assert.equal(run(["--repo", RD, "packages/chain/hop00.ts"]).out, `${RD}/apps/web/portal`));

// A cycle must terminate rather than walk forever.
{
  put(join(RH, "packages/ui/index.ts"), 'export { Button } from "./button"\nimport "./cycle"\n');
  put(join(RH, "packages/ui/cycle.ts"), 'import "./index"\nexport const cycle = 1\n');
  const r = run(["--repo", RH, "packages/ui/button.ts"], { timeout: 60_000 });
  test("a circular import graph terminates", () => assert.equal(r.rc, 0, r.err));
  test("and still reaches the app", () => assert.ok(r.out.includes(`${RH}/apps/web/portal`), r.out));
}

// ── The walk scans the repo ONCE, not once per file it reaches ─────────
//
// A walk where every file it reached ran its own repo-wide `git grep` took
// about 15 minutes on a diff touching one widely imported library file, and a
// 322-file diff was unfinished after about 50. A `git`
// shim on PATH logs every `git grep` and hands the call to the real git.
{
  const shim = join(TMP, "shim");
  mkdirSync(shim);
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const logFile = join(TMP, "git-greps.log");
  // `ls-files` is logged too: it is the one listing import-map.ts makes, so
  // more than one means the map was rebuilt per file instead.
  writeFileSync(
    join(shim, "git"),
    `#!/bin/sh\ncase "\${1:-} \${3:-}" in grep*|*ls-files*) echo "$1 $3" >>"${logFile}" ;; esac\nexec "${realGit}" "$@"\n`,
  );
  chmodSync(join(shim, "git"), 0o755);
  writeFileSync(logFile, "");
  const r = run(["--repo", RD, "packages/chain/hop00.ts"], { env: { PATH: `${shim}:${process.env.PATH ?? ""}` } });
  test("the shimmed ten-hop walk still reaches the app", () => assert.equal(r.out, `${RD}/apps/web/portal`));
  test("a ten-hop walk scans the repo once, not once per file reached", () => {
    const scans = lines(readFileSync(logFile, "utf8"));
    assert.ok(scans.length <= 1, `scanned ${scans.length} times: ${scans.join(", ")}`);
  });
}

// An UNTRACKED importer counts, as it did under `git grep --untracked`: a new
// page not yet added still renders the changed component.
{
  const RU = newRepo("untracked");
  makeAstro(join(RU, "apps/web/portal"));
  put(join(RU, "packages/ui/button.ts"), "export const Button = () => null\n");
  git(RU, "add", "apps", "packages");
  git(RU, "commit", "-qm", "init");
  put(
    join(RU, "apps/web/portal/src/new.ts"),
    'import { Button } from "../../../../packages/ui/button"\nexport const a = Button\n',
  );
  test("an untracked importer still reaches the app", () =>
    assert.equal(run(["--repo", RU, "packages/ui/button.ts"]).out, `${RU}/apps/web/portal`));
}

// A comment's prose "from the import" ending in a quote must not run on into the
// next line and swallow the real import there. The one-pass map did exactly
// that on its first version; the grep walk matched line by line.
{
  const RP = newRepo("prose");
  makeAstro(join(RP, "apps/web/portal"));
  put(join(RP, "packages/ui/button.ts"), "export const Button = () => null\n");
  put(
    join(RP, "apps/web/portal/src/uses.ts"),
    '// re-deriving it "from the import" would be wrong\nimport { Button } from "../../../../packages/ui/button"\nexport const a = Button\n',
  );
  git(RP, "add", "apps", "packages");
  git(RP, "commit", "-qm", "init");
  test("an import after a quoted 'from' in a comment still counts", () =>
    assert.equal(run(["--repo", RP, "packages/ui/button.ts"]).out, `${RP}/apps/web/portal`));
}

// ── Caller errors and the detector HALT ───────────────────────────────

test("a missing --repo is a caller error", () => assert.equal(run(["--repo", join(TMP, "nope"), "a.ts"]).rc, 2));
test("no --repo at all is a caller error", () => assert.equal(run(["a.ts"]).rc, 2));
test("--repo with no value is a caller error", () => assert.equal(run(["--repo"]).rc, 2));
test("an unknown flag is a caller error", () => assert.equal(run(["--repo", R2, "--sideways"]).rc, 2));

test("a missing detector is a HALT, not 'not web'", () =>
  assert.equal(
    run(["--repo", R2, "apps/web/portal/src/pages/index.astro"], {
      env: { QA_DETECT_APP: join(TMP, "no-such-detector.ts") },
    }).rc,
    2,
  ));

// exit 2 is the detector FAILING. Reading that as "no UI here" is how a UI
// ships with no QA and a green run.
{
  const crash = stub("crashing-detector", 'echo "detector blew up" >&2\nexit 2');
  const r = run(["--repo", R2, "apps/web/portal/src/pages/index.astro"], { env: { QA_DETECT_APP: crash } });
  test("a detector exiting 2 is exit 2, not an empty list", () => assert.equal(r.rc, 2));
  test("the halt says why", () => assert.ok(r.err.includes("Refusing to report 'no UI changed'"), r.err));
}

// exit 3 is the detector WORKING and saying "I cannot classify this". That is
// data, and it means not-web.
{
  const unknown = stub("unknown-detector", 'echo "TYPE=unknown"\nexit 3');
  const r = run(["--repo", R2, "apps/web/portal/src/pages/index.astro"], { env: { QA_DETECT_APP: unknown } });
  test("a detector exiting 3 is not a failure", () => assert.equal(r.rc, 0, r.err));
  test("a detector exiting 3 means not-web", () => assert.equal(r.out, ""));
}

// Every web TYPE the detector can return is a target; cli/render/unknown are not.
for (const t of ["astro-cf", "astro", "next", "vite", "static", "node-server"]) {
  const detector = stub(`type-${t}`, `echo "TYPE=${t}"\nexit 0`);
  test(`TYPE=${t} is a web target`, () =>
    assert.equal(
      run(["--repo", R2, "apps/web/portal/src/pages/index.astro"], { env: { QA_DETECT_APP: detector } }).out,
      `${R2}/apps/web/portal`,
    ));
}
for (const t of ["cli", "render", "unknown"]) {
  const detector = stub(`type-${t}`, `echo "TYPE=${t}"\nexit 0`);
  test(`TYPE=${t} is not a web target`, () =>
    assert.equal(
      run(["--repo", R2, "apps/web/portal/src/pages/index.astro"], { env: { QA_DETECT_APP: detector } }).out,
      "",
    ));
}
