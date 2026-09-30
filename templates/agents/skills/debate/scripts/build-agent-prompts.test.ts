// Test harness for build-agent-prompts.ts — always exactly three role prompts,
// named so they sort into seat order, and no format or config to choose.
//
// The program is SPAWNED, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/debate/scripts/build-agent-prompts.test.ts
//
// peers: build-agent-prompts.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-agent-prompts.ts");
const ROLES = ["pragmatist", "skeptic", "visionary"];

// Every dir the script or this suite made, removed at the end.
const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function promptsDir(stdout: string): string {
  const m = /^prompts_dir=(.+)$/m.exec(stdout);
  assert.ok(m, `no prompts_dir= line: ${stdout}`);
  const dir = m[1] ?? "";
  made.push(dir);
  return dir;
}

test("the script is executable", () => {
  assert.ok((statSync(SCRIPT).mode & 0o111) !== 0, `not executable: ${SCRIPT}`);
});

test("any question yields exactly the three role prompts, in seat order", () => {
  const r = run("--question", "X or Y?");
  assert.equal(r.code, 0, r.stderr);
  const dir = promptsDir(r.stdout);
  // Sorted order IS seat order: dispatch-agents.ts gives seat N to panel voice N.
  const order = readdirSync(dir)
    .filter((f) => f.endsWith(".prompt"))
    .sort();
  assert.deepEqual(order, ["pragmatist.prompt", "skeptic.prompt", "visionary.prompt"]);
});

test("every prompt carries the question, its stance and the schema anchor", () => {
  const dir = promptsDir(run("--question", "Should we ship feature X?").stdout);
  for (const role of ROLES) {
    const body = readFileSync(join(dir, `${role}.prompt`), "utf8");
    assert.ok(body.includes("Question: Should we ship feature X?"), `${role} prompt lacks the question`);
    assert.match(body, /^## Position/m, `${role} prompt lacks the ## Position anchor the parser reads`);
  }
  assert.ok(
    readFileSync(join(dir, "skeptic.prompt"), "utf8").includes("Your assigned position: Skeptic"),
    "skeptic prompt lacks its stance",
  );
});

test("the removed --format and --config choices are refused, not silently ignored", () => {
  const f = run("--question", "q", "--format", "council");
  assert.equal(f.code, 2, "expected exit 2 on --format");
  assert.match(f.stderr, /unknown flag: --format/);
  assert.equal(run("--question", "q", "--config", "cross").code, 2, "expected exit 2 on --config");
});

test("an empty --question fails loud with exit 2", () => {
  const r = run("--question", "");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /question empty/);
});

test("a missing --context-file path fails loud", () => {
  const r = run("--question", "q", "--context-file", `/tmp/does-not-exist-${process.pid}`);
  assert.notEqual(r.code, 0, "expected non-zero on missing context");
  assert.match(r.stderr, /context file not found/);
});

test("a context file reaches every prompt", () => {
  const scratch = mkdtempSync(join(tmpdir(), "build-prompts-test-"));
  made.push(scratch);
  const ctx = join(scratch, "ctx.md");
  writeFileSync(ctx, "- Decision: pick a queue\n");
  const dir = promptsDir(run("--question", "q", "--context-file", ctx).stdout);
  for (const role of ROLES) {
    assert.ok(
      readFileSync(join(dir, `${role}.prompt`), "utf8").includes("Decision: pick a queue"),
      `${role} prompt lacks the context`,
    );
  }
});
