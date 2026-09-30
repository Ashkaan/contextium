// {{name}}.test.ts — boundary rows for {{name}}.ts: 0 files, 1 clean file, 1
// violating file, the error names file + line + remediation.
//
// Run: node --test --experimental-strip-types .agents/checks/{{name}}.test.ts
//
// Every fixture lives in a throwaway directory; the check is spawned as a
// program, never imported, with HOME pointed at that directory so anything it
// writes under $HOME lands there rather than in the real home.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "{{name}}.ts");
const TMP = mkdtempSync(join(tmpdir(), "{{name}}-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

function run(...files: string[]): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...files], {
    encoding: "utf8",
    env: { ...process.env, HOME: TMP },
    timeout: 30_000,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}` };
}

// ── 0 files: nothing to check is a pass ──
test("no files → exit 0", () => {
  assert.equal(run().rc, 0);
});

// ── 1 clean file ──
test("clean file → exit 0", () => {
  writeFileSync(join(TMP, "clean.txt"), "clean\n");
  assert.equal(run(join(TMP, "clean.txt")).rc, 0);
});

// ── 1 violating file: TODO write the violation the check exists for ──
// The error must name the file, the line and the fix;
// fill the remediation needle with the words the check prints.
test("violating file → exit 1, and the error names the file, the line and the fix", () => {
  writeFileSync(join(TMP, "bad.txt"), "TODO the violating line\n");
  const { rc, out } = run(join(TMP, "bad.txt"));
  assert.equal(rc, 1, "violating file → exit 1");
  assert.ok(out.includes("bad.txt"), `the error names the file — output lacks 'bad.txt':\n${out}`);
  assert.ok(out.includes("bad.txt:1"), `the error names the line — output lacks 'bad.txt:1':\n${out}`);
  assert.ok(
    out.includes("TODO the remediation"),
    `the error names the fix — output lacks 'TODO the remediation':\n${out}`,
  );
});
