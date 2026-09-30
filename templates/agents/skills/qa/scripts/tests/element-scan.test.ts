#!/usr/bin/env -S node --experimental-strip-types
// element-scan.test.ts — pin element-scan.ts on fixture JSX/HTML: a
// multi-line opening tag comes back flattened on one line with its start line
// number; a `>` inside an arrow-function attribute or a string does not end the
// tag; a tag named in a comment line is skipped; several tags and several files
// scan in one call. `scanElements` is imported (system-drift.ts imports it);
// the usage errors and the printed row format are pinned by spawning it.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/element-scan.test.ts
//
// peers: ../element-scan.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { scanElements } from "../element-scan.ts";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "element-scan.ts");
const TMP = mkdtempSync(join(tmpdir(), "element-scan-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(...args: string[]): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SCRIPT, ...args], { encoding: "utf8" });
  return { rc: r.status, out: r.stdout + r.stderr };
}
/** Rows as the program prints them: FILE<TAB>LINE<TAB>TAG. */
const rows = (tags: string, ...files: string[]): string[] =>
  scanElements(tags, files).map(({ file, line, tag }) => `${file}\t${line}\t${tag}`);

// ── usage ──
test("no args → exit 2 with usage", () => {
  const r = run();
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage:/);
});
test("a tag but no file → exit 2 with usage", () => {
  const r = run("input");
  assert.equal(r.rc, 2);
  assert.match(r.out, /usage:/);
});

// an unreadable file is skipped, not fatal
test("a missing file → exit 0, no output", () => {
  const r = run("input", join(TMP, "missing.tsx"));
  assert.equal(r.rc, 0);
  assert.equal(r.out, "");
});

// ── the fixture: the formatted-JSX shape a line grep misses ──
const FORM = join(TMP, "Form.tsx");
writeFileSync(
  FORM,
  `// <input type="date"> is mentioned here in a comment and must not count
export function Form({ onChange }) {
  return (
    <form>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value > 3 ? ">" : "")}
        placeholder="a > b"
      />
      <select className="w-full"><option>x</option></select>
      <inputs-are-not-input />
      <textarea rows={3}>
        text
      </textarea>
    </form>
  );
}
`,
);

test("the program prints one FILE<TAB>LINE<TAB>TAG row per element, exit 0", () => {
  const r = run("input", FORM);
  assert.equal(r.rc, 0);
  assert.equal(r.out, `${rows("input", FORM).join("\n")}\n`);
});
test("one <input> found, comment and <inputs-…> skipped", () => assert.equal(rows("input", FORM).length, 1));
test("tag flattened to one line, closed past the > in braces and strings, start line 5", () =>
  assert.deepEqual(rows("input", FORM), [
    `${FORM}\t5\t<input type="date" value={value} onChange={(e) => onChange(e.target.value > 3 ? ">" : "")} placeholder="a > b" />`,
  ]));

// several tags in one call, in document order
test("three tags → three rows", () => assert.equal(rows("input,select,textarea", FORM).length, 3));
test("<select> row stops at its own >", () =>
  assert.equal(rows("input,select,textarea", FORM)[1], `${FORM}\t11\t<select className="w-full">`));
test("<textarea> opening tag only", () =>
  assert.ok(rows("input,select,textarea", FORM)[2].endsWith("\t13\t<textarea rows={3}>")));

// ── plain HTML, several files, an HTML comment line ──
const PAGE = join(TMP, "page.html");
writeFileSync(
  PAGE,
  `<!doctype html>
<!-- <button>ignored</button> -->
<body>
  <button
    class="primary"
    disabled>Go</button>
  <button>Two</button>
</body>
`,
);
test("html: two <button>s, comment skipped, tsx has none", () => assert.equal(rows("button", PAGE, FORM).length, 2));
test("html multi-line tag flattened, line 4", () =>
  assert.equal(rows("button", PAGE, FORM)[0], `${PAGE}\t4\t<button class="primary" disabled>`));
test("html second tag, line 7", () => assert.equal(rows("button", PAGE, FORM)[1], `${PAGE}\t7\t<button>`));

// a tag that never closes is not a tag
test("unclosed tag past 4000 chars → nothing", () => {
  const open = join(TMP, "open.tsx");
  writeFileSync(open, `<input type="date"\n${"x".repeat(4100)}\n`);
  assert.deepEqual(rows("input", open), []);
});

// Finding 1 of the R45 review: the harnesses reach every skill script through a
// symlink (~/.agents/skills -> workbench/skills), and an entry guard comparing
// the invoked path with the resolved module path skipped main() there, exiting
// 0 having done nothing.
test("invoked through a symlink, the script still runs", () => {
  const dir = mkdtempSync(join(TMP, "symlink-"));
  const link = join(dir, "element-scan.ts");
  symlinkSync(SCRIPT, link);

  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", link, ...[]], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  assert.equal(r.status, 2, `through a symlink: exit ${r.status}, output '${out}'`);
  assert.match(out, /usage: element-scan\.ts/);
});
