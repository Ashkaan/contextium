// open-clarifications.test.ts — peer of open-clarifications.ts.
// Run: node --test --experimental-strip-types .agents/skills/close/scripts/open-clarifications.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "open-clarifications.ts");
const tmp = mkdtempSync(join(tmpdir(), "open-clarifications-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

function sut(...args: string[]): { rc: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--no-warnings", "--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { rc: r.status, out: `${r.stdout}${r.stderr}`.replace(/\n+$/, "") };
}
const run = (d: string): string => sut(d).out;
const rc = (d: string): number | null => sut(d).rc;
function folder(name: string, files: Record<string, string>): string {
  const d = join(tmp, name);
  mkdirSync(d, { recursive: true });
  for (const [f, body] of Object.entries(files)) writeFileSync(join(d, f), body);
  return d;
}

// Empty folder: nothing open
test("empty folder", () => {
  const d = folder("empty", {});
  assert.equal(run(d), "", "empty folder prints nothing");
  assert.equal(rc(d), 0, "empty folder exits 0");
});

// A marker inside a one-line and a multi-line comment is ignored
test("comment markers ignored", () => {
  const d = folder("comments", {
    "spec.md":
      "# Spec\n<!-- mark it [NEEDS CLARIFICATION: like this] -->\n<!--\n  Use [NEEDS CLARIFICATION: x] for open items\n-->\nBody.\n",
  });
  assert.equal(run(d), "", "comment markers ignored");
  assert.equal(rc(d), 0, "comment markers exit 0");
});

// Text after a comment closes on the same line IS read
test("text after a closed comment is read", () => {
  const d = folder("after", { "spec.md": "a <!-- note --> [NEEDS CLARIFICATION: after the comment]\n" });
  assert.equal(run(d), "spec.md:1: a  [NEEDS CLARIFICATION: after the comment]");
});

// Markers in spec.md, plan.md, tasks.md with their own line numbers
test("all three files, right lines", () => {
  const d = folder("all", {
    "spec.md": "one\ntwo\n- FR-3: [NEEDS CLARIFICATION: auth method?]\n",
    "plan.md": "**Testing**: NEEDS CLARIFICATION\n",
    "tasks.md": "<!--\nmulti\n-->\n\n- [ ] T001 [NEEDS CLARIFICATION: which file]\n",
    "research.md": "Decision: NEEDS CLARIFICATION resolved below\n",
  });
  assert.equal(
    run(d),
    "spec.md:3: - FR-3: [NEEDS CLARIFICATION: auth method?]\nplan.md:1: **Testing**: NEEDS CLARIFICATION\ntasks.md:5: - [ ] T001 [NEEDS CLARIFICATION: which file]",
    "all three files, right lines",
  );
  assert.equal(rc(d), 1, "markers exit 1");
});

// research.md alone is never counted
test("research.md not counted", () => {
  const d = folder("research", { "research.md": "NEEDS CLARIFICATION\n" });
  assert.equal(rc(d), 0);
});

// Usage
test("usage", () => {
  assert.equal(sut().rc, 2, "no argument is usage");
  assert.equal(rc(join(tmp, "nope")), 2, "missing folder is usage");
});

// An unreadable file is an error, never "no markers"
test("unreadable spec.md exits 2", (t) => {
  const d = folder("unreadable", { "spec.md": "[NEEDS CLARIFICATION: hidden]\n" });
  const f = join(d, "spec.md");
  chmodSync(f, 0o000);
  try {
    let readable = true;
    try {
      accessSync(f, constants.R_OK);
    } catch {
      readable = false;
    }
    if (readable) {
      t.skip("running as a user who can read mode-000 files");
      return;
    }
    const r = sut(d);
    assert.equal(r.rc, 2, "unreadable spec.md exits 2");
    assert.match(r.out, /cannot read/, "…and says so");
  } finally {
    chmodSync(f, 0o644);
  }
});

test("a directory named spec.md exits 2", () => {
  const d = join(tmp, "dirnamed");
  mkdirSync(join(d, "spec.md"), { recursive: true });
  const r = sut(d);
  assert.equal(r.rc, 2, "a directory named spec.md exits 2");
  assert.match(r.out, /cannot read/, "…and says so");
});
