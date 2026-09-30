#!/usr/bin/env -S node --experimental-strip-types
// sight-validate.test.ts — the review chain's shape test for a visual review,
// run as the chain runs it: the file itself, one argument, the codes in
// QA_SIGHT_CODES. A reply that transcribed every code passes; one that did not
// is refused with a single reason line; a missing codes file is never a pass.
//
// Run: node --test --experimental-strip-types .agents/skills/qa/scripts/tests/sight-validate.test.ts
//
// peers: ../sight-validate.ts, ../sight-check.ts, ./sight-fallback.test.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SV = join(dirname(fileURLToPath(import.meta.url)), "..", "sight-validate.ts");
const TMP = mkdtempSync(join(tmpdir(), "sight-validate-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));

const CODES = join(TMP, "codes");
writeFileSync(CODES, "index-1440.png\tK7M3PX\nabout-1440.png\tR4W9TN\n");
const reply = (name: string, text: string) => {
  writeFileSync(join(TMP, name), text);
  return join(TMP, name);
};

/** Exec the file directly (its shebang), as policy-chain.ts runs a validator; `codes` null leaves QA_SIGHT_CODES unset. */
function run(args: string[], codes: string | null = CODES) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.QA_SIGHT_CODES;
  if (codes !== null) env.QA_SIGHT_CODES = codes;
  const r = spawnSync(SV, args, { encoding: "utf8", env });
  return {
    rc: r.status,
    stdout: r.stdout,
    // Node 22.6 warns that type stripping is experimental, on two lines.
    stderr: r.stderr.replace(/^.*(ExperimentalWarning|--trace-warnings).*\n?/gm, ""),
  };
}

test("every code transcribed → 0, nothing on stdout", () => {
  const r = run([reply("seen", "index-1440.png = K7M3PX\nabout-1440.png = r4w9tn\nZero findings.\n")]);
  assert.equal(r.rc, 0, r.stderr);
  assert.equal(r.stdout, "");
});
test("a code missing → 6, one reason line naming the count", () => {
  const r = run([reply("half", "index-1440.png = K7M3PX\nabout-1440.png = (could not open)\n")]);
  assert.equal(r.rc, 6);
  assert.equal(r.stderr.trim().split("\n").length, 1, r.stderr);
  assert.match(
    r.stderr,
    /^sight-validate: not a visual review — 1\/2 sight codes came back\. Missing for: about-1440\.png/,
  );
});
test('"cannot see" → 6', () => assert.equal(run([reply("blind", "CANNOT SEE\n")]).rc, 6));
test("a codes file that is not there → 5, never a pass", () =>
  assert.equal(run([reply("any", "K7M3PX R4W9TN\n")], join(TMP, "absent")).rc, 5));
test("no QA_SIGHT_CODES → 2", () => assert.equal(run([reply("x", "K7M3PX\n")], null).rc, 2));
test("no response file argument → 2", () => assert.equal(run([]).rc, 2));
test("more than one argument → 2", () => assert.equal(run(["a", "b"]).rc, 2));
