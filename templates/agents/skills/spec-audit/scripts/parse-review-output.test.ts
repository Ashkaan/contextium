// parse-review-output.test.ts — peer of parse-review-output.ts.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/parse-review-output.test.ts
//
// Pins the round-2 summary /spec-audit reads: the two counts, the verdict
// (consensus when every expected finding is conceded, escalate when every one
// has a verdict and some disagree, incomplete when one is missing, doubled or
// unknown), and the verbatim lines echoed after the blank line — concedes
// first, disagrees second, in the order the reviewer wrote them. Boundaries:
// empty input is refused, --expected is required, a marker that is not at the
// start of its line is not a verdict, and prose around the markers is dropped. The script is run as a subprocess on stdin, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "parse-review-output.ts");

/** Run with `--expected <ids>`, the IDs of the findings pushed back on. */
function run(input: string, expected = "F1") {
  return runWith(["--expected", expected], input);
}
function runWith(args: string[], input: string) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    // Node 22 prints a type-stripping warning on stderr, which these cases read.
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    input,
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  const lines = r.stdout.split("\n");
  if (r.stdout.endsWith("\n")) lines.pop();
  return {
    rc: r.status,
    out: r.stdout.replace(/\n+$/, ""),
    err: r.stderr.replace(/\n+$/, ""),
    /** `sed -n "<n>p"` */
    line: (n: number): string => lines[n - 1] ?? "",
    /** `wc -l` */
    count: r.stdout.split("\n").length - 1,
  };
}

// ── 1. empty input ────────────────────────────────────────────────────────
test("empty input", () => {
  const r = run("");
  assert.equal(r.rc, 1, "empty input exits 1");
  assert.equal(r.err, "error: empty input", "empty input is named on stderr");
  assert.equal(r.out, "", "empty input prints no summary");
  assert.equal(run("\n\n").rc, 1, "input of only newlines is empty too");
});

// ── 2. consensus: every finding conceded ──────────────────────────────────
test("consensus: every finding conceded", () => {
  const r = run(
    "Round 2 verdicts follow.\n[concede] F1 — the retry cap is fine as written\n[concede] F2 — the doc link resolves\nThanks.\n",
    "F1,F2",
  );
  assert.equal(r.rc, 0, "all-concede exits 0");
  assert.equal(r.line(1), "concede-count: 2", "concede count");
  assert.equal(r.line(2), "disagree-count: 0", "disagree count is zero");
  assert.equal(r.line(3), "verdict: consensus", "no disagree means consensus");
  assert.equal(r.line(4), "", "a blank line separates the summary from the lines");
  assert.equal(r.line(5), "[concede] F1 — the retry cap is fine as written", "first conceded line is echoed verbatim");
  assert.equal(r.line(6), "[concede] F2 — the doc link resolves", "second conceded line follows");
  assert.equal(r.count, 6, "prose around the markers is dropped");
});

// ── 3. escalate: one disagreement, interleaved ────────────────────────────
test("escalate: interleaved", () => {
  const r = run(
    "[disagree] F1 — the cap still lets a 3h hang through\n[concede] F2 — agreed\n[disagree] F3 — the schema is still mirrored in prose\n",
    "F1,F2,F3",
  );
  assert.equal(r.rc, 0, "a disagreement exits 0 (the verdict is in the output, not the code)");
  assert.equal(r.line(1), "concede-count: 1", "concede count with interleaving");
  assert.equal(r.line(2), "disagree-count: 2", "disagree count with interleaving");
  assert.equal(r.line(3), "verdict: escalate", "any disagree means escalate");
  assert.equal(r.line(5), "[concede] F2 — agreed", "concedes come first regardless of input order");
  assert.equal(
    r.line(6),
    "[disagree] F1 — the cap still lets a 3h hang through",
    "disagrees follow in input order (1)",
  );
  assert.equal(
    r.line(7),
    "[disagree] F3 — the schema is still mirrored in prose",
    "disagrees follow in input order (2)",
  );
});

// ── 4. one disagree and nothing else ──────────────────────────────────────
test("one disagree and nothing else", () => {
  const r = run("[disagree] F1 only one\n");
  assert.equal(r.line(1), "concede-count: 0", "single disagree: concede count zero");
  assert.equal(r.line(2), "disagree-count: 1", "single disagree: count one");
  assert.equal(r.line(3), "verdict: escalate", "single disagree escalates");
  assert.equal(r.line(5), "[disagree] F1 only one", "single disagree is echoed");
  assert.equal(r.count, 5, "single disagree: nothing after it");
});

// ── 5. no markers at all ──────────────────────────────────────────────────
// A reply with no verdict lines adjudicated nothing: every expected finding is
// missing, which is incomplete, never consensus.
test("no markers at all", () => {
  const r = run("The reviewer wrote prose and no verdict lines.\n");
  assert.equal(r.rc, 3, "no markers exits 3");
  assert.equal(r.line(1), "concede-count: 0", "no markers: zero concedes");
  assert.equal(r.line(2), "disagree-count: 0", "no markers: zero disagrees");
  assert.equal(r.line(3), "verdict: incomplete", "no markers is incomplete, not consensus");
  assert.equal(r.line(5), "missing: F1", "the unadjudicated finding is named");
});

// ── 5b. incomplete: a submitted finding with no verdict is not consensus ──
//
// Two pushbacks went out and only F1 came back. Counting [disagree] lines alone
// read that as consensus, and the SPEC recorded agreement on a finding (F2)
// nobody reviewed.
test("incomplete: a pushed-back finding with no verdict", () => {
  const r = runWith(["--expected", "F1,F2"], "[concede] F1 — agreed\n");
  assert.notEqual(r.rc, 0, `a missing verdict exited ${r.rc}`);
  assert.equal(r.line(3), "verdict: incomplete", "a missing verdict is not consensus");
  assert.ok(r.out.includes("missing: F2"), `the unreviewed finding is not named: ${r.out}`);
});

// ── 6. malformed markers ──────────────────────────────────────────────────
test("malformed markers", () => {
  const r = run(
    "  [disagree] F1 indented marker is not a verdict\nI would [disagree] F1 mid-line\n[Concede] F1 wrong case\n[concede]F1 glued still counts\n[disagreed] F1 near miss\n",
  );
  assert.equal(r.line(2), "disagree-count: 0", "indented, mid-line, wrong-case and near-miss markers are not verdicts");
  assert.equal(r.line(1), "concede-count: 1", "a marker glued to its text still counts");
  assert.equal(r.line(3), "verdict: consensus", "the one real verdict covers F1");
  assert.equal(r.line(5), "[concede]F1 glued still counts", "the glued marker is echoed as written");
  // A marker a reviewer wrapped in Markdown emphasis is not at the start of its line.
  const bold = run("Here are my verdicts:\n**[concede] F1**\n[concede] F1\n");
  assert.equal(`${bold.line(1)}|${bold.line(3)}`, "concede-count: 1|verdict: consensus", "a bolded marker is not a verdict");
});

// ── 7. the verdict ID tolerates trailing punctuation ──────────────────────
test("verdict ID with trailing colon", () => {
  const r = run("[concede] F1: fair\n[disagree] F2, still stands\n", "F1,F2");
  assert.equal(`${r.rc}|${r.line(3)}`, "0|verdict: escalate");
});

// ── 8. a doubled verdict is incomplete ────────────────────────────────────
test("duplicate verdict for one finding", () => {
  const r = run("[concede] F1 ok\n[disagree] F1 no wait\n");
  assert.equal(`${r.rc}|${r.line(3)}`, "3|verdict: incomplete");
  assert.ok(r.out.includes("duplicate: F1"), `the doubled ID is not named: ${r.out}`);
});

// ── 9. a verdict for a finding nobody submitted is incomplete ─────────────
test("verdict for an unexpected finding", () => {
  const r = run("[concede] F1 ok\n[concede] F9 also\n");
  assert.equal(`${r.rc}|${r.line(3)}`, "3|verdict: incomplete");
  assert.ok(r.out.includes("unexpected: F9"), `the unknown ID is not named: ${r.out}`);
});

// ── 10. --expected is required ────────────────────────────────────────────
test("no --expected is a caller error", () => {
  const r = runWith([], "[concede] F1\n");
  assert.equal(r.rc, 2, "no --expected exits 2");
  assert.ok(r.err.includes("--expected"), `the error does not name the flag: ${r.err}`);
  assert.equal(runWith(["--expected", ""], "[concede] F1\n").rc, 2, "an empty --expected exits 2");
  assert.equal(runWith(["--bogus"], "[concede] F1\n").rc, 2, "an unknown flag exits 2");
});
