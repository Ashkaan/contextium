#!/usr/bin/env -S node --experimental-strip-types
// design-authority.test.ts — pin the two-limb stub rule design-authority.ts
// owns: the `design-authority: generated-stub` marker in any quoting, and a
// body with no contract heading, are both stubs; a real DESIGN.md is not; a
// missing file and an unterminated frontmatter block have their own exits.
// The script is spawned, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/design-authority.test.ts
//
// peers: ../design-authority.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "design-authority.ts");
const TMP = mkdtempSync(join(tmpdir(), "design-authority-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(...args: string[]): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr };
}
function expect(r: { rc: number | null; out: string }, rc: number, pattern: string): void {
  assert.equal(r.rc, rc, r.out);
  assert.ok(r.out.includes(pattern), `missing '${pattern}' in: ${r.out}`);
}
function mk(name: string, body: string): string {
  mkdirSync(join(TMP, name), { recursive: true });
  writeFileSync(join(TMP, name, "DESIGN.md"), body);
  return join(TMP, name);
}

// ── usage ──
test("no args → 2", () => expect(run(), 2, "usage:"));
test("unknown verb → 2", () => expect(run("sideways"), 2, "usage:"));
test("status without repo → 2", () => expect(run("status"), 2, "usage:"));
test("status on no dir → 4", () => expect(run("status", join(TMP, "nope")), 4, "no such directory"));

// ── headings vocabulary ──
test("headings prints the vocabulary", () => {
  const r = run("headings");
  assert.equal(r.rc, 0);
  assert.ok(r.out.includes("typography") && r.out.includes("|"), r.out);
});
test("headings omits colour on purpose", () => assert.ok(!run("headings").out.includes("colour")));

// ── missing DESIGN.md ──
test("no DESIGN.md → missing/3", () => {
  mkdirSync(join(TMP, "empty"));
  expect(run("status", join(TMP, "empty")), 3, "AUTHORITY=missing");
});

// ── limb one: the marker, in every spelling ──
const MARKERS: Array<[string, string]> = [
  ["bare", "design-authority: generated-stub"],
  ["quoted", 'design-authority: "generated-stub"'],
  ["single", "design-authority: 'generated-stub'"],
  ["commented", "design-authority: generated-stub  # written by /qa"],
];
for (const [name, line] of MARKERS) {
  const repo = mk(name, `---\n${line}\n---\n## Typography\n`);
  test(`marker (${name}) → stub/3`, () => expect(run("status", repo), 3, "AUTHORITY=stub"));
  test(`marker (${name}) reason names the marker`, () => assert.ok(run("status", repo).out.includes("generated-stub")));
}

// ── limb two: a body with no contract heading ──
const TOKENS = mk("tokens", '---\ncolors:\n  ink: "#101010"\n---\n# Design\n## Colors\n- ink #101010\n## Brand\n');
test("no contract heading → stub/3", () => expect(run("status", TOKENS), 3, "AUTHORITY=stub"));
test("heading-limb reason", () => assert.ok(run("status", TOKENS).out.includes("declares no design contract")));

// a `state:` frontmatter KEY is not a heading about state
test("frontmatter key is not a heading → stub/3", () =>
  expect(run("status", mk("fmkey", "---\nstate: draft\n---\n## Palette\n")), 3, "AUTHORITY=stub"));

// ── real: one contract heading, any case, any depth ──
const REAL = mk("real", "---\nversion: 1\n---\n# Design\n#### FOCUS rings\nEvery control shows a 2px ring.\n");
test("contract heading → real/0", () => expect(run("status", REAL), 0, "AUTHORITY=real"));
test("real counts headings", () => assert.ok(run("status", REAL).out.includes("declares 1 design contract heading")));

// no frontmatter at all, real body
test("no frontmatter, real body → 0", () =>
  expect(run("status", mk("nofm", "# App\n## Spacing\n4px grid.\n## Motion\n")), 0, "declares 2 design contract"));

// ── malformed: an unterminated frontmatter block is a parse failure ──
test("unterminated frontmatter → 2", () =>
  expect(run("status", mk("broken", "---\ndesign-authority: real\n## Typography\n")), 2, "AUTHORITY=malformed"));
