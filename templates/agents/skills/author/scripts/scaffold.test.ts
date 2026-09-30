// Test harness for scaffold.ts — boundary cases for the name contract (unknown
// type, empty name, non-kebab, collision) and each type's round-trip.
//
// Run: node --test --experimental-strip-types .agents/skills/author/scripts/scaffold.test.ts
//
// scaffold.ts writes into THIS SESSION's write root (session-write-root.ts), not
// a self-located repo root, so this harness pins CONTEXT_WRITE_ROOT to the
// checkout it is asserting against. Without the pin the test was asserting in one
// tree while the scaffold wrote in another: run from a worktree with a live
// session it wrote into the MAIN checkout, and four cases failed with "file not
// written" while the files sat, uncleaned, one directory over.
//
// Destructive cases (skill/hook/agent writes) use throwaway kebab names under a
// `zz-` prefix, inside throwaway roots removed at the end.
//
// peers: scaffold.ts, verify.ts, ../../implement/scripts/session-write-root.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "scaffold.ts");
// A scaffolded skill lands under `<workbench>/.agents/skills/`. Skill cases run
// against a throwaway SKILLS_ROOT — without it they would scaffold into the live
// tree. REPO_ROOT governs the hook/agent cases, which write into a repo.
const SKILLS_ROOT = mkdtempSync(join(tmpdir(), "author-skills-"));
// REPO_ROOT is a THROWAWAY workbench, not a live checkout: every hook/agent
// case writes a file into it, and nothing here should write into a working tree.
const REPO_ROOT = mkdtempSync(join(tmpdir(), "author-repo-"));
for (const d of [".agents/hooks", ".agents/checks", ".agents/agents"]) {
  mkdirSync(join(REPO_ROOT, d), { recursive: true });
}
after(() => {
  rmSync(SKILLS_ROOT, { recursive: true, force: true });
  rmSync(REPO_ROOT, { recursive: true, force: true });
});

function isExecutable(p: string): boolean {
  try {
    statSync(p);
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Combined stdout+stderr (trailing newlines trimmed, as `$(…)` did) and the exit code. */
function run(...args: string[]): { out: string; rc: number | null } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    // NODE_NO_WARNINGS: Node 22's type-stripping warning would land in the
    // output this compares, from the scaffold and from the resolver it spawns.
    env: { ...process.env, SKILLS_ROOT, CONTEXT_WRITE_ROOT: REPO_ROOT, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  return { out: `${r.stdout}${r.stderr}`.replace(/\n+$/, ""), rc: r.status };
}

test("the scaffold is executable", () => {
  assert.ok(isExecutable(SCRIPT), `not executable: ${SCRIPT}`);
});

// ── Case 1: unknown type → exit 2, no write ──
test("unknown-type rejected exit2", () => {
  const { out, rc } = run("command", "foo");
  assert.equal(rc, 2, `unknown-type: expected exit 2; got ${rc}`);
  assert.ok(out.includes("valid types"), "unknown-type: missing valid-types hint");
});

// ── Case 2: empty name (no name) → exit 2, prompt message ──
test("empty-name prompts exit2", () => {
  const { out, rc } = run("skill", "");
  assert.equal(rc, 2, `empty-name: expected exit 2; got ${rc}`);
  assert.ok(/name required/i.test(out), "empty-name: missing name-required msg");
});

// ── Case 3: non-kebab name → exit 1, regex cited, no write ──
test("non-kebab rejected exit1", () => {
  const { out, rc } = run("skill", "MySkill");
  assert.equal(rc, 1, `non-kebab: expected exit 1; got ${rc}`);
  assert.ok(out.includes("[a-z]"), "non-kebab: missing kebab regex");
  assert.equal(existsSync(join(SKILLS_ROOT, "MySkill")), false, "non-kebab: wrote a dir anyway");
});

// ── Case 4: skill round-trip → writes SKILL.md, prints path ──
test("skill-write round-trip", () => {
  const name = "zz-scaffold-test-skill";
  const { out, rc } = run("skill", name);
  assert.equal(rc, 0, `skill-write: expected exit 0; got ${rc}: ${out}`);
  // The skill branch prints an ABSOLUTE path — SKILLS_ROOT need not sit under
  // the write root, so there is nothing for a relative one to be relative to.
  assert.equal(out, `${SKILLS_ROOT}/${name}/SKILL.md`, `skill-write: bad path: ${out}`);
  assert.ok(existsSync(out), "skill-write: file not written");
  const text = readFileSync(out, "utf8");
  assert.ok(text.includes(`name: ${name}`), "skill-write: {{name}} not substituted");
  assert.equal(text.includes("{{name}}"), false, "skill-write: unsubstituted placeholder remains");
});

// ── Case 5: collision → 2nd write exits 1, 1st file intact ──
test("collision refuses overwrite", () => {
  const name = "zz-scaffold-test-collide";
  run("skill", name);
  assert.ok(existsSync(`${SKILLS_ROOT}/${name}/SKILL.md`), "collision: first write missing");
  const { out, rc } = run("skill", name);
  assert.equal(rc, 1, `collision: expected exit 1 on 2nd; got ${rc}`);
  assert.ok(/exists/i.test(out), "collision: missing exists msg");
  assert.ok(existsSync(`${SKILLS_ROOT}/${name}/SKILL.md`), "collision: first file clobbered");
});

// ── Case 6: hook round-trip (default + checks placement) ──
test("hook-write both placements", () => {
  const name = "zz-scaffold-test-hook";
  let r = run("hook", name);
  assert.ok(
    r.rc === 0 && r.out === `.agents/hooks/${name}.ts`,
    `hook-write: default placement wrong: rc=${r.rc} path=${r.out}`,
  );
  assert.ok(isExecutable(join(REPO_ROOT, r.out)), "hook-write: hook not executable");
  r = run("hook", name, "checks");
  assert.ok(
    r.rc === 0 && r.out === `.agents/checks/${name}.ts`,
    `hook-write: checks placement wrong: rc=${r.rc} path=${r.out}`,
  );
  assert.ok(isExecutable(join(REPO_ROOT, r.out)), "hook-write: check not executable");
  const testFile = join(REPO_ROOT, `.agents/checks/${name}.test.ts`);
  assert.ok(existsSync(testFile), `hook-write: checks placement wrote no ${name}.test.ts beside the check`);
  assert.ok(
    readFileSync(testFile, "utf8").includes(`${name}.ts`),
    "hook-write: the test does not name the check it tests",
  );
});

// ── Case 7: agent round-trip ──
test("agent-write round-trip", () => {
  const name = "zz-scaffold-test-agent";
  const { out, rc } = run("agent", name);
  assert.ok(rc === 0 && out === `.agents/agents/${name}.md`, `agent-write: rc=${rc} path=${out}`);
  assert.ok(
    readFileSync(join(REPO_ROOT, out), "utf8").includes(`name: ${name}`),
    "agent-write: {{name}} not substituted",
  );
});

// ── Case 8: output-style round-trip ──
// Styles live in the shared layer (.agents/output-styles/), which the installer
// links from ~/.claude/output-styles; there is no in-repo .claude/.
test("output-style-write round-trip", () => {
  const name = "zz-scaffold-test-style";
  let { out, rc } = run("output-style", name);
  const path = out.split("\n")[0] ?? "";
  assert.ok(rc === 0 && path === `.agents/output-styles/${name}.md`, `output-style-write: rc=${rc} path=${path}`);
  assert.ok(
    readFileSync(join(REPO_ROOT, path), "utf8").includes(`name: ${name}`),
    "output-style-write: {{name}} not substituted",
  );
  assert.equal(existsSync(join(REPO_ROOT, ".claude")), false, "output-style-write: wrote an in-repo .claude/");
  ({ out, rc } = run("output-style", name));
  assert.equal(rc, 1, `output-style-write: a second scaffold must refuse the collision, got rc=${rc}`);
});
