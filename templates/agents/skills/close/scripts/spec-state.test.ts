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

// 1. no report at all → none
test("no report is none", () => {
  mk("p1");
  put("p1/alpha.spec.md");
  assert.equal(state("p1", "alpha"), "none");
});

// 2. exact filename, no declaration → complete (the legacy convention)
test("exact filename is complete", () => {
  mk("p2");
  put("p2/alpha.spec.md");
  put("p2/alpha-report.md", "# report\n");
  assert.equal(state("p2", "alpha"), "complete");
});

// 3. qualified filename, no declaration → partial, NOT complete and NOT none
test("qualified filename is partial", () => {
  mk("p3");
  put("p3/phase-2.spec.md");
  put("p3/phase-2-sync-freshness-report.md", "# r\n");
  assert.equal(state("p3", "phase-2"), "partial");
});

// 4. prose declaration wins: qualified name but Status COMPLETE → complete
test("prose COMPLETE is complete", () => {
  mk("p4");
  put("p4/phase-2.spec.md");
  put("p4/phase-2-sync-report.md", "# R\n\n**SPEC**: `phase-2.spec.md` § 7\n**Status**: COMPLETE — shipped\n");
  assert.equal(state("p4", "phase-2"), "complete");
});

// 5. prose PARTIAL → partial even with the exact filename
test("prose PARTIAL beats exact filename", () => {
  mk("p5");
  put("p5/alpha.spec.md");
  put("p5/alpha-report.md", "# R\n\n**SPEC**: `alpha.spec.md`\n**Status**: PARTIAL — half done\n");
  assert.equal(state("p5", "alpha"), "partial");
});

// 6. frontmatter beats prose
test("frontmatter beats prose", () => {
  mk("p6");
  put("p6/alpha.spec.md");
  put("p6/alpha-report.md", "---\nspec: alpha\nspec-status: partial\n---\n\n**Status**: COMPLETE\n");
  assert.equal(state("p6", "alpha"), "partial");
});

// 7. a report whose FILENAME relates to nothing, but declares the spec
test("declaration found by name not filename", () => {
  mk("p7");
  put("p7/beta.spec.md");
  put("p7/wholly-unrelated-report.md", "# R\n\n**SPEC**: `beta.spec.md`\n**Status**: COMPLETE\n");
  assert.equal(state("p7", "beta"), "complete");
});

// 8. any one complete among several reports wins
test("one complete among many is complete", () => {
  mk("p8");
  put("p8/gamma.spec.md");
  put("p8/gamma-a-report.md", "**SPEC**: `gamma.spec.md`\n**Status**: PARTIAL\n");
  put("p8/gamma-b-report.md", "**SPEC**: `gamma.spec.md`\n**Status**: COMPLETE\n");
  assert.equal(state("p8", "gamma"), "complete");
});

// 9. CODE COMPLETE / NOT IMPLEMENTED fail toward partial, never complete
test("CODE COMPLETE is partial", () => {
  mk("p9");
  put("p9/delta.spec.md");
  put("p9/delta-report.md", "**SPEC**: `delta.spec.md`\n**Status**: CODE COMPLETE — not shipped\n");
  assert.equal(state("p9", "delta"), "partial");
});
test("NOT IMPLEMENTED is partial", () => {
  mk("p10");
  put("p10/eps.spec.md");
  put("p10/eps-report.md", "**SPEC**: `eps.spec.md`\n**Status**: NOT IMPLEMENTED\n");
  assert.equal(state("p10", "eps"), "partial");
});

// 10. legacy *.plan.md is recognised alongside *.spec.md
test("legacy plan file recognised", () => {
  mk("p11");
  put("p11/legacy.plan.md");
  put("p11/legacy-report.md", "x\n");
  assert.equal(state("p11", "legacy"), "complete");
});

// 11. a prefix collision must not leak: alpha-2.spec.md is not alpha's report
test("sibling spec's report is not this spec's", () => {
  mk("p12");
  put("p12/alpha.spec.md");
  put("p12/alpha-2.spec.md");
  put("p12/alpha-2-report.md", "x\n");
  assert.equal(state("p12", "alpha"), "none");
});

// 12. The spec-kit layout: a folder `specs/NNN-name/` is its own spec, named by
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

// 13. A top-level report never completes a folder spec, even by its name
test("top-level report does not complete a folder", () => {
  mk("p14");
  put("p14/specs/001-x/spec.md");
  put("p14/001-x-report.md", "---\nspec: specs/001-x\nspec-status: complete\n---\n");
  assert.equal(state("p14", "specs/001-x"), "none");
});

// 14. A legacy 001-x.spec.md beside a folder specs/001-x/ are two names
test("legacy and folder are distinct names", () => {
  mk("p15");
  put("p15/specs/001-x/spec.md");
  put("p15/001-x.spec.md");
  put("p15/001-x-report.md", "x\n");
  const got = run("p15")
    .replace(/\n+$/, "")
    .split("\n")
    .map((l) => l.split("\t").slice(0, 2).join(" "))
    .join("\n");
  assert.equal(got, "001-x complete\nspecs/001-x none");
});

// 15. A specs/ folder of loose files is invisible, as it always was
test("loose files under specs/ are not specs", () => {
  mk("p16");
  put("p16/specs/old.spec.md");
  assert.equal(run("p16").replace(/\n+$/, ""), "");
});

// 16. The one-line header older reports carry: SPEC and Status on one line.
test("same-line SPEC and Status", () => {
  mk("p17");
  put("p17/gamma.spec.md");
  put(
    "p17/gamma-report.md",
    "# Implementation Report\n**SPEC**: `projects/web/2026-01-10_checkout-flow/gamma.spec.md`  **Status**: PARTIAL\n",
  );
  assert.equal(state("p17", "gamma"), "partial", "same-line SPEC and Status read");
  put("p17/gamma-report.md", "# Implementation Report\n**SPEC**: `gamma.spec.md`  **Status**: COMPLETE\n");
  assert.equal(state("p17", "gamma"), "complete", "same-line COMPLETE is complete");
});
