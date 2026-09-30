// write-audit-line.test.ts — peer of write-audit-line.ts.
// Run: node --test --experimental-strip-types .agents/skills/spec-audit/scripts/write-audit-line.test.ts
//
// A throwaway spec folder per case: the placeholder item, a verdict, a
// non-material skip over each, and every refusal. The script is run as a
// subprocess, never imported.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SUT = join(dirname(fileURLToPath(import.meta.url)), "write-audit-line.ts");
const TMP = mkdtempSync(join(tmpdir(), "write-audit-line-test-"));
after(() => rmSync(TMP, { recursive: true, force: true }));
const DIR = join(TMP, "specs/001-a");
const PLAN = join(DIR, "plan.md");

function today(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** A plan.md whose Constitution Check holds `- <item>`. */
function plan(item: string): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(
    PLAN,
    `# Plan\n\n## Constitution Check\n\n- AGENTS.md § Standards → Plan the four before building: PASS\n- ${item}\n\n## Project Structure\n`,
  );
}
const line = (): string => readFileSync(PLAN, "utf8").split("\n").find((l) => l.startsWith("- spec-audit:")) ?? "";

function run(...args: string[]) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", SUT, ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    timeout: 30_000,
  });
  if (r.error) throw r.error;
  return { rc: r.status, err: r.stderr.replace(/\n+$/, "") };
}

const PH = "spec-audit: [written by /spec-audit through write-audit-line.ts — leave this item in place]";
const R1 = "spec-audit: codex round-1; spirit MATCH; user-ask-verbatim in spec.md Input";

test("a verdict, then non-material re-checks over it, then a new verdict", () => {
  plan(PH);
  assert.equal(run(DIR, R1).rc, 0);
  assert.equal(line(), `- ${R1}`, "a verdict replaces the placeholder");
  assert.ok(
    readFileSync(PLAN, "utf8").includes("- AGENTS.md § Standards → Plan the four before building: PASS\n"),
    "the rest of plan.md is untouched",
  );
  assert.ok(readFileSync(PLAN, "utf8").endsWith("## Project Structure\n"), "the trailing newline is kept");

  run(`${DIR}/`, "spec-audit: skipped — non-material (wording-polish)");
  assert.equal(
    line(),
    `- ${R1}; re-check ${today()} non-material`,
    "non-material keeps a real verdict and notes the re-check",
  );

  run(DIR, "spec-audit: skipped — non-material (typo)");
  assert.equal(
    line(),
    `- ${R1}; re-check ${today()} non-material`,
    "a second re-check replaces the first, never stacks",
  );

  const R2 =
    "spec-audit: grok round-2 (1 accepted by grok, 0 escalated); spirit MATCH; user-ask-verbatim in spec.md Input";
  run(DIR, R2);
  assert.equal(line(), `- ${R2}`, "a new verdict replaces the old one and its re-check");
});

test("a skip over the placeholder or over a skip replaces it", () => {
  plan(PH);
  run(DIR, "spec-audit: skipped — non-material (typo)");
  assert.equal(line(), "- spec-audit: skipped — non-material (typo)", "non-material over the placeholder writes the skip");
  run(DIR, "spec-audit: skipped — non-material (link)");
  assert.equal(line(), "- spec-audit: skipped — non-material (link)", "non-material over a skip replaces it");

  plan(R1);
  run(DIR, 'spec-audit: skipped — user authorized "just write it"');
  assert.equal(line(), '- spec-audit: skipped — user authorized "just write it"', "a user-authorized skip replaces a verdict");
});

test("a line with a backslash is written as it is", () => {
  plan(PH);
  run(DIR, 'spec-audit: skipped — user authorized "keep C:\\new as is"');
  assert.equal(line(), '- spec-audit: skipped — user authorized "keep C:\\new as is"');
});

test("refusals", () => {
  plan(PH);
  assert.equal(run(DIR, "codex round-1").rc, 2, "a line without the prefix is refused");
  assert.equal(run(DIR, "spec-audit: spec-audit: codex round-1").rc, 2, "a doubled prefix is refused");
  assert.equal(run(DIR, "spec-audit: ").rc, 2, "a prefix with nothing after it is refused");
  assert.equal(run(DIR).rc, 2, "a missing line is refused");
  assert.equal(line(), `- ${PH}`, "a refused line writes nothing");
  assert.equal(run(join(TMP, "nothing"), R1).rc, 2, "a folder with no plan.md is refused");

  writeFileSync(PLAN, "# Plan\n");
  const r = run(DIR, R1);
  assert.equal(r.rc, 1, "a plan.md with no spec-audit item fails");
  assert.equal(
    r.err,
    `write-audit-line: no '- spec-audit:' item in ${PLAN} — restore it from the plan template`,
    "the failure says what is missing",
  );
});
