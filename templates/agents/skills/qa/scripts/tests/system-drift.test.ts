#!/usr/bin/env -S node --experimental-strip-types
// system-drift.test.ts — the design-drift counter, against hermetic fixtures.
//
// Each case builds a throwaway repo with a real DESIGN.md and real source, and
// runs the REAL script. The point of the suite is the thing the check exists to
// prevent: a scan that reports clean because it was never armed. So the cases
// that matter most are the ones asserting a DISTINCT exit for "no authority" and
// "stub authority" — a missing design must never read as a passing one.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/system-drift.test.ts
//
// peers:
//   .agents/skills/qa/scripts/system-drift.ts
//   .agents/skills/qa/scripts/design-authority.ts
//   .agents/skills/qa/scripts/design-frontmatter.ts
//   .agents/skills/qa/scripts/element-scan.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRIFT = join(SCRIPTS, "system-drift.ts");
const AUTHORITY = join(SCRIPTS, "design-authority.ts");
const FRONTMATTER = join(SCRIPTS, "design-frontmatter.ts");

const TMP = mkdtempSync(join(tmpdir(), "system-drift-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

interface Run {
  rc: number | null;
  out: string;
}
/** A program's merged output, as `2>&1` captured it. */
function run(script: string, ...args: string[]): Run {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", script, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr };
}
const drift = (repo: string): Run => run(DRIFT, repo);
const authority = (repo: string): Run => run(AUTHORITY, "status", repo);
const count = (hay: string, needle: string): number => hay.split("\n").filter((l) => l.includes(needle)).length;
const has = (hay: string, needle: string): void => assert.ok(hay.includes(needle), `missing '${needle}' in:\n${hay}`);
const lacks = (hay: string, needle: string): void =>
  assert.ok(!hay.includes(needle), `unexpected '${needle}' in:\n${hay}`);

function newRepo(name: string): string {
  const dir = join(TMP, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  return dir;
}
const writeDesign = (dir: string, body: string): void => writeFileSync(join(dir, "DESIGN.md"), body);
const writeApp = (dir: string, body: string): void => writeFileSync(join(dir, "src", "app.tsx"), body);

// A real design authority: a four-step ramp, three control heights, a palette
// whose only member is the one token the fixture uses, and the contract headings
// that keep design-authority.ts from calling it a stub.
function realDesign(dir: string, ramp: string): void {
  writeDesign(
    dir,
    `---
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
${ramp}
controlHeights:
  sm: "2rem"
  md: "2.25rem"
componentVariants:
  button: [default, ghost]
---

# Design System: Fixture

## Type
A four-step ramp.

## Controls
Two heights.

## Focus
One ring.
`,
  );
}

const FOUR_STEP = `    xs: "0.75rem"
    sm: "0.875rem"
    base: "1rem"
    lg: "1.5rem"`;

// Seven distinct sizes in the source; four of them are on the ramp above, so
// exactly three are drift: 10px, 13px and 40px.
function sourceSeven(dir: string): void {
  writeApp(
    dir,
    `export function App() {
  return (
    <div>
      <p className="text-[12px]">on the ramp</p>
      <p className="text-[14px]">on the ramp</p>
      <p className="text-[16px]">on the ramp</p>
      <p className="text-[24px]">on the ramp</p>
      <p className="text-[10px]">off</p>
      <p className="text-[13px]">off</p>
      <p className="text-[40px]">off</p>
    </div>
  );
}
`,
  );
}
const ONE_OFF = 'export const App = () => <p className="text-[13px]">x</p>;\n';

// ── 1. The headline case: three off-ramp values, each named ───────────────
{
  const repo = newRepo("seven-sizes");
  realDesign(repo, FOUR_STEP);
  sourceSeven(repo);
  const r = drift(repo);
  test("seven sizes against a four-step ramp exits 1", () => assert.equal(r.rc, 1, r.out));
  test("reports exactly three off-ramp values", () => assert.equal(count(r.out, "type-size"), 3));
  test("names 10px", () => has(r.out, "type-size  10px"));
  test("names 13px", () => has(r.out, "type-size  13px"));
  test("names 40px", () => has(r.out, "type-size  40px"));
  test("does not report a size that IS on the ramp", () => lacks(r.out, "type-size  14px"));
  test("points at the file and line", () => has(r.out, "src/app.tsx:9"));
  test("counts the severities", () => has(r.out, "system-drift: P1="));
}

// ── 2. RED-FIRST: declare a ramp the fixture already satisfies ────────────
// The same source, measured against a ramp that contains all seven sizes. If the
// check still reported drift here it would be asserting against its own regex
// rather than against the declaration, which is the way a scan like this is
// usually wrong.
{
  const repo = newRepo("ramp-satisfied");
  realDesign(
    repo,
    ['a: "0.625rem"', 'b: "0.75rem"', 'c: "0.8125rem"', 'd: "0.875rem"', 'e: "1rem"', 'f: "1.5rem"', 'g: "2.5rem"']
      .map((l) => `    ${l}`)
      .join("\n"),
  );
  sourceSeven(repo);
  const r = drift(repo);
  test("a satisfied ramp produces no type-size finding", () => lacks(r.out, "type-size"));
}

// ── 3. Zero divergence is SILENT, and exits clean ─────────────────────────
{
  const repo = newRepo("clean");
  realDesign(repo, FOUR_STEP);
  writeApp(repo, 'export function App() {\n  return <p className="text-[16px]">fine</p>;\n}\n');
  const r = drift(repo);
  test("no divergence exits 0", () => assert.equal(r.rc, 0, r.out));
  // No congratulation. A scanner finding nothing is a floor, not a verdict.
  test("no divergence prints nothing", () => assert.equal(r.out, ""));
}

// ── 4. No DESIGN.md exits DISTINCTLY from clean ───────────────────────────
{
  const repo = newRepo("no-authority");
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("a missing authority exits 3, never 0", () => assert.equal(r.rc, 3, r.out));
  test("says the app has no design system", () => has(r.out, "no DESIGN.md"));
  test("raises it as P1", () => has(r.out, "[P1] design-authority"));
}

// ── 5. A generated stub is a stub under the FIRST limb ────────────────────
{
  const repo = newRepo("stub-marker");
  writeDesign(
    repo,
    `---
design-authority: generated-stub
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
    xs: "0.75rem"
---

# Design System: Fixture

## Type
Even a heading here does not rescue it: the marker is the human's own statement
that this file is an extraction rather than a design.
`,
  );
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("a marked stub exits 3", () => assert.equal(r.rc, 3, r.out));
  test("names the marker as the reason", () => has(r.out, "generated-stub"));
}

// ── 6. An UNMARKED file with no contract is a stub under the SECOND limb ──
// This is the limb that matters most: every DESIGN.md generated before the
// marker existed is unmarked, and that is the whole population with the problem.
{
  const repo = newRepo("stub-no-contract");
  writeDesign(
    repo,
    '---\nname: Fixture\ncolors:\n  ink: "#101010"\n---\n\n# Design System: Fixture\n\n## Overview\n\nAuto-generated from the tokens already in this repo.\n',
  );
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("an unmarked file declaring no contract exits 3", () => assert.equal(r.rc, 3, r.out));
  test("says it declares no contract", () => has(r.out, "declares no design contract"));
}

// ── 7. Unparseable frontmatter is a parse error, never a partial scan ─────
{
  const repo = newRepo("malformed");
  writeDesign(repo, '---\nname: Fixture\ncolors:\n  ink: "#101010"\n');
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("an unterminated frontmatter block exits 2", () => assert.equal(r.rc, 2, r.out));
  test("names the parse failure", () => has(r.out, "never closed"));
}

// ── 8. A one-entry scale is valid; drift is measured against what is declared ──
{
  const repo = newRepo("one-step");
  realDesign(repo, '    only: "1rem"');
  sourceSeven(repo);
  const r = drift(repo);
  test("a one-entry ramp measures the other six", () => assert.equal(count(r.out, "type-size"), 6));
  test("and not the one it declares", () => lacks(r.out, "type-size  16px"));
}

// ── 9. An absent key disarms its own measure and nothing else ─────────────
{
  const repo = newRepo("unarmed");
  writeDesign(
    repo,
    '---\nname: Fixture\ncolors:\n  ink: "#101010"\n---\n\n# Design System: Fixture\n\n## Focus\nOne ring, and no type ramp declared anywhere in this file.\n',
  );
  sourceSeven(repo);
  const r = drift(repo);
  test("no declared ramp means no type findings", () => lacks(r.out, "type-size"));
  test("and that is not a failure", () => assert.equal(r.rc, 0, r.out));
}

// ── 10. Severity follows the occurrence count, not the measure ────────────
{
  const repo = newRepo("severity");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    [
      "export function App() { return (<div>",
      ...Array.from({ length: 12 }, () => '  <p className="text-[10px]">many</p>'),
      '  <p className="text-[13px]">one</p>',
      "</div>); }",
      "",
    ].join("\n"),
  );
  const r = drift(repo);
  test("ten or more occurrences is systemic", () => has(r.out, "[P2] type-size  10px"));
  test("fewer than ten is a one-off", () => has(r.out, "[P3] type-size  13px"));
  test("caps the examples at five", () => has(r.out, "and 7 more"));
}

// ── 11. A native widget is P1 whatever the count, and is always armed ─────
{
  const repo = newRepo("native");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    `export function App() {
  return (
    <form>
      <select name="role">
        <option value="a">A</option>
      </select>
      <input
        type="date"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        className="rounded border px-2"
      />
      <input type="text" className="appearance-none" />
    </form>
  );
}
`,
  );
  const r = drift(repo);
  test("a raw select is P1", () => has(r.out, "[P1] native-widget  native <select>"));
  // The attributes are three lines below the tag. A line-based scan sees none
  // of them, which is how 34 of 35 native inputs went unreported before this.
  test("a multi-line native input is found", () => has(r.out, "[P1] native-widget  native <input type=date>"));
  test("a plain text input is not a platform widget", () => lacks(r.out, "type=text"));
}

// ── 12. appearance-none is the opt-out, and it is honoured ────────────────
{
  const repo = newRepo("appearance");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    'export const App = () => (\n  <select className="appearance-none rounded border" name="role">\n    <option value="a">A</option>\n  </select>\n);\n',
  );
  const r = drift(repo);
  test("a styled select is not reported", () => lacks(r.out, "native <select>"));
}

// ── 13. Off-palette colours, and the comment that is not one ──────────────
{
  const repo = newRepo("palette");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    `// The old ink was #ffeedd and this sentence must not be a finding.
export const App = () => (
  <div className="bg-slate-100 text-emerald-700">
    <span style={{ color: "#101010" }}>declared</span>
    <span style={{ color: "#abcdef" }}>not declared</span>
  </div>
);
`,
  );
  const r = drift(repo);
  test("a raw palette step is off-palette", () => has(r.out, "off-palette-colour  bg-slate-100"));
  test("so is an undeclared literal", () => has(r.out, "off-palette-colour  #abcdef"));
  test("a declared literal is not", () => lacks(r.out, "off-palette-colour  #101010"));
  test("and neither is one named in a comment", () => lacks(r.out, "#ffeedd"));
}

// ── 14. A recipe claim is never counted as a defect ───────────────────────
{
  const repo = newRepo("claims");
  realDesign(repo, FOUR_STEP);
  writeApp(repo, 'export const App = () => <button className="border px-2">Go</button>;\n');
  const r = drift(repo);
  test("a raw button is reported as a claim", () => has(r.out, "[claim] unmapped-recipe  raw <button>"));
  test("and the summary counts it separately", () => has(r.out, "claims=1"));
  test("never as a P2", () => lacks(r.out, "[P2] unmapped-recipe"));
}

// ── 15. design-authority.ts answers for a real system ─────────────────────
{
  const repo = newRepo("real-authority");
  realDesign(repo, FOUR_STEP);
  const r = authority(repo);
  test("a real authority exits 0", () => assert.equal(r.rc, 0, r.out));
  test("and says so", () => has(r.out, "AUTHORITY=real"));
}

// ── 16. A block-list scale is READ, not discarded ─────────────────────────
// `- 4px` under a key used to be skipped, which disarmed that key's measure —
// a declared scale reading as an absent one, which is the failure the whole
// mechanism exists to close.
{
  const repo = newRepo("block-list");
  writeDesign(
    repo,
    `---
name: Fixture
colors:
  ink: "#101010"
typography:
  scale:
    - "0.75rem"
    - "1rem"
controlHeights:
  - "2rem"
---

# Design System: Fixture

## Type
Two steps.

## Controls
One height.
`,
  );
  writeApp(
    repo,
    `export const App = () => (
  <div>
    <p className="text-[12px]">declared</p>
    <p className="text-[13px]">not declared</p>
    <button className="h-9">off the declared height</button>
  </div>
);
`,
  );
  const r = drift(repo);
  test("a block-list ramp is measured", () => has(r.out, "type-size  13px"));
  test("and its declared step is not drift", () => lacks(r.out, "type-size  12px"));
  test("a block-list control set is measured too", () => has(r.out, "control-height  h-9"));
}

// ── 17. An inline array keeps commas that are INSIDE a value ──────────────
{
  const repo = newRepo("inline-commas");
  writeDesign(
    repo,
    '---\nname: Fixture\ncolors:\n  ink: ["rgb(0, 0, 0)", "#abcdef"]\ntypography:\n  scale:\n    xs: "0.75rem"\n---\n\n# Design System: Fixture\n\n## Type\nOne step.\n',
  );
  writeApp(
    repo,
    `export const App = () => (
  <div>
    <span style={{ color: "rgb(0, 0, 0)" }}>declared</span>
    <span style={{ color: "#123456" }}>not declared</span>
  </div>
);
`,
  );
  const r = drift(repo);
  test("a declared rgb() is not split into three values", () => lacks(r.out, "rgb(0,0,0)"));
  test("an undeclared literal still reports", () => has(r.out, "#123456"));
}

// ── 18. An arbitrary control height is caught ─────────────────────────────
// `h-[41px]` walked past the scan because the pattern ended in a word boundary,
// and a `]` cannot be followed by one.
{
  const repo = newRepo("arbitrary-height");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    'export const App = () => (\n  <div>\n    <button className="h-[41px] px-3">odd</button>\n    <button className="h-8 px-3">declared</button>\n  </div>\n);\n',
  );
  const r = drift(repo);
  test("an arbitrary height is off-scale", () => has(r.out, "control-height  h-[41px] (41px)"));
  test("a declared height is not", () => lacks(r.out, "control-height  h-8"));
}

// ── 19. A path with a space is scanned, not silently skipped ──────────────
{
  const repo = newRepo("spaced");
  realDesign(repo, FOUR_STEP);
  mkdirSync(join(repo, "src", "my components"), { recursive: true });
  writeFileSync(
    join(repo, "src", "my components", "app.tsx"),
    'export const App = () => <select name="role"><option value="a">A</option></select>;\n',
  );
  const r = drift(repo);
  test("a file under a directory with a space is read", () => has(r.out, "native <select>"));
  test("and its path is reported whole", () => has(r.out, "src/my components/app.tsx"));
}

// ── 20. Three spellings of one attribute, one answer ──────────────────────
{
  const repo = newRepo("type-spellings");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    'export const App = () => (\n  <div>\n    <input type="date" />\n    <input type=\'time\' />\n    <input type={"file"} />\n  </div>\n);\n',
  );
  const r = drift(repo);
  test("double quotes", () => has(r.out, "native <input type=date>"));
  test("single quotes", () => has(r.out, "native <input type=time>"));
  test("a JSX expression", () => has(r.out, "native <input type=file>"));
}

// ── 21. The marker is the SCALAR, not the line it sits on ─────────────────
{
  const spellings = [
    'design-authority: "generated-stub"',
    "design-authority: 'generated-stub'",
    "design-authority: generated-stub  # written by /qa",
  ];
  spellings.forEach((spelling, i) => {
    const repo = newRepo(`marker-${i}`);
    writeDesign(
      repo,
      `---\n${spelling}\nname: Fixture\ncolors:\n  ink: "#101010"\n---\n\n# Design System: Fixture\n\n## Type\nA real-looking heading, which must not rescue a file its own frontmatter calls a stub.\n`,
    );
    writeApp(repo, "export const App = () => <p>x</p>;\n");
    const r = authority(repo);
    test(`marker spelled as [${spelling}] is still a stub`, () => assert.equal(r.rc, 3, r.out));
    test(`marker spelled as [${spelling}] is reported as one`, () => has(r.out, "AUTHORITY=stub"));
  });
}

// ── 22. A token inventory headed "## Colors" is NOT a design system ───────
// The second limb has to reject exactly this shape, or it exempts the whole
// population of generated files it exists to catch.
{
  const repo = newRepo("colours-only");
  writeDesign(
    repo,
    '---\nname: Fixture\ncolors:\n  ink: "#101010"\n---\n\n# Design System: Fixture\n\n## Colors\n\nEvery colour this repo happens to use, and nothing about how to use them.\n',
  );
  writeApp(repo, "export const App = () => <p>x</p>;\n");
  const r = authority(repo);
  test("a colour list under a colour heading is a stub", () => assert.equal(r.rc, 3, r.out));
  test("and says it declares no contract", () => has(r.out, "declares no design contract"));
}

// ── 23. A quoted marker with trailing spaces is still a marker ────────────
{
  const repo = newRepo("marker-trailing");
  writeDesign(
    repo,
    '---\ndesign-authority: "generated-stub"   \nname: Fixture\n---\n\n# Design System: Fixture\n\n## Type\nA heading that must not rescue it.\n',
  );
  writeApp(repo, "export const App = () => <p>x</p>;\n");
  const r = authority(repo);
  test("a quoted marker padded with spaces is still a stub", () => assert.equal(r.rc, 3, r.out));
  test("and is reported as one", () => has(r.out, "AUTHORITY=stub"));
}

// ── 24. A list of maps is a parse ERROR, not a corrupted scale ────────────
{
  const repo = newRepo("list-of-maps");
  writeDesign(
    repo,
    '---\nname: Fixture\ntypography:\n  scale:\n    - name: xs\n      size: "0.75rem"\n---\n\n# Design System: Fixture\n\n## Type\nOne step, written in a shape the reader does not cover.\n',
  );
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("a list of maps exits 2, never 0", () => assert.equal(r.rc, 2, r.out));
  test("and names the shape it cannot read", () => has(r.out, "list of maps is not supported"));
}

// ── 25. A quoted map key is the same unsupported shape ────────────────────
{
  const repo = newRepo("quoted-map-key");
  writeDesign(
    repo,
    '---\nname: Fixture\ntypography:\n  scale:\n    - "name": xs\n      size: "0.75rem"\n---\n\n# Design System: Fixture\n\n## Type\nStill a list of maps, just quoted.\n',
  );
  writeApp(repo, ONE_OFF);
  const r = drift(repo);
  test("a quoted map key is rejected too", () => assert.equal(r.rc, 2, r.out));
  test("with the same reason", () => has(r.out, "list of maps is not supported"));
}

// ── 26. A trailing comment is stripped; a hex colour is not ───────────────
{
  const repo = newRepo("trailing-comments");
  writeDesign(
    repo,
    `---
name: Fixture
colors:
  ink: "#101010" # the brand ink
typography:
  scale:
    xs: "0.75rem"   # small
controlHeights:
  - "2rem" # standard
---

# Design System: Fixture

## Type
One step.

## Controls
One height.
`,
  );
  writeApp(
    repo,
    `export const App = () => (
  <div>
    <p className="text-[12px]">declared</p>
    <span style={{ color: "#101010" }}>declared</span>
    <button className="h-8">declared</button>
    <button className="h-9">not declared</button>
  </div>
);
`,
  );
  const r = drift(repo);
  test("a commented size is still recognised", () => lacks(r.out, "type-size  12px"));
  test("a commented hex colour survives the strip", () => lacks(r.out, "#101010"));
  test("a commented height is still recognised", () => lacks(r.out, "control-height  h-8"));
  test("and a genuinely undeclared height still reports", () => has(r.out, "control-height  h-9"));
}

// ── 27. A comment on a container key does not disarm its measure ──────────
{
  const repo = newRepo("commented-container");
  writeDesign(
    repo,
    '---\nname: Fixture\ncolors:\n  ink: "#101010"\ntypography:\n  scale: # the ramp, four steps\n    - "0.75rem"\n    - "1rem"\n---\n\n# Design System: Fixture\n\n## Type\nTwo steps.\n',
  );
  writeApp(
    repo,
    'export const App = () => (\n  <div>\n    <p className="text-[12px]">declared</p>\n    <p className="text-[13px]">not declared</p>\n  </div>\n);\n',
  );
  const r = drift(repo);
  test("the ramp under a commented key is still read", () => has(r.out, "type-size  13px"));
  test("and its declared step under a commented key is not drift", () => lacks(r.out, "type-size  12px"));
}

// ── 28. A JSX variable is not a native type ───────────────────────────────
// `type={fileType}` is a variable whose value is unknown at scan time. Matching
// it on the prefix `file` reported a blocking P1 about a control that may be a
// plain text box.
{
  const repo = newRepo("jsx-variable-type");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    'export const App = ({ fileType, dateish }) => (\n  <div>\n    <input type={fileType} />\n    <input type={dateish} />\n    <input type={"date"} />\n  </div>\n);\n',
  );
  const r = drift(repo);
  test("a quoted JSX literal is still found", () => has(r.out, "native <input type=date>"));
  test("a variable named fileType is not a file input", () => lacks(r.out, "type=file"));
  test("exactly one native finding", () => assert.equal(count(r.out, "native-widget"), 1));
}

// ── 29. Control heights in the published shape arm the control measure ────
// The schema has no `controlHeights` key: a control's height lives on a
// `components` entry. Only entries named `control-*` count — an app may
// declare `person-row: 64px`, and a row height is not a control height.
{
  const repo = newRepo("components-controls");
  writeDesign(
    repo,
    `---
name: Fixture
colors:
  ink: "#101010"
typography:
  body:
    fontSize: "1rem"
spacing:
  s4: "4px"
  s8: "8px"
rounded:
  sm: "6px"
components:
  control-sm:
    height: "2rem"
  control-md:
    height: "2.25rem"
  person-row:
    height: "64px"
---

# Design System: Fixture

## Controls
Two heights.
`,
  );
  writeApp(
    repo,
    `export const App = () => (
  <div>
    <button className="h-9">declared control height</button>
    <button className="h-11">not declared</button>
    <button className="h-16">declared only by a row, which is not a control</button>
  </div>
);
`,
  );
  const r = drift(repo);
  test("a components control set arms the measure", () => has(r.out, "control-height  h-11"));
  test("and a declared control height is not drift", () => lacks(r.out, "control-height  h-9"));
  test("a non-control component height does not join the set", () => has(r.out, "control-height  h-16"));

  // ── 30. The reader reads the published keys when the older ones are absent ─
  const fm = run(FRONTMATTER, repo).out;
  test("a spacing map arms the spacing scale", () => has(fm, "SPACING_SCALE=4px|8px"));
  test("and control-* heights arm the control set", () => has(fm, "CONTROL_HEIGHTS=2rem|2.25rem"));
}

// ── 31. Variants derive from <role>-<variant> component names ─────────────
// `componentVariants` is not a schema key either; the schema's way to say a
// button has a ghost variant is an entry named `button-ghost`.
{
  const repo = newRepo("components-variants");
  writeDesign(
    repo,
    `---
name: Fixture
colors:
  ink: "#101010"
typography:
  body:
    fontSize: "1rem"
components:
  button-default:
    backgroundColor: "{colors.ink}"
  button-ghost:
    textColor: "{colors.ink}"
---

# Design System: Fixture

## Controls
Two button variants.
`,
  );
  writeApp(repo, 'export const App = () => <button className="px-2">raw</button>;\n');
  const fm = run(FRONTMATTER, repo).out;
  test("variants derive from component names", () => has(fm, "VARIANTS_BUTTON=default|ghost"));
  const r = drift(repo);
  test("and arm the recipe measure", () => has(r.out, "unmapped-recipe"));
}

// ── 32. Usage and a missing directory have their own exits ────────────────
test("no repo argument → exit 2 with usage", () => {
  const r = run(DRIFT);
  assert.equal(r.rc, 2);
  has(r.out, "usage:");
});
test("a directory that does not exist → exit 4", () => {
  const r = drift(join(TMP, "nope"));
  assert.equal(r.rc, 4);
  has(r.out, "no such directory");
});

// ── 33. The report's exact shape: grouping, ordering and the summary line ──
// Most occurrences first; the evidence is `file:line`, indented seven spaces.
{
  const repo = newRepo("report-shape");
  realDesign(repo, FOUR_STEP);
  writeApp(
    repo,
    'export const A = () => (\n  <div>\n    <p className="text-[13px]">a</p>\n    <p className="text-[10px]">b</p>\n    <p className="text-[10px]">c</p>\n  </div>\n);\n',
  );
  const r = drift(repo);
  test("findings are grouped per value, most occurrences first, then summed", () =>
    assert.equal(
      r.out,
      [
        "[P3] type-size  10px — 2 occurrence(s); not in the declared ramp (0.75rem|0.875rem|1rem|1.5rem)",
        "       src/app.tsx:4",
        "       src/app.tsx:5",
        "[P3] type-size  13px — 1 occurrence(s); not in the declared ramp (0.75rem|0.875rem|1rem|1.5rem)",
        "       src/app.tsx:3",
        "system-drift: P1=0 P2=0 P3=2 claims=0",
        "",
      ].join("\n"),
    ));
}

// ── 34. A long report survives a pipe whose reader is slow ────────────────
// Node writes to a full pipe asynchronously, so an exit straight after the
// report dropped whatever the pipe had not taken yet: 2,500 findings came out
// as a few hundred and no summary line. The reader here sleeps first, so the
// pipe is full when the script finishes writing.
{
  const repo = newRepo("long-report");
  realDesign(repo, FOUR_STEP);
  const spans = Array.from(
    { length: 2500 },
    (_, i) => `  <span style={{ color: "#${(0x200000 + i).toString(16)}" }}>x</span>`,
  );
  writeApp(repo, `export const A = () => (<div>\n${spans.join("\n")}\n</div>);\n`);
  const r = spawnSync(
    "sh",
    [
      "-c",
      '{ "$0" --experimental-strip-types "$1" "$2"; echo "rc=$?" >&2; } | { sleep 1; cat; }',
      process.execPath,
      DRIFT,
      repo,
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  test("a slow pipe gets every finding", () =>
    assert.equal(r.stdout.split("\n").filter((l) => l.startsWith("[P3] off-palette-colour")).length, 2500));
  test("and the summary line after them", () => has(r.stdout, "system-drift: P1=0 P2=0 P3=2500 claims=0"));
  test("and the exit status is still 1", () => has(r.stderr, "rc=1"));
}
