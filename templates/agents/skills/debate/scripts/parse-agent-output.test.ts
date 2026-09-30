// Test harness for parse-agent-output.ts — the boundary cases of the parser's
// contract. Uses fixture files under scripts/fixtures/.
//
// The program is SPAWNED, never imported.
//
// Run: node --test --experimental-strip-types .agents/skills/debate/scripts/parse-agent-output.test.ts
//
// peers: parse-agent-output.ts

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "parse-agent-output.ts");
const FIXTURES = join(HERE, "fixtures");

const made: string[] = [];
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "parse-agent-output-test-"));
  made.push(d);
  return d;
}

/** A dir holding each named fixture as `<role>.output`: makeOutputDir(["thesis", "clean.output"], …). */
function makeOutputDir(...pairs: [role: string, fixture: string][]): string {
  const d = scratch();
  for (const [role, fixture] of pairs) copyFileSync(join(FIXTURES, fixture), join(d, `${role}.output`));
  return d;
}

function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the script is executable and its fixtures are present", () => {
  assert.ok((statSync(SCRIPT).mode & 0o111) !== 0, `not executable: ${SCRIPT}`);
  assert.ok(existsSync(FIXTURES), `fixtures dir missing: ${FIXTURES}`);
});

test("a clean output becomes a fenced block with its Position section", () => {
  const r = run("--output-dir", makeOutputDir(["thesis", "clean.output"]));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("=== thesis ==="), "missing role fence");
  assert.match(r.stdout, /^## Position/m, "missing Position section");
});

// LEGACY SHAPE. Codex v0.147.0 and later write the banner and token count to
// STDERR, so live stdout now looks like the v0147 fixture's. This case stays as
// the regression guard for the stripper — an older codex on another host, or a
// vendor that reverts to stdout noise, must still parse. The v0147 case covers
// the shape the CLI actually produces today; neither alone is the real contract.
test("codex header and footer noise is stripped", () => {
  const r = run("--output-dir", makeOutputDir(["antithesis", "codex-noise.output"]));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes("tokens-in: 1843"), "header noise leaked through");
  assert.ok(!r.stdout.includes("total tokens"), "footer noise leaked through");
  assert.ok(r.stdout.includes("Option B is the better choice"), "content missing");
});

// Skipping it would make the synthesis silently run on fewer voices than it
// says it has.
test("an output with no ## Position is passed through whole, marked and warned — never dropped", () => {
  const r = run("--output-dir", makeOutputDir(["thesis", "malformed.output"]));
  assert.equal(r.code, 0, "expected 0 — the answer is usable");
  assert.match(r.stderr, /unstructured output/, "missing warn msg");
  assert.ok(r.stdout.includes("=== thesis ==="), "the answer was dropped");
  assert.ok(r.stdout.includes("(unstructured"), "the answer is not marked unstructured");
  assert.ok(r.stdout.includes("The model wandered off"), "the answer's text is missing");
});

test("--round 2 parses the round-2 schema", () => {
  const r = run("--output-dir", makeOutputDir(["thesis", "round2.output"]), "--round", "2");
  assert.equal(r.code, 0, r.stdout);
  assert.ok(r.stdout.includes("## Rebuttal"), "missing Rebuttal section");
  assert.ok(r.stdout.includes("## Revised Position"), "missing Revised section");
});

test("an output dir holding only .gap files exits non-zero with a diagnostic", () => {
  const d = scratch();
  writeFileSync(join(d, "thesis.gap"), "timeout after 120s\n");
  const r = run("--output-dir", d);
  assert.notEqual(r.code, 0, "expected non-zero on no-output");
  assert.match(r.stdout + r.stderr, /no \.output files/, "missing diagnostic msg");
});

test("a missing --output-dir exits 2", () => {
  assert.equal(run().code, 2);
});

// The shape of a live `codex exec --sandbox=read-only --skip-git-repo-check
// --color never` run, the invocation dispatch-agents.ts uses (content
// genericized).
test("real codex v0.147.0 stdout (banner on stderr) parses intact", () => {
  const r = run("--output-dir", makeOutputDir(["critic", "codex-v0147-clean-stdout.output"]));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("=== critic ==="), "missing role fence");
  assert.match(r.stdout, /^## Position/m, "missing Position section");
  assert.ok(!r.stdout.includes("OpenAI Codex"), "banner leaked into stdout fixture");
});

// A reasoning preamble that ends with no newline puts `## Position`
// mid-line, where a start-of-line anchor never matches.
test("a preamble running into the heading on one line keeps the block and cuts the preamble", () => {
  const d = scratch();
  writeFileSync(
    join(d, "skeptic.output"),
    ["Let me think about this carefully.## Position", "Ship it.", "", "## Key Arguments", "1. Speed", ""].join("\n"),
  );
  const r = run("--output-dir", d);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^## Position$/m, `heading not recovered: ${r.stdout}`);
  assert.ok(r.stdout.includes("Ship it."), `body missing: ${r.stdout}`);
  assert.ok(!r.stdout.includes("Let me think"), `preamble leaked: ${r.stdout}`);
  assert.ok(!r.stdout.includes("(unstructured"), `a found heading was treated as no heading: ${r.stdout}`);
});

test("each block names who argued it, stand-ins included", () => {
  const d = makeOutputDir(["skeptic", "clean.output"]);
  writeFileSync(join(d, "skeptic.voice"), "claude opus[1m] — stood in for codex (timeout after 120s (codex))\n");
  const r = run("--output-dir", d);
  assert.ok(r.stdout.includes("argued by: claude opus[1m] — stood in for codex"), `voice line missing: ${r.stdout}`);
});

// A blank answer — empty, whitespace only, or nothing left once the footer
// noise is cut — carries no position. Passing it through produced a fenced
// block with no content and exit 0, so three silent voices read as three
// arguments. It is skipped with a warning, and a dir with no usable answer
// fails like a dir with no answer at all.
test("a blank output is skipped with a warning, and the usable answers still parse", () => {
  const d = makeOutputDir(["pragmatist", "clean.output"]);
  writeFileSync(join(d, "skeptic.output"), "  \n\n");
  writeFileSync(join(d, "visionary.output"), "[done in 4.2s]\ntotal tokens: 2255\n");
  const r = run("--output-dir", d);
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("=== pragmatist ==="), "the usable answer was dropped");
  assert.ok(!r.stdout.includes("=== skeptic ==="), `a blank answer was emitted as a block: ${r.stdout}`);
  assert.ok(!r.stdout.includes("=== visionary ==="), `a noise-only answer was emitted as a block: ${r.stdout}`);
  assert.match(r.stderr, /skeptic: no usable content/);
  assert.match(r.stderr, /visionary: no usable content/);
});

test("an output dir whose every answer is blank exits non-zero", () => {
  const d = scratch();
  writeFileSync(join(d, "pragmatist.output"), "");
  writeFileSync(join(d, "skeptic.output"), "\n\n");
  const r = run("--output-dir", d);
  assert.equal(r.code, 1, `blank answers were reported as success: ${r.stdout}`);
  assert.equal(r.stdout, "", "a blank answer reached the synthesis input");
  assert.match(r.stderr, /no usable answer/);
});

// Dispatch accepts a seat when any reading keeps an answer (answer-block.ts's
// hasAnswer); the parser must print exactly those seats, whatever --round it is
// given, or a seat dispatch called answered vanishes here with no stand-in. A
// round-1 run whose answer carries only the round-2 heading, below a
// footer-like line, is the case that split them.
test("an answer dispatch accepted is printed under either round, even with the other round's heading", () => {
  const d = scratch();
  writeFileSync(join(d, "skeptic.output"), "tokens-in: 1\n## Rebuttal\nNo.\n");
  const r = run("--output-dir", d);
  assert.equal(r.code, 0, `an answered seat vanished at parse: ${r.stderr}`);
  assert.ok(r.stdout.includes("=== skeptic ==="), r.stdout);
  assert.ok(r.stdout.includes("## Rebuttal\nNo.\n"), r.stdout);
  assert.ok(r.stdout.includes("(unstructured — no '## Position' heading)"), "an off-round answer is not marked");
  assert.ok(!r.stdout.includes("tokens-in"), "the footer-like line above the heading leaked");
});
