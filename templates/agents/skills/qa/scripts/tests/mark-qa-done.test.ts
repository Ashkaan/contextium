// mark-qa-done.test.ts — pin mark-qa-done.ts's two markers in a sandbox
// QA_DONE_DIR against fixture repos: the change-set marker is always written
// (even for a non-git directory), `--marker-path` prints the tree marker's path
// and writes nothing, `--tree` on a served web target refuses (3) until the
// interaction stamp for that tree exists, and cli/render targets need no stamp.
// The script is spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/mark-qa-done.test.ts
//
// peers: ../mark-qa-done.ts

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { cksum } from "../lib.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mark-qa-done.ts");
const TMP = mkdtempSync(join(tmpdir(), "mark-qa-done-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const DONE = join(TMP, "done");
const TREE = "0123456789abcdef0123456789abcdef01234567";

function run(args: string[], env: Record<string, string | undefined> = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, QA_DONE_DIR: DONE, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env: e,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8" });
const ls = () => (existsSync(DONE) ? readdirSync(DONE) : []);

// fixture: a git repo that detect-app calls `static` (a dist/ dir, no package.json)
const WEB = join(TMP, "webapp");
mkdirSync(join(WEB, "dist"), { recursive: true });
git(WEB, "init", "-q");
git(WEB, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
// fixture: a cli target
const CLI = join(TMP, "clitool");
mkdirSync(CLI);
writeFileSync(join(CLI, "package.json"), '{"scripts":{"qa:cmd":"node ."}}');
// fixture: a render target
const RENDER = join(TMP, "renderer");
mkdirSync(RENDER);
writeFileSync(join(RENDER, "package.json"), '{"scripts":{"qa:render":"node render.js"}}');

// ── usage ──
test("no repo → 2", () => {
  const r = run([]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage: mark-qa-done\.ts/);
});
test("repo not a dir → 2", () => assert.equal(run([join(TMP, "nope")]).rc, 2));
test("unknown flag → 2", () => {
  const r = run(["--bogus", WEB]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /unknown flag: --bogus/);
});
test("--tree without sha → 2", () => {
  const r = run([WEB, "--tree"]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /--tree needs a sha/);
});
test("--marker-path without --tree → 2", () => {
  const r = run(["--marker-path", WEB]);
  assert.equal(r.rc, 2);
  assert.match(r.out, /--marker-path needs --tree/);
});
test("--help → 0, prints the header", () => {
  const r = run(["--help"]);
  assert.equal(r.rc, 0);
  assert.match(r.out, /TWO MARKERS/);
});

// ── --marker-path: prints, writes nothing ── (the cases below run in order)
let MARKER = "";
let SLUG = "";
test("--marker-path → <done>/<basename>-<hash>-<tree>", () => {
  const r = run(["--marker-path", "--tree", TREE, WEB]);
  MARKER = r.stdout.replace(/\n$/, "");
  assert.equal(r.rc, 0);
  assert.ok(MARKER.startsWith(`${DONE}/webapp-`) && MARKER.endsWith(`-${TREE}`), MARKER);
  SLUG = basename(MARKER.slice(0, -(TREE.length + 1)));
});
test("--marker-path writes nothing", () => assert.equal(existsSync(DONE), false));
test("same basename elsewhere → distinct tree slug", () => {
  const OTHER = join(TMP, "other/webapp");
  mkdirSync(OTHER, { recursive: true });
  const r = run(["--marker-path", "--tree", TREE, OTHER]);
  assert.notEqual(r.stdout.replace(/\n$/, ""), MARKER);
  assert.ok(r.stdout.startsWith(`${DONE}/webapp-`));
});

// ── change-set marker only ──
test("change-set marker written as <basename>-<cksum of git status>", () => {
  const r = run([WEB]);
  const hash = cksum(git(WEB, "status", "--porcelain"));
  assert.equal(r.rc, 0);
  assert.ok(existsSync(join(DONE, `webapp-${hash}`)), ls().join(" "));
  assert.match(r.out, /marked webapp QA'd for current change-set/);
});
test("no tree marker without --tree", () => {
  const hash = cksum(git(WEB, "status", "--porcelain"));
  assert.deepEqual(ls(), [`webapp-${hash}`]);
});

// a non-git directory: best-effort hash, still exits 0 and writes a marker.
test("non-git repo → change-set marker still written, exit 0", () => {
  const r = run([CLI]);
  assert.equal(r.rc, 0);
  assert.match(r.out, /marked clitool QA'd for current change-set/);
  assert.ok(
    ls().some((f) => f.startsWith("clitool-")),
    ls().join(" "),
  );
});
test("non-git repo's change-set key is `unknown`", () => assert.ok(ls().includes("clitool-unknown"), ls().join(" ")));

// ── --tree on a served web target: refused until the interaction stamp exists ──
test("web target, no stamp → 3 with the step-3.7 hint", () => {
  const r = run(["--tree", TREE, WEB]);
  assert.equal(r.rc, 3);
  assert.ok(r.out.includes(`refusing — no clean interaction check for tree ${TREE.slice(0, 12)}`), r.out);
  assert.match(r.out, /interaction-check\.ts/);
});
test("refusal writes no tree marker", () => assert.equal(existsSync(MARKER), false));
test("web target with stamp → tree marker at the --marker-path path", () => {
  // the stamp path is the one lib.ts's formula names: interaction-<slug>-<tree>
  writeFileSync(join(DONE, `interaction-${SLUG}-${TREE}`), "");
  const r = run(["--tree", TREE, WEB]);
  assert.equal(r.rc, 0);
  assert.ok(existsSync(MARKER));
  assert.ok(r.out.includes(`marked ${SLUG} QA'd for tree ${TREE.slice(0, 12)}`), r.out);
});
test("another tree without its own stamp → 3", () =>
  assert.equal(run(["--tree", TREE.replaceAll("0", "f"), WEB]).rc, 3));

// ── cli / render targets need no stamp ──
test("cli target → tree marker without a stamp", () => {
  const r = run(["--tree", TREE, CLI]);
  assert.equal(r.rc, 0);
  assert.ok(
    ls().some((f) => f.startsWith("clitool-") && f.endsWith(`-${TREE}`)),
    ls().join(" "),
  );
});
test("render target → tree marker without a stamp", () => {
  const r = run(["--tree", TREE, RENDER]);
  assert.equal(r.rc, 0);
  assert.ok(
    ls().some((f) => f.startsWith("renderer-") && f.endsWith(`-${TREE}`)),
    ls().join(" "),
  );
});

// QA_DONE_DIR unset falls back to /tmp/qa-done — only the path is checked, nothing written
test("default DONE_DIR is /tmp/qa-done", () => {
  const r = run(["--marker-path", "--tree", TREE, WEB], { QA_DONE_DIR: undefined });
  assert.equal(r.rc, 0);
  assert.equal(r.stdout, `/tmp/qa-done/${SLUG}-${TREE}\n`);
});
