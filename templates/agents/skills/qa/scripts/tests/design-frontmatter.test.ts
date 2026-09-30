#!/usr/bin/env -S node --experimental-strip-types
// design-frontmatter.test.ts — pin what design-frontmatter.ts reads out of a
// DESIGN.md frontmatter (`TYPE_SCALE=`, `COLORS=`, `SPACING_SCALE=`,
// `RADIUS_SCALE=`, `CONTROL_HEIGHTS=`, `VARIANTS_<ROLE>=` lines), the aliases
// and fallbacks it accepts, and the shapes it refuses with exit 2 rather than
// guessing at. It is a library (system-drift.ts imports `readDeclared`) and a
// program: the parse cases import it, the exit codes and the printed lines are
// pinned by spawning it.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/design-frontmatter.test.ts
//
// peers: ../design-frontmatter.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { FrontmatterError, readDeclared } from "../design-frontmatter.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "design-frontmatter.ts");
const TMP = mkdtempSync(join(tmpdir(), "design-frontmatter-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(...args: string[]): { rc: number | null; out: string; stdout: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr, stdout: r.stdout };
}
function mk(name: string, body: string): string {
  mkdirSync(join(TMP, name), { recursive: true });
  writeFileSync(join(TMP, name, "DESIGN.md"), body);
  return join(TMP, name);
}
/** The declared pairs as a KEY → value map. */
const declared = (repo: string): Map<string, string> => new Map(readDeclared(repo));

// ── usage / missing ──
test("no repo → exit 2 with usage", () => {
  const r = run();
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage:/);
});

test("no DESIGN.md → exit 3 naming the file", () => {
  mkdirSync(join(TMP, "none"));
  const r = run(join(TMP, "none"));
  assert.equal(r.rc, 3);
  assert.ok(r.out.includes(`no ${join(TMP, "none")}/DESIGN.md`), r.out);
  assert.throws(
    () => readDeclared(join(TMP, "none")),
    (e: unknown) => e instanceof FrontmatterError && e.code === 3,
  );
});

// no frontmatter: unarmed, silent, exit 0
test("no frontmatter → 0, prints nothing", () => {
  const r = run(mk("plain", "# Design\n## Typography\n"));
  assert.equal(r.rc, 0);
  assert.equal(r.out, "");
});

// ── the published shape: nested maps, inline arrays, comments, hex colours ──
const FULL = mk(
  "full",
  `---
version: 1
typography:
  scale: [12px, 14px, "16px", 20px]   # the ramp
colors:
  ink: "#101010" # brand — the # inside quotes is a colour, not a comment
  paper: '#fafafa'
  accent: "rgb(0, 0, 0)"
spacing: [4px, 8px, 16px]
rounded:
  sm: 4px
  lg: 12px
components:
  control-sm:
    height: 32px
  control-md:
    height: 40px
  person-row:
    height: 64px
  button-primary:
    background: ink
  button-ghost:
    background: transparent
  status-pill-success:
    background: green
---
## Typography
`,
);

test("full file → 0, one KEY=value line per declared pair, in order", () => {
  const r = run(FULL);
  assert.equal(r.rc, 0, r.out);
  assert.equal(
    r.stdout,
    readDeclared(FULL)
      .map(([k, v]) => `${k}=${v}\n`)
      .join(""),
  );
});
test("TYPE_SCALE from typography.scale, quotes and comment stripped", () =>
  assert.equal(declared(FULL).get("TYPE_SCALE"), "12px|14px|16px|20px"));
test("COLORS keeps quoted # and inner comma", () =>
  assert.equal(declared(FULL).get("COLORS"), "#101010|#fafafa|rgb(0, 0, 0)"));
test("SPACING_SCALE from spacing", () => assert.equal(declared(FULL).get("SPACING_SCALE"), "4px|8px|16px"));
test("RADIUS_SCALE from rounded map", () => assert.equal(declared(FULL).get("RADIUS_SCALE"), "4px|12px"));
test("CONTROL_HEIGHTS from control-* only (person-row excluded)", () =>
  assert.equal(declared(FULL).get("CONTROL_HEIGHTS"), "32px|40px"));
test("VARIANTS_BUTTON from button-* entries", () =>
  assert.equal(declared(FULL).get("VARIANTS_BUTTON"), "primary|ghost"));
test("two-word role groups under its first word", () =>
  assert.equal(declared(FULL).get("VARIANTS_STATUS"), "pill-success"));

// ── aliases: the older keys win when present; block lists count ──
const ALIAS = mk(
  "alias",
  `---
typeScale:
  - 1rem
  - "2rem" # display
spacingScale: [1, 2]
radiusScale: [0, 999px]
controlHeights: [36px]
componentVariants:
  input:
    - default
    - error
---
`,
);
test("alias file → 0", () => assert.equal(run(ALIAS).rc, 0));
test("typeScale block list (last-key flush included)", () =>
  assert.equal(declared(ALIAS).get("TYPE_SCALE"), "1rem|2rem"));
test("spacingScale alias", () => assert.equal(declared(ALIAS).get("SPACING_SCALE"), "1|2"));
test("radiusScale alias", () => assert.equal(declared(ALIAS).get("RADIUS_SCALE"), "0|999px"));
test("controlHeights alias", () => assert.equal(declared(ALIAS).get("CONTROL_HEIGHTS"), "36px"));
test("componentVariants block list", () => assert.equal(declared(ALIAS).get("VARIANTS_INPUT"), "default|error"));

// typography entries' fontSize is the last fallback for TYPE_SCALE
test("TYPE_SCALE falls back to entry fontSizes", () => {
  const repo = mk(
    "entries",
    `---
typography:
  body:
    fontSize: 16px
  display:
    fontSize: 48px
    lineHeight: 1.1
---
`,
  );
  assert.equal(declared(repo).get("TYPE_SCALE"), "16px|48px");
});

// a `scale: # comment` opens a container, it is not the scalar "# comment"
test("comment after empty key still opens the list", () => {
  const repo = mk("commentkey", "---\ntypography:\n  scale: # the ramp\n    - 12px\n---\n");
  assert.equal(declared(repo).get("TYPE_SCALE"), "12px");
});

// absent keys print nothing (disarmed, not empty)
test("absent keys print no line", () => {
  const r = run(mk("sparse", "---\ncolors: [red]\n---\n"));
  assert.equal(r.rc, 0);
  assert.equal(r.out, "COLORS=red\n");
});

// ── refusals: exit 2 with a line number, never a partial pass ──
const REFUSALS: Array<[string, string, number, string]> = [
  ["unterminated", "---\ncolors: [red]\n## Body\n", 1, "never closed"],
  ["tabbed", "---\ncolors:\n\tink: red\n---\n", 3, "tab indentation"],
  ["orphanitem", "---\n- 12px\n---\n", 2, "no key above it"],
  [
    "listofmaps",
    "---\ntypography:\n  scale:\n    - name: xs\n      size: 12px\n---\n",
    4,
    "list of maps is not supported",
  ],
  ["quotedmapitem", '---\ntypography:\n  scale:\n    - "name": xs\n---\n', 4, "list of maps is not supported"],
  ["nocolon", "---\ncolors:\n  ink red\n---\n", 3, "cannot parse"],
];
for (const [name, body, line, reason] of REFUSALS) {
  test(`${name} → exit 2 at line ${line}: ${reason}`, () => {
    const repo = mk(name, body);
    const r = run(repo);
    assert.equal(r.rc, 2, r.out);
    assert.ok(r.out.includes(`DESIGN.md:${line} `), r.out);
    assert.ok(r.out.includes(reason), r.out);
    assert.throws(
      () => readDeclared(repo),
      (e: unknown) => e instanceof FrontmatterError && e.code === 2 && e.message.includes(reason),
    );
  });
}

// Finding 1 of the R45 review: the harnesses reach every skill script through a
// symlink (~/.agents/skills -> workbench/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "design-frontmatter.ts");
  symlinkSync(SCRIPT, link);

  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", link, ...[dir]], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 3, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /DESIGN\.md/);
});
