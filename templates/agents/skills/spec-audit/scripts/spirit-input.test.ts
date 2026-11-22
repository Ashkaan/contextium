// spirit-input.test.ts — peer of spirit-input.ts, run as a program.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/spirit-input.test.ts
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "spirit-input.ts");
const TMP = mkdtempSync(join(tmpdir(), "spirit-input-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const SPEC = `# Feature Specification: X

**Feature Branch**: \`001-x\`

**Input**: User description, Robin 2026-11-07: "make it faster"
and a second line of the same paragraph

**Systems Affected**: SECRET-SYSTEMS

## Clarifications

| Q | Chosen | The user's words |
|---|---|---|
| speed | a | "1) a" |

### Session 2026-11-07

- detail kept

## User Scenarios & Testing *(mandatory)*

### Story 1
It is faster.

## Requirements *(mandatory)*

- FR-001 faster

## Success Criteria *(mandatory)*

- SECRET-SUCCESS
`;
const PLAN = `# Plan

## Summary

SECRET-SUMMARY

### Simplest shape

One cache.

## Technical Context

SECRET-TECH
`;

function folder(spec = SPEC, plan: string | null = PLAN): string {
  const d = join(TMP, `f-${++n}`);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "spec.md"), spec);
  if (plan !== null) writeFileSync(join(d, "plan.md"), plan);
  return d;
}

test("a spec folder: the five sections, verbatim and in order, and nothing else", () => {
  const out = join(TMP, "out-1.md");
  const r = run(folder(), out);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out, `${out}\n`);
  const got = readFileSync(out, "utf8");
  const heads = [...got.matchAll(/^=== (.+) ===$/gm)].map((m) => m[1]);
  assert.deepEqual(heads, [
    "spec.md § Input",
    "spec.md § Clarifications",
    "spec.md § User Scenarios & Testing",
    "spec.md § Requirements",
    "plan.md § Simplest shape",
  ]);
  assert.match(got, /"make it faster"\nand a second line of the same paragraph\n\n=== spec\.md § Clarifications/);
  assert.match(got, /### Session 2026-11-07\n\n- detail kept/, "a subsection stays with its section");
  assert.match(got, /=== plan\.md § Simplest shape ===\n### Simplest shape\n\nOne cache\.\n$/);
  for (const secret of ["SECRET-SYSTEMS", "SECRET-SUCCESS", "SECRET-SUMMARY", "SECRET-TECH", "Feature Branch"])
    assert.ok(!got.includes(secret), `${secret} leaked into the input`);
});

test("an Input lead line with its list below a blank line keeps the list", () => {
  const spec = SPEC.replace(
    '**Input**: User description, Robin 2026-11-07: "make it faster"\nand a second line of the same paragraph\n',
    '**Input**: User description, in order:\n\n- The row\'s words: "make it faster"\n- Robin 2026-11-07: "yes"\n\n1. a numbered turn\n',
  );
  const out = join(TMP, "out-list.md");
  const r = run(folder(spec), out);
  assert.equal(r.code, 0, r.err);
  const got = readFileSync(out, "utf8");
  assert.match(
    got,
    /=== spec\.md § Input ===\n\*\*Input\*\*: User description, in order:\n\n- The row's words: "make it faster"\n- Robin 2026-11-07: "yes"\n\n1\. a numbered turn\n\n=== spec\.md § Clarifications/,
  );
  assert.ok(!got.includes("SECRET-SYSTEMS"), "the paragraph after the list leaked into the input");
});

test("an indented paragraph inside an Input list item, after a blank line, stays", () => {
  const spec = SPEC.replace(
    '**Input**: User description, Robin 2026-11-07: "make it faster"\nand a second line of the same paragraph\n',
    '**Input**: User description, in order:\n\n1. "OMG! Yes!"\n\n   (1a = "the first option")\n2. "1a 2a"\n\n    (2a = "the later option")\n',
  );
  const out = join(TMP, "out-indented.md");
  const r = run(folder(spec), out);
  assert.equal(r.code, 0, r.err);
  const got = readFileSync(out, "utf8");
  assert.match(
    got,
    /=== spec\.md § Input ===\n\*\*Input\*\*: User description, in order:\n\n1\. "OMG! Yes!"\n\n {3}\(1a = "the first option"\)\n2\. "1a 2a"\n\n {4}\(2a = "the later option"\)\n\n=== spec\.md § Clarifications/,
  );
  assert.ok(!got.includes("SECRET-SYSTEMS"), "the paragraph after the list leaked into the input");
});

test("an Input paragraph followed by a blank line and a non-list paragraph stops at the blank line", () => {
  const out = join(TMP, "out-stop.md");
  const r = run(folder(), out);
  assert.equal(r.code, 0, r.err);
  assert.ok(!readFileSync(out, "utf8").includes("SECRET-SYSTEMS"));
});

test("a single-file SPEC: § 0, 0a, 0b and 1, and nothing after", () => {
  const f = join(TMP, "SPEC.md");
  writeFileSync(
    f,
    "# App SPEC\n\nintro SECRET\n\n## 0. User's ask (verbatim)\n\nask\n\n## 0a. How we interpreted this\n\nread\n\n## 0b. Simplest shape that could work\n\nshape\n\n## 1. Behavior contract\n\ncontract\n\n### 1.1 sub\n\nsub kept\n\n## 2. Input contract\n\nSECRET-2\n",
  );
  const out = join(TMP, "out-2.md");
  assert.equal(run(f, out).code, 0);
  const got = readFileSync(out, "utf8");
  assert.deepEqual(
    [...got.matchAll(/^=== (.+) ===$/gm)].map((m) => m[1]),
    ["SPEC.md § 0", "SPEC.md § 0a", "SPEC.md § 0b", "SPEC.md § 1"],
  );
  assert.match(got, /sub kept\n$/);
  assert.ok(!got.includes("SECRET"));
});

test("a missing section is named, exit 1, and nothing is written", () => {
  const out = join(TMP, "out-3.md");
  const r = run(folder(SPEC.replace("## Clarifications", "## Notes"), "# Plan\n\n## Summary\n"), out);
  assert.equal(r.code, 1);
  assert.match(r.err, /missing spec\.md § Clarifications/);
  assert.match(r.err, /missing plan\.md § Simplest shape/);
  assert.equal(existsSync(out), false);
});

test("a folder without plan.md names its section missing", () => {
  const r = run(folder(SPEC, null), join(TMP, "out-4.md"));
  assert.equal(r.code, 1);
  assert.match(r.err, /missing plan\.md § Simplest shape/);
});

test("caller errors exit 2", () => {
  assert.equal(run().code, 2);
  assert.equal(run(join(TMP, "nope"), join(TMP, "o.md")).code, 2);
  assert.equal(run(folder(), join(TMP, "o.md"), "extra").code, 2);
});

// The spec template's Supported inputs block sits under ## Requirements, so the
// fidelity check reads which inputs the work must handle and what it leaves out
// (a spec that never named the layouts it had to support left six code reviews
// each inventing a new one).
test("the spec template's Supported inputs subsection reaches the fidelity input", () => {
  const template = readFileSync(join(dirname(SCRIPT), "../../spec/references/templates/spec.md"), "utf8");
  const out = join(TMP, "out-template.md");
  const r = run(folder(template), out);
  assert.equal(r.code, 0, r.err);
  const requirements = readFileSync(out, "utf8").split("=== spec.md § Requirements ===\n")[1] ?? "";
  assert.match(requirements, /^### Supported inputs$/m, "Supported inputs is not inside the Requirements cut");
  assert.match(requirements, /<!-- workbench: inputs -->/, "the inputs guidance block is not inside the cut");
  assert.match(requirements, /^Not covered:/m, "the Not covered list is not inside the cut");
});
