#!/usr/bin/env -S node --experimental-strip-types
// parse-review-output.ts
//
// Parse a follow-up round's output (.agents/skills/review/spec-audit.ts --follow-up)
// for line-anchored [resolved] and [open] verdicts, one per finding sent, named
// by its ID (`F<n>`, see .agents/skills/spec-audit/SKILL.md § step-5-follow-up-rounds),
// plus any new [must-fix] / [should-fix] lines the accepted edits introduced.
//
// Deterministic — line match + count + emit a summary.
//
// Usage:
//   parse-review-output.ts --expected <id,id,...> < follow-up-output.txt
//
// Flags:
//   --expected <ids>  REQUIRED. Comma-separated IDs of the findings sent to the
//                     follow-up (e.g. `F2,F4`). Each needs exactly one verdict. A
//                     verdict's ID is the first word after its marker, with
//                     trailing `:,.;` dropped.
//
// Output (multi-line to stdout):
//   resolved-count: <N>
//   open-count: <N>
//   new-must-fix-count: <N>
//   new-should-fix-count: <N>
//   verdict: consensus | open | incomplete
//   <blank line>
//   [resolved] … / [open] … / [must-fix] … / [should-fix] …   (that order)
//   missing: <id>          (incomplete only — a finding sent with no verdict)
//   duplicate: <id>        (incomplete only — more than one verdict for it)
//   unexpected: <id>       (incomplete only — a verdict for no finding sent)
//
// Caller uses:
//   - verdict=consensus  → every finding resolved, no new must-fix: stop
//   - verdict=open       → a finding is open or an edit introduced a must-fix:
//                          disposition them and run another follow-up (cap 3)
//   - verdict=incomplete → NOT consensus: some finding was not adjudicated
//
// A new [should-fix] alone does not keep the loop open: it is dispositioned
// like any finding, but only open findings and new must-fix lines need another
// review.
//
// Why --expected is required: counting verdict lines alone made "two findings
// sent, one verdict back" read as consensus, so the SPEC recorded agreement on
// a finding nobody reviewed. Only the caller knows what it submitted.
//
// Exit code: 0 consensus or open; 1 empty input; 2 caller error (no or bad
// --expected); 3 incomplete (the summary is still printed).
//
// peers:
//   .agents/skills/spec-audit/scripts/parse-review-output.test.ts

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exit, runToExit } from "../../../packages/cli-exit/cli-exit.ts";

/** The finding ID a verdict line names: its first word, trailing punctuation dropped. */
function verdictId(line: string): string {
  const word = line.replace(/^\[[a-z]+\]/, "").trimStart().split(/\s/, 1)[0] ?? "";
  return word.replace(/[:,.;]+$/, "");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let expectedArg: string | undefined;
  while (argv.length > 0) {
    const a = argv.shift() ?? "";
    if (a === "--expected") expectedArg = argv.shift();
    else {
      process.stderr.write(`error: unknown argument: ${a}\n`);
      exit(2);
    }
  }
  const EXPECTED = (expectedArg ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (EXPECTED.length === 0) {
    process.stderr.write("error: --expected <id,id,...> is required — the IDs of the findings sent to the follow-up\n");
    exit(2);
  }

  // `$(cat)`: trailing newlines dropped, so input of only newlines is empty.
  const INPUT = readFileSync(0, "utf8").replace(/\n+$/, "");

  if (INPUT === "") {
    process.stderr.write("error: empty input\n");
    exit(1);
  }

  const lines = INPUT.split("\n");
  const RESOLVED = lines.filter((l) => l.startsWith("[resolved]"));
  const OPEN = lines.filter((l) => l.startsWith("[open]"));
  const MUST_FIX = lines.filter((l) => l.startsWith("[must-fix]"));
  const SHOULD_FIX = lines.filter((l) => l.startsWith("[should-fix]"));

  const seen = new Map<string, number>();
  for (const id of [...RESOLVED, ...OPEN].map(verdictId)) seen.set(id, (seen.get(id) ?? 0) + 1);
  const expected = new Set(EXPECTED);
  const missing = EXPECTED.filter((id) => !seen.has(id));
  const duplicate = EXPECTED.filter((id) => (seen.get(id) ?? 0) > 1);
  const unexpected = [...seen.keys()].filter((id) => !expected.has(id));
  const incomplete = missing.length + duplicate.length + unexpected.length > 0;

  const VERDICT = incomplete ? "incomplete" : OPEN.length + MUST_FIX.length === 0 ? "consensus" : "open";

  let out = `resolved-count: ${RESOLVED.length}\nopen-count: ${OPEN.length}\nnew-must-fix-count: ${MUST_FIX.length}\nnew-should-fix-count: ${SHOULD_FIX.length}\nverdict: ${VERDICT}\n\n`;
  for (const l of [...RESOLVED, ...OPEN, ...MUST_FIX, ...SHOULD_FIX]) out += `${l}\n`;
  for (const id of missing) out += `missing: ${id}\n`;
  for (const id of duplicate) out += `duplicate: ${id}\n`;
  for (const id of unexpected) out += `unexpected: ${id}\n`;
  process.stdout.write(out);
  if (incomplete) exit(3);
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  await runToExit(main);
}
