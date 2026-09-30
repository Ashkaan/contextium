// find-project.test.ts — peer of find-project.ts.
// Run: node --test --experimental-strip-types .agents/skills/project/scripts/find-project.test.ts
//
// find-project.ts reads projects/ relative to the write root, which it asks
// session-write-root.ts for; CONTEXT_WRITE_ROOT points that at the fixture.
// The script is run as a subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "find-project.ts");
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "find-project-test.")));
after(() => rmSync(tmp, { recursive: true, force: true }));

const env: Record<string, string | undefined> = { ...process.env, CONTEXT_WRITE_ROOT: tmp };
delete env.CLAUDE_SESSION_ID;
delete env.CLAUDE_CODE_SESSION_ID;

function run(...args: string[]) {
  // --no-warnings: Node 22.6 prints an ExperimentalWarning for type stripping
  // on stderr, and one case asserts stderr is quiet.
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SUT, ...args], {
    encoding: "utf8",
    cwd: tmp,
    env: { ...env, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { out: r.stdout.replace(/\n+$/, ""), err: r.stderr, rc: r.status };
}
const mk = (...dirs: string[]): void => {
  for (const d of dirs) mkdirSync(join(tmp, d), { recursive: true });
};

// With no projects/ folder there is no project to find: NOT_FOUND, exit 0,
// like any other miss (the caller parses stdout), and nothing on stderr.
// Runs first, before any case builds the tree.
test("no projects folder at all", () => {
  const r = run("checkout-flow");
  assert.equal(`${r.out}|rc=${r.rc}`, "NOT_FOUND|rc=0", "no projects folder at all: NOT_FOUND, exit 0");
  assert.equal(r.err, "", "no projects folder at all: quiet on stderr");
});

test("resolving slugs", () => {
  mk(
    "projects/web/2026-01-10_checkout-flow",
    "projects/web/2026-02-01_checkout-retries",
    "projects/data/2026-01-05_sync-engine",
    "projects/web/2026-03-01_sync-engine",
  );
  assert.equal(run("checkout-flow").out, "PATH:projects/web/2026-01-10_checkout-flow", "bare slug resolves");
  assert.equal(run("data/sync-engine").out, "PATH:projects/data/2026-01-05_sync-engine", "qualified slug resolves");
  // Which one is filesystem order (the scan is not sorted); the qualified form
  // is how to pick.
  assert.ok(
    ["PATH:projects/data/2026-01-05_sync-engine", "PATH:projects/web/2026-03-01_sync-engine"].includes(
      run("sync-engine").out,
    ),
    "a slug in two domains resolves to one of them",
  );
  assert.equal(
    run("web/sync-engine").out,
    "PATH:projects/web/2026-03-01_sync-engine",
    "qualified form picks the other domain",
  );
  assert.equal(run("data/checkout-flow").out, "NOT_FOUND", "qualified form in the wrong domain");
  assert.equal(
    run("checkout").out,
    "NOT_FOUND:nearest: checkout-flow,checkout-retries",
    "partial slug suggests the slugs containing it",
  );
  assert.equal(run("CHECKOUT").out, "NOT_FOUND:nearest: checkout-flow,checkout-retries", "suggestions ignore case");
  assert.equal(run("flow").out, "NOT_FOUND:nearest: checkout-flow", "a suffix of a slug is not a match");
  assert.equal(run("billing").out, "NOT_FOUND", "nothing close");
  assert.equal(
    run("check.*").out,
    "NOT_FOUND:nearest: checkout-flow,checkout-retries",
    "the input is a regex for suggestions",
  );
  assert.equal(run("web").out, "NOT_FOUND", "a domain name is not a project");
});

test("missing argument exits non-zero", () => {
  assert.equal(run().rc, 1);
});

test("at most five suggestions", () => {
  mk(
    "projects/web/2026-04-01_a",
    "projects/web/2026-04-02_ab",
    "projects/web/2026-04-03_abc",
    "projects/web/2026-04-04_abcd",
    "projects/web/2026-04-05_abcde",
    "projects/web/2026-04-06_abcdef",
  );
  const list = run("b").out.replace(/^NOT_FOUND:nearest: /, "").split(",").filter(Boolean);
  assert.equal(list.length, 5);
});
