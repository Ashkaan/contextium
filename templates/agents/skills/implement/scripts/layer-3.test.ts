// Test harness for layer-3.ts. The subject is spawned as a program against
// fixture repos built under one temp root that is removed when the suite ends.
// The workbench's checks are stubs committed beside this test
// (fixtures/layer-3-checks/), copied where an install puts them, so RAN lines
// are deterministic.
//
// Run: node --test --experimental-strip-types .agents/skills/implement/scripts/layer-3.test.ts
//
// peers: layer-3.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "layer-3.ts");
const STUBS = join(HERE, "fixtures/layer-3-checks");
const TMP = mkdtempSync(join(tmpdir(), "layer-3-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const mktemp = (): string => mkdtempSync(join(TMP, `d${++n}-`));

function run(args: string[], opts: { repo?: string; cwd?: string }): { rc: number; out: string; all: string } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (opts.repo) env.CLAUDE_PROJECT_DIR = opts.repo;
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    env,
    cwd: opts.cwd,
    timeout: 60000,
  });
  return { rc: r.status ?? -1, out: r.stdout, all: `${r.stdout}${r.stderr}` };
}

/** A repo holding the stub checks at .agents/checks/: two that pass, one that fails. */
function makeRepo(): string {
  const d = mktemp();
  cpSync(STUBS, join(d, ".agents/checks"), { recursive: true });
  return d;
}

// ── Case 1: the workbench's checks run, each one reported ──
test("case1 each-present-check-runs-and-is-reported", () => {
  const repo = makeRepo();
  const r = run(["--scope", "apps/foo"], { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("RAN: check-decision-records.ts → PASS"), `missing the passing RAN line: ${r.all}`);
  assert.ok(r.out.includes("RAN: check-secrets.ts → FAIL"), `missing the failing RAN line: ${r.all}`);
  assert.ok(r.out.includes("RAN: check-standards-refs.ts → PASS"), `standards refs not run over the tree: ${r.all}`);
  assert.equal(r.all.includes("check-skills.ts"), false, `an absent check was reported: ${r.all}`);
  assert.equal(r.all.includes("a key"), false, `a check's own output leaked: ${r.all}`);
});

// ── Case 2: a repo with no checks → NO-MATCH ──
test("case2 no-checks-no-match", () => {
  const repo = mktemp();
  const r = run(["--scope", "integrations/google"], { repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("NO-MATCH:"), `missing NO-MATCH: ${r.all}`);
});

// ── Case 3: CLAUDE_PROJECT_DIR unset but cwd inside a git repo → resolve the
// root via git rev-parse → RAN lines (exit 0) ──
test("case3 env-unset-in-repo-resolves-via-git", () => {
  const repo = makeRepo();
  spawnSync("git", ["-C", repo, "init", "-q"]);
  const r = run(["--scope", "apps/foo"], { cwd: repo });
  assert.equal(r.rc, 0, r.all);
  assert.ok(r.out.includes("RAN: check-decision-records.ts"), `missing RAN with env unset: ${r.all}`);
});

// ── Case 4: CLAUDE_PROJECT_DIR unset AND outside a git repo → exit 1 ──
test("case4 env-unset-outside-repo-hard-errors", () => {
  const nongit = mktemp();
  const r = run(["--scope", "apps/foo"], { cwd: nongit });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.all.includes("not inside a git repo"), `missing hard-error msg: ${r.all}`);
});

// ── Case 5: an advisory layer never fails the phase ──
test("case5 a-failing-check-is-advisory", () => {
  const repo = makeRepo();
  const r = run(["--scope", ""], { repo });
  assert.equal(r.rc, 0, `a failing check must not fail layer 3: ${r.all}`);
  assert.ok(r.out.includes("→ FAIL"), r.all);
});

// ── Case 6: an unknown flag is refused ──
test("case6 unknown-flag-exits-1", () => {
  const repo = makeRepo();
  const r = run(["--bogus"], { repo });
  assert.equal(r.rc, 1, r.all);
  assert.ok(r.all.includes("unknown flag: --bogus"), r.all);
});
