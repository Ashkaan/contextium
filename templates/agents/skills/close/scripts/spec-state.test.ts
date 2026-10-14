// spec-state.test.ts — peer of spec-state.ts.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/spec-state.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "spec-state.ts");
const tmp = mkdtempSync(join(tmpdir(), "spec-state-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function mk(name: string, readme = ""): void {
  mkdirSync(join(tmp, name), { recursive: true });
  writeFileSync(join(tmp, name, "README.md"), `${readme}\n`);
}
const put = (rel: string, body = ""): void => {
  mkdirSync(dirname(join(tmp, rel)), { recursive: true });
  writeFileSync(join(tmp, rel), body);
};
function run(project: string): string {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SUT, join(tmp, project)], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return `${r.stdout}${r.stderr}`;
}
/** The state column of the row named `name`. */
const state = (project: string, name: string): string =>
  run(project)
    .split("\n")
    .filter((l) => l.split(/[ \t]+/)[0] === name)
    .map((l) => l.split(/[ \t]+/)[1] ?? "")
    .join("\n");

// 1. A loose spec and report beside a folder spec are not read: only the
// folder is a spec (the loose layout is retired).
test("loose files are not specs", () => {
  mk("p1");
  put("p1/a.spec.md");
  put("p1/a-report.md", "---\nspec: a\nspec-status: complete\n---\n");
  put("p1/b.plan.md");
  put("p1/specs/001-b/spec.md");
  assert.equal(run("p1"), "specs/001-b\tnone\tno report\n");
});

// 2. The spec-kit layout: a folder `specs/NNN-name/` is its own spec, named by
// its path, and its report is that folder's report.md frontmatter.
test("folder specs", () => {
  mk("p13");
  put("p13/specs/001-x/spec.md");
  assert.equal(state("p13", "specs/001-x"), "none", "folder spec with no report is none");
  put("p13/specs/001-x/report.md", "---\nspec: 001-x\nspec-status: complete\n---\n");
  assert.equal(state("p13", "specs/001-x"), "complete", "folder report claiming complete is complete");
  put("p13/specs/001-x/report.md", "---\nspec: 001-x\nspec-status: partial\n---\n");
  assert.equal(state("p13", "specs/001-x"), "partial", "folder report claiming partial is partial");
  put("p13/specs/001-x/report.md", "# report\n\n**Status**: COMPLETE\n");
  assert.equal(state("p13", "specs/001-x"), "partial", "folder report with no frontmatter is partial");
});

// 3. A top-level report never completes a folder spec, even by its name
test("top-level report does not complete a folder", () => {
  mk("p14");
  put("p14/specs/001-x/spec.md");
  put("p14/001-x-report.md", "---\nspec: specs/001-x\nspec-status: complete\n---\n");
  assert.equal(state("p14", "specs/001-x"), "none");
});

// 4. A specs/ folder of loose files is invisible, as is a report-only folder
test("loose files under specs/ are not specs", () => {
  mk("p16");
  put("p16/specs/old.spec.md");
  put("p16/specs/002-b/report.md", "---\nspec: 002-b\nspec-status: complete\n---\n");
  assert.equal(run("p16").replace(/\n+$/, ""), "");
});
