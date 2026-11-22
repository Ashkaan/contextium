// parse-review-output.test.ts — peer of parse-review-output.ts.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/parse-review-output.test.ts
//
// Pins the follow-up summary /spec-audit reads: the four counts, the verdict
// (consensus when every expected finding is [resolved] and no new [must-fix]
// appeared, open when one is [open] or the accepted edits introduced a
// must-fix, incomplete when a verdict is missing, doubled or unknown), and the
// verbatim lines echoed after the blank line — resolved, open, new must-fix,
// new should-fix, each in the order the reviewer wrote them. Boundaries: empty
// input is refused, --expected is required, a marker that is not at the start
// of its line is not a verdict, the retired [concede]/[disagree] markers are not
// verdicts, and prose around the markers is dropped. The script is run as a
// subprocess on stdin, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "parse-review-output.ts");

/** Run with `--expected <ids>`, the IDs of the findings sent to the follow-up. */
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

// ── 2. consensus: every finding resolved ──────────────────────────────────
test("consensus: every finding resolved", () => {
  const r = run("Verdicts follow.\n[resolved] F1\n[resolved] F2 the doc link resolves\nThanks.\n", "F1,F2");
  assert.equal(r.rc, 0, "all-resolved exits 0");
  assert.equal(r.line(1), "resolved-count: 2");
  assert.equal(r.line(2), "open-count: 0");
  assert.equal(r.line(3), "new-must-fix-count: 0");
  assert.equal(r.line(4), "new-should-fix-count: 0");
  assert.equal(r.line(5), "verdict: consensus", "nothing open and no new must-fix is consensus");
  assert.equal(r.line(6), "", "a blank line separates the summary from the lines");
  assert.equal(r.line(7), "[resolved] F1");
  assert.equal(r.line(8), "[resolved] F2 the doc link resolves");
  assert.equal(r.count, 8, "prose around the markers is dropped");
});

// ── 3. open: an [open] verdict, interleaved ───────────────────────────────
test("open: a finding still open, interleaved", () => {
  const r = run("[open] F1 the cap still lets a 3h hang through\n[resolved] F2\n[open] F3 the schema is still mirrored\n", "F1,F2,F3");
  assert.equal(r.rc, 0, "an open finding exits 0 (the verdict is in the output, not the code)");
  assert.equal(r.line(1), "resolved-count: 1");
  assert.equal(r.line(2), "open-count: 2");
  assert.equal(r.line(5), "verdict: open", "any [open] means another round");
  assert.equal(r.line(7), "[resolved] F2", "resolved come first regardless of input order");
  assert.equal(r.line(8), "[open] F1 the cap still lets a 3h hang through", "open follow in input order (1)");
  assert.equal(r.line(9), "[open] F3 the schema is still mirrored", "open follow in input order (2)");
});

// ── 4. a new must-fix from an accepted edit keeps the loop open ───────────
test("a new must-fix keeps the verdict open; a new should-fix alone does not", () => {
  const mf = run("[resolved] F1\n[must-fix] spec.md: the edit dropped CSV — add it — CSV rejected\n");
  assert.equal(mf.line(3), "new-must-fix-count: 1");
  assert.equal(mf.line(5), "verdict: open", "a defect the edit introduced needs another round");
  assert.equal(mf.line(8), "[must-fix] spec.md: the edit dropped CSV — add it — CSV rejected");
  const sf = run("[should-fix] plan.md: shape note stale\n[resolved] F1\n");
  assert.equal(sf.line(4), "new-should-fix-count: 1");
  assert.equal(sf.line(5), "verdict: consensus", "a new should-fix is dispositioned, not another round");
  assert.equal(sf.line(7), "[resolved] F1");
  assert.equal(sf.line(8), "[should-fix] plan.md: shape note stale", "new should-fix lines come last");
});

// ── 5. no markers at all ──────────────────────────────────────────────────
// A reply with no verdict lines adjudicated nothing: every expected finding is
// missing, which is incomplete, never consensus.
test("no markers at all", () => {
  const r = run("The reviewer wrote prose and no verdict lines.\n");
  assert.equal(r.rc, 3, "no markers exits 3");
  assert.equal(r.line(5), "verdict: incomplete", "no markers is incomplete, not consensus");
  assert.equal(r.line(7), "missing: F1", "the unadjudicated finding is named");
});

// ── 6. the retired round-2 markers are not verdicts ───────────────────────
test("[concede] and [disagree] are no longer verdicts", () => {
  const r = run("[concede] F1\n[disagree] F2 no\n", "F1,F2");
  assert.equal(r.rc, 3, "old markers leave every finding unadjudicated");
  assert.equal(r.line(5), "verdict: incomplete");
  assert.ok(r.out.includes("missing: F1") && r.out.includes("missing: F2"), r.out);
});

// ── 7. incomplete: a finding with no verdict is not consensus ─────────────
test("incomplete: a finding with no verdict", () => {
  const r = runWith(["--expected", "F1,F2"], "[resolved] F1\n");
  assert.equal(r.rc, 3, `a missing verdict exited ${r.rc}`);
  assert.equal(r.line(5), "verdict: incomplete", "a missing verdict is not consensus");
  assert.ok(r.out.includes("missing: F2"), `the unreviewed finding is not named: ${r.out}`);
});

// ── 8. malformed markers ──────────────────────────────────────────────────
test("malformed markers", () => {
  const r = run(
    "  [open] F1 indented marker is not a verdict\nI would [open] F1 mid-line\n[Resolved] F1 wrong case\n[resolved]F1 glued still counts\n[opened] F1 near miss\n",
  );
  assert.equal(r.line(2), "open-count: 0", "indented, mid-line, wrong-case and near-miss markers are not verdicts");
  assert.equal(r.line(1), "resolved-count: 1", "a marker glued to its text still counts");
  assert.equal(r.line(5), "verdict: consensus", "the one real verdict covers F1");
  assert.equal(r.line(7), "[resolved]F1 glued still counts", "the glued marker is echoed as written");
  // A marker a reviewer wrapped in Markdown emphasis is not at the start of its line.
  const bold = run("Here are my verdicts:\n**[resolved] F1**\n[resolved] F1\n");
  assert.equal(`${bold.line(1)}|${bold.line(5)}`, "resolved-count: 1|verdict: consensus", "a bolded marker is not a verdict");
});

// ── 9. the verdict ID tolerates trailing punctuation ──────────────────────
test("verdict ID with trailing colon", () => {
  const r = run("[resolved] F1: fair\n[open] F2, still stands\n", "F1,F2");
  assert.equal(`${r.rc}|${r.line(5)}`, "0|verdict: open");
});

// ── 10. a doubled verdict is incomplete ───────────────────────────────────
test("duplicate verdict for one finding", () => {
  const r = run("[resolved] F1 ok\n[open] F1 no wait\n");
  assert.equal(`${r.rc}|${r.line(5)}`, "3|verdict: incomplete");
  assert.ok(r.out.includes("duplicate: F1"), `the doubled ID is not named: ${r.out}`);
});

// ── 11. a verdict for a finding nobody sent is incomplete ─────────────────
test("verdict for an unexpected finding", () => {
  const r = run("[resolved] F1 ok\n[resolved] F9 also\n");
  assert.equal(`${r.rc}|${r.line(5)}`, "3|verdict: incomplete");
  assert.ok(r.out.includes("unexpected: F9"), `the unknown ID is not named: ${r.out}`);
});

// ── 12. --expected is required ────────────────────────────────────────────
test("no --expected is a caller error", () => {
  const r = runWith([], "[resolved] F1\n");
  assert.equal(r.rc, 2, "no --expected exits 2");
  assert.ok(r.err.includes("--expected"), `the error does not name the flag: ${r.err}`);
  assert.equal(runWith(["--expected", ""], "[resolved] F1\n").rc, 2, "an empty --expected exits 2");
  assert.equal(runWith(["--bogus"], "[resolved] F1\n").rc, 2, "an unknown flag exits 2");
});
